// Directorate sealed content: a file as the seal pinned it, and the checks that tie quotes and evidence to that content.
import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { failure, ReviewError } from "./error.ts";
import { DEPENDENCY_DIRS, inScope, isSecret, scopeOf } from "./exclusions.ts";
import { Git } from "./git.ts";
import { isUrl, LineRef } from "./model.ts";
import type { Anchor, Entry, Seal, Side } from "./model.ts";
import { Store } from "./store.ts";

const IO_CONCURRENCY = 16;

export const outsideWorktreeScope = (seal: Seal, path: string) =>
  seal.postImage === "worktree" && !inScope(path, scopeOf(seal.target.paths));

/** A path's bytes on one side of the seal. Paths arrive in repository form, checked by RepoPath at the tool boundary. */
const sealedBytes = Effect.fnUntraced(function* sealedBytes(
  seal: Seal,
  p: string,
  side: Side = "new"
) {
  const git = yield* Git;

  if (side === "old") {
    return yield* git.blob(seal.repo, seal.baseSha, p);
  }

  if (seal.postImage === "commit") {
    return yield* git.blob(seal.repo, seal.headSha, p);
  }

  if (seal.deleted.includes(p)) {
    return;
  }

  const snap = yield* (yield* Store).readSnapshot(seal, p);

  if (snap !== undefined) {
    return snap;
  }

  // Changed but withheld (excluded) files have no sealed content; everything else unchanged is the base.
  if (seal.sigs && p in seal.sigs) {
    return;
  }

  return yield* git.blob(seal.repo, seal.baseSha, p);
});

export const sealedFile = (seal: Seal, path: string, side: Side = "new") =>
  sealedBytes(seal, path, side).pipe(
    Effect.map((bytes) => bytes?.toString("utf-8"))
  );

/** Whether a repository path lies in a dependency directory (node_modules, vendor, venv, …); a directory counts too. */
export const inDependencyDir = (p: string) => DEPENDENCY_DIRS.test(`${p}/`);

/**
 * An installed dependency file or directory on disk, which is outside the seal: allowed only when its resolved path is in
 * the repository, in a gitignored dependency directory, and not secret-like. It is resolved before git sees it: package
 * managers such as Bun and pnpm link packages into a store, and git refuses a path beyond a symbolic link.
 */
export const installed = Effect.fn("Directorate.installed")(function* installed(
  seal: Seal,
  p: string
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const missing = `${p} not found (installed dependencies: directorate_ls lists a dependency directory)`;

  if (isSecret(p) || !inDependencyDir(p)) {
    return yield* failure(`${p} not found at the seal`);
  }

  const [root, abs] = yield* Effect.all(
    [fs.realPath(seal.repo), fs.realPath(paths.join(seal.repo, p))],
    { concurrency: 2 }
  ).pipe(Effect.catchTag("PlatformError", () => failure(missing)));

  const rel = paths.relative(root, abs).split(paths.sep).join("/");

  if (rel === ".." || rel.startsWith("../") || paths.isAbsolute(rel)) {
    return yield* failure(`${p} resolves outside the repository`);
  }

  if (isSecret(rel) || !inDependencyDir(rel)) {
    return yield* failure(`${p} resolves to a withheld path`);
  }

  if (!(yield* (yield* Git).isIgnored(seal.repo, rel))) {
    return yield* failure(`${p} not found at the seal`);
  }

  return { abs, missing, rel };
});

/** Sealed content, else an installed dependency on disk (see installed). Secrets are withheld. */
export const readable = Effect.fn("Directorate.readable")(function* readable(
  seal: Seal,
  p: string,
  side: Side = "new"
): Effect.fn.Return<
  { content: string; live: boolean },
  ReviewError,
  FileSystem.FileSystem | Path.Path | Git | Store
> {
  const fs = yield* FileSystem.FileSystem;

  if (isSecret(p)) {
    return yield* failure(`${p} is a secret-like path; content withheld`);
  }

  const sealed = yield* sealedFile(seal, p, side);

  if (sealed !== undefined) {
    return { content: sealed, live: false };
  }

  if (
    side === "old" ||
    seal.deleted.includes(p) ||
    seal.files.some((f) => f.path === p)
  ) {
    return yield* failure(
      `${p} does not exist on the ${side === "old" ? "base" : "sealed"} side`
    );
  }

  const dep = yield* installed(seal, p);

  return {
    content: yield* fs
      .readFileString(dep.abs)
      .pipe(Effect.catchTag("PlatformError", () => failure(dep.missing))),
    live: true,
  };
});

const norm = (s: string) => s.replaceAll(/\s+/gu, " ").trim();
const longEnough = (line: string) => line.replaceAll(/\s/gu, "").length >= 8;

