// Directorate sealing: capture a target's diff, snapshot, and regions into a containment seal, and re-capture it once when the code moves.
import {
  Crypto,
  Data,
  DateTime,
  Effect,
  FileSystem,
  Path,
  Predicate,
  Schema,
} from "effect";
import { Hex } from "effect/encoding";

import { depsOf } from "./content.ts";
import { assemble, buildRegions, type Piece, RawDiff, shown } from "./diff.ts";
import { failure, ReviewError } from "./error.ts";
import { exclusionReason, isSecret, scopeOf } from "./exclusions.ts";
import { Git } from "./git.ts";
import { sha256 } from "./hash.ts";
import { reopen } from "./ledger.ts";
import {
  type Actor,
  DEFAULT_BUDGET,
  type Entry,
  type FileEntry,
  type Ledger,
  type Mode,
  PANEL_BUDGET_FACTOR,
  type Region,
  type Seal,
  type Target,
  REVIEWER,
} from "./model.ts";
import { emptyLedger, Store } from "./store.ts";
import {
  type Current,
  currentFingerprint,
  endsFingerprint,
  resolveEnds,
} from "./target.ts";
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

const binary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);
type Captured = {
  text: string;
  files: readonly FileEntry[];
  regions: readonly Region[];
};

/** An untracked file as an addition or a net diff when it replaces a staged deletion. */
const untrackedPiece = Effect.fn("Directorate.untrackedPiece")(function* (
  repo: string,
  path: string,
  base: string,
  deleted?: Piece
) {
  const code = deleted ? "M" : "A";
  if (exclusionReason(path)) return { code, path, lines: [] } satisfies Piece;
  const { buf, mode } = yield* (yield* Worktree).entry(repo, path);
  if (buf === undefined) return deleted;
  const git = yield* Git;
  const old = deleted ? yield* git.blob(repo, base, path) : undefined;
  const oldMode = deleted?.lines
    .find((line) => line.startsWith("deleted file mode "))
    ?.slice("deleted file mode ".length);
  const newMode =
    mode === "link" ? "120000" : mode === "exec" ? "100755" : "100644";
  const sameBytes = old?.equals(
    oldMode === "120000" && mode === "link"
      ? buf.subarray("symlink -> ".length, -1)
      : buf
  );
  if (sameBytes && oldMode === newMode) return undefined;

  // Diff the captured bytes, not the live path, so a symlink stays its link text.
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const scratch = yield* fs.makeTempDirectoryScoped({
    prefix: "directorate-delta-",
  });
  const file = paths.join(scratch, "b");
  const original = old ? paths.join(scratch, "a") : "/dev/null";
  yield* fs.writeFile(file, buf);
  if (old) yield* fs.writeFile(original, old);
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
    .replace(/\n$/, "")
    .split("\n");
  // Use the real names and modes in place of those of the scratch files.
  const start = body.findIndex(
    (l) => l.startsWith("--- ") || l.startsWith("Binary files")
  );
  const a = shown(`a/${path}`);
  const b = shown(`b/${path}`);
  const from = old ? a : "/dev/null";
  const endOfHeader = body.findIndex((l) => l.startsWith("@@"));
  const headers =
    start < 0
      ? []
      : body
          .slice(start, endOfHeader < 0 ? undefined : endOfHeader)
          .map((l) =>
            l.startsWith("--- ")
              ? `--- ${from}`
              : l.startsWith("+++ ")
                ? `+++ ${b}`
                : l.startsWith("Binary files ")
                  ? `Binary files ${from} and ${b} differ`
                  : l
          );
  return {
    code,
    path,
    lines: [
      ...(deleted && !old ? deleted.lines : []),
      `diff --git ${a} ${b}`,
      ...(!old
        ? [`new file mode ${newMode}`]
        : oldMode === newMode
          ? []
          : [`old mode ${oldMode}`, `new mode ${newMode}`]),
      ...headers,
      ...(endOfHeader < 0 ? [] : body.slice(endOfHeader)),
    ],
  } satisfies Piece;
}, Effect.scoped);

