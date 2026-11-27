// The records repository: one directory per seal under the state root, holding seal.json, ledger.json, each generation's
// diff and snapshot, the report, the cross-process mutation lock, and, between a pair commit's steps, commit.json.
import {
  Context,
  Effect,
  Exit,
  FileSystem,
  Function,
  Layer,
  Path,
  Schema,
} from "effect";

import { Ledger, LedgerJson } from "../feature/ledger/entry.ts";
import { orWarn, recover } from "../platform/error.ts";
import { IO_CONCURRENCY, isDirectory } from "../platform/platform.ts";
import { SealJson } from "../seal/record.ts";
import type { Seal } from "../seal/record.ts";
import { asSealId, isSealId } from "../seal/seal-id.ts";
import type { SealId } from "../seal/seal-id.ts";
import { mutationLocks } from "./locks.ts";
import { mtimeOf, retentionOf } from "./retention.ts";
import { StateRoot } from "./state-root.ts";

/** The files a review keeps by name, beside each generation's patch and snapshot. */
const RecordFileSchema = Schema.Literals([
  "seal.json",
  "ledger.json",
  "report.md",
]);

export const isRecordFile = Schema.is(RecordFileSchema);

/** A generation's diff: diff.patch for the first, diff.g<N>.patch after a refresh. */
export const diffName = (gen: number) =>
  gen ? `diff.g${gen}.patch` : "diff.patch";

/** A generation's snapshot directory: snapshot for the first, snapshot.g<N> after a refresh. */
export const snapshotName = (gen: number) =>
  gen ? `snapshot.g${gen}` : "snapshot";

const GENERATION =
  /^(?:diff(?:\.g(?<diff>\d+))?\.patch|snapshot(?:\.g(?<snapshot>\d+))?)$/u;

/** The generation a diffName or snapshotName names; undefined for other names. */
export const generationOf = (name: string) => {
  const groups = GENERATION.exec(name)?.groups;

  return groups && Number(groups.diff ?? groups.snapshot ?? 0);
};

/** Whether a missing ledger is damage (a reported review always has one) or an empty dossier. */
const LedgerDemandSchema = Schema.Struct({ required: Schema.Boolean });

/** Which seals to list: those of one repository, and at most how many. */
const ListFilterSchema = Schema.Struct({
  limit: Schema.optionalKey(Schema.Finite),
  repo: Schema.optionalKey(Schema.String),
});

const decodeSeal = Schema.decodeEffect(SealJson);
const decodeLedger = Schema.decodeEffect(LedgerJson);

/**
 * commit.json: a ledger and seal written together, as the texts their files receive. Written whole, it is the pair's
 * commit point: while it exists, reads take both files from it, and the next lock holder finishes replacing them.
 * Absent when no pair write is in flight.
 */
const PendingCommit = Schema.fromJsonString(
  Schema.Struct({ ledger: Schema.String, seal: Schema.String })
);

const decodePending = Schema.decodeEffect(PendingCommit);
const encodePending = Schema.encodeEffect(PendingCommit);

// Encoding validates too: a malformed in-memory seal or ledger is a bug, never a file on disk.
const encodeSeal = (s: Seal) =>
  Schema.encodeEffect(SealJson)(s).pipe(Effect.orDie);

const encodeLedger = (l: Ledger) =>
  Schema.encodeEffect(LedgerJson)(l).pipe(Effect.orDie);

export const emptyLedger = Ledger.make({ entries: [], notes: [] });

/**
 * No seal by that id: a malformed id (with a `hint` saying what to do instead), or one with no record under the state
 * `root` searched.
 */
class SealNotFound extends Schema.TaggedError<
  SealNotFound,
  { readonly brand: unique symbol }
>()("SealNotFound", {
  hint: Schema.optional(Schema.String),
  id: Schema.String,
  root: Schema.optional(Schema.String),
}) {
  override get message() {
    return this.root === undefined
      ? `Unknown seal id "${this.id}". ${this.hint ?? ""}`
      : `Seal ${this.id} not found under ${this.root}.`;
  }
}

/**
 * A review record that exists, or must, cannot be read: unreadable, missing, or failing its schema. `what` says which
 * record and how; `detail` is the underlying failure, if any.
 */
class RecordDamaged extends Schema.TaggedError<
  RecordDamaged,
  { readonly brand: unique symbol }
