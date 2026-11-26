// Directorate reading tools: how the Liaison, Auditors, Seats, and Compliance read the sealed code, and how the Liaison accounts for what it did not.
import { Effect, Schema } from "effect";
import type { FileSystem, Path } from "effect";

import {
  actor,
  optional,
  positiveInt,
  str,
  strArr,
} from "../platform/platform.ts";
import type { DefineTool, Git } from "../platform/platform.ts";
import type { Records } from "../records/records.ts";
import { NotInSeal } from "./content.ts";
import {
  coverageSummary,
  dispose,
  markShown,
  nextRegions,
} from "./coverage.ts";
import { DispositionSchema, SideSchema } from "./region.ts";
import { RepoPath, RepoScope } from "./repo-path.ts";
import { done, Sessions, ToolCall } from "./sessions.ts";
import {
  grepSealed,
  history,
  HistoryKindSchema,
  listFiles,
  readLines,
  renderRegions,
} from "./views.ts";

export const readTools = (
  tool: DefineTool<Sessions | Records | Git | FileSystem.FileSystem | Path.Path>
) => {
  tool({
    description:
      "Read sealed diff regions with old and new line numbers (or whole-file regions for paths targets). With only the seal, returns your next unread chunk; or pass region ids or a file. Long regions continue on the next call; the sealing session's complete reads count toward the coverage gate.",
    *execute(input, c) {
      const a = actor(c);

      // A step that began before lockdown must not record reads after it; a reported seal stays readable.
      return yield* (yield* Sessions).mutate(
        input.seal,
        ToolCall.make({
          actor: a,
          reported: "shown",
          tool: "directorate_diff",
        }),
        ({ seal }) =>
          Effect.gen(function* execute() {
            const owner = a.session === seal.ownerSession;
            const reader = owner ? "owner" : a.session;

            const { picked, omitted } = nextRegions(seal, {
              file: input.file,
              ids: input.regions,
              owner,
              reader,
            });

            if (!picked.length) {
              return {
                out: yield* done(
                  seal,
                  input.regions?.length || input.file
                    ? "No matching regions."
                    : "All regions have been read.",
                  a
                ),
              };
            }

            const { text, shown } = yield* renderRegions(seal, picked, reader);

            const read = seal.reportedAt
              ? seal
              : markShown(seal, shown, { key: reader, owner });

            const cov = coverageSummary(read);

            const notShown = [
              ...omitted,
              ...picked.slice(shown.length).map((r) => r.id),
            ];

            const head = `[seal ${seal.id} · base ${seal.baseSha.slice(0, 12)} · head ${seal.postImage === "commit" ? seal.headSha.slice(0, 12) : "working tree"} · columns: old line, new line]`;

            const tail = [
              owner
                ? `[coverage ${cov.read}/${cov.total}${
                    cov.unread.length
                      ? ` · next unread: ${cov.unread
                          .slice(0, 8)
                          .map((r) => r.id)
                          .join(" ")}`
                      : " · all regions read"
                  }]`
                : `[shown ${shown
                    .map((s) => {
                      const progress = s.complete
                        ? ""
                        : " (partial; call again)";

                      return `${s.id}${s.missing ? " (unavailable)" : progress}`;
                    })
                    .join(" ")}]`,
              notShown.length
                ? `[not shown yet: ${notShown.slice(0, 40).join(" ")}${notShown.length > 40 ? ` and ${notShown.length - 40} more` : ""}; request them next]`
                : "",
            ]
              .filter(Boolean)
              .join("\n");

            return {
              out: yield* done(read, `${head}\n${text}\n\n${tail}`, a),
              seal: read === seal ? undefined : read,
            };
          })
      );
    },
    input: Schema.Struct({
      file: optional(RepoPath),
      regions: optional(strArr),
      seal: str,
    }),
    name: "directorate_diff",
  });

  tool({
    description:
      "Read a file as sealed (new side = reviewed post-image, old side = base), with line numbers. Unchanged files come from the base; installed dependencies (gitignored node_modules, vendor, venv) from disk. Secret-like paths and .git are withheld.",
    *execute(input, c) {
      const seal = yield* (yield* Sessions).sealFor(c.sessionID, input.seal);

      return yield* done(
        seal,
        yield* readLines(
          seal,
          input.path,
          input.side ?? "new",
          input.start,
          input.end
        ),
        actor(c)
      );
    },
    files: (input) => [input.path],
    input: Schema.Struct({
      end: optional(positiveInt),
      path: RepoPath,
      seal: str,
      side: optional(SideSchema),
      start: optional(positiveInt),
    }),
    name: "directorate_read",
  });

  tool({
    description:
      "List file names at the seal (the head tree for commit, range, and PR seals; the base tree plus the changes captured at sealing for local and paths seals), optionally under one directory. Withheld files are marked. A dependency directory (node_modules, vendor, venv, …) with nothing sealed is listed one level from disk, with each link's resolved target: use it to find installed files for directorate_read instead of guessing paths.",
    *execute(input, c) {
      const seal = yield* (yield* Sessions).sealFor(c.sessionID, input.seal);

      return yield* done(seal, yield* listFiles(seal, input.dir), actor(c));
    },
    input: Schema.Struct({ dir: optional(RepoScope), seal: str }),
    name: "directorate_ls",
  });

  tool({
    description:
      "Search code with git grep (extended regex unless fixed; literal paths; no pager or shell). Commit, range, and PR seals search the sealed head; local and paths seals search the live tree, so confirm deciding lines with directorate_read.",
    *execute(input, c) {
      const seal = yield* (yield* Sessions).sealFor(c.sessionID, input.seal);

      return yield* done(
        seal,
        yield* grepSealed(seal, input.pattern, {
          fixed: input.fixed,
          ignoreCase: input.ignore_case,
          paths: input.paths,
        }),
        actor(c)
      );
    },
    input: Schema.Struct({
      fixed: optional(Schema.Boolean),
      ignore_case: optional(Schema.Boolean),
      paths: optional(Schema.Array(RepoScope)),
      pattern: str,
      seal: str,
    }),
    name: "directorate_grep",
  });

  tool({
    description:
      "Git history with fixed arguments: log (commits, optionally for a path), blame (a file's lines), or show (a commit's message and file list; with a file path, that file's patch). Paths are literal; secret-like paths are withheld.",
    *execute(input, c) {
      const seal = yield* (yield* Sessions).sealFor(c.sessionID, input.seal);

      return yield* done(seal, yield* history(seal, input), actor(c));
    },
    files: (input) => [input.path],
    input: Schema.Struct({
      end: optional(positiveInt),
      kind: HistoryKindSchema,
      limit: optional(positiveInt.check(Schema.isLessThanOrEqualTo(200))),
      path: optional(RepoPath),
      rev: optional(str),
      seal: str,
      start: optional(positiveInt),
    }),
    name: "directorate_history",
  });

  tool({
    description:
      "Record a disposition with a reason for regions you did not read through directorate_diff: reviewed (an Auditor or Seat read it and you assessed it), skimmed, or skipped. Skimmed and skipped regions make the report partial and are listed under Outside Containment (Not Reviewed).",
    *execute(input, c) {
      return yield* (yield* Sessions).mutate(
        input.seal,
        ToolCall.make({
          actor: actor(c),
          callers: "owner",
          tool: "directorate_coverage",
        }),
        ({ seal }) =>
          Effect.gen(function* execute() {
            const unknown = input.regions.filter(
              (id) => !seal.regions.some((r) => r.id === id)
            );

            if (unknown.length) {
              return yield* new NotInSeal({
                message: `Unknown regions: ${unknown.join(", ")}`,
              });
            }

            const { seal: next, coerced } = dispose(
              seal,
              input.regions,
              input.disposition,
              input.note
            );

            const cov = coverageSummary(next);

            return {
              out: yield* done(
                next,
                `Recorded ${input.disposition} for ${input.regions.length} regions.${coerced.length ? ` ${coerced.join(" ")} recorded as skimmed: nobody read them through directorate_diff.` : ""} Read ${cov.read}/${cov.total}.`
              ),
              seal: next,
            };
          })
      );
    },
    input: Schema.Struct({
      disposition: DispositionSchema,
      note: str.check(
        Schema.makeFilter(
          (s: string) =>
            s.trim().length > 0 ||
            "A disposition needs a note saying how it was assessed or why it was skipped."
        )
      ),
      regions: strArr,
      seal: str,
    }),
    name: "directorate_coverage",
  });
};
