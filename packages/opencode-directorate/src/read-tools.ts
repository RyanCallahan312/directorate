// Directorate reading tools: how the Liaison, Auditors, Seats, and Compliance read the sealed code, and how the Liaison accounts for what it did not.
import { Schema } from "effect";

import {
  grepSealed,
  history,
  listFiles,
  readLines,
  renderRegions,
} from "./browse.ts";
import {
  coverageSummary,
  dispose,
  markShown,
  nextRegions,
} from "./coverage.ts";
import { failure } from "./error.ts";
import { Disposition, RepoPath, RepoScope, Side } from "./model.ts";
import { Sessions } from "./session.ts";
import { Store } from "./store.ts";
import {
  actor,
  type DefineTool,
  done,
  locked,
  mutate,
  optional,
  positiveInt,
  str,
  strArr,
} from "./tool.ts";

export function readTools(tool: DefineTool) {
  tool({
    name: "directorate_diff",
    description:
      "Read sealed diff regions with old and new line numbers (or whole-file regions for paths targets). With only the seal, returns your next unread chunk; or pass region ids or a file. Long regions continue on the next call; the sealing session's complete reads count toward the coverage gate.",
    input: Schema.Struct({
      seal: str,
      regions: optional(strArr),
      file: optional(RepoPath),
    }),
    execute: function* (input, c) {
      return yield* locked(c, input.seal, function* (seal) {
        const a = actor(c);
        const owner = a.session === seal.ownerSession;
        const reader = owner ? "owner" : a.session;
        const { picked, omitted } = nextRegions(seal, {
          ids: input.regions,
          file: input.file,
          reader,
          owner,
        });
        if (!picked.length)
          return yield* done(
            seal,
            input.regions?.length || input.file
              ? "No matching regions."
              : "All regions have been read.",
            a.agent
          );
        const { text, shown } = yield* renderRegions(seal, picked, reader);
        const read = seal.reportedAt
          ? seal
          : markShown(seal, shown, { key: reader, owner });
        if (read !== seal) yield* (yield* Store).save(read);
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
            : `[shown ${shown.map((s) => `${s.id}${s.missing ? " (unavailable)" : s.complete ? "" : " (partial; call again)"}`).join(" ")}]`,
          notShown.length
            ? `[not shown yet: ${notShown.slice(0, 40).join(" ")}${notShown.length > 40 ? ` and ${notShown.length - 40} more` : ""}; request them next]`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
        return yield* done(read, `${head}\n${text}\n\n${tail}`, a.agent);
      });
    },
  });

  tool({
    name: "directorate_read",
    description:
      "Read a file as sealed (new side = reviewed post-image, old side = base), with line numbers. Unchanged files come from the base; installed dependencies (gitignored node_modules, vendor, venv) from disk. Secret-like paths and .git are withheld.",
    input: Schema.Struct({
      seal: str,
      path: RepoPath,
      side: optional(Side),
      start: optional(positiveInt),
      end: optional(positiveInt),
    }),
    files: (input) => [input.path],
    execute: function* (input, c) {
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
        c.agent
      );
    },
  });

  tool({
    name: "directorate_ls",
    description:
      "List file names at the seal (the head tree for commit, range, and PR seals; the base tree plus the changes captured at sealing for local and paths seals), optionally under one directory. Withheld files are marked. A dependency directory (node_modules, vendor, venv, …) with nothing sealed is listed one level from disk, with each link's resolved target: use it to find installed files for directorate_read instead of guessing paths.",
    input: Schema.Struct({ seal: str, dir: optional(RepoScope) }),
    execute: function* (input, c) {
      const seal = yield* (yield* Sessions).sealFor(c.sessionID, input.seal);
      return yield* done(seal, yield* listFiles(seal, input.dir), c.agent);
    },
  });

  tool({
    name: "directorate_grep",
    description:
      "Search code with git grep (extended regex unless fixed; literal paths; no pager or shell). Commit, range, and PR seals search the sealed head; local and paths seals search the live tree, so confirm deciding lines with directorate_read.",
    input: Schema.Struct({
      seal: str,
      pattern: str,
      paths: optional(Schema.Array(RepoScope)),
      fixed: optional(Schema.Boolean),
      ignore_case: optional(Schema.Boolean),
    }),
    execute: function* (input, c) {
      const seal = yield* (yield* Sessions).sealFor(c.sessionID, input.seal);
      return yield* done(
        seal,
        yield* grepSealed(seal, input.pattern, {
          paths: input.paths,
          fixed: input.fixed,
          ignoreCase: input.ignore_case,
        }),
        c.agent
      );
    },
  });

  tool({
    name: "directorate_history",
    description:
      "Git history with fixed arguments: log (commits, optionally for a path), blame (a file's lines), or show (a commit's message and file list; with a file path, that file's patch). Paths are literal; secret-like paths are withheld.",
    input: Schema.Struct({
      seal: str,
      kind: Schema.Literals(["log", "blame", "show"]),
      path: optional(RepoPath),
      rev: optional(str),
      start: optional(positiveInt),
      end: optional(positiveInt),
      limit: optional(positiveInt.check(Schema.isLessThanOrEqualTo(200))),
    }),
    files: (input) => [input.path],
    execute: function* (input, c) {
      const seal = yield* (yield* Sessions).sealFor(c.sessionID, input.seal);
      return yield* done(seal, yield* history(seal, input), c.agent);
    },
  });

  tool({
    name: "directorate_coverage",
    description:
      "Record a disposition with a reason for regions you did not read through directorate_diff: reviewed (an Auditor or Seat read it and you assessed it), skimmed, or skipped. Skimmed and skipped regions make the report partial and are listed under Outside Containment (Not Reviewed).",
    input: Schema.Struct({
      seal: str,
      regions: strArr,
      disposition: Disposition,
      note: str.check(
        Schema.makeFilter(
          (s: string) =>
            s.trim().length > 0 ||
            "A disposition needs a note saying how it was assessed or why it was skipped."
        )
      ),
    }),
    execute: function* (input, c) {
      return yield* mutate(
        c,
        input.seal,
        "directorate_coverage",
        function* (seal) {
          const unknown = input.regions.filter(
            (id) => !seal.regions.some((r) => r.id === id)
          );
          if (unknown.length)
            return yield* failure(`Unknown regions: ${unknown.join(", ")}`);
          const { seal: next, coerced } = dispose(
            seal,
            input.regions,
            input.disposition,
            input.note
          );
          yield* (yield* Store).save(next);
          const cov = coverageSummary(next);
          return yield* done(
            next,
            `Recorded ${input.disposition} for ${input.regions.length} regions.${coerced.length ? ` ${coerced.join(" ")} recorded as skimmed: nobody read them through directorate_diff.` : ""} Read ${cov.read}/${cov.total}.`
          );
        },
        true
      );
    },
  });
}
