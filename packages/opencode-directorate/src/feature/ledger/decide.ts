// Directorate ledger rules: who may decide an entry, how severities and duplicates resolve, and how entries reopen.
// Decision authority is a specification over the deciding Agent: named predicates on the agent, the entry, and the claim,
// composed in one decision (`verdictError`).
import { Match, Schema } from "effect";

import type { Anchor } from "../../seal/region.ts";
import { agentNamed, Compliance, Liaison } from "../agents/agent.ts";
import type { Actor, Agent } from "../agents/agent.ts";
import {
  Entry,
  EntryStatusSchema,
  SeveritySchema,
  Verdict,
  VerdictKindSchema,
} from "./entry.ts";
import type { Ledger } from "./entry.ts";

export const RANK = Schema.Record(SeveritySchema, Schema.Int).make({
  blocking: 0,
  important: 1,
  minor: 2,
});

/** Severity of the current verification generation: the latest confirmation, else the claim. */
export const currentSeverity = (e: Entry) =>
  e.verdicts.findLast((v) => v.verdict === "confirmed")?.severity ?? e.severity;

const lastOf = (e: Entry) =>
  e.verdicts.findLast((v) => v.verdict === "duplicate")?.of;

const followDuplicate = (
  ledger: Ledger,
  e: Entry | undefined,
  seen: Set<string>
): Entry | undefined => {
  if (!e || e.status !== "duplicate") {
    return e;
  }

  if (seen.has(e.id)) {
    return undefined;
  }

  seen.add(e.id);

  return followDuplicate(ledger, ledger.entryById(lastOf(e)), seen);
};

/** The entry a duplicate finally points at, following chains; undefined for a cycle or a missing target. */
export const resolvedTarget = (ledger: Ledger, e: Entry) =>
  followDuplicate(ledger, e, new Set());

/** Open entries plus duplicates whose target is not confirmed. */
export const unresolved = (ledger: Ledger) =>
  ledger.entries.filter(
    (e) =>
      e.status === "open" ||
      (e.status === "duplicate" &&
        resolvedTarget(ledger, e)?.status !== "confirmed")
  );

/** A verdict as its caller claims it: the parts of a `Verdict` the decision reads. */
const VerdictClaimSchema = Schema.Struct({
  evidence: Verdict.fields.evidence,
  of: Verdict.fields.of,
  severity: Verdict.fields.severity,
  verdict: Verdict.fields.verdict,
});

export type VerdictClaim = typeof VerdictClaimSchema.Type;

// ---------- Specifications: who may decide what ----------

/** Only the Liaison and Compliance record verdicts; any other agent, or a name no Directorate agent has, may not. */
const recordsVerdicts = (agent: Agent | undefined): agent is Agent =>
  agent === Liaison || agent === Compliance;

const isAffirming = Schema.is(
  VerdictKindSchema.pick(["confirmed", "resolved"])
);

/** A claim that the entry holds or that its fix works: both need the same independence from whoever raised it. */
const affirms = (claim: VerdictClaim) => isAffirming(claim.verdict);

/** Resolved applies only to findings carried from the review a re-check follows. */
const resolvesOnlyCarried = (entry: Entry, claim: VerdictClaim) =>
  claim.verdict !== "resolved" || entry.carried !== undefined;

/** A verified finding carried into a re-check was confirmed by Compliance (or within its rules); only Compliance re-decides it. */
const decidesCarriedFinding = (agent: Agent, entry: Entry) =>
  entry.carried?.status !== "confirmed" || agent === Compliance;

/** The caller's own session raised the entry. */
const raisedBy = (by: Actor, entry: Entry) =>
  by.session === entry.raisedBy.session;

const isOpen = Schema.is(EntryStatusSchema.pick(["open"]));

/** A duplicate may point only at an entry still in play. */
const isDuplicable = Schema.is(EntryStatusSchema.pick(["open", "confirmed"]));

/** Merging `entry` into `target` would hide a higher claim behind a lower one. */
const hidesHigherClaim = (target: Entry, entry: Entry) =>
  RANK[currentSeverity(target)] > RANK[currentSeverity(entry)];

/** The Liaison's reach over entries other sessions raised: undecided, minor, not its own kind's to affirm, kept minor. */
const liaisonReachError = (entry: Entry, claim: VerdictClaim) => {
  if (!isOpen(entry.status)) {
    return `${entry.id} is ${entry.status}. Only ${Compliance.id} may re-decide a decided entry.`;
  }

  if (agentNamed(entry.raisedBy.agent) === Liaison && affirms(claim)) {
    return `${entry.id} was raised by ${Liaison.id}; only ${Compliance.id} may ${claim.verdict === "resolved" ? "resolve" : "confirm"} it.`;
  }

  const sev = currentSeverity(entry);

  if (sev !== "minor") {
    return `${entry.id} is ${sev}. Any verdict on a blocking or important entry needs ${Compliance.id}; route it there with your evidence.`;
  }

  if (
    claim.verdict === "confirmed" &&
    claim.severity &&
    claim.severity !== "minor"
  ) {
    return `You may confirm only as minor; route it to ${Compliance.id} to raise its severity.`;
  }
};

