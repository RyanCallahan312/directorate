// The protocol gates' memory and the filed Directive: the Protocol & Directive field group of seal.json, and the
// Directive's status and reasons.
import { Schema } from "effect";
import type { DateTime } from "effect";

import { isSecret } from "../../exclusions.ts";
import { orLegacyTrue, since, Time } from "../../platform/stored.ts";
import { coverageSummary } from "../../seal/coverage.ts";
import type { Seal } from "../../seal/record.ts";
import type { Phase } from "../../workflow/review/window.ts";
import {
  failedDispatches,
  outstandingDispatches,
  missingSeats,
} from "../dispatch/lifecycle.ts";
import { unresolved } from "../ledger/decide.ts";
import type { Ledger } from "../ledger/entry.ts";

const list = Schema.Array;
const opt = Schema.optional;

/** Each gate remembers what it already pushed back on; it fires again only for something new. */
const GatesSchema = Schema.Struct({
  children: opt(orLegacyTrue(list(Schema.String), [])),
  coverage: opt(orLegacyTrue(list(Schema.String), [])),
  // A legacy `true` matched no fingerprint, so it decodes to one that matches none.
  freshness: opt(orLegacyTrue(Schema.String, "")),
  open: opt(orLegacyTrue(list(Schema.String), [])),
  panel: opt(list(Schema.String)),
});

export type Gates = typeof GatesSchema.Type;

/** A Directive's status: complete, partial (something went unreviewed or undecided), or stale (the code moved). */
export const DirectiveStatusSchema = Schema.Literals([
  "complete",
  "partial",
  "stale",
]);

export type DirectiveStatus = typeof DirectiveStatusSchema.Type;

/** A filed Directive's status and the reasons for it. */
const DirectiveSchema = Schema.Struct({
  reasons: list(Schema.String),
  status: DirectiveStatusSchema,
});

type Directive = typeof DirectiveSchema.Type;

/** The Protocol & Directive field group of seal.json. */
export const Protocol = Schema.Struct({
  autoReported: opt(Schema.Boolean),
  /** What the reported Directive stated, so a ship reads it from the seal; seals reported by older versions omit it. */
  directive: opt(DirectiveSchema),
  freshnessUnverified: opt(Schema.String),
  gates: since(GatesSchema, {}),
  reportedAt: opt(Time),
  staleFiles: opt(list(Schema.String)),
});

export interface Freshness {
  stale?: readonly string[] | undefined;
  unverified?: string | undefined;
}

/** A gate pushed back: it remembers what it pushed back on, so it fires again only for something new. */
export const pushedBack = (seal: Seal, gates: Gates) =>
  seal.withProtocol({ gates: { ...seal.gates, ...gates } });

/** A refreshed seal: the gates start over and the drift is gone. */
export const driftCleared = (seal: Seal) =>
  seal.withProtocol({ gates: {}, staleFiles: undefined });

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

/** Status and reasons from everything except gates. */
interface Assessment {
  status: DirectiveStatus;
  reasons: string[];
}

export const assess = (
  seal: Seal,
  ledger: Ledger,
  fresh: Freshness,
  phase: Phase
): Assessment => {
  const reasons: string[] = [];
  let status: DirectiveStatus = "complete";

  const partial = (why: string) => {
    if (status === "complete") {
      status = "partial";
    }

    reasons.push(why);
  };

  const cov = coverageSummary(seal);

  if (cov.unread.length) {
    partial(`${cov.unread.length} regions unread`);
  }

  if (cov.skipped.length) {
    partial(`${cov.skipped.length} regions skipped`);
  }

  if (cov.skimmed.length) {
    partial(`${cov.skimmed.length} regions only skimmed`);
  }

  const secrets = seal.files.filter(
    (f) =>
      f.status !== "unchanged" &&
      f.excluded &&
      (isSecret(f.path) || (f.oldPath !== undefined && isSecret(f.oldPath)))
  );

  if (secrets.length) {
    partial(
      `${secrets.length} changed secret-like file${secrets.length === 1 ? " was" : "s were"} withheld and not reviewed`
    );
  }

  const leads = unresolved(ledger).length;

  if (leads) {
    partial(`${leads} leads unverified`);
  }

  if (
    ledger.notes.some((n) => n.kind === "unanswered") ||
    failedDispatches(seal, ledger).length ||
    outstandingDispatches(seal).length
  ) {
    partial("some questions went unanswered");
  }

  const seatless = missingSeats(seal);

  if (seatless.length) {
    partial(
      `${seatless.length} of ${seal.panel?.length} Directorate Seats did not review ${seatless.some((s) => s.status === "partial") ? "every region" : "the target"}`
    );
  }

  if (fresh.unverified) {
    partial("freshness could not be verified");
  }

  if (fresh.stale) {
    status = "stale";
    reasons.push(
      `code changed after the seal (${fresh.stale.length} ${fresh.stale.length === 1 ? "change" : "changes"})`
    );
  }

  if (phase === "locked") {
    reasons.push("time budget ran out");
  }

  if (seal.abandoned) {
    partial("abandoned for a new review");
  }

  return { reasons, status };
};
