// Directorate capture: a target's diff, snapshot, and regions captured into a seal's generation, and the drift check that
// tells whether the sealed code moved since.
import {
  Bytes,
  Effect,
  FileSystem,
  Match,
  Path,
  Predicate,
  Schema,
} from "effect";

import { exclusionReason, isSecret, scopeOf } from "../exclusions.ts";
import { sha256 } from "../platform/hash.ts";
import { Git, Worktree } from "../platform/platform.ts";
import { decodeUtf8 } from "../platform/utf8.ts";
import { Store } from "../records/records.ts";
import { assemble, buildRegions, RawDiff, shown } from "./diff.ts";
import type { Piece } from "./diff.ts";
import { endsFingerprint } from "./ends.ts";
import type { Current } from "./ends.ts";
import type { Seal } from "./record.ts";
import { FileEntry, Region } from "./region.ts";

const FILE_REGION_LINES = 300;
const IO_CONCURRENCY = 16;

/** Raw records (exact names) and the patch, in one run so they describe the same tree. */
const RAW_DIFF = [
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "-M",
  "--unified=3",
  "--raw",
  "-z",
  "-p",
];

const decodeRawDiff = Schema.decodeEffect(RawDiff);

/** An edit landed while capturing; the capture is retried. */
class CaptureDrift extends Schema.TaggedError<
  CaptureDrift,
  { readonly brand: unique symbol }
>()("CaptureDrift", {}) {}

/** The target could not be captured consistently. */
export class CaptureFailed extends Schema.TaggedError<
  CaptureFailed,
  { readonly brand: unique symbol }
>()("CaptureFailed", { message: Schema.String }) {}

/** Retries a capture twice when files change mid-capture, then fails with `message`. */
export const settled =
  (message: string) =>
  <A, E, R>(self: Effect.Effect<A, E | CaptureDrift, R>) =>
    self.pipe(
      Effect.retry({
        times: 2,
        while: Schema.is(CaptureDrift),
      }),
      Effect.catchTag("CaptureDrift", () =>
        Effect.fail(new CaptureFailed({ message }))
      )
    );

const binary = (buf: Uint8Array) => buf.subarray(0, 8000).includes(0);

interface Captured {
  text: string;
  files: readonly FileEntry[];
  regions: readonly Region[];
}

const gitFileMode = Match.type<
  "absent" | "link" | "exec" | "file" | "gitlink"
>().pipe(
  Match.when("gitlink", () => "160000"),
  Match.when("link", () => "120000"),
  Match.when("exec", () => "100755"),
  Match.orElse(() => "100644")
);

const rewriteDiffHeader = (line: string, from: string, to: string): string => {
  if (line.startsWith("--- ")) {
    return `--- ${from}`;
  }

  if (line.startsWith("+++ ")) {
    return `+++ ${to}`;
  }

  if (line.startsWith("Binary files ")) {
    return `Binary files ${from} and ${to} differ`;
  }

  return line;
};

const diffModeLines = (
  oldMode: string | undefined,
  newMode: string | undefined
): string[] => {
  if (newMode === undefined) {
    return oldMode === undefined ? [] : [`deleted file mode ${oldMode}`];
  }

  if (oldMode === undefined) {
    return [`new file mode ${newMode}`];
  }

  return oldMode === newMode
    ? []
    : [`old mode ${oldMode}`, `new mode ${newMode}`];
};

/** A path's bytes and git mode on one side of a change. */
interface Version {
  readonly buf: Uint8Array;
  readonly mode: string;
}

/** Whether two versions match; a base symlink's blob is its bare link text. */
const sameVersion = (old: Version | undefined, now: Version | undefined) =>
  old === undefined || now === undefined
    ? old === now
    : old.mode === now.mode &&
      Bytes.Equivalence(
        old.buf,
        old.mode === "120000"
          ? now.buf.subarray("symlink -> ".length, -1)
          : now.buf
      );

