// Directorate dossier (ledger) tools: candidate findings filed as they are found, verdicts from a different session, and notes.
import { DateTime, Effect, Function, Schema } from "effect";
import type { FileSystem, Path } from "effect";

import {
  actor,
  Git,
  Host,
  optional,
  positiveInt,
  str,
  strArr,
} from "../../platform/platform.ts";
import type { DefineTool } from "../../platform/platform.ts";
import { Records } from "../../records/records.ts";
import { coverageSummary } from "../../seal/coverage.ts";
import { SideSchema } from "../../seal/region.ts";
import {
  RepoPath,
  Sessions,
  checkEvidence,
  checkQuote,
  done,
  ToolCall,
} from "../../seal/seal.ts";
import { Auditor, Compliance, Liaison, Seat } from "../agents/agent.ts";
import {
  actorName,
  failedDispatches,
  dispatchQuestion,
  questionText,
} from "../dispatch/lifecycle.ts";
import {
  currentSeverity,
  decide,
  nearby,
  unresolved,
  verdictError,
  VerdictRefused,
} from "./decide.ts";
import {
  Entry,
  EntryStatusSchema,
  isAnswered,
  isConfirming,
  KindSchema,
  LensSchema,
  Note,
  NoteKindSchema,
  SeveritySchema,
  Verdict,
  VerdictKindSchema,
} from "./entry.ts";

/** A candidate the dossier does not take: a disabled lens, or an anchor or quote that does not tie to the sealed code. */
class EntryRejected extends Schema.TaggedError<
  EntryRejected,
  { readonly brand: unique symbol }
>()("EntryRejected", { reason: Schema.String }) {
  override get message() {
    return `Rejected: ${this.reason}`;
  }
}

/** No entry by that id in the dossier. */
class NoEntry extends Schema.TaggedError<
  NoEntry,
  { readonly brand: unique symbol }
>()("NoEntry", { id: Schema.String }) {
  override get message() {
    return `No entry ${this.id}.`;
  }
}

/** A note the caller may not record: an answered question only the Liaison records, for a question a failed Auditor asked. */
class NoteRefused extends Schema.TaggedError<
  NoteRefused,
  { readonly brand: unique symbol }
>()("NoteRefused", { message: Schema.String }) {}

