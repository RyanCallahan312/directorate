// Directorate report (Directive): the review's status and the markdown rendered from verified dossier entries only.
import { Clock, DateTime, Effect, Result } from "effect";

import { budget, type Phase } from "./budget.ts";
import {
  actorName,
  childFailures,
  childName,
  childOutstanding,
  childQuestion,
  missingSeats,
  panelSeats,
  seatName,
} from "./children.ts";
import { coverageSummary } from "./coverage.ts";
import { failure, type ReviewError } from "./error.ts";
import { isSecret } from "./exclusions.ts";
import { currentSeverity, RANK, resolvedTarget, unresolved } from "./ledger.ts";
import type { Entry, Ledger, Region, Seal, Severity } from "./model.ts";
import { changedSinceSeal } from "./seal.ts";
import { Store } from "./store.ts";
import { type Current, currentFingerprint } from "./target.ts";

const SEV_LABEL: Record<Severity, string> = {
  blocking: "Blocking",
  important: "Important",
  minor: "Minor",
};
export type Status = "complete" | "partial" | "stale";

/** For each confirmed entry, the panel seats that raised it or a duplicate of it. */
function seatsRaising(seal: Seal, ledger: Ledger) {
  const seats = panelSeats(seal);
  const seatOf = (e: Entry) =>
    seats.find((s) => s.sessions.has(e.raisedBy.session))?.model;
  const raised = new Map<string, Set<string>>();
  for (const e of ledger.entries) {
    const root = e.status === "duplicate" ? resolvedTarget(ledger, e) : e;
    const seat = seatOf(e);
    if (root && seat)
      raised.set(root.id, (raised.get(root.id) ?? new Set()).add(seat));
  }
  return { seats, seatOf, raised };
}

