// Directorate sealing: capture a target's diff, snapshot, and regions into a containment seal, and re-capture it once when the code moves.
import {
  Bytes,
  Data,
  DateTime,
  Effect,
  FileSystem,
  Match,
  Option,
  Path,
  Predicate,
  Schema,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { Hex } from "effect/encoding";

import { unansweredQuestions } from "./children.ts";
import { depsOf, inDependencyDir, readable } from "./content.ts";
import { isRead } from "./coverage.ts";
import { assemble, buildRegions, RawDiff, shown } from "./diff.ts";
import type { Piece } from "./diff.ts";
import { failure, ReviewError } from "./error.ts";
import { exclusionReason, isSecret, scopeOf } from "./exclusions.ts";
import { Git } from "./git.ts";
import { sha256 } from "./hash.ts";
import { Host } from "./host.ts";
import { reopen, unresolved } from "./ledger.ts";
import { DEFAULT_BUDGET, PANEL_BUDGET_FACTOR, REVIEWER } from "./model.ts";
import type {
  Actor,
  Entry,
  FileEntry,
  Ledger,
  Mode,
  Region,
  Seal,
  Target,
} from "./model.ts";
import { ProcessIdentity } from "./process-identity.ts";
import { emptyLedger, Store } from "./store.ts";
import { currentFingerprint, endsFingerprint, resolveEnds } from "./target.ts";
import type { Current } from "./target.ts";
import { decodeUtf8 } from "./utf8.ts";
import { Worktree } from "./worktree.ts";

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
class CaptureDrift extends Data.TaggedError("DirectorateCaptureDrift") {}

/** Retries a capture twice when files change mid-capture, then fails with `message`. */
const settled =
  (message: string) =>
  <A, E, R>(self: Effect.Effect<A, E | CaptureDrift, R>) =>
    self.pipe(
      Effect.retry({
        times: 2,
        while: (e) => Predicate.isTagged(e, "DirectorateCaptureDrift"),
      }),
      Effect.catchTag("DirectorateCaptureDrift", () => failure(message))
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
          file: {
            added: 0,
            path,
            removed: 0,
            status: "deleted",
          } satisfies FileEntry,
          regions: [],
        };

        const excluded = exclusionReason(path);

        if (excluded) {
          return (yield* wt.present(top, path))
            ? {
                file: {
                  added: 0,
                  excluded,
                  path,
                  removed: 0,
                  status,
                } satisfies FileEntry,
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
            file: {
              added: 0,
              excluded: mode === "gitlink" ? "submodule" : "binary",
              path,
              removed: 0,
              status,
            } satisfies FileEntry,
            regions: [],
          };
        }

        const text = decodeUtf8(buf);
        const lines = text.split("\n");
        const n = text.replace(/\n$/u, "").split("\n").length;
        const regions: Omit<Region, "id">[] = [];

        for (let s = 1; s <= n; s += FILE_REGION_LINES) {
          const end = Math.min(n, s + FILE_REGION_LINES - 1);
          regions.push({
            file: path,
            key: yield* sha256(
              `${path}\0${s}\0${lines.slice(s - 1, end).join("\n")}`
            ),
            newEnd: end,
            newStart: s,
            patchEnd: 0,
            patchStart: 0,
            readBy: [],
          });
        }

        return {
          file: { added: n, path, removed: 0, status } satisfies FileEntry,
          regions,
        };
      }),
      { concurrency: IO_CONCURRENCY }
    );

    return {
      files: perFile.map((x): FileEntry => x.file),
      regions: perFile
        .flatMap((x) => x.regions)
        .map((r, i) => ({ id: `R${i + 1}`, ...r })),
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
        : new ReviewError({
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
      }): FileEntry => file
    ),
    regions,
    text,
  } satisfies Captured;
});

/**
 * The seal's ends captured into its current generation: signatures and snapshot, then the diff, file list, regions, and
 * tombstones. Worktree files are read twice: once to sign and snapshot them, once for the closing fingerprint. Any edit
 * after signing shows up as a difference between the two, which fails with CaptureDrift so the caller retries.
 */
const capture = Effect.fn("Directorate.capture")(function* capture(
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

  return { ...seal, deleted, files, fingerprint, regions, sigs } satisfies Seal;
});

/** A new seal's id: its creation time, and a random suffix. */
const sealId = Effect.fnUntraced(function* sealId(createdAt: DateTime.Utc) {
  const suffix = Hex.encode(
    yield* (yield* SecureRandom.SecureRandom).randomBytes(3)
  );

  return `directorate-${DateTime.formatIso(createdAt)
    .replaceAll(/[-:TZ.]/gu, "")
    .slice(0, 14)}-${suffix}`;
});

