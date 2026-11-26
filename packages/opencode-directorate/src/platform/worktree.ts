// Directorate live working-tree access, under one path policy, and the signatures that tell whether it moved since the seal.
import {
  Bytes,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
} from "effect";
import { Digest } from "effect/crypto";
import type { PlatformError } from "effect/PlatformError";

import { isSecret } from "../exclusions.ts";
import { Git, UnreadableFile } from "./git.ts";
import { sha256 } from "./hash.ts";
import { encodeUtf8 } from "./utf8.ts";

const IO_CONCURRENCY = 16;

/** What a working-tree path is: absent, a symlink, an executable or plain file, or a checked-out submodule. */
export const EntryModeSchema = Schema.Literals([
  "absent",
  "link",
  "exec",
  "file",
  "gitlink",
]);

export type EntryMode = typeof EntryModeSchema.Type;

/** The git file mode of each kind of entry; an absent path diffs as a plain file. */
const GIT_MODES = Schema.Record(EntryModeSchema, Schema.String).make({
  absent: "100644",
  exec: "100755",
  file: "100644",
  gitlink: "160000",
  link: "120000",
});

/** A working-tree path as captured: its bytes (a symlink as its link text, a submodule as its commit) and mode, or absent. */
export class LiveEntry extends Schema.Class<
  LiveEntry,
  { readonly brand: unique symbol }
>("directorate/LiveEntry")({
  buf: Schema.optionalKey(Schema.Uint8Array),
  mode: EntryModeSchema,
}) {
  /** The mode git records for it. */
  get gitMode() {
    return GIT_MODES[this.mode];
  }
}

const absent = LiveEntry.make({ mode: "absent" });

/** Missing is a fact about the worktree; any other filesystem error is not. */
const orMissing = <A, R>(self: Effect.Effect<A, PlatformError, R>) =>
  self.pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined)
  );

const unreadable = (path: string) =>
  Effect.mapError(
    (e: PlatformError) => new UnreadableFile({ path, reason: e.message })
  );

const make = Effect.gen(function* make() {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const git = yield* Git;
  const hasher = yield* Digest.Digest;

  const hash = (s: string | Uint8Array) =>
    sha256(s).pipe(Effect.provideService(Digest.Digest, hasher));

  /** One path policy for the worktree: a path below a symlink or a non-directory is absent. */
  const stat = Effect.fnUntraced(function* stat(repo: string, path: string) {
    const parts = path.split("/");

    for (let i = 1; i < parts.length; i += 1) {
      const st = yield* orMissing(
        fs.lstat(paths.join(repo, ...parts.slice(0, i)))
      );

      if (st?.type !== "Directory") {
        return { abs: "", st: undefined };
      }
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

  /** A checked-out submodule's commit, as git's diff names it; undefined for a directory that is not its own checkout. */
  const submodule = Effect.fnUntraced(function* submodule(abs: string) {
    if ((yield* orMissing(fs.lstat(paths.join(abs, ".git")))) === undefined) {
      return;
    }

    const head = (yield* git
      .run(abs, ["rev-parse", "--verify", "-q", "HEAD"], [0, 1])
      .pipe(Effect.orElseSucceed(() => ""))).trim();

    return head || undefined;
  });

  /**
   * Working-tree entry under the path policy; a leaf symlink is its link text, a checked-out submodule its commit.
   * Unreadable files fail rather than read as deleted.
   */
  const entry = Effect.fn("Worktree.entry")(
    function* entry(repo: string, path: string) {
      const { abs, st } = yield* stat(repo, path);

      // An untracked nested repository is listed as `dir/`; only a tracked gitlink names its directory bare.
      if (st?.type === "Directory" && !path.endsWith("/")) {
        const head = yield* submodule(abs);

        return head === undefined
          ? absent
          : LiveEntry.make({
              buf: encodeUtf8(`Subproject commit ${head}\n`),
              mode: "gitlink",
            });
      }

      if (st?.type === "SymbolicLink") {
        const link = yield* orMissing(fs.readLink(abs));

        return link === undefined
          ? absent
          : LiveEntry.make({
              buf: encodeUtf8(`symlink -> ${link}\n`),
              mode: "link",
            });
      }

      if (st?.type !== "File") {
        return absent;
      }

      const buf = yield* orMissing(fs.readFile(abs));

      if (buf === undefined) {
        return absent;
      }

      // Git for Windows retains modes in the index, including links checked out as text.
      const indexed =
        paths.sep === "\\" ? yield* git.indexMode(repo, path) : undefined;

      if (indexed === "120000") {
        return LiveEntry.make({
          buf: Bytes.concat([encodeUtf8("symlink -> "), buf, encodeUtf8("\n")]),
          mode: "link",
        });
      }

      // Each of the last three octal digits is odd when its execute bit is set.
      const executable =
        indexed === undefined
          ? /[1357]/u.test(st.mode.toString(8).slice(-3))
          : indexed === "100755";

      return LiveEntry.make({ buf, mode: executable ? "exec" : "file" });
    },
    (effect, _repo, path) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new UnreadableFile({ path, reason: cause.message })
        )
      )
  );

  /** An entry's signature: its mode and content hash, or "deleted". */
  const sign = (e: LiveEntry) =>
    e.buf === undefined
      ? Effect.succeed("deleted")
      : hash(e.buf).pipe(Effect.map((digest) => `${e.mode}:${digest}`));

  /** A secret-like path's signature: whether it is there, never its bytes. */
  const signWithheld = (repo: string, path: string) =>
    present(repo, path).pipe(
      Effect.map((here) => (here ? "withheld" : "deleted"))
    );

  /**
   * Signature of every changed path in the post-image; a secret-like one by name and status only, and one gone from the
   * post-image as deleted whatever working copy remains.
   */
  const sigs = Effect.fn("Worktree.sigs")(function* sigs(
    repo: string,
    base: string,
    scope?: readonly string[]
  ) {
    const { gone, names } = yield* git.changes(repo, base, scope);

    const signature = (f: string) => {
      if (gone.has(f)) {
        return Effect.succeed("deleted");
      }

      return isSecret(f)
        ? signWithheld(repo, f)
        : entry(repo, f).pipe(Effect.flatMap(sign));
    };

    const signed = yield* Effect.forEach(
      names,
      (f) => signature(f).pipe(Effect.map((s) => [f, s] as const)),
      { concurrency: IO_CONCURRENCY }
    );

    return Object.fromEntries(signed);
  });

  /** One fingerprint for a set of signatures against a base. */
  const fingerprintOf = (
    base: string,
    signatures: Readonly<Record<string, string>>
  ) =>
    hash(
      `wt:${base}\0${Object.entries(signatures)
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}\0${v}`)
        .join("\0")}`
    );

  return {
    entry,
    fingerprint: (repo: string, base: string, scope?: readonly string[]) =>
      sigs(repo, base, scope).pipe(
        Effect.flatMap((s) => fingerprintOf(base, s))
      ),
    fingerprintOf,
    present,
    sign,
    signWithheld,
    sigs,
  };
});

export class Worktree extends Context.Service<
  Worktree,
  Effect.Success<typeof make>
>()("directorate/Worktree") {
  static readonly layer = Layer.effect(Worktree, make);
}