/** A path's git mode at the base, without reading it, or undefined when the base has no such entry. */
const baseMode = Effect.fnUntraced(function* baseMode(
  repo: string,
  base: string,
  path: string
) {
  const out = yield* (yield* Git).run(repo, [
    "ls-tree",
    "-z",
    base,
    "--",
    path,
  ]);

  return out.split(" ", 1)[0] || undefined;
});

/** A path's version at the base, or undefined when the base has no such blob (a submodule has none). */
const baseVersion = Effect.fnUntraced(function* baseVersion(
  repo: string,
  base: string,
  path: string
) {
  const mode = yield* baseMode(repo, base, path);

  const buf =
    mode === undefined ? undefined : yield* (yield* Git).blob(repo, base, path);

  return mode === undefined || buf === undefined
    ? undefined
    : ({ buf, mode } satisfies Version);
});

/**
 * One path's patch from `old` to `now`, either of which may be absent, or undefined when they match. It diffs the captured
 * bytes, not the live path, so a symlink stays its link text.
 */
const versionPatch = Effect.fn("Directorate.versionPatch")(
  function* versionPatch(
    repo: string,
    path: string,
    old: Version | undefined,
    now: Version | undefined
  ) {
    if (sameVersion(old, now)) {
      return;
    }

    const git = yield* Git;
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;

    const scratch = yield* fs.makeTempDirectoryScoped({
      prefix: "directorate-delta-",
    });

    const scratchFile = Effect.fnUntraced(function* scratchFile(
      name: string,
      version: Version | undefined
    ) {
      if (version === undefined) {
        return "/dev/null";
      }

      const file = paths.join(scratch, name);
      yield* fs.writeFile(file, version.buf);

      return file;
    });

    const original = yield* scratchFile("a", old);
    const file = yield* scratchFile("b", now);

    const body = (yield* git.run(
      repo,
      [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-index",
        "--",
        original,
        file,
      ],
      [0, 1]
    ))
      .replace(/\n$/u, "")
      .split("\n");

    // Use the real names and modes in place of those of the scratch files.
    const start = body.findIndex(
      (l) => l.startsWith("--- ") || l.startsWith("Binary files")
    );

    const a = shown(`a/${path}`);
    const b = shown(`b/${path}`);
    const endOfHeader = body.findIndex((l) => l.startsWith("@@"));

    const headers =
      start === -1
        ? []
        : body
            .slice(start, endOfHeader === -1 ? undefined : endOfHeader)
            .map((l) =>
              rewriteDiffHeader(l, old ? a : "/dev/null", now ? b : "/dev/null")
            );

    return [
      `diff --git ${a} ${b}`,
      ...diffModeLines(old?.mode, now?.mode),
      ...headers,
      ...(endOfHeader === -1 ? [] : body.slice(endOfHeader)),
    ];
  },
  Effect.scoped
);

/** A captured worktree entry as a version, or undefined when absent. */
const liveVersion = (e: {
  readonly buf?: Uint8Array;
  readonly mode: Parameters<typeof gitFileMode>[0];
}) =>
  e.buf === undefined
    ? undefined
    : ({ buf: e.buf, mode: gitFileMode(e.mode) } satisfies Version);

/** An untracked file as an addition or a net diff when it replaces a staged deletion. */
const untrackedPiece = Effect.fn("Directorate.untrackedPiece")(
  function* untrackedPiece(
    repo: string,
    path: string,
    base: string,
    deleted?: Piece
  ) {
    const code = deleted ? "M" : "A";

    if (exclusionReason(path)) {
      return { code, lines: [], path } satisfies Piece;
    }

    const now = liveVersion(yield* (yield* Worktree).entry(repo, path));

    if (now === undefined) {
      return deleted;
    }

    const old = deleted ? yield* baseVersion(repo, base, path) : undefined;
    const lines = yield* versionPatch(repo, path, old, now);

    return (
      lines && {
        code,
        lines: [...(deleted && !old ? deleted.lines : []), ...lines],
        path,
      }
    );
  }
);

const changeCode = (old: boolean, now: boolean) => {
  if (!old) {
    return "A";
  }

  return now ? "M" : "D";
};