/** A commit pair's description with the ends it moved to; a worktree's description does not name them. */
const describedAt = (seal: Seal, cur: Pick<Current, "baseSha" | "headSha">) =>
  seal.postImage === "commit"
    ? seal.description.replace(
        /\((?<prefix>[^()]*?)[0-9a-f]{10} → [0-9a-f]{10}\)/u,
        `($1${cur.baseSha.slice(0, 10)} → ${cur.headSha.slice(0, 10)})`
      )
    : seal.description;

/** The sealing OpenCode instance's directory, if sealed inside one. */
const hostDirectory = Effect.serviceOption(Host).pipe(
  Effect.map((h) => Option.getOrUndefined(h)?.location.directory)
);

export const createSeal = Effect.fn("Directorate.createSeal")(
  function* createSeal(input: {
    repo: string;
    mode: Mode;
    target: Target;
    owner?: Actor;
    budgetMinutes?: number | undefined;
    question?: string | undefined;
    panel?: readonly string[] | undefined;
    lensesOff?: readonly string[] | undefined;
    beforeCapture?: () => Effect.Effect<void>;
  }) {
    const store = yield* Store;
    const top = yield* (yield* Git).root(input.repo);
    const host = yield* hostDirectory;
    const { pid } = yield* ProcessIdentity;
    const createdAt = yield* DateTime.now;
    const id = yield* sealId(createdAt);
    const panel = input.panel?.length ? [...new Set(input.panel)] : undefined;

    const budgetMinutes =
      input.budgetMinutes ??
      DEFAULT_BUDGET[input.mode] * (panel ? PANEL_BUDGET_FACTOR : 1);

    // Each attempt re-resolves the ends, then captures; files changing mid-capture retry the whole attempt.
    return yield* store.create(
      id,
      Effect.gen(function* attempt() {
        const ends = yield* resolveEnds(top, input.target);

        const seal = yield* capture(
          {
            baseSha: ends.baseSha,
            baseTip: ends.baseTip,
            budgetMinutes,
            children: [],
            createdAt,
            deadline: DateTime.add(createdAt, { minutes: budgetMinutes }),
            deleted: [],
            description: ends.description,
            files: [],
            fingerprint: "",
            gates: {},
            gen: 0,
            headSha: ends.headSha,
            host,
            id,
            lensesOff: input.lensesOff,
            mode: input.mode,
            owner: input.owner?.agent ?? REVIEWER,
            ownerSession: input.owner?.session ?? "",
            panel,
            pid,
            postImage: ends.postImage,
            question: input.question,
            refreshes: 0,
            regions: [],
            repo: top,
            target: ends.target,
          },
          ends.scope,
          input.beforeCapture
        );

        yield* store.saveBoth(seal, emptyLedger);

        return seal;
      }).pipe(
        settled(
          "Files kept changing while sealing (3 attempts). Wait until edits stop, then seal again."
        )
      )
    );
  }
);

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

/** What `next` changed in the files an entry rests on, judged against `before`; undefined when nothing it rests on moved. */
const movedUnder = (before: Seal, next: Seal, changed: ReadonlySet<string>) => {
  const inChange = new Set(
    next.files.filter((f) => f.status !== "unchanged").map((f) => f.path)
  );

  return (e: Entry) => {
    const hit = [...depsOf(e)].filter((d) => changed.has(d));

    const gone =
      e.anchor.side === "new" &&
      before.files.some(
        (f) => f.path === e.anchor.path && f.status !== "unchanged"
      ) &&
      !inChange.has(e.anchor.path);

    const baseMoved = e.anchor.side === "old" && changed.has("(base moved)");

    return hit.length || gone || baseMoved
      ? { files: hit.join(", ") || "base moved", gone, hit: hit.length > 0 }
      : undefined;
  };
};

/** Files that differ between a seal and a later capture of the same target. */
const changedBetween = (seal: Seal, captured: Seal) =>
  seal.postImage === "worktree"
    ? Effect.succeed(changedSignatures(seal.sigs ?? {}, captured.sigs ?? {}))
    : changedSinceSeal(seal, captured);

/** Captured regions, with the receipts and dispositions of the `from` regions (those `keep` accepts) whose content they repeat. */
const carryRegions = (
  from: readonly Region[],
  onto: readonly Region[],
  keep: (r: Region) => boolean = () => true
) => {
  const byKey = Map.groupBy(from, (r) => r.key);
  const matches = new Map<Region, Region>();

  for (const [key, regions] of Map.groupBy(onto, (r) => r.key)) {
    const previous = key ? byKey.get(key) : undefined;

    // Identical chunks have the same key. Pair occurrences in order, including unread ones;
    // if their counts changed, none can be matched unambiguously.
    if (previous?.length === regions.length) {
      for (const [i, r] of regions.entries()) {
        const p = previous[i];

        if (p && keep(p)) {
          matches.set(r, p);
        }
      }
    }
  }

  return onto.map((r): Region => {
    const p = matches.get(r);

    return p
      ? {
          ...r,
          disposition: p.disposition,
          note: p.note,
          ownerRead: p.ownerRead,
          readBy: p.readBy,
        }
      : r;
  });
};