/** Paths targets: every file in scope as whole-file regions, numbered in file order. Withheld files are never read. */
const capturePaths = Effect.fn("Directorate.capturePaths")(function* (
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
  ].sort();
  const perFile = yield* Effect.forEach(
    names,
    Effect.fnUntraced(function* (path) {
      const status = changed.has(path) ? "modified" : "unchanged";
      const deleted = {
        file: {
          path,
          status: "deleted",
          added: 0,
          removed: 0,
        } satisfies FileEntry,
        regions: [],
      };
      const excluded = exclusionReason(path);
      if (excluded)
        return (yield* wt.present(top, path))
          ? {
              file: {
                path,
                status,
                added: 0,
                removed: 0,
                excluded,
              } satisfies FileEntry,
              regions: [],
            }
          : deleted;
      const { buf } = yield* wt.entry(top, path);
      if (buf === undefined) return deleted;
      if (binary(buf))
        return {
          file: {
            path,
            status,
            added: 0,
            removed: 0,
            excluded: "binary",
          } satisfies FileEntry,
          regions: [],
        };
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      const n = text.replace(/\n$/, "").split("\n").length;
      const regions: Omit<Region, "id">[] = [];
      for (let s = 1; s <= n; s += FILE_REGION_LINES) {
        const end = Math.min(n, s + FILE_REGION_LINES - 1);
        regions.push({
          file: path,
          newStart: s,
          newEnd: end,
          patchStart: 0,
          patchEnd: 0,
          readBy: [],
          key: yield* sha256(
            `${path}\0${s}\0${lines.slice(s - 1, end).join("\n")}`
          ),
        });
      }
      return {
        file: { path, status, added: n, removed: 0 } satisfies FileEntry,
        regions,
      };
    }),
    { concurrency: IO_CONCURRENCY }
  );
  return {
    text: "",
    files: perFile.map((x): FileEntry => x.file),
    regions: perFile
      .flatMap((x) => x.regions)
      .map((r, i) => ({ id: `R${i + 1}`, ...r })),
  } satisfies Captured;
});

/** Diff targets: the base→post-image diff (untracked files as additions), with withheld files reduced to stubs. */
const captureDiff = Effect.fn("Directorate.captureDiff")(function* (
  seal: Seal,
  scope: readonly string[] | undefined
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
  const { text, files } = assemble([
    ...tracked.filter((p) => replacements.get(p.path) !== p),
    ...extra.filter(Predicate.isNotUndefined),
  ]);
  const regions = yield* buildRegions(files, text);
  return {
    text,
    files: files.map(
      ({ hunks, patchStart, patchEnd, ...file }): FileEntry => file
    ),
    regions,
  } satisfies Captured;
});

/**
 * The seal's ends captured into its current generation: signatures and snapshot, then the diff, file list, regions, and
 * tombstones. Worktree files are read twice: once to sign and snapshot them, once for the closing fingerprint. Any edit
 * after signing shows up as a difference between the two, which fails with CaptureDrift so the caller retries.
 */