>()("RecordDamaged", {
  detail: Schema.optional(Schema.String),
  id: Schema.String,
  what: Schema.String,
}) {
  override get message() {
    return this.detail === undefined
      ? this.what
      : `${this.what}: ${this.detail}`;
  }
}

/** What a caller hands a seal id to: the door, which changes the review, or a lookup, which only reads the seal. */
const SealUseSchema = Schema.Literals(["door", "lookup"]);

/** What to do instead, for a malformed seal id handed to each. */
const UNKNOWN_SEAL_HINTS = Schema.Record(SealUseSchema, Schema.String).make({
  door: "Call directorate_seal first.",
  lookup:
    "Call directorate_seal first, or directorate_ledger_list with no seal to list recent seals.",
});

/**
 * A seal id from outside (a tool's input, a re-check request): the one place a string becomes a SealId. A malformed id
 * is not found, with the hint for its `use`.
 */
export const sealIdOf = (id: string, use: typeof SealUseSchema.Type) =>
  Effect.fromOption(asSealId(id)).pipe(
    Effect.mapError(
      () => new SealNotFound({ hint: UNKNOWN_SEAL_HINTS[use], id })
    )
  );

/** A record of review `id` that fails its schema is damage; `damaged` says which. */
const damagedAs =
  (id: string, damaged: string) =>
  <A>(self: Effect.Effect<A, Schema.SchemaError>) =>
    self.pipe(
      Effect.mapError(
        (e) => new RecordDamaged({ detail: e.message, id, what: damaged })
      )
    );

