// Directorate live working-tree access, under one path policy, and the signatures that tell whether it moved since the seal.
import { Context, Crypto, Effect, FileSystem, Layer, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { ReviewError } from "./error.ts";
import { isSecret } from "./exclusions.ts";
import { Git } from "./git.ts";
import { sha256 } from "./hash.ts";

const IO_CONCURRENCY = 16;
/** A working-tree path as captured: its bytes (a symlink as its link text) and mode, or absent. */
type LiveEntry = {
  readonly buf?: Buffer;
  readonly mode: "absent" | "link" | "exec" | "file";
};

/** Missing is a fact about the worktree; any other filesystem error is not. */
const orMissing = <A, R>(self: Effect.Effect<A, PlatformError, R>) =>
  self.pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined)
  );
const unreadable = (path: string) =>
  Effect.mapError(
    (e: PlatformError) =>
      new ReviewError({ message: `Cannot read ${path}: ${e.message}` })
  );

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const git = yield* Git;
  const crypto = yield* Crypto.Crypto;
  const hash = (s: string | Uint8Array) =>
    sha256(s).pipe(Effect.provideService(Crypto.Crypto, crypto));

  /** One path policy for the worktree: a path below a symlink or a non-directory is absent. */
  const stat = Effect.fnUntraced(function* (repo: string, path: string) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const st = yield* orMissing(
        fs.lstat(paths.join(repo, ...parts.slice(0, i)))
      );
      if (st?.type !== "Directory") return { abs: "", st: undefined };
    }
    const abs = paths.join(repo, path);
    return { abs, st: yield* orMissing(fs.lstat(abs)) };
  });
  /** Whether a file or symlink exists under the path policy, without reading it. */
  const present = (repo: string, path: string) =>
    stat(repo, path).pipe(
      Effect.map(
        ({ st }) => st?.type === "File" || st?.type === "SymbolicLink"
      ),
      unreadable(path)
    );
  /** Working-tree entry under the path policy; a leaf symlink is its link text. Unreadable files fail rather than read as deleted. */
  const entry = Effect.fn("Worktree.entry")(
    function* (
      repo: string,
      path: string
    ): Effect.fn.Return<LiveEntry, PlatformError> {
      const { abs, st } = yield* stat(repo, path);
      if (st?.type === "SymbolicLink") {
        const link = yield* orMissing(fs.readLink(abs));
        return link === undefined
          ? { mode: "absent" }
          : { buf: Buffer.from(`symlink -> ${link}\n`), mode: "link" };
      }
      if (st?.type !== "File") return { mode: "absent" };
      const buf = yield* orMissing(fs.readFile(abs));
      return buf === undefined
        ? { mode: "absent" }
        : { buf: Buffer.from(buf), mode: st.mode & 0o111 ? "exec" : "file" };
    },
    (effect, _repo, path) => effect.pipe(unreadable(path))
  );
  /** An entry's signature: its mode and content hash, or "deleted". */
  const sign = (e: LiveEntry) =>
    e.buf === undefined
      ? Effect.succeed("deleted")
      : hash(e.buf).pipe(Effect.map((digest) => `${e.mode}:${digest}`));
  /** Signature of every changed, non-secret path in the post-image. */
  const sigs = Effect.fn("Worktree.sigs")(function* (
    repo: string,
    base: string,
    scope?: readonly string[]
  ) {
    const names = (yield* git.changedNames(repo, base, scope)).filter(
      (f) => !isSecret(f)
    );
    const signed = yield* Effect.forEach(
      names,
      (f) => entry(repo, f).pipe(Effect.flatMap(sign)),
      { concurrency: IO_CONCURRENCY }
    );
    return Object.fromEntries(names.map((f, i) => [f, signed[i]]));
  });
  /** One fingerprint for a set of signatures against a base. */
  const fingerprintOf = (
    base: string,
    signatures: Readonly<Record<string, string>>
  ) =>
    hash(
      `wt:${base}\0${Object.entries(signatures)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}\0${v}`)
        .join("\0")}`
    );

  return {
    present,
    entry,
    sign,
    sigs,
    fingerprintOf,
    fingerprint: (repo: string, base: string, scope?: readonly string[]) =>
      sigs(repo, base, scope).pipe(
        Effect.flatMap((s) => fingerprintOf(base, s))
      ),
  };
});

export class Worktree extends Context.Service<
  Worktree,
  Effect.Success<typeof make>
>()("directorate/Worktree") {
  static readonly layer = Layer.effect(Worktree, make);
}