const capture = Effect.fn("Directorate.capture")(function* (
  seal: Seal,
  scope: readonly string[] | undefined,
  beforeCapture?: () => Effect.Effect<void>
) {
  const store = yield* Store;
  const wt = yield* Worktree;
  const top = seal.repo;
  const worktree = seal.postImage === "worktree";
  yield* store.resetSnapshot(seal);
  const changed = worktree
    ? yield* (yield* Git).changedNames(top, seal.baseSha, scope)
    : [];
  // Sign every changed non-secret path, snapshotting those not withheld by name.
  const signed = yield* Effect.forEach(
    changed.filter((f) => !isSecret(f)),
    Effect.fnUntraced(function* (f) {
      const e = yield* wt.entry(top, f);
      if (e.buf !== undefined && !exclusionReason(f))
        yield* store.writeSnapshot(seal, f, e.buf);
      return [f, yield* wt.sign(e)] as const;
    }),
    { concurrency: IO_CONCURRENCY }
  );
  if (beforeCapture) yield* beforeCapture();
  const { text, files, regions }: Captured =
    seal.target.kind === "paths"
      ? yield* capturePaths(top, scope, new Set(changed))
      : yield* captureDiff(seal, scope);
  // A file renamed from a withheld path is withheld too: its content came from there.
  yield* Effect.forEach(
    files.filter((f) => f.oldPath && exclusionReason(f.oldPath)),
    (f) => store.dropSnapshot(seal, f.path),
    { discard: true }
  );
  yield* store.writeDiff(seal, text);
  const sigs = worktree ? Object.fromEntries(signed) : undefined;
  // Secret paths have no signatures; check presence without reading their bytes.
  const absentSecrets = yield* Effect.filter(
    changed.filter(isSecret),
    (path) => wt.present(top, path).pipe(Effect.map((present) => !present)),
    { concurrency: IO_CONCURRENCY }
  );
  const deleted = [
    ...new Set([
      ...signed.filter(([, sig]) => sig === "deleted").map(([f]) => f),
      ...absentSecrets,
      ...(seal.target.kind === "paths"
        ? files.filter((f) => f.status === "deleted").map((f) => f.path)
        : []),
    ]),
  ].sort();
  const fingerprint = yield* endsFingerprint(top, {
    postImage: seal.postImage,
    baseSha: seal.baseSha,
    headSha: seal.headSha,
    scope,
  });
  if (sigs && (yield* wt.fingerprintOf(seal.baseSha, sigs)) !== fingerprint)
    return yield* new CaptureDrift();
  return { ...seal, files, regions, sigs, deleted, fingerprint } satisfies Seal;
});

/** A new seal's id: its creation time, and a random suffix. */
const sealId = Effect.fnUntraced(function* (createdAt: DateTime.Utc) {
  const suffix = Hex.encode(yield* (yield* Crypto.Crypto).randomBytes(3));
  return `directorate-${DateTime.formatIso(createdAt)
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14)}-${suffix}`;
});

/** A commit pair's description with the ends it moved to; a worktree's description does not name them. */
const describedAt = (seal: Seal, cur: Pick<Current, "baseSha" | "headSha">) =>
  seal.postImage === "commit"
    ? seal.description.replace(
        /\(([^()]*?)[0-9a-f]{10} → [0-9a-f]{10}\)/,
        `($1${cur.baseSha.slice(0, 10)} → ${cur.headSha.slice(0, 10)})`
      )
    : seal.description;

