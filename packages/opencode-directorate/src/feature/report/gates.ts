// The five protocol gates as pure specifications over the seal and its dossier: what each finds missing before the
// Directive is filed, and the protocol hold it reads to the Liaison. directorate_report applies them in this order.
import { Schema } from "effect";

import { coverageSummary } from "../../seal/coverage.ts";
import type { Seal } from "../../seal/record.ts";
import { isDraining, isLocked } from "../../workflow/review/window.ts";
import type { Phase } from "../../workflow/review/window.ts";
import { Compliance, Seat } from "../agents/agent.ts";
import {
  isPartialSeat,
  outstandingDispatches,
  missingSeats,
  seatName,
} from "../dispatch/lifecycle.ts";
import { currentSeverity, unresolved } from "../ledger/decide.ts";
import type { Ledger } from "../ledger/entry.ts";
import { GapGateSchema } from "./directive.ts";
import type { GapGate, Remembered } from "./directive.ts";

/** A gap gate's finding: the gaps it sees now, under the key it remembers them by, and its protocol hold. */
export class Hold extends Schema.Class<Hold, { readonly brand: unique symbol }>(
  "directorate/Hold"
)({
  ids: Schema.Array(Schema.String),
  key: GapGateSchema,
  message: Schema.String,
}) {}

const hold = (key: GapGate, ids: readonly string[], message: string) =>
  Hold.make({ ids, key, message });

/** Coverage: every region is read or disposed. Undefined when none is unread. */
export const coverageGate = (seal: Seal) => {
  const cov = coverageSummary(seal);

  if (!cov.unread.length) {
    return;
  }

  return hold(
    "coverage",
    cov.unread.map((r) => r.id),
    `Protocol hold (Coverage): ${cov.unread.length} of ${cov.total} regions unread: ${cov.unread
      .slice(0, 40)
      .map((r) => `${r.id} ${r.file}:${r.newStart}-${r.newEnd}`)
      .join(
        ", "
      )}. Read them with directorate_diff, or record directorate_coverage dispositions. Calling directorate_report again files a <Partial/Incomplete> directive.`
  );
};

/** Seats: every Directorate Seat returned a review of every region. Undefined when none is missing. */
export const seatsGate = (seal: Seal, phase: Phase) => {
  const missing = missingSeats(seal);

  if (!missing.length) {
    return;
  }

  return hold(
    "panel",
    missing.map((s) => `${s.model}:${s.runs.length}`),
    `Protocol hold (Seats): ${missing.length} of ${seal.panel?.length ?? 0} Directorate Seats ${missing.some((s) => isPartialSeat(s.status)) ? "did not finish reading all regions" : "returned no review"}: ${missing.map((s) => `${seatName(s.model)} (${isPartialSeat(s.status) ? `${s.unread} regions unread` : s.status})`).join(", ")}. ${isDraining(phase) ? "Seats can no longer be launched or continued during drain." : `Continue a partial seat in its existing session or launch a new ${Seat.id} without a model (The Directorate assigns it); leave a seat that failed twice.`} Calling directorate_report again files a partial review.`
  );
};

/** Active Personnel: no Auditor, Seat, or Compliance run is still going. Undefined when none is. */
export const personnelGate = (seal: Seal) => {
  const running = outstandingDispatches(seal);

  if (!running.length) {
    return;
  }

  return hold(
    "children",
    running.map((r) => r.call),
    `Protocol hold (Active Personnel): Still running: ${running.map((r) => `${r.agent} (${r.session ?? r.call})`).join(", ")}. Call directorate_wait to wait for them without ending your turn, then verify their entries. Calling directorate_report again terminates them and marks their questions unanswered.`
  );
};

/** Unverified Dossier: every entry is decided. Undefined when every entry is. */
export const dossierGate = (ledger: Ledger) => {
  const open = unresolved(ledger);

  if (!open.length) {
    return;
  }

  return hold(
    "open",
    open.map(
      (e) =>
        `${e.id}:${e.status}:${e.verdicts.length}:${e.history?.length ?? 0}`
    ),
    `Protocol hold (Unverified Dossier): ${open.length} entries are unresolved: ${open.map((e) => `${e.id} (${currentSeverity(e)}, by ${e.raisedBy.agent}${e.isDuplicate ? ", duplicate of an unconfirmed entry" : ""})`).join(", ")}. Decide minor Auditor/Seat entries yourself; route the rest to ${Compliance.id}. Calling directorate_report again renders them as unverified leads.`
  );
};

/**
 * A gap gate pushes back once for each new id it has not already pushed back on, and never once the budget is locked.
 * Returns the gates to remember when it pushes back.
 */
export const pushesBack = (seal: Seal, phase: Phase, { ids, key }: Hold) => {
  const seen = new Set(seal.gates[key]);

  return isLocked(phase) || ids.every((id) => seen.has(id))
    ? undefined
    : { [key]: [...new Set([...seen, ...ids])] };
};

/**
 * Containment Drift: the artifact still matches the seal. Pushes back once per new fingerprint, only before the one
 * refresh, and never once the budget is locked. Returns the protocol hold when it pushes back.
 */
export const driftGate = (
  seal: Seal,
  phase: Phase,
  fingerprint: string,
  unfetched: string | undefined
) =>
  fingerprint !== seal.fingerprint &&
  seal.refreshes < 1 &&
  seal.gates.freshness !== fingerprint &&
  !isLocked(phase)
    ? `Protocol hold (Containment Drift): the artifact changed after sealing${unfetched ? ` (${unfetched})` : ""}. Call directorate_refresh to re-contain once, read the new regions, and re-verify reopened entries; then call directorate_report again.`
    : undefined;

/** A gate that pushes back now: what the seal's gates remember from now on, and the protocol hold the Liaison reads. */
const pushBack = (remembered: Remembered, message: string) => ({
  message,
  remembered,
});

/** The gap gate's push-back, or undefined when it holds nothing new. */
const once = (seal: Seal, phase: Phase, gate: Hold | undefined) => {
  const remembered = gate && pushesBack(seal, phase, gate);

  return gate && remembered ? pushBack(remembered, gate.message) : undefined;
};

/** The target's fingerprint now, as the freshness check found it, and why the PR head was out of reach, if it was. */
const FingerprintSchema = Schema.Struct({
  fingerprint: Schema.String,
  unfetched: Schema.optional(Schema.String),
});

/** The gates decided before the target's fingerprint is checked, in order: Coverage, Seats, Active Personnel. */
export const heldBeforeFreshness = (seal: Seal, phase: Phase) =>
  once(seal, phase, coverageGate(seal)) ??
  once(seal, phase, seatsGate(seal, phase)) ??
  once(seal, phase, personnelGate(seal));

/**
 * The gates decided after the fingerprint check, in order: Containment Drift (only when the check told the fingerprint),
 * then the Unverified Dossier.
 */
export const heldAfterFreshness = (
  seal: Seal,
  ledger: Ledger,
  phase: Phase,
  current: typeof FingerprintSchema.Type | undefined
) => {
  const drift =
    current && driftGate(seal, phase, current.fingerprint, current.unfetched);

  if (current && drift) {
    return pushBack({ freshness: current.fingerprint }, drift);
  }

  return once(seal, phase, dossierGate(ledger));
};
