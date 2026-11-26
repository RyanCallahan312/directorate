// The protocol gates' memory and the filed Directive: the Protocol & Directive field group of seal.json, and the
// Directive's status and reasons.
import { Schema } from "effect";
import type { DateTime } from "effect";

import { isSecret } from "../../exclusions.ts";
import { orLegacyTrue, since, Time } from "../../platform/stored.ts";
import { coverageSummary } from "../../seal/coverage.ts";
import type { Seal } from "../../seal/record.ts";
import { isLocked } from "../../workflow/review/window.ts";
import type { Phase } from "../../workflow/review/window.ts";
import {
  failedDispatches,
  isPartialSeat,
  outstandingDispatches,
  missingSeats,
} from "../dispatch/lifecycle.ts";
import { unresolved } from "../ledger/decide.ts";
import type { Ledger } from "../ledger/entry.ts";

const list = Schema.Array;
const opt = Schema.optional;

/** The gates that remember each gap (by id) they pushed back on; Containment Drift remembers a fingerprint instead. */
export const GapGateSchema = Schema.Literals([
  "children",
  "coverage",
  "open",
  "panel",
]);

export type GapGate = typeof GapGateSchema.Type;

const gatesFields = {
  children: opt(orLegacyTrue(list(Schema.String), [])),
  coverage: opt(orLegacyTrue(list(Schema.String), [])),
  // A legacy `true` matched no fingerprint, so it decodes to one that matches none.
  freshness: opt(orLegacyTrue(Schema.String, "")),
  open: opt(orLegacyTrue(list(Schema.String), [])),
  panel: opt(list(Schema.String)),
} satisfies Record<GapGate | "freshness", Schema.Top>;

/** What the gates remember: a gap gate's ids, or Containment Drift's fingerprint. */
export type Remembered = Partial<Schema.Struct.Type<typeof gatesFields>>;

/** Each gate remembers what it already pushed back on; it fires again only for something new. */
export class Gates extends Schema.Class<
  Gates,
  { readonly brand: unique symbol }
>("directorate/Gates")(gatesFields) {
  /** These gates, also remembering `remembered`. */
  remembering(remembered: Remembered) {
    return new Gates({ ...this, ...remembered });
  }
}

/** A Directive's status: complete, partial (something went unreviewed or undecided), or stale (the code moved). */
export const DirectiveStatusSchema = Schema.Literals([
  "complete",
  "partial",
  "stale",
]);

export type DirectiveStatus = typeof DirectiveStatusSchema.Type;

export const isComplete = Schema.is(DirectiveStatusSchema.pick(["complete"]));

/** A Directive's status and the reasons for it: assessed at filing, and stored on the reported seal. */
export class Directive extends Schema.Class<
  Directive,
  { readonly brand: unique symbol }
>("directorate/Directive")({
  reasons: list(Schema.String),
  status: DirectiveStatusSchema,
}) {}

/** The Protocol & Directive field group of seal.json. */
export const Protocol = Schema.Struct({
  autoReported: opt(Schema.Boolean),
  /** What the reported Directive stated, so a ship reads it from the seal; seals reported by older versions omit it. */
  directive: opt(Directive),
  freshnessUnverified: opt(Schema.String),
  gates: since(Gates, {}),
  reportedAt: opt(Time),
  staleFiles: opt(list(Schema.String)),
});

/** What the freshness check at filing found: the files that changed since the seal, or why it could not tell. */
const FreshnessSchema = Schema.Struct({
  stale: opt(list(Schema.String)),
  unverified: opt(Schema.String),
});

export type Freshness = typeof FreshnessSchema.Type;

/** A gate pushed back: it remembers what it pushed back on, so it fires again only for something new. */
export const pushedBack = (seal: Seal, remembered: Remembered) =>
  seal.withProtocol({ gates: seal.gates.remembering(remembered) });

/** A refreshed seal: the gates start over and the drift is gone. */
export const driftCleared = (seal: Seal) =>
  seal.withProtocol({ gates: Gates.make({}), staleFiles: undefined });

/** What the freshness check at filing found. */
export const freshnessChecked = (seal: Seal, fresh: Freshness) =>
  seal.withProtocol({
    freshnessUnverified: fresh.unverified,
    staleFiles: fresh.stale,
  });

/** The filed Directive: the seal is reported from then on. */
export const directiveFiled = (
  seal: Seal,
  directive: Directive,
  at: DateTime.Utc,
  auto: boolean | undefined
) =>
  seal.withProtocol({
    autoReported: auto || undefined,
    directive,
    reportedAt: at,
  });

/** Stale when the code moved, whatever else went missing; otherwise partial when anything did. */
const directiveStatus = (fresh: Freshness, partial: boolean) => {
  if (fresh.stale) {
    return "stale";
  }

  return partial ? "partial" : "complete";
};

/** The Directive from everything except gates: its status, and the reasons in the order they are read. */
export const assess = (
  seal: Seal,
  ledger: Ledger,
  fresh: Freshness,
  phase: Phase
) => {
  const cov = coverageSummary(seal);

  const secrets = seal.files.filter(
    (f) =>
      f.isChanged &&
      f.excluded &&
      (isSecret(f.path) || (f.oldPath !== undefined && isSecret(f.oldPath)))
  );

  const leads = unresolved(ledger).length;
  const seatless = missingSeats(seal);

  /** Each reason, and whether it makes the Directive partial. */
  const found = [
    [cov.unread.length > 0, `${cov.unread.length} regions unread`, true],
    [cov.skipped.length > 0, `${cov.skipped.length} regions skipped`, true],
    [
      cov.skimmed.length > 0,
      `${cov.skimmed.length} regions only skimmed`,
      true,
    ],
    [
      secrets.length > 0,
      `${secrets.length} changed secret-like file${secrets.length === 1 ? " was" : "s were"} withheld and not reviewed`,
      true,
    ],
    [leads > 0, `${leads} leads unverified`, true],
    [
      ledger.notes.some((n) => n.isUnanswered) ||
        failedDispatches(seal, ledger).length > 0 ||
        outstandingDispatches(seal).length > 0,
      "some questions went unanswered",
      true,
    ],
    [
      seatless.length > 0,
      `${seatless.length} of ${seal.panel?.length} Directorate Seats did not review ${seatless.some((s) => isPartialSeat(s.status)) ? "every region" : "the target"}`,
      true,
    ],
    [Boolean(fresh.unverified), "freshness could not be verified", true],
    [
      fresh.stale !== undefined,
      `code changed after the seal (${fresh.stale?.length} ${fresh.stale?.length === 1 ? "change" : "changes"})`,
      false,
    ],
    [isLocked(phase), "time budget ran out", false],
    [Boolean(seal.abandoned), "abandoned for a new review", true],
  ] as const;

  return Directive.make({
    reasons: found.flatMap(([holds, why]) => (holds ? [why] : [])),
    status: directiveStatus(
      fresh,
      found.some(([holds, , partial]) => holds && partial)
    ),
  });
};