/**
 * A tracked file git is told not to check (see Git.unwatched), from its base version to its captured one: git's diff shows
 * its index entry instead. `removed` diffs the source of a rename into such a file, which is deleted.
 */
const unwatchedPiece = Effect.fn("Directorate.unwatchedPiece")(
  function* unwatchedPiece(
    repo: string,
    path: string,
    base: string,
    removed = false
  ) {
    const wt = yield* Worktree;

    if (exclusionReason(path)) {
      const here = !removed && (yield* wt.present(repo, path));
      const mode = yield* baseMode(repo, base, path);

      return {
        code: changeCode(mode !== undefined, here),
        lines: [],
        path,
      } satisfies Piece;
    }

    const old = yield* baseVersion(repo, base, path);
    const now = removed ? undefined : liveVersion(yield* wt.entry(repo, path));
    const lines = yield* versionPatch(repo, path, old, now);

    return (
      lines && {
        code: changeCode(old !== undefined, now !== undefined),
        lines,
        path,
      }
    );
  }
);

/** Paths targets: every file in scope as whole-file regions, numbered in file order. Withheld files are never read. */
const capturePaths = Effect.fn("Directorate.capturePaths")(
  function* capturePaths(
    top: string,
    scope: readonly string[] | undefined,
    changed: ReadonlySet<string>
  ) {
    const git = yield* Git;
    const wt = yield* Worktree;

    const [tracked, extra] = yield* Effect.all(
      [
        git.run(top, ["ls-files", "-z", "--", ...(scope ?? [])]),
        git.untracked(top, scope),
      ],
      { concurrency: 2 }
    );

    const names = [
      ...new Set([...tracked.split("\0").filter(Boolean), ...extra]),
    ].toSorted();

    const perFile = yield* Effect.forEach(
      names,
      Effect.fnUntraced(function* perFile(path) {
        const status = changed.has(path) ? "modified" : "unchanged";

        const deleted = {
          file: FileEntry.make({
            added: 0,
            path,
            removed: 0,
            status: "deleted",
          }),
          regions: [],
        };

        const excluded = exclusionReason(path);

        if (excluded) {
          return (yield* wt.present(top, path))
            ? {
                file: FileEntry.make({
                  added: 0,
                  excluded,
                  path,
                  removed: 0,
                  status,
                }),
                regions: [],
              }
            : deleted;
        }

        const { buf, mode } = yield* wt.entry(top, path);

        if (buf === undefined) {
          return deleted;
        }

        if (mode === "gitlink" || binary(buf)) {
          return {
            file: FileEntry.make({
              added: 0,
              excluded: mode === "gitlink" ? "submodule" : "binary",
              path,
              removed: 0,
              status,
            }),
            regions: [],
          };
        }

        const text = decodeUtf8(buf);
        const lines = text.split("\n");
        const n = text.replace(/\n$/u, "").split("\n").length;

        // Numbered once every file's chunks are in, in path order.
        const regions = yield* Effect.forEach(
          Array.from(
            { length: Math.ceil(n / FILE_REGION_LINES) },
            (_, i) => i * FILE_REGION_LINES + 1
          ),
          (s) => {
            const end = Math.min(n, s + FILE_REGION_LINES - 1);

            return sha256(
              `${path}\0${s}\0${lines.slice(s - 1, end).join("\n")}`
            ).pipe(
              Effect.map((key) => ({
                file: path,
                key,
                newEnd: end,
                newStart: s,
              }))
            );
          }
        );

        return {
          file: FileEntry.make({ added: n, path, removed: 0, status }),
          regions,
        };
      }),
      { concurrency: IO_CONCURRENCY }
    );

    return {
      files: perFile.map((x) => x.file),
      regions: perFile
        .flatMap((x) => x.regions)
        .map((r, i) =>
          Region.make({
            ...r,
            id: `R${i + 1}`,
            patchEnd: 0,
            patchStart: 0,
            readBy: [],
          })
        ),
      text: "",
    } satisfies Captured;
  }
);

