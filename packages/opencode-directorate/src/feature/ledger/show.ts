// What directorate_ledger_list shows: a seal's dossier entries under its header, or the repository's recent seals.
import { DateTime } from "effect";

import { coverageSummary } from "../../seal/coverage.ts";
import type { Seal } from "../../seal/record.ts";
import { actorName } from "../dispatch/lifecycle.ts";
import { currentSeverity } from "./decide.ts";
import type { Entry, Ledger } from "./entry.ts";

/** How many recent seals the index lists. */
const SEALS_LISTED = 10;

/** The repository's seals, newest first, as the index lists them: the latest reported one, then the most recent ones. */
export const sealIndex = (seals: readonly Seal[]) => {
  const recent = seals.slice(0, SEALS_LISTED);

  if (!recent.length) {
    return "No Directorate seals found for this repository.";
  }

  const [latest] = seals
    .filter((s) => s.reportedAt)
    .toSorted(
      (a, b) =>
        (b.reportedAt?.epochMilliseconds ?? 0) -
        (a.reportedAt?.epochMilliseconds ?? 0)
    );

  // Recent seals can all be unreported, so the latest reported one is named on its own.
  return [
    latest
      ? `Latest reported seal (re-check this one): \`${latest.id}\`, reported ${DateTime.formatIso(latest.reportedAt ?? latest.createdAt)}.`
      : "No reported seal for this repository.",
    "",
    ...recent.map(
      (s) =>
        `- \`${s.id}\` ${s.mode} · ${s.description} · created ${DateTime.formatIso(s.createdAt)}${s.reportedAt ? ` · reported${s.autoReported ? " automatically" : ""}` : " · unreported"}`
    ),
  ].join("\n");
};

/** A re-check's carried entry: what it was in the earlier review. */
const carried = (seal: Seal, e: Entry) =>
  e.carried
    ? ` · carried: ${e.carried.status} as ${e.carried.id} in ${seal.recheckOf}`
    : "";

/** One entry: a single line when `brief`, else its anchor, quote, claim, verdicts, and earlier verdicts. */
export const entryRow = (seal: Seal, e: Entry, brief: boolean) =>
  brief
    ? `- ${e.id} [${e.status}] ${currentSeverity(e)} · ${e.title} — ${e.anchor.path}:${e.anchor.line} · by ${actorName(seal, e.raisedBy)}${carried(seal, e)}`
    : [
        `### ${e.id} [${e.status}] ${currentSeverity(e)} ${e.kind} · ${e.lens} · ${e.title}`,
        `anchor: ${e.anchor.path}:${e.anchor.line}${e.anchor.endLine === e.anchor.line ? "" : `-${e.anchor.endLine}`} (${e.anchor.side} side) · raised by ${actorName(seal, e.raisedBy)}${carried(seal, e)}${e.staleReason ? `\nSTALE: ${e.staleReason}` : ""}`,
        `quote:\n\`\`\`\n${e.quote}\n\`\`\``,
        `trigger: ${e.trigger}`,
        `consequence: ${e.consequence}`,
        `evidence: ${e.evidence.join(", ")}`,
        e.fix ? `fix: ${e.fix}` : "",
        e.brief ? `brief: ${e.brief}` : "",
        e.verdicts.length
          ? `verdicts:\n${e.verdicts.map((v) => `- ${v.verdict}${v.severity ? ` (${v.severity})` : ""}${v.of ? ` of ${v.of}` : ""} by ${v.by.agent}: ${v.rationale} [${v.evidence.join(", ")}]`).join("\n")}`
          : "",
        e.history?.length
          ? `earlier verdicts (before the code changed): ${e.history.map((v) => `${v.verdict} by ${v.by.agent}`).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

/** The seal's header: its SHAs, coverage, notes, and whether it is reported. */
export const sealHeader = (seal: Seal, ledger: Ledger) => {
  const cov = coverageSummary(seal);

  return `seal ${seal.id} · ${seal.mode} · base ${seal.baseSha.slice(0, 12)} · head ${seal.pinsCommit ? seal.headSha.slice(0, 12) : "working tree"} · read ${cov.read}/${cov.total} · notes ${ledger.notes.length}${seal.reportedAt ? " · REPORTED" : ""}`;
};

/** The seal's header over the picked entries, or "No entries." when none is picked. */
export const ledgerShown = (
  seal: Seal,
  ledger: Ledger,
  picked: readonly Entry[],
  brief: boolean
) =>
  `${sealHeader(seal, ledger)}\n\n${picked.map((e) => entryRow(seal, e, brief)).join(brief ? "\n" : "\n\n") || "No entries."}`;
