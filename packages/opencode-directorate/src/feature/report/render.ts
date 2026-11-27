// The Directive as markdown: rendered from verified dossier entries only.
import { Match, Schema } from "effect";

import { coverageSummary } from "../../seal/coverage.ts";
import { Seal } from "../../seal/record.ts";
import { isBaseSide } from "../../seal/region.ts";
import type { Region } from "../../seal/region.ts";
import { Seat as SeatAgent } from "../agents/agent.ts";
import type { Actor } from "../agents/agent.ts";
import {
  actorName,
  failedDispatches,
  dispatchName,
  outstandingDispatches,
  dispatchQuestion,
  isFailed,
  missingSeats,
  panelSeats,
  seatName,
} from "../dispatch/lifecycle.ts";
import {
  currentSeverity,
  RANK,
  resolvedTarget,
  unresolved,
} from "../ledger/decide.ts";
import {
  isConfirming,
  isMinor,
  isRefuting,
  isResolving,
  Ledger,
  SeveritySchema,
} from "../ledger/entry.ts";
import type { Entry, EntryId, Severity, Verdict } from "../ledger/entry.ts";
import { DirectiveStatusSchema, isComplete } from "./directive.ts";
import type { DirectiveStatus } from "./directive.ts";

const SEV_LABEL = Schema.Record(SeveritySchema, Schema.String).make({
  blocking: "Blocking",
  important: "Important",
  minor: "Minor",
});

/**
 * Each entry's root (itself, or the entry a duplicate finally points at; undefined for a cycle or a missing target), and
 * each root's duplicates by the root's id, in ledger order.
 */
const rootsOf = (ledger: Ledger) => {
  const root = new Map(
    ledger.entries.map((e) => [e, resolvedTarget(ledger, e)] as const)
  );

  const duplicates = Map.groupBy(
    ledger.entries.filter((e) => e.isDuplicate),
    (d) => root.get(d)?.id
  );

  return { duplicates, root };
};

type Roots = ReturnType<typeof rootsOf>;

/** For each confirmed entry, the panel seats that raised it or a duplicate of it. */
const seatsRaising = (seal: Seal, ledger: Ledger, roots: Roots) => {
  const seats = panelSeats(seal);

  const seatOf = (e: Entry) =>
    seats.find((s) => s.sessions.has(e.raisedBy.session))?.model;

  const raised = new Map<EntryId, Set<string>>();

  for (const e of ledger.entries) {
    const root = roots.root.get(e);
    const seat = seatOf(e);

    if (root && seat) {
      raised.set(root.id, (raised.get(root.id) ?? new Set()).add(seat));
    }
  }

  return { raised, seatOf, seats };
};

const verdicts = Schema.Record(SeveritySchema, Schema.String).make({
  blocking: "<Hold/Blocking — Do Not Merge>",
  important: "<Changes Required/Remediation Needed>",
  minor: "<Minor Revisions/Tolerated with Notes>",
});

const directiveVerdict = (
  top: Severity | undefined,
  status: DirectiveStatus,
  resolved: number
) => {
  if (top) {
    return verdicts[top];
  }

  if (!isComplete(status)) {
    return "<Provisional/Incomplete> — No Confirmed Issues";
  }

  return resolved
    ? "<Approved/Tolerated> — Prior Findings Resolved"
    : "<Approved/Tolerated> — No Anomalies Verified";
};

const findingOrder = (a: Finding, b: Finding) =>
  RANK[a.sev] - RANK[b.sev] ||
  a.e.anchor.path.localeCompare(b.e.anchor.path) ||
  a.e.anchor.line - b.e.anchor.line;

const origin = (entry: Entry, recheckOf: string | undefined): string => {
  if (!recheckOf) {
    return "";
  }

  if (!entry.carried) {
    return " · new";
  }

  const label = entry.carried.wasVerified
    ? "still present"
    : "previously unverified";

  return ` · ${label} (${entry.carried.id} in \`${recheckOf}\`)`;
};

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

/** How many files one coverage line lists before the rest are counted. */
const FILES_PER_NOTE = 20;