interface RefreshResult {
  files: string[];
  ledger: Ledger;
  newRegions: Region[];
  reopened: string[];
  seal: Seal;
}

/**
 * Re-pins a moved target into the seal's next generation. Regions whose content did not change keep their read receipts
 * and dispositions; entries whose anchor or evidence changed reopen. Both are saved, and returned.
 */
export const refreshSeal = Effect.fn("Directorate.refreshSeal")(
  function* refreshSeal(
    seal: Seal,
    ledger: Ledger,
    beforeCapture?: () => Effect.Effect<void>
  ) {
    const unchanged: RefreshResult = {
      files: [],
      ledger,
      newRegions: [],
      reopened: [],
      seal,
    };

    const cur = yield* currentFingerprint(seal).pipe(
      Effect.mapError(
        (e) =>
          new ReviewError({ message: `Cannot check freshness: ${e.message}` })
      )
    );

    if (cur.unfetched) {
      return yield* failure(
        `${cur.unfetched}. Ask the user to fetch it, or call directorate_report to report the review as stale.`
      );
    }

    if (cur.fingerprint === seal.fingerprint) {
      return unchanged;
    }

    const captured = yield* capture(
      {
        ...seal,
        baseSha: cur.baseSha,
        baseTip: cur.baseTip ?? seal.baseTip,
        description: describedAt(seal, cur),
        gates: {},
        gen: seal.gen + 1,
        headSha: cur.headSha,
        refreshes: seal.refreshes + 1,
        staleFiles: undefined,
      },
      scopeOf(seal.target.paths),
      beforeCapture
    ).pipe(
      settled(
        "Files kept changing during refresh (3 attempts). Wait until edits stop, then call directorate_refresh again."
      )
    );

    if (captured.fingerprint === seal.fingerprint) {
      return unchanged;
    }

    const changed = new Set(yield* changedBetween(seal, captured));
    const regions = carryRegions(seal.regions, captured.regions);
    const moved = movedUnder(seal, captured, changed);
    const reopened: string[] = [];

    const entries = ledger.entries.map((e) => {
      const why = moved(e);

      if (!why || (e.status === "refuted" && !why.hit)) {
        return e;
      }

      reopened.push(e.id);

      return reopen(
        e,
        why.gone
          ? `${e.anchor.path} is no longer part of the change; re-verify or refute`
          : `code changed after the seal (${why.files}); re-verify and re-anchor`
      );
    });

    const next = { ...captured, regions };
    const nextLedger = { ...ledger, entries };
    yield* (yield* Store).saveBoth(next, nextLedger);

    return {
      files: [...changed],
      ledger: nextLedger,
      newRegions: regions.filter((r) => !r.ownerRead && !r.disposition),
      reopened,
      seal: next,
    };
  }
);

/** A re-check's budget when the caller names none: half its mode's default, at least RECHECK_MIN_MINUTES. */
const RECHECK_MIN_MINUTES = 10;

/** Only a reported review can be re-checked; an unreported one is resumed. */
export const recheckable = (prior: Seal) =>
  prior.reportedAt
    ? Effect.void
    : failure(
        `${prior.id} has not been reported. Resume it with resume: "${prior.id}" instead of re-checking it.`
      );

/**
 * A new review of a reported seal's target as it stands now, while the reported Directive is left as it was. The base is
 * kept, so committing fixes is not a new change. Regions read in the earlier review whose content did not change keep
 * their receipts; skimmed and skipped ones are read again. Its verified findings and unverified leads carry over as new
 * entries: open again where the code they rest on changed (or always, for leads), still confirmed where it did not. A
 * re-check runs without a panel: it is a targeted pass, not a second independent review.
 */
