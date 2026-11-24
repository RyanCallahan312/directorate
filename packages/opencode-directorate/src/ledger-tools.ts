// Directorate dossier (ledger) tools: candidate findings filed as they are found, verdicts from a different session, and notes.
import { DateTime, Effect, Schema } from "effect";

import { actorName } from "./children.ts";
import { checkEvidence, checkQuote } from "./content.ts";
import { coverageSummary } from "./coverage.ts";
import { failure, ReviewError } from "./error.ts";
import { Git } from "./git.ts";
import {
  currentSeverity,
  decide,
  nearby,
  unresolved,
  verdictError,
} from "./ledger.ts";
import {
  type Entry,
  EntryStatus,
  Kind,
  Lens,
  NoteKind,
  PANELIST,
  RepoPath,
  Severity,
  Side,
  VerdictKind,
} from "./model.ts";
import { Sessions } from "./session.ts";
import { Store } from "./store.ts";
import {
  actor,
  type DefineTool,
  done,
  mutate,
  optional,
  positiveInt,
  str,
  strArr,
} from "./tool.ts";

export function ledgerTools(tool: DefineTool) {
  tool({
    name: "directorate_ledger_add",
    description:
      "File a candidate finding to the dossier the moment you find it. The quote must contain at least one complete line (8+ non-space characters) of the code at the anchor on the sealed side; the anchor snaps to the nearest place it is. Evidence is path:line refs you read. Entries stay unverified until a different session clears them.",
    input: Schema.Struct({
      seal: str,
      title: str.annotate({ description: "One line: what is wrong." }),
      severity: Severity,
      kind: Kind,
      lens: Lens,
      path: RepoPath,
      line: positiveInt,
      end_line: optional(positiveInt),
      side: optional(
        Side.annotate({ description: "old = base side, for removed code" })
      ),
      quote: str.annotate({
        description: "Exact code at the anchor: at least one full line.",
      }),
      trigger: str.annotate({
        description:
          "Concrete input, state, timing, or actor that makes it happen.",
      }),
      consequence: str.annotate({
        description:
          "What goes wrong, for whom (or, for quality, the concrete benefit and tradeoff).",
      }),
      evidence: strArr
        .check(
          Schema.isMinLength(1, {
            message:
              "Rejected: add at least one evidence ref (path:line), such as the caller or guard you checked.",
          })
        )
        .annotate({
          description:
            'The deciding lines and the guards you checked. Each item is only a bare ref: path:line, path:start-end, or a URL. No side marker such as (old) (both sides are checked), and no prose or "none: searched …" (say what a search found in trigger or brief).',
        }),
      fix: optional(
        str.annotate({
          description:
            "Smallest safe correction plus the test scenario that would catch it.",
        })
      ),
      brief: optional(
        str.annotate({
          description:
            "Optional technical brief: affected sites, required outcome, approach, open questions.",
        })
      ),
    }),
    execute: function* (input, c) {
      return yield* mutate(
        c,
        input.seal,
        "directorate_ledger_add",
        function* (seal) {
          const store = yield* Store;
          if (seal.lensesOff?.includes(input.lens))
            return yield* failure(
              `Rejected: the ${input.lens} lens is disabled for this review (directorate.json). File it under the lens it also fits, or leave it.`
            );
          const raw = {
            path: input.path,
            line: input.line,
            endLine: Math.max(input.end_line ?? input.line, input.line),
            side: input.side ?? "new",
          };
          const anchor = yield* checkQuote(seal, raw, input.quote).pipe(
            Effect.mapError(
              (e) => new ReviewError({ message: `Rejected: ${e.message}` })
            )
          );
          const evidence = yield* checkEvidence(seal, input.evidence);
          const ledger = yield* store.loadLedger(seal.id);
          // Seats operate under memetic isolation: never reveal other entries' titles or ids.
          const near = c.agent === PANELIST ? [] : nearby(ledger, anchor);
          const entry: Entry = {
            id: `F${ledger.entries.length + 1}`,
            raisedBy: actor(c),
            lens: input.lens,
            title: input.title,
            severity: input.severity,
            kind: input.kind,
            anchor,
            quote: input.quote,
            trigger: input.trigger,
            consequence: input.consequence,
            evidence,
            fix: input.fix,
            brief: input.brief,
            status: "open",
            verdicts: [],
            createdAt: yield* DateTime.now,
          };
          yield* store.saveLedger(seal.id, {
            ...ledger,
            entries: [...ledger.entries, entry],
          });
          const moved =
            anchor.line !== raw.line
              ? ` Anchor moved to line ${anchor.line}, where the quote is.`
              : "";
          return yield* done(
            seal,
            `Recorded ${entry.id} (open).${moved}${near.length ? ` Nearby entries: ${near.map((e) => `${e.id} "${e.title}" (${e.status})`).join("; ")}. If it is the same root cause, say so in your handoff.` : ""}`,
            c.agent
          );
        }
      );
    },
  });

  tool({
    name: "directorate_ledger_verdict",
    description:
      "Decide a dossier (ledger) entry: confirmed (you retraced trigger → path → consequence; evidence = deciding lines), refuted (evidence = counterevidence), or duplicate (of an open or confirmed entry). directorate_liaison decides only minor entries raised by others and may withdraw its own open entries; directorate_compliance decides everything else and may re-decide. Refuting an entry reopens its duplicates. Pass path/line/quote (and side) to re-anchor a reopened entry.",
    input: Schema.Struct({
      seal: str,
      id: str,
      verdict: VerdictKind,
      rationale: str,
      evidence: strArr.annotate({
        description:
          'The deciding lines (or counterevidence). Each item is only a bare ref: path:line, path:start-end, or a URL. No side marker such as (old) (both sides are checked), and no prose or "none: searched …" (put those in rationale).',
      }),
      of: optional(
        str.annotate({ description: "For duplicate: the entry id it repeats." })
      ),
      severity: optional(
        Severity.annotate({
          description: "Verified severity when confirming (Compliance).",
        })
      ),
      path: optional(RepoPath),
      line: optional(positiveInt),
      end_line: optional(positiveInt),
      side: optional(Side),
      quote: optional(str),
    }),
    execute: function* (input, c) {
      return yield* mutate(
        c,
        input.seal,
        "directorate_ledger_verdict",
        function* (seal) {
          const store = yield* Store;
          const ledger = yield* store.loadLedger(seal.id);
          const entry = ledger.entries.find((e) => e.id === input.id);
          if (!entry) return yield* failure(`No entry ${input.id}.`);
          const by = actor(c);
          const err = verdictError(
            entry,
            by,
            {
              verdict: input.verdict,
              evidence: input.evidence,
              of: input.of,
              severity: input.severity,
            },
            ledger
          );
          if (err) return yield* failure(err);
          const evidence = yield* checkEvidence(seal, input.evidence);
          // A confirmation pins the entry to the sealed code, re-anchored if the verdict names a new place.
          const want =
            input.path || input.line || input.side
              ? {
                  path: input.path ?? entry.anchor.path,
                  line: input.line ?? entry.anchor.line,
                  endLine: Math.max(
                    input.end_line ?? input.line ?? entry.anchor.endLine,
                    input.line ?? entry.anchor.line
                  ),
                  side: input.side ?? entry.anchor.side,
                }
              : entry.anchor;
          const quote = input.quote ?? entry.quote;
          const anchored =
            input.verdict !== "confirmed"
              ? {}
              : {
                  anchor: yield* checkQuote(seal, want, quote).pipe(
                    Effect.mapError(
                      (e) =>
                        new ReviewError({
                          message: `Cannot confirm: the anchor does not match the sealed code (${e.message}). Re-anchor with path/line/quote, or refute.`,
                        })
                    )
                  ),
                  quote,
                };
          const verdict = {
            by,
            verdict: input.verdict,
            rationale: input.rationale,
            evidence,
            of: input.of,
            severity:
              input.verdict === "confirmed"
                ? (input.severity ?? currentSeverity(entry))
                : undefined,
            at: yield* DateTime.now,
          };
          const { ledger: next, reopened } = decide(ledger, {
            ...entry,
            ...anchored,
            verdicts: [...entry.verdicts, verdict],
            status: input.verdict,
            staleReason: undefined,
          });
          yield* store.saveLedger(seal.id, next);
          return yield* done(
            seal,
            `${entry.id} → ${input.verdict}.${reopened.length ? ` Reopened its duplicates: ${reopened.join(" ")}.` : ""} ${unresolved(next).length} entries still unresolved.`,
            by.agent
          );
        }
      );
    },
  });

  tool({
    name: "directorate_ledger_list",
    description:
      "Show dossier (ledger) entries (optionally by status or ids; brief = one line each), with the seal's SHAs, coverage, and budget. Without a seal, lists recent seals for this repository so an interrupted review can be resumed (directorate_seal resume) or reported.",
    input: Schema.Struct({
      seal: optional(str),
      status: optional(EntryStatus),
      ids: optional(strArr),
      brief: optional(Schema.Boolean),
    }),
    execute: function* (input, c) {
      const store = yield* Store;
      const sessions = yield* Sessions;
      if (!input.seal) {
        const dir = yield* sessions.directory(c.sessionID);
        const repo = dir
          ? yield* (yield* Git)
              .root(dir)
              .pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
        const seals = yield* store.list({ repo, limit: 10 });
        if (!seals.length)
          return { content: "No Directorate seals found for this repository." };
        return {
          content: seals
            .map(
              (s) =>
                `- \`${s.id}\` ${s.mode} · ${s.description} · created ${DateTime.formatIso(s.createdAt)}${s.reportedAt ? ` · reported${s.autoReported ? " automatically" : ""}` : " · unreported"}`
            )
            .join("\n"),
        };
      }
      const seal = yield* sessions.sealFor(c.sessionID, input.seal);
      const ledger = yield* store.loadLedger(seal.id);
      const pick = ledger.entries.filter(
        (e) =>
          (!input.status || e.status === input.status) &&
          (!input.ids?.length || input.ids.includes(e.id))
      );
      const rows = input.brief
        ? pick.map(
            (e) =>
              `- ${e.id} [${e.status}] ${currentSeverity(e)} · ${e.title} — ${e.anchor.path}:${e.anchor.line} · by ${actorName(seal, e.raisedBy)}`
          )
        : pick.map((e) =>
            [
              `### ${e.id} [${e.status}] ${currentSeverity(e)} ${e.kind} · ${e.lens} · ${e.title}`,
              `anchor: ${e.anchor.path}:${e.anchor.line}${e.anchor.endLine !== e.anchor.line ? `-${e.anchor.endLine}` : ""} (${e.anchor.side} side) · raised by ${actorName(seal, e.raisedBy)}${e.staleReason ? `\nSTALE: ${e.staleReason}` : ""}`,
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
              .join("\n")
          );
      const cov = coverageSummary(seal);
      const head = `seal ${seal.id} · ${seal.mode} · base ${seal.baseSha.slice(0, 12)} · head ${seal.postImage === "commit" ? seal.headSha.slice(0, 12) : "working tree"} · read ${cov.read}/${cov.total} · notes ${ledger.notes.length}${seal.reportedAt ? " · REPORTED" : ""}`;
      return yield* done(
        seal,
        `${head}\n\n${rows.join(input.brief ? "\n" : "\n\n") || "No entries."}`,
        c.agent
      );
    },
  });

  tool({
    name: "directorate_note",
    description:
      "Record a coverage limit, an unanswered question (such as an Auditor that failed twice, or a candidate you could not anchor), or an assumption. Limits and unanswered questions render under Outside Containment (Not Reviewed); unanswered questions make the report partial.",
    input: Schema.Struct({ seal: str, kind: NoteKind, text: str }),
    execute: function* (input, c) {
      return yield* mutate(c, input.seal, "directorate_note", function* (seal) {
        const store = yield* Store;
        const ledger = yield* store.loadLedger(seal.id);
        yield* store.saveLedger(seal.id, {
          ...ledger,
          notes: [
            ...ledger.notes,
            {
              kind: input.kind,
              text: input.text,
              by: actor(c),
              at: yield* DateTime.now,
            },
          ],
        });
        return yield* done(seal, `Noted (${input.kind}).`, c.agent);
      });
    },
  });
}