/** One line per distinct note: a bulk disposition's note once, then the files and line ranges it covers. */
const byNote = (label: string, rs: readonly Region[]) =>
  [...Map.groupBy(rs, (r) => r.note ?? "")].map(([note, regions]) => {
    const files = group(regions);

    const listed = files
      .slice(0, FILES_PER_NOTE)
      .map(([f, ranges]) => `\`${f}\` lines ${ranges.join(", ")}`);

    const more = files.length - listed.length;

    return `- ${label}${note ? `: ${note}` : ""} — ${listed.join("; ")}${more ? `; and ${more} more files` : ""}`;
  });

const outsideContainment = (
  seal: Seal,
  ledger: Ledger,
  cov: ReturnType<typeof coverageSummary>
) => {
  const nr: string[] = [];

  for (const [f, rs] of group(cov.unread)) {
    nr.push(`- \`${f}\` lines ${rs.join(", ")}: not read`);
  }

  nr.push(
    ...byNote("skimmed only", cov.skimmed),
    ...byNote("skipped", cov.skipped)
  );

  for (const f of seal.files.filter(
    (file) => file.excluded && file.isChanged
  )) {
    nr.push(`- \`${f.path}\`: ${f.excluded}`);
  }

  // A failed Seat is reported once, as its seat.
  const seatless = missingSeats(seal);

  for (const c of [
    ...outstandingDispatches(seal),
    ...failedDispatches(seal, ledger),
  ]) {
    if (!seatless.some((s) => s.runs.includes(c))) {
      nr.push(
        `- ${dispatchName(c)} did not ${isFailed(c) ? "complete" : "finish"}: ${dispatchQuestion(c)}`
      );
    }
  }

  for (const s of seatless) {
    const explanation = Match.value(s.status).pipe(
      Match.when(
        "partial",
        () => `${s.unread} of ${seal.regions.length} regions unread`
      ),
      Match.when("failed", () => "its review failed"),
      Match.whenOr(
        "not launched",
        "launching",
        "running",
        "completed",
        () => "never launched"
      ),
      Match.exhaustive
    );

    nr.push(`- ${SeatAgent.title} ${seatName(s.model)}: ${explanation}`);
  }

  for (const n of ledger.notes.filter((note) => note.isNotReviewed)) {
    nr.push(`- ${n.isUnanswered ? "Unanswered question" : "Limit"}: ${n.text}`);
  }

  if (seal.staleFiles?.length) {
    nr.push(
      `- Containment drift (changed after sealing and not re-verified): ${seal.staleFiles.map((f) => `\`${f}\``).join(", ")}`
    );
  }

  if (seal.freshnessUnverified) {
    nr.push(`- Freshness not verified: ${seal.freshnessUnverified}`);
  }

  return nr;
};

/** A confirmed entry and the severity it was confirmed at. */
const finding = (e: Entry) => ({ e, sev: currentSeverity(e) });

type Finding = ReturnType<typeof finding>;

type Panel = ReturnType<typeof seatsRaising>;

/** How the report names whoever raised or decided an entry. */
type Who = (actor: Actor) => string;

/** Who decided an entry and on what: "<who>: <rationale> <evidence>", or "?" for who when no verdict decided it. */
const decision = (who: Who, v: Verdict | undefined) =>
  `${v ? who(v.by) : "?"}: ${v?.rationale ?? ""} ${v?.evidence.map((x) => `\`${x}\``).join(", ") ?? ""}`.trimEnd();

const renderFindings = (
  seal: Seal,
  who: Who,
  roots: Roots,
  confirmed: readonly Finding[],
  panel: Panel | undefined
) => {
  const out: string[] = [];

  if (confirmed.length) {
    out.push("", "### Verified Findings");

    for (const [i, { e, sev }] of confirmed.entries()) {
      const loc =
        e.anchor.line === e.anchor.endLine
          ? `${e.anchor.path}:${e.anchor.line}`
          : `${e.anchor.path}:${e.anchor.line}-${e.anchor.endLine}`;

      const v = e.verdicts.findLast((x) => isConfirming(x.verdict));

      const dupes = roots.duplicates.get(e.id) ?? [];

      const higher = dupes.filter((d) => RANK[currentSeverity(d)] < RANK[sev]);
      const seats = panel?.raised.get(e.id);
      const marker = `${i + 1}. `;
      const indent = " ".repeat(marker.length);
      out.push(
        `${marker}**[${SEV_LABEL[sev]}] ${e.title}** — \`${loc}\`${isBaseSide(e.anchor.side) ? " (base side)" : ""} · ${e.kind} · ${e.lens}${panel ? ` · seats ${seats?.size ?? 0}/${panel.seats.length}` : ""}${origin(e, seal.recheckOf)}`,
        `${indent}- **Trigger:** ${e.trigger}`,
        `${indent}- **Consequence:** ${e.consequence}`
      );

      if (e.fix) {
        out.push(`${indent}- **Fix:** ${e.fix}`);
      }

      const ev = [...new Set([...(v?.evidence ?? []), ...e.evidence])].slice(
        0,
        6
      );

      out.push(
        `${indent}- Evidence: ${ev.map((x) => `\`${x}\``).join(", ")} · raised by ${who(e.raisedBy)}, confirmed by ${v ? who(v.by) : "?"}${dupes.length ? ` · also raised by ${[...new Set(dupes.map((d) => who(d.raisedBy)))].join(", ")}` : ""}${higher.length ? ` · merged claims of higher severity (unverified): ${higher.map((d) => `${d.id} ${currentSeverity(d)}`).join(", ")}` : ""}`
      );
      const brief = e.brief?.trim();

      if (brief) {
        out.push(
          `${indent}- **Technical brief:**`,
          "",
          ...brief
            .split(/\r?\n/u)
            .map((line) => (line.trim() ? `${indent}  ${line}` : "")),
          ""
        );
      }
    }
  }

  return out;
};

const renderRefuted = (who: Who, refuted: readonly Entry[]) => {
  const out: string[] = [];
  const notable = refuted.filter((e) => !isMinor(currentSeverity(e)));

  if (notable.length) {
    out.push(
      "",
      "### Refuted blocking/important candidates (cleared by Compliance)",
      ""
    );

    for (const e of notable) {
      const v = e.verdicts.findLast((x) => isRefuting(x.verdict));
      out.push(
        `- ${e.title} — \`${e.anchor.path}:${e.anchor.line}\` (${currentSeverity(e)}, raised by ${who(e.raisedBy)}; refuted by ${decision(who, v)})`
      );
    }
  }

  return out;
};