const make = Effect.gen(function* make() {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = yield* StateRoot;
  const { locked, replace } = yield* mutationLocks;

  const file = (id: string, ...names: string[]) =>
    paths.join(root, id, ...names);

  const snapDir = (s: Pick<Seal, "id" | "gen">) =>
    file(s.id, snapshotName(s.gen));

  /** The diff of the seal's current generation; earlier generations stay beside it. */
  const diffFile = (s: Pick<Seal, "id" | "gen">) => file(s.id, diffName(s.gen));

  const writeText = Effect.fn("Records.writeText")(function* writeText(
    path: string,
    text: string
  ) {
    yield* replace(path, text, { mode: 0o600, prefix: ".directorate-write-" });
  });

  /** A record file's text, or undefined when it is missing; any other read failure is damage, `unreadable` saying which. */
  const readRecord = (id: string, path: string, unreadable: string) =>
    fs.readFileString(path).pipe(
      Effect.catchReason(
        "PlatformError",
        "NotFound",
        () => Effect.undefined,
        (_, e) =>
          Effect.fail(
            new RecordDamaged({ detail: e.message, id, what: unreadable })
          )
      )
    );

  /** The pair commit.json holds, if a commit has not finished. */
  const pending = Effect.fn("Records.pending")(function* pending(id: SealId) {
    const raw = yield* readRecord(
      id,
      file(id, "commit.json"),
      `Cannot read the pending commit of ${id}`
    );

    return raw === undefined
      ? undefined
      : yield* decodePending(raw).pipe(
          damagedAs(id, `The pending commit of ${id} is damaged`)
        );
  });

  /** Replaces both files with a committed pair, then retires its commit.json. */
  const apply = (id: SealId, pair: typeof PendingCommit.Type) =>
    writeText(file(id, "ledger.json"), pair.ledger).pipe(
      Effect.andThen(writeText(file(id, "seal.json"), pair.seal)),
      Effect.andThen(fs.remove(file(id, "commit.json"), { force: true }))
    );

  /** Finishes a pair commit a stopped writer left behind; under the lock, before anything reads or writes the files. */
  const settle = (id: SealId) =>
    pending(id).pipe(
      Effect.flatMap((pair) => (pair ? apply(id, pair) : Effect.void)),
      Effect.uninterruptible
    );

  /** Runs body under the review's lock as it stands, without settling it: retention's eviction, which never waits. */
  const lockReview = <A, E, R>(id: SealId, body: Effect.Effect<A, E, R>) =>
    locked(id, file(id, "mutation.lock"), body, { wait: false });

  /** Runs body under the seal's cross-process lock, once any unfinished pair commit is finished. */
  const withLock = <A, E, R>(id: SealId, body: Effect.Effect<A, E, R>) =>
    locked(id, file(id, "mutation.lock"), Effect.andThen(settle(id), body));

  const withShipLock = <A, E, R>(id: string, body: Effect.Effect<A, E, R>) =>
    fs
      .makeDirectory(file(".ship-locks"), { recursive: true })
      .pipe(
        Effect.andThen(
          locked(
            id,
            file(".ship-locks", `${encodeURIComponent(id)}.lock`),
            body
          )
        )
      );

  const load = Effect.fn("Records.load")(function* load(id: SealId) {
    const committed = yield* pending(id);

    const raw = committed
      ? committed.seal
      : yield* readRecord(id, file(id, "seal.json"), `Cannot read seal ${id}`);

    if (raw === undefined) {
      return yield* new SealNotFound({ id, root });
    }

    return yield* decodeSeal(raw).pipe(damagedAs(id, `Seal ${id} is damaged`));
  });

  /** The seal, or undefined when there is none; a damaged one is logged as a warning and reads as none. */
  const find = Effect.fn("Records.find")(function* find(id: SealId) {
    return yield* load(id).pipe(
      Effect.catchTag("SealNotFound", () => Effect.undefined),
      orWarn(`Skipping seal ${id}`)
    );
  });

  /**
   * When the seal's record was last written, in epoch milliseconds: the newer of seal.json and commit.json, or undefined
   * without either. A stat, not a read: pollers skip loading a record that has not changed.
   */
  const modifiedAt = Effect.fn("Records.modifiedAt")(function* modifiedAt(
    id: SealId
  ) {
    const times = (yield* Effect.all(
      [
        mtimeOf(fs, file(id, "seal.json")),
        mtimeOf(fs, file(id, "commit.json")),
      ],
      { concurrency: 2 }
    )).filter((t): t is number => t !== undefined);

    return times.length ? Math.max(...times) : undefined;
  });

  const save = (s: Seal) =>
    encodeSeal(s).pipe(
      Effect.flatMap((text) => writeText(file(s.id, "seal.json"), text))
    );

  const loadLedger = Effect.fn("Records.loadLedger")(function* loadLedger(
    id: SealId,
    options?: typeof LedgerDemandSchema.Type
  ) {
    const committed = yield* pending(id);

    const raw = committed
      ? committed.ledger
      : yield* readRecord(
          id,
          file(id, "ledger.json"),
          `Cannot read ledger for ${id}`
        );

    if (raw === undefined) {
      return options?.required
        ? yield* new RecordDamaged({
            id,
            what: `The ledger for ${id} is missing.`,
          })
        : emptyLedger;
    }

    return yield* decodeLedger(raw).pipe(
      damagedAs(
        id,
        `Ledger for ${id} is damaged; refusing to treat it as empty`
      )
    );
  });

  const saveLedger = (id: SealId, l: Ledger) =>
    encodeLedger(l).pipe(
      Effect.flatMap((text) => writeText(file(id, "ledger.json"), text))
    );

  /**
   * A new seal's directory for `body`, which saves the seal. If body fails before seal.json is written, the directory
   * is removed; once it is written, the seal is published and stays.
   */
  const create = <A, E, R>(id: SealId, body: Effect.Effect<A, E, R>) =>
    fs.makeDirectory(root, { mode: 0o700, recursive: true }).pipe(
      Effect.andThen(
        Effect.acquireUseRelease(
          fs.makeDirectory(file(id), { mode: 0o700 }),
          () => body,
          (_, exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : fs.exists(file(id, "seal.json")).pipe(
                  Effect.flatMap((published) =>
                    published
                      ? Effect.void
                      : fs.remove(file(id), { force: true, recursive: true })
                  ),
                  Effect.orDie
                )
        )
      )
    );

  /** Seal ids in the store, newest first. */
  const ids = fs.readDirectory(root).pipe(
    Effect.orElseSucceed((): string[] => []),
    Effect.map((names) => names.filter(isSealId).toSorted().toReversed())
  );

  const { gc } = yield* retentionOf(file, ids, isRecordFile, lockReview);

  /** Seals in the store, newest first. */
  const list = Effect.fn("Records.list")(function* list(
    opts: typeof ListFilterSchema.Type = {}
  ) {
    const seals = yield* Effect.forEach(yield* ids, find, {
      concurrency: IO_CONCURRENCY,
    });

    const out = seals.filter(
      (s): s is Seal => s !== undefined && (!opts.repo || s.repo === opts.repo)
    );

    return opts.limit ? out.slice(0, opts.limit) : out;
  });

  /** Seals in the store except the `skip` ids, newest first, without reading the skipped ones. */
  const listWithout = Effect.fn("Records.listWithout")(function* listWithout(
    skip: ReadonlySet<SealId>
  ) {
    const seals = yield* Effect.forEach(
      (yield* ids).filter((id) => !skip.has(id)),
      find,
      { concurrency: IO_CONCURRENCY }
    );

    return seals.filter((s): s is Seal => s !== undefined);
  });

  /** The saved report of a reported seal. */
  const readReport = (id: SealId) =>
    fs
      .readFileString(file(id, "report.md"))
      .pipe(
        Effect.orElseSucceed(
          () => `${id} was reported, but its report file is missing.`
        )
      );

  /** The report and its reported seal, written together. */
  const publish = (s: Seal, md: string) =>
    writeText(file(s.id, "report.md"), md).pipe(
      Effect.andThen(save(s)),
      Effect.uninterruptible
    );

  // A generation's captured files: the diff text, and a snapshot of the worktree files it shows.
  const readDiff = (s: Seal) => fs.readFileString(diffFile(s));

  const writeDiff = (s: Seal, text: string) =>
    fs.writeFileString(diffFile(s), text);

  const resetSnapshot = (s: Seal) =>
    fs
      .remove(snapDir(s), { force: true, recursive: true })
      .pipe(Effect.andThen(fs.makeDirectory(snapDir(s), { recursive: true })));

  const writeSnapshot = Effect.fn("Records.writeSnapshot")(
    function* writeSnapshot(s: Seal, path: string, buf: Uint8Array) {
      const dir = snapDir(s);
      const dest = paths.join(dir, path);

      for (
        let p = paths.dirname(dest);
        p.length > dir.length;
        p = paths.dirname(p)
      ) {
        const st = yield* fs
          .lstat(p)
          .pipe(Effect.orElseSucceed(Function.constUndefined));

        if (st && !isDirectory(st.type)) {
          yield* fs.remove(p, { force: true });
        }
      }

      yield* fs.makeDirectory(paths.dirname(dest), { recursive: true });

      if (
        isDirectory(
          (yield* fs
            .lstat(dest)
            .pipe(Effect.orElseSucceed(Function.constUndefined)))?.type
        )
      ) {
        yield* fs.remove(dest, { force: true, recursive: true });
      }

      yield* fs.writeFile(dest, buf);
    }
  );

  const readSnapshot = (s: Seal, path: string) =>
    fs
      .readFile(paths.join(snapDir(s), path))
      .pipe(Effect.orElseSucceed(Function.constUndefined));

  const dropSnapshot = (s: Seal, path: string) =>
    fs.remove(paths.join(snapDir(s), path), { force: true });

  return {
    create,
    diffFile,
    dropSnapshot,
    find,
    gc,
    list,
    listWithout,
    load,
    loadLedger,
    modifiedAt,
    publish,
    readDiff,
    readReport,
    readSnapshot,
    resetSnapshot,
    root,
    save,
    /**
     * The ledger and the seal, committed together: commit.json holds the pair until both files are replaced, so a stop
     * between the two leaves reads on the new pair, never a mixture. Once commit.json is written the pair is saved, so a
     * failed replacement is only logged: the next lock holder finishes it.
     */
    saveBoth: Effect.fn("Records.saveBoth")(function* saveBoth(
      s: Seal,
      l: Ledger
    ) {
      const pair = {
        ledger: yield* encodeLedger(l),
        seal: yield* encodeSeal(s),
      };

      yield* writeText(
        file(s.id, "commit.json"),
        yield* encodePending(pair).pipe(Effect.orDie)
      );
      yield* apply(s.id, pair).pipe(
        recover(`finishing the pair commit of ${s.id}`)
      );
    }, Effect.uninterruptible),
    saveLedger,
    withLock,
    withShipLock,
    writeDiff,
    writeSnapshot,
  };
});

export class Records extends Context.Service<
  Records,
  Effect.Success<typeof make>
>()("directorate/Records") {
  static readonly layer = Layer.effect(Records, make);
}
