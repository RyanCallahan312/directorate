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

/** How many filesystem operations (reads, stats, removals) one fan-out runs at once. */
export const IO_CONCURRENCY = 16;

/** What kind of entry the filesystem reports a path as (`FileSystem.File.Type`). */
const FileTypeSchema = Schema.Literals([
  "File",
  "Directory",
  "SymbolicLink",
  "BlockDevice",
  "CharacterDevice",
  "FIFO",
  "Socket",
  "Unknown",
]);

export const isFile = Schema.is(FileTypeSchema.pick(["File"]));

export const isDirectory = Schema.is(FileTypeSchema.pick(["Directory"]));

const isSymbolicLink = Schema.is(FileTypeSchema.pick(["SymbolicLink"]));

/** A file or a symlink: what a review reads, as opposed to a directory or a special file. */
const isFileOrLink = Schema.is(FileTypeSchema.pick(["File", "SymbolicLink"]));

/** What a working-tree path is: absent, a symlink, an executable or plain file, or a checked-out submodule. */
const EntryModeSchema = Schema.Literals([
  "absent",
  "link",
  "exec",
  "file",
  "gitlink",
]);

const isGitlink = Schema.is(EntryModeSchema.pick(["gitlink"]));

const isLinkMode = Schema.is(EntryModeSchema.pick(["link"]));

/** The git file mode of each kind of entry; an absent path diffs as a plain file. */
const GIT_MODES = Schema.Record(EntryModeSchema, Schema.String).make({
  absent: "100644",
  exec: "100755",
  file: "100644",
  gitlink: "160000",
  link: "120000",
});

/** How a link's bytes read in a diff: its target, between this prefix and a final newline. */
const LINK_PREFIX = encodeUtf8("symlink -> ");
const LINK_END = encodeUtf8("\n");

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

  /** A checked-out submodule, recorded as its commit. */
  get isSubmodule() {
    return isGitlink(this.mode);
  }

  /** A symbolic link, recorded as its link text. */
  get isLink() {
    return isLinkMode(this.mode);
  }

  /** A link's bare target, as git stores a symlink's blob; undefined for any other entry. */
  get linkTarget() {
    return this.isLink && this.buf !== undefined
      ? this.buf.subarray(LINK_PREFIX.byteLength, -LINK_END.byteLength)
      : undefined;
  }
}

const linkEntry = (target: Uint8Array) =>
  LiveEntry.make({
    buf: Bytes.concat([LINK_PREFIX, target, LINK_END]),
    mode: "link",
  });

const absent = LiveEntry.make({ mode: "absent" });

/** The signature of a path gone from the post-image; any other signature is a mode and hash, or withheld. */
export const isDeletedSignature = Schema.is(Schema.Literal("deleted"));

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

      if (!isDirectory(st?.type)) {
        return { abs: "", st: undefined };
      }
    }

    const abs = paths.join(repo, path);

    return { abs, st: yield* orMissing(fs.lstat(abs)) };
  });

  /** Whether a file or symlink exists under the path policy, without reading it. */
  const present = (repo: string, path: string) =>
    stat(repo, path).pipe(
      Effect.map(({ st }) => isFileOrLink(st?.type)),
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
      if (isDirectory(st?.type) && !path.endsWith("/")) {
        const head = yield* submodule(abs);

        return head === undefined
          ? absent
          : LiveEntry.make({
              buf: encodeUtf8(`Subproject commit ${head}\n`),
              mode: "gitlink",
            });
      }

      if (isSymbolicLink(st?.type)) {
        const link = yield* orMissing(fs.readLink(abs));

        return link === undefined ? absent : linkEntry(encodeUtf8(link));
      }

      if (!isFile(st?.type)) {
        return absent;
      }

      const buf = yield* orMissing(fs.readFile(abs));

      if (buf === undefined) {
        return absent;
      }

      // Git for Windows retains modes in the index, including links checked out as text.
      const indexed =
        paths.sep === "\\" ? yield* git.indexMode(repo, path) : undefined;

      if (indexed === GIT_MODES.link) {
        return linkEntry(buf);
      }

      // Each of the last three octal digits is odd when its execute bit is set.
      const executable =
        indexed === undefined
          ? /[1357]/u.test(st.mode.toString(8).slice(-3))
          : indexed === GIT_MODES.exec;

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
   * A changed path's signature in the post-image, with its entry only when its bytes were read: deleted when `gone` from the
   * post-image whatever working copy remains, a secret-like one by presence only, and any other by its mode and bytes.
   */
  const signature = Effect.fnUntraced(function* signature(
    repo: string,
    path: string,
    gone: ReadonlySet<string>
  ) {
    if (gone.has(path)) {
      return { sig: "deleted" };
    }

    if (isSecret(path)) {
      return { sig: yield* signWithheld(repo, path) };
    }

    const read = yield* entry(repo, path);

    return { entry: read, sig: yield* sign(read) };
  });

  /** Signature of every changed path in the post-image (see signature). */
  const sigs = Effect.fn("Worktree.sigs")(function* sigs(
    repo: string,
    base: string,
    scope?: readonly string[]
  ) {
    const { gone, names } = yield* git.changes(repo, base, scope);

    const signed = yield* Effect.forEach(
      names,
      (f) =>
        signature(repo, f, gone).pipe(
          Effect.map(({ sig }) => [f, sig] as const)
        ),
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
    signature,
    sigs,
  };
});

export class Worktree extends Context.Service<
  Worktree,
  Effect.Success<typeof make>
>()("directorate/Worktree") {
  static readonly layer = Layer.effect(Worktree, make);
}