/**
 * Diff targets: the base→post-image diff (untracked files as additions, and `unwatched` files git's diff cannot see from
 * their captured bytes), with withheld files reduced to stubs.
 */
const captureDiff = Effect.fn("Directorate.captureDiff")(function* captureDiff(
  seal: Seal,
  scope: readonly string[] | undefined,
  unwatched: readonly string[],
  sigs: Readonly<Record<string, string>> | undefined
) {
  const git = yield* Git;
  const worktree = seal.postImage === "worktree";

  const tracked = yield* decodeRawDiff(
    yield* git.run(
      seal.repo,
      worktree
        ? [...RAW_DIFF, seal.baseSha, "--", ...(scope ?? [])]
        : [...RAW_DIFF, seal.baseSha, seal.headSha]
    )
  ).pipe(
    // A worktree can change between git's two passes; a commit pair cannot, so a mismatch there is git's, and final.
    Effect.mapError((e) =>
      worktree
        ? new CaptureDrift()
        : new CaptureFailed({
            message: `git listed different files than it diffed for ${seal.description}: ${e.message}`,
          })
    )
  );

  const untracked = worktree ? yield* git.untracked(seal.repo, scope) : [];
  const untrackedNames = new Set(untracked);

  const replacements = new Map(
    tracked
      .filter((p) => p.code === "D" && untrackedNames.has(p.path))
      .map((p) => [p.path, p])
  );

  const extra = yield* Effect.forEach(
    untracked,
    (f) => untrackedPiece(seal.repo, f, seal.baseSha, replacements.get(f)),
    { concurrency: IO_CONCURRENCY }
  );

  // Rediff paths Git reads differently from the snapshot, including files below a directory junction.
  const rediffNames = new Set([
    ...unwatched,
    ...tracked
      .filter((p) => p.code !== "D" && sigs?.[p.path] === "deleted")
      .map((p) => p.path),
  ]);

  const misread = tracked.filter((p) => rediffNames.has(p.path));

  const rediffed = yield* Effect.forEach(
    [
      ...Array.from(rediffNames, (path) => ({ path, removed: false })),
      ...misread.flatMap((p) =>
        p.code === "R" && p.oldPath !== undefined
          ? [{ path: p.oldPath, removed: true }]
          : []
      ),
    ],
    ({ path, removed }) =>
      unwatchedPiece(seal.repo, path, seal.baseSha, removed),
    { concurrency: IO_CONCURRENCY }
  );

  const { text, files } = assemble([
    ...tracked.filter(
      (p) => replacements.get(p.path) !== p && !rediffNames.has(p.path)
    ),
    ...extra.filter(Predicate.isNotUndefined),
    ...rediffed.filter(Predicate.isNotUndefined),
  ]);

  const regions = yield* buildRegions(files, text);

  return {
    files: files.map(
      ({
        hunks: _hunks,
        patchStart: _patchStart,
        patchEnd: _patchEnd,
        ...file
      }) => FileEntry.make(file)
    ),
    regions,
    text,
  } satisfies Captured;
});

/** The seal's next generation, re-pinned to ends that moved; capture fills it. */
export const repinned = (
  seal: Seal,
  ends: Pick<Seal, "baseSha" | "baseTip" | "description" | "headSha">
) =>
  seal.withContainment({
    ...ends,
    gen: seal.gen + 1,
    refreshes: seal.refreshes + 1,
  });

/**
 * The seal's ends captured into its current generation: signatures and snapshot, then the diff, file list, regions, and
 * tombstones. Worktree files are read twice: once to sign and snapshot them, once for the closing fingerprint. Any edit
 * after signing shows up as a difference between the two, which fails with CaptureDrift so the caller retries.
 */