export function renderReport(input: {
  seal: Seal;
  ledger: Ledger;
  status: Status;
  approach?: string;
  synthesis?: string;
  reasons: readonly string[];
}): string {
  const { seal, ledger, status } = input;
  const confirmed = ledger.entries
    .filter((e) => e.status === "confirmed")
    .map((e) => ({ e, sev: currentSeverity(e) }))
    .sort(
      (a, b) =>
        RANK[a.sev] - RANK[b.sev] ||
        a.e.anchor.path.localeCompare(b.e.anchor.path) ||
        a.e.anchor.line - b.e.anchor.line
    );
  const leads = unresolved(ledger);
  const refuted = ledger.entries.filter((e) => e.status === "refuted");
  const merged =
    ledger.entries.filter((e) => e.status === "duplicate").length -
    leads.filter((e) => e.status === "duplicate").length;
  const top = confirmed[0]?.sev;
  const verdict =
    top === "blocking"
      ? "<Hold/Blocking — Do Not Merge>"
      : top === "important"
        ? "<Changes Required/Remediation Needed>"
        : top === "minor"
          ? "<Minor Revisions/Tolerated with Notes>"
          : status === "complete"
            ? "<Approved/Tolerated> — No Anomalies Verified"
            : "<Provisional/Incomplete> — No Confirmed Issues";
  const cov = coverageSummary(seal);
  const who = (a: Entry["raisedBy"]) => actorName(seal, a);
  const panel = seal.panel?.length ? seatsRaising(seal, ledger) : undefined;
  const out: string[] = [];
  out.push(
    `**Directorate Directive: ${verdict}** · status: **${status}** · mode: ${seal.mode}`
  );
  out.push(
    `Containment: ${seal.description} · seal \`${seal.id}\` · fingerprint \`${seal.fingerprint.slice(0, 12)}\`${seal.refreshes ? ` · re-contained ${seal.refreshes}×` : ""} · regions ${cov.read}/${cov.total} observed${cov.assessed ? ` (${cov.assessed} by disposition)` : ""}${cov.skimmed.length ? `, ${cov.skimmed.length} skimmed` : ""}${cov.skipped.length ? `, ${cov.skipped.length} skipped` : ""} · ${confirmed.length} verified, ${refuted.length} refuted, ${merged} merged, ${leads.length} unverified`
  );
  if (panel)
    out.push(
      `Directorate Seats: ${panel.seats.map((s) => seatName(s.model)).join(", ")} (memetic isolation intact)`
    );
  if (seal.question?.trim()) out.push(`Focus: ${seal.question.trim()}`);
  if (input.reasons.length)
    out.push(
      `> ${status === "complete" ? "Directive Note" : `Why ${status}`}: ${input.reasons.join("; ")}`
    );
  if (input.approach?.trim())
    out.push("", `**Approach:** ${input.approach.trim()}`);
  if (confirmed.length) {
    out.push("", "### Verified Findings");
    confirmed.forEach(({ e, sev }, i) => {
      const loc =
        e.anchor.line === e.anchor.endLine
          ? `${e.anchor.path}:${e.anchor.line}`
          : `${e.anchor.path}:${e.anchor.line}-${e.anchor.endLine}`;
      const v = e.verdicts.findLast((x) => x.verdict === "confirmed");
      const dupes = ledger.entries.filter(
        (d) =>
          d.status === "duplicate" && resolvedTarget(ledger, d)?.id === e.id
      );
      const higher = dupes.filter((d) => RANK[currentSeverity(d)] < RANK[sev]);
      const seats = panel?.raised.get(e.id);
      out.push(
        `${i + 1}. **[${SEV_LABEL[sev]}] ${e.title}** — \`${loc}\`${e.anchor.side === "old" ? " (base side)" : ""} · ${e.kind} · ${e.lens}${panel ? ` · seats ${seats?.size ?? 0}/${panel.seats.length}` : ""}`
      );
      out.push(`   - **Trigger:** ${e.trigger}`);
      out.push(`   - **Consequence:** ${e.consequence}`);
      if (e.fix) out.push(`   - **Fix:** ${e.fix}`);
      const ev = [...new Set([...(v?.evidence ?? []), ...e.evidence])].slice(
        0,
        6
      );
      out.push(
        `   - Evidence: ${ev.map((x) => `\`${x}\``).join(", ")} · raised by ${who(e.raisedBy)}, confirmed by ${v ? who(v.by) : "?"}${dupes.length ? ` · also raised by ${[...new Set(dupes.map((d) => who(d.raisedBy)))].join(", ")}` : ""}${higher.length ? ` · merged claims of higher severity (unverified): ${higher.map((d) => `${d.id} ${currentSeverity(d)}`).join(", ")}` : ""}`
      );
      if (e.brief?.trim())
        out.push(
          `   <details><summary>Technical brief</summary>\n\n${e.brief.trim()}\n\n   </details>`
        );
    });
  }
  if (leads.length) {
    out.push(
      "",
      "### Unverified Leads",
      "_Filed in the dossier but not cleared by Compliance; hypotheses, not findings._"
    );
    for (const e of leads)
      out.push(
        `- ${e.title} — \`${e.anchor.path}:${e.anchor.line}\` (${currentSeverity(e)}, ${who(e.raisedBy)}${e.staleReason ? `; ${e.staleReason}` : ""}${e.status === "duplicate" ? "; duplicate of an unconfirmed entry" : ""})`
      );
  }
  const notable = refuted.filter((e) => currentSeverity(e) !== "minor");
  if (notable.length) {
    out.push(
      "",
      "<details><summary>Refuted blocking/important candidates (cleared by Compliance)</summary>",
      ""
    );
    for (const e of notable) {
      const v = e.verdicts.findLast((x) => x.verdict === "refuted");
      out.push(
        `- ${e.title} — \`${e.anchor.path}:${e.anchor.line}\` (${currentSeverity(e)}, raised by ${who(e.raisedBy)}; refuted by ${v ? who(v.by) : "?"}: ${v?.rationale ?? ""} ${v?.evidence.map((x) => `\`${x}\``).join(", ") ?? ""})`
      );
    }
    out.push("", "</details>");
  }
  if (panel) {
    // Per seat: what it raised, how much of that was confirmed, and the confirmed findings no other seat raised.
    out.push(
      "",
      "### Directorate Seats",
      "| Seat | Review | Raised | Confirmed | Only this seat |",
      "|---|---|---|---|---|"
    );
    for (const seat of panel.seats) {
      const mine = ledger.entries.filter((e) => panel.seatOf(e) === seat.model);
      const found = confirmed.filter(({ e }) =>
        panel.raised.get(e.id)?.has(seat.model)
      );
      const only = found.filter(({ e }) => panel.raised.get(e.id)?.size === 1);
      out.push(
        `| ${seatName(seat.model)} | ${seat.status} | ${mine.length} | ${found.length} | ${only.map(({ e }) => `#${confirmed.findIndex((x) => x.e === e) + 1}`).join(" ") || "—"} |`
      );
    }
  }
  const nr: string[] = [];
  const group = (rs: readonly Region[]) =>
    [...Map.groupBy(rs, (r) => r.file)].map(
      ([f, ranges]) =>
        [
          f,
          ranges.map((r) =>
            r.newEnd ? `${r.newStart}-${r.newEnd}` : "metadata"
          ),
        ] as const
    );
  for (const [f, rs] of group(cov.unread))
    nr.push(`- \`${f}\` lines ${rs.join(", ")}: not read`);
  for (const r of cov.skimmed)
    nr.push(
      `- \`${r.file}:${r.newStart}-${r.newEnd}\` skimmed only: ${r.note ?? ""}`
    );
  for (const r of cov.skipped)
    nr.push(
      `- \`${r.file}:${r.newStart}-${r.newEnd}\` skipped: ${r.note ?? ""}`
    );
  for (const f of seal.files.filter(
    (f) => f.excluded && f.status !== "unchanged"
  ))
    nr.push(`- \`${f.path}\`: ${f.excluded}`);
  // A failed Seat is reported once, as its seat.
  const seatless = missingSeats(seal);
  for (const c of [...childOutstanding(seal), ...childFailures(seal)])
    if (!(c.model && seatless.some((s) => s.model === c.model)))
      nr.push(
        `- ${childName(c)} did not ${c.status === "failed" ? "complete" : "finish"}: ${childQuestion(c)}`
      );
  for (const s of seatless)
    nr.push(
      `- Directorate Seat ${seatName(s.model)}: ${s.status === "partial" ? `${s.unread} of ${seal.regions.length} regions unread` : s.status === "failed" ? "its review failed" : "never launched"}`
    );
  for (const n of ledger.notes.filter((n) => n.kind !== "assumption"))
    nr.push(
      `- ${n.kind === "unanswered" ? "Unanswered question" : "Limit"}: ${n.text}`
    );
  if (seal.staleFiles?.length)
    nr.push(
      `- Containment drift (changed after sealing and not re-verified): ${seal.staleFiles.map((f) => `\`${f}\``).join(", ")}`
    );
  if (seal.freshnessUnverified)
    nr.push(`- Freshness not verified: ${seal.freshnessUnverified}`);
  if (nr.length) out.push("", "### Outside Containment (Not Reviewed)", ...nr);
  const assumptions = ledger.notes.filter((n) => n.kind === "assumption");
  if (assumptions.length)
    out.push(
      "",
      "### Recorded Assumptions",
      ...assumptions.map((n) => `- ${n.text}`)
    );
  if (input.synthesis?.trim())
    out.push("", "### Synthesis", input.synthesis.trim());
  return out.join("\n");
}

type Freshness = { stale?: readonly string[]; unverified?: string };
/** Status and reasons from everything except gates. */
export function assess(
  seal: Seal,
  ledger: Ledger,
  fresh: Freshness,
  phase: Phase
): { status: Status; reasons: string[] } {
  const reasons: string[] = [];
  let status: Status = "complete";
  const partial = (why: string) => {
    if (status === "complete") status = "partial";
    reasons.push(why);
  };
  const cov = coverageSummary(seal);
  if (cov.unread.length) partial(`${cov.unread.length} regions unread`);
  if (cov.skipped.length) partial(`${cov.skipped.length} regions skipped`);
  if (cov.skimmed.length) partial(`${cov.skimmed.length} regions only skimmed`);
  const secrets = seal.files.filter(
    (f) =>
      f.status !== "unchanged" &&
      f.excluded &&
      (isSecret(f.path) || (f.oldPath !== undefined && isSecret(f.oldPath)))
  );
  if (secrets.length)
    partial(
      `${secrets.length} changed secret-like file${secrets.length === 1 ? " was" : "s were"} withheld and not reviewed`
    );
  const leads = unresolved(ledger).length;
  if (leads) partial(`${leads} leads unverified`);
  if (
    ledger.notes.some((n) => n.kind === "unanswered") ||
    childFailures(seal).length ||
    childOutstanding(seal).length
  )
    partial("some questions went unanswered");
  const seatless = missingSeats(seal);
  if (seatless.length)
    partial(
      `${seatless.length} of ${seal.panel?.length} Directorate Seats did not review ${seatless.some((s) => s.status === "partial") ? "every region" : "the target"}`
    );
  if (fresh.unverified) partial("freshness could not be verified");
  if (fresh.stale) {
    status = "stale";
    reasons.push(
      `code changed after the seal (${fresh.stale.length} ${fresh.stale.length === 1 ? "change" : "changes"})`
    );
  }
  if (phase === "locked") reasons.push("time budget ran out");
  if (seal.abandoned) partial("abandoned for a new review");
  return { status, reasons };
}

/** What changed since the seal; failures to check are reported as unverified, never raised. */
const freshness = (seal: Seal, cur: Result.Result<Current, ReviewError>) =>
  Result.match(cur, {
    onFailure: (e) => Effect.succeed<Freshness>({ unverified: e.message }),
    onSuccess: (c) =>
      c.fingerprint === seal.fingerprint
        ? Effect.succeed<Freshness>({})
        : changedSinceSeal(seal, c).pipe(
            Effect.timeoutOrElse({
              duration: 20_000,
              orElse: () =>
                failure("listing changed files timed out after 20s"),
            }),
            Effect.match({
              onSuccess: (changed): Freshness => ({
                stale: changed.length ? changed : ["(fingerprint changed)"],
              }),
              onFailure: (e): Freshness => ({
                stale: ["(changes not enumerated)"],
                unverified: e.message,
              }),
            })
          ),
  });

/**
 * Renders and saves the report; the seal is reported from then on. Caller holds the seal's lock. `cur` is the freshness
 * check the caller already ran, if any.
 */
export const finalize = Effect.fn("Directorate.finalize")(function* (
  seal: Seal,
  ledger: Ledger,
  opts: {
    approach?: string;
    synthesis?: string;
    extraReasons?: readonly string[];
    auto?: boolean;
    cur?: Result.Result<Current, ReviewError>;
  }
) {
  const { stale, unverified } = yield* freshness(
    seal,
    opts.cur ?? (yield* Effect.result(currentFingerprint(seal)))
  );
  const assessed = {
    ...seal,
    staleFiles: stale,
    freshnessUnverified: unverified,
  };
  const a = assess(
    assessed,
    ledger,
    { stale, unverified },
    budget(seal, yield* Clock.currentTimeMillis).phase
  );
  const status = opts.auto && a.status === "complete" ? "partial" : a.status;
  const md = renderReport({
    seal: assessed,
    ledger,
    status,
    approach: opts.approach,
    synthesis: opts.synthesis,
    reasons: [...a.reasons, ...(opts.extraReasons ?? [])],
  });
  const reported: Seal = {
    ...assessed,
    reportedAt: yield* DateTime.now,
    autoReported: opts.auto || undefined,
  };
  yield* (yield* Store).publish(reported, md);
  return { seal: reported, md };
});