export const createSeal = Effect.fn("Directorate.createSeal")(
  function* (input: {
    repo: string;
    mode: Mode;
    target: Target;
    owner?: Actor;
    budgetMinutes?: number;
    question?: string;
    panel?: readonly string[];
    lensesOff?: readonly string[];
    beforeCapture?: () => Effect.Effect<void>;
  }) {
    const store = yield* Store;
    const top = yield* (yield* Git).root(input.repo);
    const createdAt = yield* DateTime.now;
    const id = yield* sealId(createdAt);
    const panel = input.panel?.length ? [...new Set(input.panel)] : undefined;
    const budgetMinutes =
      input.budgetMinutes ??
      DEFAULT_BUDGET[input.mode] * (panel ? PANEL_BUDGET_FACTOR : 1);
    // Each attempt re-resolves the ends, then captures; files changing mid-capture retry the whole attempt.
    return yield* store.create(
      id,
      Effect.gen(function* () {
        const ends = yield* resolveEnds(top, input.target);
        const seal = yield* capture(
          {
            id,
            repo: top,
            owner: input.owner?.agent ?? REVIEWER,
            ownerSession: input.owner?.session ?? "",
            mode: input.mode,
            target: ends.target,
            description: ends.description,
            baseSha: ends.baseSha,
            headSha: ends.headSha,
            baseTip: ends.baseTip,
            postImage: ends.postImage,
            fingerprint: "",
            gen: 0,
            createdAt,
            deadline: DateTime.add(createdAt, { minutes: budgetMinutes }),
            budgetMinutes,
            refreshes: 0,
            files: [],
            regions: [],
            deleted: [],
            children: [],
            gates: {},
            question: input.question,
            panel,
            lensesOff: input.lensesOff,
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
    .sort();

/** Files that differ between the seal and `cur`; for commit pairs, "(base moved)" when the base did. */
export const changedSinceSeal = Effect.fn("Directorate.changedSinceSeal")(
  function* (
    seal: Seal,
    cur: Pick<Current, "baseSha" | "headSha" | "unfetched">
  ) {
    if (cur.unfetched) return [`(${cur.unfetched})`];
    if (seal.postImage === "worktree")
      return changedSignatures(
        seal.sigs ?? {},
        yield* (yield* Worktree).sigs(
          seal.repo,
          seal.baseSha,
          scopeOf(seal.target.paths)
        )
      );
    const git = yield* Git;
    const [heads, bases] = yield* Effect.all(
      [
        git.diffNames(seal.repo, seal.headSha, cur.headSha),
        git.diffNames(seal.repo, seal.baseSha, cur.baseSha),
      ],
      { concurrency: 2 }
    );
    const files = new Set([...heads, ...bases]);
    if (cur.baseSha !== seal.baseSha) files.add("(base moved)");
    return [...files].sort();
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
      ? { hit: hit.length > 0, gone, files: hit.join(", ") || "base moved" }
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
  const byKey = new Map(
    from.flatMap((r) => (r.key && keep(r) ? [[r.key, r] as const] : []))
  );
  return onto.map((r): Region => {
    const p = r.key ? byKey.get(r.key) : undefined;
    return p
      ? {
          ...r,
          ownerRead: p.ownerRead,
          readBy: p.readBy,
          disposition: p.disposition,
          note: p.note,
        }
      : r;
  });
};

/**
 * Re-pins a moved target into the seal's next generation. Regions whose content did not change keep their read receipts
 * and dispositions; entries whose anchor or evidence changed reopen. Both are saved, and returned.
 */
export const refreshSeal = Effect.fn("Directorate.refreshSeal")(function* (
  seal: Seal,
  ledger: Ledger,
  beforeCapture?: () => Effect.Effect<void>
) {
  const unchanged = {
    seal,
    ledger,
    files: [] as string[],
    newRegions: [] as Region[],
    reopened: [] as string[],
  };
  const cur = yield* currentFingerprint(seal).pipe(
    Effect.mapError(
      (e) =>
        new ReviewError({ message: `Cannot check freshness: ${e.message}` })
    )
  );
  if (cur.unfetched)
    return yield* failure(
      `${cur.unfetched}. Ask the user to fetch it, or call directorate_report to report the review as stale.`
    );
  if (cur.fingerprint === seal.fingerprint) return unchanged;
  const captured = yield* capture(
    {
      ...seal,
      gen: seal.gen + 1,
      refreshes: seal.refreshes + 1,
      staleFiles: undefined,
      gates: {},
      baseSha: cur.baseSha,
      headSha: cur.headSha,
      baseTip: cur.baseTip ?? seal.baseTip,
      description: describedAt(seal, cur),
    },
    scopeOf(seal.target.paths),
    beforeCapture
  ).pipe(
    settled(
      "Files kept changing during refresh (3 attempts). Wait until edits stop, then call directorate_refresh again."
    )
  );
  if (captured.fingerprint === seal.fingerprint) return unchanged;
  const changed = new Set(yield* changedBetween(seal, captured));
  const regions = carryRegions(seal.regions, captured.regions);
  const moved = movedUnder(seal, captured, changed);
  const reopened: string[] = [];
  const entries = ledger.entries.map((e) => {
    const why = moved(e);
    if (!why || (e.status === "refuted" && !why.hit)) return e;
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
    seal: next,
    ledger: nextLedger,
    files: [...changed],
    newRegions: regions.filter((r) => !r.ownerRead && !r.disposition),
    reopened,
  };
});