const renderCandidates = (
  seal: Seal,
  who: Who,
  resolved: readonly Entry[],
  leads: readonly Entry[]
) => {
  const out: string[] = [];

  if (resolved.length) {
    out.push("", `### Resolved Since \`${seal.recheckOf}\``);

    for (const e of resolved) {
      const v = e.verdicts.findLast((x) => isResolving(x.verdict));
      out.push(
        `- ${e.title} — was \`${e.anchor.path}:${e.anchor.line}\` (${currentSeverity(e)}, ${e.carried?.id}${e.carried && !e.carried.wasVerified ? ", previously unverified" : ""}); resolved by ${decision(who, v)}`
      );
    }
  }

  if (leads.length) {
    out.push(
      "",
      "### Unverified Leads",
      "_Filed in the dossier but not cleared by Compliance; hypotheses, not findings._"
    );

    for (const e of leads) {
      const stale = e.staleReason ? `; ${e.staleReason}` : "";

      const prior = e.carried
        ? `; ${e.carried.wasVerified ? "verified" : "unverified"} as ${e.carried.id} in \`${seal.recheckOf}\`, not re-checked`
        : stale;

      const duplicate = e.isDuplicate
        ? "; duplicate of an unconfirmed entry"
        : "";

      out.push(
        `- ${e.title} — \`${e.anchor.path}:${e.anchor.line}\` (${currentSeverity(e)}, ${who(e.raisedBy)}${prior}${duplicate})`
      );
    }
  }

  return out;
};

