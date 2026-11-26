// The five protocol gates as pure specifications over the seal and its dossier: what each finds missing before the
// Directive is filed, and the protocol hold it reads to the Liaison. directorate_report applies them in this order.
import { Schema } from "effect";

import { coverageSummary } from "../../seal/coverage.ts";
import type { Seal } from "../../seal/record.ts";
import { isLocked } from "../../workflow/review/window.ts";
import type { Phase } from "../../workflow/review/window.ts";
import { Compliance, Seat } from "../agents/agent.ts";
import {
  outstandingDispatches,
  missingSeats,
  seatName,
} from "../dispatch/lifecycle.ts";
import { currentSeverity, unresolved } from "../ledger/decide.ts";
import type { Ledger } from "../ledger/entry.ts";
import { GapGateSchema } from "./directive.ts";
import type { GapGate } from "./directive.ts";

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

/** Coverage: every region is read or disposed. */
export const coverageGate = (seal: Seal) => {
  const cov = coverageSummary(seal);

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

/** Seats: every Directorate Seat returned a review of every region. */
export const seatsGate = (seal: Seal, phase: Phase) => {
  const missing = missingSeats(seal);

  return hold(
    "panel",
    missing.map((s) => `${s.model}:${s.runs.length}`),
    `Protocol hold (Seats): ${missing.length} of ${seal.panel?.length ?? 0} Directorate Seats ${missing.some((s) => s.status === "partial") ? "did not finish reading all regions" : "returned no review"}: ${missing.map((s) => `${seatName(s.model)} (${s.status === "partial" ? `${s.unread} regions unread` : s.status})`).join(", ")}. ${phase === "drain" ? "Seats can no longer be launched or continued during drain." : `Continue a partial seat in its existing session or launch a new ${Seat.id} without a model (The Directorate assigns it); leave a seat that failed twice.`} Calling directorate_report again files a partial review.`
  );
};

/** Active Personnel: no Auditor, Seat, or Compliance run is still going. */
export const personnelGate = (seal: Seal) => {
  const running = outstandingDispatches(seal);

  return hold(
    "children",
    running.map((r) => r.call),
    `Protocol hold (Active Personnel): Still running: ${running.map((r) => `${r.agent} (${r.session ?? r.call})`).join(", ")}. Call directorate_wait to wait for them without ending your turn, then verify their entries. Calling directorate_report again terminates them and marks their questions unanswered.`
  );
};

/** Unverified Dossier: every entry is decided. */
export const dossierGate = (ledger: Ledger) => {
  const open = unresolved(ledger);

  return hold(
    "open",
    open.map(
      (e) =>
        `${e.id}:${e.status}:${e.verdicts.length}:${e.history?.length ?? 0}`
    ),
    `Protocol hold (Unverified Dossier): ${open.length} entries are unresolved: ${open.map((e) => `${e.id} (${currentSeverity(e)}, by ${e.raisedBy.agent}${e.status === "duplicate" ? ", duplicate of an unconfirmed entry" : ""})`).join(", ")}. Decide minor Auditor/Seat entries yourself; route the rest to ${Compliance.id}. Calling directorate_report again renders them as unverified leads.`
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