export const recheckSeal = Effect.fn("Directorate.recheckSeal")(
  function* recheckSeal(input: {
    prior: Seal;
    ledger: Ledger;
    owner?: Actor;
    budgetMinutes?: number | undefined;
    question?: string | undefined;
    beforeCapture?: () => Effect.Effect<void>;
  }) {
    const { prior } = input;
    yield* recheckable(prior);
    const store = yield* Store;
    const host = yield* hostDirectory;
    const { pid } = yield* ProcessIdentity;
    const createdAt = yield* DateTime.now;
    const id = yield* sealId(createdAt);

    const budgetMinutes =
      input.budgetMinutes ??
      Math.max(RECHECK_MIN_MINUTES, Math.round(DEFAULT_BUDGET[prior.mode] / 2));

    return yield* store.create(
      id,
      Effect.gen(function* attempt() {
        // A worktree seal keeps its base (committed fixes are not a new change) but records the HEAD it now sits on;
        // only commit pairs re-resolve both ends.
        const cur: Pick<Current, "baseSha" | "headSha" | "baseTip"> =
          prior.postImage === "worktree"
            ? {
                baseSha: prior.baseSha,
                headSha: yield* (yield* Git).head(prior.repo),
              }
            : yield* currentFingerprint(prior).pipe(
                Effect.mapError(
                  (e) =>
                    new ReviewError({
                      message: `Cannot re-resolve ${prior.id}'s target: ${e.message}`,
                    })
                ),
                Effect.filterOrElse(
                  (c) => !c.unfetched,
                  (c) =>
                    failure(
                      `${c.unfetched}. Ask the user to fetch it, then re-check again.`
                    )
                )
              );

        const captured = yield* capture(
          {
            baseSha: cur.baseSha,
            baseTip: cur.baseTip ?? prior.baseTip,
            budgetMinutes,
            children: [],
            createdAt,
            deadline: DateTime.add(createdAt, { minutes: budgetMinutes }),
            deleted: [],
            description: describedAt(prior, cur),
            files: [],
            fingerprint: "",
            gates: {},
            gen: 0,
            headSha: cur.headSha,
            host,
            id,
            lensesOff: prior.lensesOff,
            mode: prior.mode,
            owner: input.owner?.agent ?? REVIEWER,
            ownerSession: input.owner?.session ?? "",
            pid,
            postImage: prior.postImage,
            question: input.question ?? prior.question,
            recheckOf: prior.id,
            refreshes: 0,
            regions: [],
            repo: prior.repo,
            target: prior.target,
          },
          scopeOf(prior.target.paths),
          input.beforeCapture
        );

        const changed = new Set(yield* changedBetween(prior, captured));

        const seal: Seal = {
          ...captured,
          regions: carryRegions(prior.regions, captured.regions, isRead),
        };

        const moved = movedUnder(prior, captured, changed);
        const open = new Set(unresolved(input.ledger));
        const reopened: string[] = [];
        const kept: string[] = [];

        // Installed dependencies are read live from disk, outside any seal, so Git cannot say whether they changed:
        // a confirmed finding that cites one is re-decided. One that is gone now counts as changed.
        const live = new Set(
          yield* Effect.filter(
            new Set(
              input.ledger.entries
                .filter((e) => e.status === "confirmed")
                .flatMap((e) => [...depsOf(e)].filter(inDependencyDir))
            ),
            (d) =>
              readable(seal, d).pipe(
                Effect.map((r) => r.live),
                Effect.orElseSucceed(() => true)
              ),
            { concurrency: IO_CONCURRENCY }
          )
        );

        // What the earlier review left behind: verified findings, and entries filed but never cleared.
        const entries = input.ledger.entries.flatMap((e): Entry[] => {
          let status: "confirmed" | "unverified" | undefined;

          if (e.status === "confirmed") {
            status = "confirmed";
          } else if (open.has(e)) {
            status = "unverified";
          }

          if (!status) {
            return [];
          }

          const carried: Entry = {
            ...e,
            carried: { id: e.id, status },
            id: `F${reopened.length + kept.length + 1}`,
          };

          const why = moved(e);
          const onDisk = [...depsOf(e)].filter((d) => live.has(d));

          if (status === "confirmed" && !why && !onDisk.length) {
            kept.push(carried.id);

            return [carried];
          }

          reopened.push(carried.id);

          let reason: string;

          if (status === "unverified") {
            reason = `unverified in ${prior.id}; decide it on the current code`;
          } else if (why?.gone) {
            reason = `${e.anchor.path} is no longer part of the change since ${prior.id}; decide whether it is resolved`;
          } else if (why) {
            reason = `code it rests on changed since ${prior.id} (${why.files}); decide whether it is still present (re-anchor) or resolved`;
          } else {
            reason = `it rests on installed dependencies read from disk (${onDisk.join(", ")}), which may have changed since ${prior.id}; decide whether it is still present (re-anchor) or resolved`;
          }

          return [reopen(carried, reason)];
        });

        const ledger: Ledger = { entries, notes: [] };
        yield* store.saveBoth(seal, ledger);

        return {
          files: [...changed],
          kept,
          ledger,
          reopened,
          seal,
          // Explicit notes, and Auditor questions the earlier review left without an answer.
          unanswered: [
            ...new Set([
              ...input.ledger.notes
                .filter((n) => n.kind === "unanswered")
                .map((n) => n.text),
              ...unansweredQuestions(prior, input.ledger),
            ]),
          ],
        };
      }).pipe(
        settled(
          "Files kept changing while sealing (3 attempts). Wait until edits stop, then seal again."
        )
      )
    );
  }
);