const duplicateError = (
  entry: Entry,
  agent: Agent,
  of: string | undefined,
  ledger: Ledger
) => {
  const target = ledger.entryById(of);

  if (!target) {
    return `duplicate needs "of": an existing entry id.`;
  }

  if (target.id === entry.id) {
    return "an entry cannot duplicate itself.";
  }

  if (!isDuplicable(target.status)) {
    return `${target.id} is ${target.status}; mark duplicates only of open or confirmed entries.`;
  }

  if (agent === Liaison && hidesHigherClaim(target, entry)) {
    return `${target.id} is ${currentSeverity(target)} and ${entry.id} claims ${currentSeverity(entry)}; merging would hide the higher claim. Route both to ${Compliance.id}.`;
  }
};

const evidenceError = (verdict: VerdictClaim["verdict"]) =>
  Match.value(verdict).pipe(
    Match.when(
      "refuted",
      () =>
        "refuted needs counterevidence (path:line of the guard, caller, or test that defeats it)."
    ),
    Match.when(
      "resolved",
      () =>
        "resolved needs the lines that fix it (path:line of the new guard, check, or test)."
    ),
    Match.orElse(
      () =>
        "a verdict needs at least one deciding evidence reference (path:line)."
    )
  );

/** A verdict the caller may not record on an entry, or one whose confirmation does not tie to the sealed code. */
export class VerdictRefused extends Schema.TaggedError<
  VerdictRefused,
  { readonly brand: unique symbol }
>()("VerdictRefused", { message: Schema.String }) {}

/** Why `by` may not record `claim` on `entry`, or undefined if it may: the specifications above, in order. */
export const verdictError = (
  entry: Entry,
  by: Actor,
  claim: VerdictClaim,
  ledger: Ledger
) => {
  const agent = agentNamed(by.agent);

  if (!recordsVerdicts(agent)) {
    return `Only ${Liaison.id} or ${Compliance.id} may record verdicts (you are ${by.agent}).`;
  }

  if (!resolvesOnlyCarried(entry, claim)) {
    return `${entry.id} is new in this review; resolved applies only to findings carried from the review this one re-checks. Refute it instead if it does not hold.`;
  }

  if (!decidesCarriedFinding(agent, entry)) {
    return `${entry.id} carries a verified finding from the earlier review; route it to ${Compliance.id} to decide whether it is still present, resolved, or was wrong.`;
  }

  const own = raisedBy(by, entry);

  // No session affirms its own entry; its author may only withdraw it while it is open.
  if (own && affirms(claim)) {
    return `${entry.id} was raised in this session. A different session must ${claim.verdict === "resolved" ? "resolve" : "confirm"} it: ${Compliance.id} for the Liaison's own entries.`;
  }

  if (own && !isOpen(entry.status)) {
    return `${entry.id} is ${entry.status}; you can only withdraw your own open entries.`;
  }

  if (agent === Liaison && !own) {
    const error = liaisonReachError(entry, claim);

    if (error) {
      return error;
    }
  }

  if (!claim.evidence.length) {
    return evidenceError(claim.verdict);
  }

  return claim.verdict === "duplicate"
    ? duplicateError(entry, agent, claim.of, ledger)
    : undefined;
};

export const nearby = (ledger: Ledger, a: Anchor) =>
  ledger.entries.filter(
    (e) =>
      e.anchor.path === a.path &&
      Math.abs(e.anchor.line - a.line) <= 8 &&
      e.status !== "refuted"
  );

// ---------- Transitions: each returns the next entry or ledger ----------

/** The entry, open again for a new verification generation; its verdicts move to its history. */
export const reopen = (e: Entry, reason: string) =>
  new Entry({
    ...e,
    history: [...(e.history ?? []), ...e.verdicts],
    severity: currentSeverity(e),
    staleReason: reason,
    status: "open",
    verdicts: [],
  });

/** Refuting or resolving an entry reopens the entries merged into it. */
const reopensDuplicates = Schema.is(
  EntryStatusSchema.pick(["refuted", "resolved"])
);

/** The ledger with a decided entry in place; refuting or resolving it reopens its duplicates. */
export const decide = (ledger: Ledger, entry: Entry) => {
  const placed = ledger.entries.map((e) => (e.id === entry.id ? entry : e));
  const { status } = entry;

  if (!reopensDuplicates(status)) {
    return { ledger: ledger.withEntries(placed), reopened: [] };
  }

  // After the entry was refuted or resolved, entries merged into it are open questions again.
  const reopened: string[] = [];

  const entries = placed.map((d) => {
    if (d.status !== "duplicate" || lastOf(d) !== entry.id) {
      return d;
    }

    reopened.push(d.id);

    return reopen(
      d,
      `the entry it duplicated (${entry.id}) was ${status}; decide it on its own`
    );
  });

  return { ledger: ledger.withEntries(entries), reopened };
};