export const ledgerTools = (
  tool: DefineTool<
    Sessions | Records | Git | Host | FileSystem.FileSystem | Path.Path
  >
) => {
  tool({
    description:
      "File a candidate finding to the dossier the moment you find it. The quote must contain at least one complete line (8+ non-space characters) of the code at the anchor on the sealed side; the anchor snaps to the nearest place it is. Evidence is path:line refs you read. Entries stay unverified until a different session clears them.",
    *execute(input, c) {
      const by = actor(c);

      return yield* (yield* Sessions).mutate(
        input.seal,
        ToolCall.make({ actor: by, tool: "directorate_ledger_add" }),
        (review) =>
          Effect.gen(function* execute() {
            const { seal } = review;

            if (seal.lensesOff?.includes(input.lens)) {
              return yield* new EntryRejected({
                reason: `the ${input.lens} lens is disabled for this review (directorate.json). File it under the lens it also fits, or leave it.`,
              });
            }

            const raw = {
              endLine: input.line,
              line: input.line,
              path: input.path,
              side: input.side ?? "new",
            };

            const anchor = yield* checkQuote(seal, raw, input.quote).pipe(
              Effect.mapError((e) => new EntryRejected({ reason: e.message }))
            );

            const evidence = yield* checkEvidence(seal, input.evidence);
            const ledger = yield* review.ledger;
            // Seats operate under memetic isolation: never reveal other entries' titles or ids.
            const near = by.role === Seat ? [] : nearby(ledger, anchor);

            const entry = Entry.make({
              anchor,
              brief: input.brief,
              consequence: input.consequence,
              createdAt: yield* DateTime.now,
              evidence,
              fix: input.fix,
              id: ledger.nextEntryId,
              kind: input.kind,
              lens: input.lens,
              quote: input.quote,
              raisedBy: by,
              severity: input.severity,
              status: "open",
              title: input.title,
              trigger: input.trigger,
              verdicts: [],
            });

            const moved =
              anchor.line === raw.line
                ? ""
                : ` Anchor moved to line ${anchor.line}, where the quote is.`;

            return {
              ledger: ledger.filed(entry),
              out: yield* done(
                seal,
                `Recorded ${entry.id} (open).${moved}${near.length ? ` Nearby entries: ${near.map((e) => `${e.id} "${e.title}" (${e.status})`).join("; ")}. If it is the same root cause, say so in your handoff.` : ""}`,
                by
              ),
            };
          })
      );
    },
    input: Schema.Struct({
      brief: optional(
        str.annotate({
          description:
            "Optional technical brief: affected sites, required outcome, approach, open questions.",
        })
      ),
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
      kind: KindSchema,
      lens: LensSchema,
      line: positiveInt,
      path: RepoPath,
      quote: str.annotate({
        description: "Exact code at the anchor: at least one full line.",
      }),
      seal: str,
      severity: SeveritySchema,
      side: optional(
        SideSchema.annotate({
          description: "old = base side, for removed code",
        })
      ),
      title: str.annotate({ description: "One line: what is wrong." }),
      trigger: str.annotate({
        description:
          "Concrete input, state, timing, or actor that makes it happen.",
      }),
    }),
    lockdown: [Auditor, Seat],
    name: "directorate_ledger_add",
  });

  tool({
    description: `Decide a dossier (ledger) entry: confirmed (you retraced trigger → path → consequence; evidence = deciding lines), refuted (evidence = counterevidence), duplicate (of an open or confirmed entry), or, in a re-check, resolved (a finding carried from the earlier review no longer holds; evidence = the lines that fix it). ${Liaison.id} decides only minor entries raised by others and may withdraw its own open entries; ${Compliance.id} decides everything else, including every carried verified finding, and may re-decide. Refuting or resolving an entry reopens its duplicates. Pass path/line/quote (and side) to re-anchor a reopened entry.`,
    *execute(input, c) {
      const by = actor(c);

      return yield* (yield* Sessions).mutate(
        input.seal,
        ToolCall.make({ actor: by, tool: "directorate_ledger_verdict" }),
        (review) =>
          Effect.gen(function* execute() {
            const { seal } = review;
            const ledger = yield* review.ledger;
            const entry = ledger.entryById(input.id);

            if (!entry) {
              return yield* new NoEntry({ id: input.id });
            }

            const err = verdictError(
              entry,
              by,
              {
                evidence: input.evidence,
                of: input.of,
                severity: input.severity,
                verdict: input.verdict,
              },
              ledger
            );

            if (err) {
              return yield* new VerdictRefused({ message: err });
            }

            const evidence = yield* checkEvidence(seal, input.evidence);

            // A confirmation pins the entry to the sealed code, re-anchored if the verdict names a new place.
            const want =
              input.path || input.line || input.side
                ? {
                    endLine: input.line ?? entry.anchor.endLine,
                    line: input.line ?? entry.anchor.line,
                    path: input.path ?? entry.anchor.path,
                    side: input.side ?? entry.anchor.side,
                  }
                : entry.anchor;

            const quote = input.quote ?? entry.quote;

            const anchored = isConfirming(input.verdict)
              ? {
                  anchor: yield* checkQuote(seal, want, quote).pipe(
                    Effect.mapError(
                      (e) =>
                        new VerdictRefused({
                          message: `Cannot confirm: the anchor does not match the sealed code (${e.message}). Re-anchor with path/line/quote, or refute.`,
                        })
                    )
                  ),
                  quote,
                }
              : undefined;

            const verdict = Verdict.make({
              at: yield* DateTime.now,
              by,
              evidence,
              of: input.of,
              rationale: input.rationale,
              severity: isConfirming(input.verdict)
                ? (input.severity ?? currentSeverity(entry))
                : undefined,
              verdict: input.verdict,
            });

            const { ledger: next, reopened } = decide(
              ledger,
              entry.decided(verdict, anchored)
            );

            return {
              ledger: next,
              out: yield* done(
                seal,
                `${entry.id} → ${input.verdict}.${reopened.length ? ` Reopened its duplicates: ${reopened.join(" ")}.` : ""} ${unresolved(next).length} entries still unresolved.`,
                by
              ),
            };
          })
      );
    },
    input: Schema.Struct({
      evidence: strArr.annotate({
        description:
          'The deciding lines (or counterevidence). Each item is only a bare ref: path:line, path:start-end, or a URL. No side marker such as (old) (both sides are checked), and no prose or "none: searched …" (put those in rationale).',
      }),
      id: str,
      line: optional(positiveInt),
      of: optional(
        str.annotate({ description: "For duplicate: the entry id it repeats." })
      ),
      path: optional(RepoPath),
      quote: optional(str),
      rationale: str,
      seal: str,
      severity: optional(
        SeveritySchema.annotate({
          description: "Verified severity when confirming (Compliance).",
        })
      ),
      side: optional(SideSchema),
      verdict: VerdictKindSchema,
    }),
    lockdown: [Compliance],
    name: "directorate_ledger_verdict",
  });

  tool({
    description:
      "Show dossier (ledger) entries (optionally by status or ids; brief = one line each), with the seal's SHAs, coverage, and budget. Without a seal, lists recent seals for this repository so an interrupted review can be resumed (directorate_seal resume) or reported.",
    *execute(input, c) {
      const store = yield* Records;
      const sessions = yield* Sessions;

      if (!input.seal) {
        const dir =
          (yield* sessions.directory(c.sessionID)) ??
          (yield* Host).location.directory;

        const repo = yield* (yield* Git)
          .root(dir)
          .pipe(Effect.orElseSucceed(Function.constUndefined));

        const all = repo ? yield* store.list({ repo }) : [];
        const seals = all.slice(0, 10);

        const [latest] = all
          .filter((s) => s.reportedAt)
          .toSorted(
            (a, b) =>
              (b.reportedAt?.epochMilliseconds ?? 0) -
              (a.reportedAt?.epochMilliseconds ?? 0)
          );

        if (!seals.length) {
          return { content: "No Directorate seals found for this repository." };
        }

        // Recent seals can all be unreported, so the latest reported one is named on its own.
        return {
          content: [
            latest
              ? `Latest reported seal (re-check this one): \`${latest.id}\`, reported ${DateTime.formatIso(latest.reportedAt ?? latest.createdAt)}.`
              : "No reported seal for this repository.",
            "",
            ...seals.map(
              (s) =>
                `- \`${s.id}\` ${s.mode} · ${s.description} · created ${DateTime.formatIso(s.createdAt)}${s.reportedAt ? ` · reported${s.autoReported ? " automatically" : ""}` : " · unreported"}`
            ),
          ].join("\n"),
        };
      }

      const seal = yield* sessions.sealFor(c.sessionID, input.seal);
      const ledger = yield* store.loadLedger(seal.id);

      const pick = ledger.entries.filter(
        (e) =>
          (!input.status || e.status === input.status) &&
          (!input.ids?.length || input.ids.includes(e.id))
      );

      /** A re-check's carried entry: what it was in the earlier review. */
      const carried = (e: Entry) =>
        e.carried
          ? ` · carried: ${e.carried.status} as ${e.carried.id} in ${seal.recheckOf}`
          : "";

      const rows = input.brief
        ? pick.map(
            (e) =>
              `- ${e.id} [${e.status}] ${currentSeverity(e)} · ${e.title} — ${e.anchor.path}:${e.anchor.line} · by ${actorName(seal, e.raisedBy)}${carried(e)}`
          )
        : pick.map((e) =>
            [
              `### ${e.id} [${e.status}] ${currentSeverity(e)} ${e.kind} · ${e.lens} · ${e.title}`,
              `anchor: ${e.anchor.path}:${e.anchor.line}${e.anchor.endLine === e.anchor.line ? "" : `-${e.anchor.endLine}`} (${e.anchor.side} side) · raised by ${actorName(seal, e.raisedBy)}${carried(e)}${e.staleReason ? `\nSTALE: ${e.staleReason}` : ""}`,
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
      const head = `seal ${seal.id} · ${seal.mode} · base ${seal.baseSha.slice(0, 12)} · head ${seal.pinsCommit ? seal.headSha.slice(0, 12) : "working tree"} · read ${cov.read}/${cov.total} · notes ${ledger.notes.length}${seal.reportedAt ? " · REPORTED" : ""}`;

      return yield* done(
        seal,
        `${head}\n\n${rows.join(input.brief ? "\n" : "\n\n") || "No entries."}`,
        actor(c)
      );
    },
    input: Schema.Struct({
      brief: optional(Schema.Boolean),
      ids: optional(strArr),
      seal: optional(str),
      status: optional(EntryStatusSchema),
    }),
    lockdown: [Liaison, Compliance],
    name: "directorate_ledger_list",
  });

  tool({
    description: `Record a coverage limit, an unanswered question (such as an Auditor that failed twice, or a candidate you could not anchor), or an assumption. Limits and unanswered questions render under Outside Containment (Not Reviewed); unanswered questions make the report partial. ${Liaison.id} only: kind answered, with text = a failed Auditor's question: line verbatim, records that you answered it yourself, so it no longer counts as unanswered.`,
    *execute(input, c) {
      const by = actor(c);

      return yield* (yield* Sessions).mutate(
        input.seal,
        ToolCall.make({ actor: by, tool: "directorate_note" }),
        (review) =>
          Effect.gen(function* execute() {
            const { seal } = review;
            const ledger = yield* review.ledger;
            let { text } = input;

            if (isAnswered(input.kind)) {
              if (by.role !== Liaison) {
                return yield* new NoteRefused({
                  message: `Only ${Liaison.id} records an answered question.`,
                });
              }

              text = questionText(input.text);

              const failed = failedDispatches(seal, ledger)
                .filter((x) => x.agent === Auditor.id)
                .map(dispatchQuestion);

              if (!failed.includes(text)) {
                return yield* new NoteRefused({
                  message: failed.length
                    ? `No failed Auditor asked "${text}". Pass one of these question lines verbatim: ${failed.map((q) => `"${q}"`).join("; ")}.`
                    : "No failed Auditor question is unanswered.",
                });
              }
            }

            return {
              ledger: ledger.noted(
                Note.make({
                  at: yield* DateTime.now,
                  by,
                  kind: input.kind,
                  text,
                })
              ),
              out: yield* done(seal, `Noted (${input.kind}).`, by),
            };
          })
      );
    },
    input: Schema.Struct({ kind: NoteKindSchema, seal: str, text: str }),
    lockdown: [Liaison, Auditor, Seat],
    name: "directorate_note",
  });
};