export const capture = Effect.fn("Directorate.capture")(function* capture(
  seal: Seal,
  scope: readonly string[] | undefined,
  beforeCapture?: () => Effect.Effect<void>
) {
  const store = yield* Store;
  const wt = yield* Worktree;
  const top = seal.repo;
  const worktree = seal.postImage === "worktree";
  yield* store.resetSnapshot(seal);

  const {
    gone,
    hidden,
    names: changed,
  } = worktree
    ? yield* (yield* Git).changes(top, seal.baseSha, scope)
    : { gone: new Set<string>(), hidden: [], names: [] };

  // Sign every changed path, snapshotting those not withheld by name; a secret-like path is signed by presence, never read.
  // A path gone from the post-image is deleted, as the diff has it, whatever working copy remains.
  const signed = yield* Effect.forEach(
    changed,
    Effect.fnUntraced(function* signed(f) {
      if (gone.has(f)) {
        return [f, "deleted"] as const;
      }

      if (isSecret(f)) {
        return [f, yield* wt.signWithheld(top, f)] as const;
      }

      const e = yield* wt.entry(top, f);

      if (e.buf !== undefined && !exclusionReason(f)) {
        yield* store.writeSnapshot(seal, f, e.buf);
      }

      return [f, yield* wt.sign(e)] as const;
    }),
    { concurrency: IO_CONCURRENCY }
  );

  if (beforeCapture) {
    yield* beforeCapture();
  }

  const sigs = worktree ? Object.fromEntries(signed) : undefined;

  const { text, files, regions }: Captured =
    seal.target.kind === "paths"
      ? yield* capturePaths(top, scope, new Set(changed))
      : yield* captureDiff(seal, scope, hidden, sigs);

  // A file renamed from a withheld path is withheld too: its content came from there.
  yield* Effect.forEach(
    files.filter((f) => f.oldPath && exclusionReason(f.oldPath)),
    (f) => store.dropSnapshot(seal, f.path),
    { discard: true }
  );
  yield* store.writeDiff(seal, text);

  const deleted = [
    ...new Set([
      ...signed.filter(([, sig]) => sig === "deleted").map(([f]) => f),
      ...(seal.target.kind === "paths"
        ? files.filter((f) => f.status === "deleted").map((f) => f.path)
        : []),
    ]),
  ].toSorted();

  const fingerprint = yield* endsFingerprint(top, {
    baseSha: seal.baseSha,
    headSha: seal.headSha,
    postImage: seal.postImage,
    scope,
  });

  if (sigs && (yield* wt.fingerprintOf(seal.baseSha, sigs)) !== fingerprint) {
    return yield* new CaptureDrift();
  }

  return seal.withContainment({ deleted, files, fingerprint, regions, sigs });
});

const changedSignatures = (
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>
) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .toSorted();

/** Files that differ between the seal and `cur`; for commit pairs, "(base moved)" when the base did. */
export const changedSinceSeal = Effect.fn("Directorate.changedSinceSeal")(
  function* changedSinceSeal(
    seal: Seal,
    cur: Pick<Current, "baseSha" | "headSha" | "unfetched">
  ) {
    if (cur.unfetched) {
      return [`(${cur.unfetched})`];
    }

    if (seal.postImage === "worktree") {
      return changedSignatures(
        seal.sigs ?? {},
        yield* (yield* Worktree).sigs(
          seal.repo,
          seal.baseSha,
          scopeOf(seal.target.paths)
        )
      );
    }

    const git = yield* Git;

    const [heads, bases] = yield* Effect.all(
      [
        git.diffNames(seal.repo, seal.headSha, cur.headSha),
        git.diffNames(seal.repo, seal.baseSha, cur.baseSha),
      ],
      { concurrency: 2 }
    );

    const files = new Set([...heads, ...bases]);

    if (cur.baseSha !== seal.baseSha) {
      files.add("(base moved)");
    }

    return [...files].toSorted();
  }
);

/** Files that differ between a seal and a later capture of the same target. */
export const changedBetween = (seal: Seal, captured: Seal) =>
  seal.postImage === "worktree"
    ? Effect.succeed(changedSignatures(seal.sigs ?? {}, captured.sigs ?? {}))
    : changedSinceSeal(seal, captured);
