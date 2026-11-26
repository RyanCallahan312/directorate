// Directorate ledger rules: who may decide an entry, how severities and duplicates resolve, and how entries reopen.
import { Match } from "effect";

import type { Anchor } from "../../seal/region.ts";
import { REFUTER, REVIEWER } from "../agents/agent.ts";
import type { Actor } from "../agents/agent.ts";
import type { Entry, Ledger, Severity, Verdict } from "./entry.ts";

export const RANK: Record<Severity, number> = {
  blocking: 0,
  important: 1,
  minor: 2,
};

/** Severity of the current verification generation: the latest confirmation, else the claim. */
export const currentSeverity = (e: Entry): Severity =>
  e.verdicts.findLast((v) => v.verdict === "confirmed")?.severity ?? e.severity;

const lastOf = (e: Entry) =>
  e.verdicts.findLast((v) => v.verdict === "duplicate")?.of;

/** The entry a duplicate finally points at, following chains; undefined for a cycle or a missing target. */
export const resolvedTarget = (ledger: Ledger, e: Entry): Entry | undefined => {
  const seen = new Set<string>();
  let cur: Entry | undefined = e;

  while (cur && cur.status === "duplicate" && !seen.has(cur.id)) {
    seen.add(cur.id);
    const of = lastOf(cur);
    cur = ledger.entries.find((x) => x.id === of);
  }

  return cur && cur.status !== "duplicate" ? cur : undefined;
};

/** Open entries plus duplicates whose target is not confirmed. */
export const unresolved = (ledger: Ledger) =>
  ledger.entries.filter(
    (e) =>
      e.status === "open" ||
      (e.status === "duplicate" &&
        resolvedTarget(ledger, e)?.status !== "confirmed")
  );

interface VerdictInput {
  verdict: Verdict["verdict"];
  evidence: readonly string[];
  of?: string | undefined;
  severity?: Severity | undefined;
}

const liaisonVerdictError = (
  entry: Entry,
  input: VerdictInput,
  affirms: boolean
) => {
  if (entry.status !== "open") {
    return `${entry.id} is ${entry.status}. Only ${REFUTER} may re-decide a decided entry.`;
  }

  if (entry.raisedBy.agent === REVIEWER && affirms) {
    return `${entry.id} was raised by ${REVIEWER}; only ${REFUTER} may ${input.verdict === "resolved" ? "resolve" : "confirm"} it.`;
  }

  const sev = currentSeverity(entry);

  if (sev !== "minor") {
    return `${entry.id} is ${sev}. Any verdict on a blocking or important entry needs ${REFUTER}; route it there with your evidence.`;
  }

  if (
    input.verdict === "confirmed" &&
    input.severity &&
    input.severity !== "minor"
  ) {
    return `You may confirm only as minor; route it to ${REFUTER} to raise its severity.`;
  }
};

const duplicateError = (
  entry: Entry,
  by: Actor,
  of: string | undefined,
  ledger: Ledger
) => {
  const target = ledger.entries.find((e) => e.id === of);

  if (!target) {
    return `duplicate needs "of": an existing entry id.`;
  }

  if (target.id === entry.id) {
    return "an entry cannot duplicate itself.";
  }

  if (target.status !== "open" && target.status !== "confirmed") {
    return `${target.id} is ${target.status}; mark duplicates only of open or confirmed entries.`;
  }

  if (
    by.agent === REVIEWER &&
    RANK[currentSeverity(target)] > RANK[currentSeverity(entry)]
  ) {
    return `${target.id} is ${currentSeverity(target)} and ${entry.id} claims ${currentSeverity(entry)}; merging would hide the higher claim. Route both to ${REFUTER}.`;
  }
};

const evidenceError = (verdict: Verdict["verdict"]) =>
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

export const verdictError = (
  entry: Entry,
  by: Actor,
  input: VerdictInput,
  ledger: Ledger
): string | undefined => {
  if (by.agent !== REVIEWER && by.agent !== REFUTER) {
    return `Only ${REVIEWER} or ${REFUTER} may record verdicts (you are ${by.agent}).`;
  }

  if (input.verdict === "resolved" && !entry.carried) {
    return `${entry.id} is new in this review; resolved applies only to findings carried from the review this one re-checks. Refute it instead if it does not hold.`;
  }

  // A verified finding was confirmed by Compliance (or within its rules); only Compliance may overturn or re-confirm it.
  if (entry.carried?.status === "confirmed" && by.agent !== REFUTER) {
    return `${entry.id} carries a verified finding from the earlier review; route it to ${REFUTER} to decide whether it is still present, resolved, or was wrong.`;
  }

  // Resolving claims the fix works, which needs the same independence as confirming.
  const affirms = input.verdict === "confirmed" || input.verdict === "resolved";
  const own = by.session === entry.raisedBy.session;

  if (own && affirms) {
    return `${entry.id} was raised in this session. A different session must ${input.verdict === "resolved" ? "resolve" : "confirm"} it: ${REFUTER} for the Liaison's own entries.`;
  }

  if (own && entry.status !== "open") {
    return `${entry.id} is ${entry.status}; you can only withdraw your own open entries.`;
  }

  if (by.agent === REVIEWER && !own) {
    const error = liaisonVerdictError(entry, input, affirms);

    if (error) {
      return error;
    }
  }

  if (!input.evidence.length) {
    return evidenceError(input.verdict);
  }

  return input.verdict === "duplicate"
    ? duplicateError(entry, by, input.of, ledger)
    : undefined;
};

export const nearby = (ledger: Ledger, a: Anchor) =>
  ledger.entries.filter(
    (e) =>
      e.anchor.path === a.path &&
      Math.abs(e.anchor.line - a.line) <= 8 &&
      e.status !== "refuted"
  );

/** The entry, open again for a new verification generation; its verdicts move to its history. */
export const reopen = (e: Entry, reason: string): Entry => ({
  ...e,
  history: [...(e.history ?? []), ...e.verdicts],
  severity: currentSeverity(e),
  staleReason: reason,
  status: "open",
  verdicts: [],
});

/** After `targetId` was refuted or resolved, entries merged into it are open questions again. */
const reopenDuplicatesOf = (
  ledger: Ledger,
  targetId: string,
  how: "refuted" | "resolved"
) => {
  const reopened: string[] = [];

  const entries = ledger.entries.map((d) => {
    if (d.status !== "duplicate" || lastOf(d) !== targetId) {
      return d;
    }

    reopened.push(d.id);

    return reopen(
      d,
      `the entry it duplicated (${targetId}) was ${how}; decide it on its own`
    );
  });

  return { ledger: { ...ledger, entries }, reopened };
};

/** The ledger with a decided entry in place; refuting or resolving it reopens its duplicates. */
export const decide = (
  ledger: Ledger,
  entry: Entry
): { ledger: Ledger; reopened: string[] } => {
  const next = {
    ...ledger,
    entries: ledger.entries.map((e) => (e.id === entry.id ? entry : e)),
  };

  return entry.status === "refuted" || entry.status === "resolved"
    ? reopenDuplicatesOf(next, entry.id, entry.status)
    : { ledger: next, reopened: [] };
};