/** Checks the quote against the sealed side; returns the anchor snapped to the nearest place the quote really is, or fails saying why not. */
export const checkQuote = Effect.fn("Directorate.checkQuote")(
  function* checkQuote(seal: Seal, anchor: Anchor, quote: string) {
    if (anchor.side === "new" && outsideWorktreeScope(seal, anchor.path)) {
      return yield* failure(
        `${anchor.path} is outside the sealed scope; only the base is available. Use side:"old" to anchor to the base.`
      );
    }

    const { content } = yield* readable(seal, anchor.path, anchor.side).pipe(
      Effect.mapError(
        (e) =>
          new ReviewError({
            message: `${e.message}. Use side:"old" for removed code.`,
          })
      )
    );

    const lines = content.split("\n");

    if (anchor.line < 1 || anchor.line > lines.length) {
      return yield* failure(
        `${anchor.path}:${anchor.line} is outside the file (${lines.length} lines).`
      );
    }

    const q = quote.split("\n").map(norm).filter(Boolean);

    const [first] = q;

    if (first === undefined) {
      return yield* failure(
        "quote is empty; copy the exact code at the anchor."
      );
    }

    if (!q.some(longEnough)) {
      return yield* failure(
        "quote too short to identify the code; include at least one full line with 8 or more non-space characters."
      );
    }

    const matchAt = (i: number): number | undefined => {
      let j = i;
      let complete = false;

      for (const [k, part] of q.entries()) {
        if (k > 0) {
          j += 1;

          while (j < lines.length && !norm(lines[j] ?? "")) {
            j += 1;
          }
        }

        const h = norm(lines[j] ?? "");

        if (h === part) {
          complete ||= longEnough(part);
        } else if (
          !(
            q.length > 1 &&
            ((k === 0 && h.endsWith(part)) ||
              (k === q.length - 1 && h.startsWith(part)))
          )
        ) {
          return undefined;
        }
      }

      return complete ? j : undefined;
    };

    const base = anchor.line - 1;

    for (const d of [0, 1, -1, 2, -2, 3, -3]) {
      const i = base + d;

      if (i < 0 || i >= lines.length) {
        continue;
      }

      const j = matchAt(i);

      if (j !== undefined) {
        return { ...anchor, endLine: j + 1, line: i + 1 } satisfies Anchor;
      }
    }

    const window = norm(
      lines.slice(Math.max(0, base - 3), base + q.length + 3).join("\n")
    );

    if (window.includes(norm(quote))) {
      return yield* failure(
        "quote is a fragment; copy at least one complete line of the code at the anchor."
      );
    }

    const hit = lines.findIndex((l) => norm(l).includes(first));

    return yield* failure(
      `quote not found at ${anchor.path}:${anchor.line} on the ${anchor.side === "old" ? "base" : "sealed"} side.${hit === -1 ? " It does not appear in the file." : ` Its first line appears at line ${hit + 1}.`} Re-read with directorate_read and anchor to the real code.`
    );
  }
);

const decodeLineRef = Schema.decodeUnknownEffect(LineRef);
const encodeLineRef = Schema.encodeEffect(LineRef);

/**
 * URLs pass as-is; a path:line or path:start-end ref (decoded by LineRef) must fit the file on the sealed side or,
 * failing that, the base. Returns the refs in normal form, or fails with every bad ref at once.
 */
export const checkEvidence = Effect.fn("Directorate.checkEvidence")(
  function* checkEvidence(seal: Seal, refs: readonly string[]) {
    return yield* Effect.validate(
      refs,
      (raw) => {
        const ref = raw.trim();

        if (isUrl(ref)) {
          return Effect.succeed(ref);
        }

        return Effect.gen(function* checkReference() {
          const r = yield* decodeLineRef(ref);

          const fits = (side: Side) =>
            readable(seal, r.path, side).pipe(
              Effect.flatMap(({ content }) => {
                const n = content.split("\n").length;

                return r.end <= n
                  ? Effect.void
                  : failure(`line outside file (${n} lines)`);
              })
            );

          // When neither side fits, the sealed side's reason is the one to report.
          yield* fits("new").pipe(
            Effect.catch((error) =>
              fits("old").pipe(Effect.mapError(() => error))
            )
          );

          return yield* encodeLineRef(r).pipe(Effect.orDie);
        }).pipe(Effect.mapError((e) => `${ref}: ${e.message}`));
      },
      { concurrency: IO_CONCURRENCY }
    ).pipe(
      Effect.mapError(
        (bad) =>
          new ReviewError({ message: `Rejected evidence: ${bad.join("; ")}` })
      )
    );
  }
);

const refFile = Schema.decodeUnknownOption(LineRef);

/** Files an entry rests on: its anchor and every path:line ref in its evidence and verdicts. */
export const depsOf = (e: Entry) =>
  new Set([
    e.anchor.path,
    ...[...e.evidence, ...e.verdicts.flatMap((v) => v.evidence)].flatMap(
      (ref) =>
        isUrl(ref)
          ? []
          : Option.toArray(Option.map(refFile(ref), (r) => r.path))
    ),
  ]);