const renderSeats = (
  ledger: Ledger,
  confirmed: readonly Finding[],
  panel: Panel | undefined
) => {
  const out: string[] = [];

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

  return out;
};

const withSynthesis = (lines: string[], synthesis: string | undefined) => {
  const text = synthesis?.trim();

  if (text) {
    lines.push("", "### Synthesis", text);
  }

  return lines;
};

/** What a Directive renders from: the reported seal and its dossier, the Directive's status and reasons, and the Liaison's prose. */
export const ReportSchema = Schema.Struct({
  approach: Schema.optional(Schema.String),
  ledger: Ledger,
  reasons: Schema.Array(Schema.String),
  seal: Seal,
  status: DirectiveStatusSchema,
  synthesis: Schema.optional(Schema.String),
});

export const renderReport = (input: typeof ReportSchema.Type): string => {
  const { seal, ledger, status } = input;

  const confirmed = ledger.entries
    .filter((e) => e.isConfirmed)
    .map(finding)
    .toSorted(findingOrder);

  const leads = unresolved(ledger);
  const refuted = ledger.entries.filter((e) => e.isRefuted);
  const resolved = ledger.entries.filter((e) => e.isResolved);

  const merged =
    ledger.entries.filter((e) => e.isDuplicate).length -
    leads.filter((e) => e.isDuplicate).length;

  const verdict = directiveVerdict(confirmed[0]?.sev, status, resolved.length);

  const cov = coverageSummary(seal);
  const roots = rootsOf(ledger);
  const who = (actor: Actor) => actorName(seal, actor);

  const panel = seal.panel?.length
    ? seatsRaising(seal, ledger, roots)
    : undefined;

  const out = [
    `**Directorate Directive: ${verdict}** · status: **${status}** · mode: ${seal.mode}`,
    `Containment: ${seal.description} · seal \`${seal.id}\`${seal.recheckOf ? ` · re-check of \`${seal.recheckOf}\`` : ""} · fingerprint \`${seal.fingerprint.slice(0, 12)}\`${seal.refreshes ? ` · re-contained ${seal.refreshes}×` : ""} · regions ${cov.read}/${cov.total} observed${cov.assessed ? ` (${cov.assessed} by disposition)` : ""}${cov.skimmed.length ? `, ${cov.skimmed.length} skimmed` : ""}${cov.skipped.length ? `, ${cov.skipped.length} skipped` : ""} · ${confirmed.length} verified${seal.recheckOf ? `, ${resolved.length} resolved` : ""}, ${refuted.length} refuted, ${merged} merged, ${leads.length} unverified`,
  ];

  if (panel) {
    out.push(
      `Directorate Seats: ${panel.seats.map((s) => seatName(s.model)).join(", ")} (memetic isolation intact)`
    );
  }

  const question = (seal.question ?? "").trim();

  if (question) {
    out.push(`Focus: ${question}`);
  }

  if (input.reasons.length) {
    out.push(
      `> ${isComplete(status) ? "Directive Note" : `Why ${status}`}: ${input.reasons.join("; ")}`
    );
  }

  if (input.approach?.trim()) {
    out.push("", `**Approach:** ${input.approach.trim()}`);
  }

  out.push(
    ...renderFindings(seal, who, roots, confirmed, panel),
    ...renderCandidates(seal, who, resolved, leads),
    ...renderRefuted(who, refuted),
    ...renderSeats(ledger, confirmed, panel)
  );

  const nr = outsideContainment(seal, ledger, cov);

  if (nr.length) {
    out.push("", "### Outside Containment (Not Reviewed)", ...nr);
  }

  const assumptions = ledger.notes.filter((n) => n.isAssumption);

  if (assumptions.length) {
    out.push(
      "",
      "### Recorded Assumptions",
      ...assumptions.map((n) => `- ${n.text}`)
    );
  }

  return [
    ...withSynthesis(out, input.synthesis),
    "",
    `Export this review: \`/directorate-export ${seal.id}\` (unredacted).`,
  ].join("\n");
};
