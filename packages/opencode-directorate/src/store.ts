// Directorate seal store: one directory per seal under the state root, holding seal.json, ledger.json, each generation's diff
// and snapshot, the report, and the cross-process mutation lock.
import {
  Clock,
  Context,
  Effect,
  Exit,
  FileSystem,
  Function,
  Layer,
  Option,
  Path,
  Predicate,
  Random,
  Schedule,
  Schema,
} from "effect";

import { failure, ReviewError } from "./error.ts";
import { LockBusy } from "./lock-busy.ts";
import { LedgerJson, SealJson } from "./model.ts";
import type { Ledger, Seal } from "./model.ts";
import { ProcessIdentity } from "./process-identity.ts";
import { StateRoot } from "./state-root.ts";

export { StateRoot } from "./state-root.ts";

const KEEP_DAYS = 31;
const IO_CONCURRENCY = 16;
const SEAL_ID = /^directorate-\d{14}-[0-9a-f]{6}$/u;

/** A mutation lock older than this is orphaned: far above the longest locked section (git calls stop at 120 s). */
const LOCK_STALE_MS = 10 * 60_000;

const LockHolder = Schema.fromJsonString(
  Schema.Struct({ at: Schema.Finite, pid: Schema.Finite, token: Schema.String })
);

const decodeHolder = Schema.decodeUnknownOption(LockHolder);
const encodeHolder = Schema.encodeSync(LockHolder);

const decodeSeal = Schema.decodeEffect(SealJson);
const decodeLedger = Schema.decodeEffect(LedgerJson);

// Encoding validates too: a malformed in-memory seal or ledger is a bug, never a file on disk.
const encodeSeal = (s: Seal) =>
  Schema.encodeEffect(SealJson)(s).pipe(Effect.orDie);

const encodeLedger = (l: Ledger) =>
  Schema.encodeEffect(LedgerJson)(l).pipe(Effect.orDie);

export const emptyLedger: Ledger = { entries: [], notes: [] };

const make = Effect.gen(function* make() {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const identity = yield* ProcessIdentity;
  const root = yield* StateRoot;

  const file = (id: string, ...names: string[]) =>
    paths.join(root, id, ...names);

  const snapDir = (s: Pick<Seal, "id" | "gen">) =>
    file(s.id, s.gen ? `snapshot.g${s.gen}` : "snapshot");

  /** The diff of the seal's current generation; earlier generations stay beside it. */
  const diffFile = (s: Pick<Seal, "id" | "gen">) =>
    file(s.id, s.gen ? `diff.g${s.gen}.patch` : "diff.patch");

  const writeText = Effect.fn("Store.writeText")(function* writeText(
    path: string,
    text: string
  ) {
    const tmp = yield* fs.makeTempFileScoped({
      directory: paths.dirname(path),
      prefix: ".directorate-write-",
    });

    yield* fs.writeFileString(tmp, text, { mode: 0o600 });
    yield* fs.rename(tmp, path);
  }, Effect.scoped);

  const removeDir = (dir: string) =>
    fs.remove(dir, { force: true, recursive: true });

  /** Runs body under the seal's cross-process lock. */
  const withLock = Effect.fn("Store.withLock")(function* withLock<A, E, R>(
    id: string,
    body: Effect.Effect<A, E, R>
  ) {
    if (!SEAL_ID.test(id)) {
      return yield* failure(
        `Unknown seal id "${id}". Call directorate_seal first.`
      );
    }

    const path = file(id, "mutation.lock");

    const readHolder = () =>
      fs
        .readFileString(paths.join(path, "holder"))
        .pipe(Effect.orElseSucceed(Function.constUndefined));

    /** Removes the lock, moving it aside first: a removal in place would race a reclaimer's gate made inside it. */
    const drop = Effect.fnUntraced(function* drop(reason: string) {
      const aside = `${path}.${reason}-${yield* Random.nextIntBetween(0, 0xff_ff_ff)}`;

      yield* fs.rename(path, aside);
      yield* removeDir(aside);
    });

    /**
     * Moves an orphaned lock aside: its holder process is gone or it is older than LOCK_STALE_MS (by mtime, for a lock
     * without a holder record). One reclaimer per orphan: the gate lives inside the lock and leaves with it, and the
     * holder record, unique to each lock, shows whether the orphan is still the lock that was judged.
     */
    const reclaim = Effect.fnUntraced(function* reclaim() {
      const now = yield* Clock.currentTimeMillis;
      const text = yield* readHolder();
      const holder = Option.getOrUndefined(decodeHolder(text));

      const stale = holder
        ? now - holder.at > LOCK_STALE_MS ||
          !(yield* identity.isAlive(holder.pid))
        : now -
            ((yield* fs.stat(path).pipe(
              Effect.map((st) => Option.getOrUndefined(st.mtime)?.getTime()),
              Effect.orElseSucceed(Function.constUndefined)
            )) ?? now) >
          LOCK_STALE_MS;

      if (!stale) {
        return;
      }

      const gate = paths.join(path, "reclaim");

      if (
        !(yield* fs.makeDirectory(gate).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        ))
      ) {
        return;
      }

      // The orphan was reclaimed and a new lock taken between the check and the gate: leave the new lock alone.
      if ((yield* readHolder()) !== text) {
        return yield* removeDir(gate).pipe(Effect.ignore);
      }

      yield* drop("stale").pipe(
        Effect.catch(() => removeDir(gate)),
        Effect.ignore
      );
    });

    const acquire = Effect.acquireRelease(
      Effect.gen(function* lock() {
        const holder = encodeHolder({
          at: yield* Clock.currentTimeMillis,
          pid: identity.pid,
          token: String(yield* Random.nextInt),
        });

        // The lock appears with its holder record, so a lock's record identifies it from the moment it exists.
        const tmp = yield* fs
          .makeTempDirectory({ directory: file(id), prefix: ".mutation.lock-" })
          .pipe(Effect.catch((error) => failure(`${id}: ${error.message}`)));

        const discard = removeDir(tmp).pipe(Effect.ignore);

        yield* fs
          .writeFileString(paths.join(tmp, "holder"), holder)
          .pipe(
            Effect.catch((error) =>
              discard.pipe(Effect.andThen(failure(`${id}: ${error.message}`)))
            )
          );

        // Renaming onto a held lock fails because the lock directory is never empty.
        yield* fs
          .rename(tmp, path)
          .pipe(
            Effect.catch(() =>
              discard.pipe(
                Effect.andThen(reclaim()),
                Effect.andThen(Effect.fail(new LockBusy()))
              )
            )
          );

        return holder;
      }),
      // A lock reclaimed from this holder belongs to its new holder now.
      (holder) =>
        readHolder().pipe(
          Effect.flatMap((text) =>
            text === holder ? drop("released") : Effect.void
          ),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          Effect.orDie
        )
    );

    // Retry outside acquisition: a waiting fiber can stop, but placing the lock and release registration are atomic.
    return yield* Effect.scoped(
      Effect.andThen(
        acquire.pipe(
          Effect.retry({
            schedule: Schedule.spaced("50 millis"),
            times: 800,
            while: Predicate.isTagged("DirectorateLockBusy"),
          }),
          Effect.catchTag("DirectorateLockBusy", () =>
            failure(
              `${id} is busy. If all writers have stopped, remove the orphaned lock directory at ${path}.`
            )
          )
        ),
        body
      )
    );
  });

  const load = Effect.fn("Store.load")(function* load(id: string) {
    if (!SEAL_ID.test(id)) {
      return yield* failure(
        `Unknown seal id "${id}". Call directorate_seal first, or directorate_ledger_list with no seal to list recent seals.`
      );
    }

    const raw = yield* fs.readFileString(file(id, "seal.json")).pipe(
      Effect.catchReason(
        "PlatformError",
        "NotFound",
        () => failure(`Seal ${id} not found under ${root}.`),
        (_, e) => failure(`Cannot read seal ${id}: ${e.message}`)
      )
    );

    return yield* decodeSeal(raw).pipe(
      Effect.mapError(
        (e) =>
          new ReviewError({ message: `Seal ${id} is damaged: ${e.message}` })
      )
    );
  });

  const save = (s: Seal) =>
    encodeSeal(s).pipe(
      Effect.flatMap((text) => writeText(file(s.id, "seal.json"), text))
    );

  const loadLedger = Effect.fn("Store.loadLedger")(function* loadLedger(
    id: string
  ) {
    const raw = yield* fs
      .readFileString(file(id, "ledger.json"))
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined)
      );

    if (raw === undefined) {
      return emptyLedger;
    }

    return yield* decodeLedger(raw).pipe(
      Effect.mapError(
        (e) =>
          new ReviewError({
            message: `Ledger for ${id} is damaged; refusing to treat it as empty: ${e.message}`,
          })
      )
    );
  });

  const saveLedger = (id: string, l: Ledger) =>
    encodeLedger(l).pipe(
      Effect.flatMap((text) => writeText(file(id, "ledger.json"), text))
    );

  /**
   * A new seal's directory for `body`, which saves the seal. If body fails before seal.json is written, the directory
   * is removed; once it is written, the seal is published and stays.
   */
  const create = <A, E, R>(id: string, body: Effect.Effect<A, E, R>) =>
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
    Effect.map((names) =>
      names
        .filter((n) => SEAL_ID.test(n))
        .toSorted()
        .toReversed()
    )
  );

  const modified = (path: string) =>
    fs.stat(path).pipe(
      Effect.map((st) => Option.getOrUndefined(st.mtime)?.getTime()),
      Effect.orElseSucceed((): number | undefined => undefined)
    );

  /** Seals in the store, newest first. */
  const list = Effect.fn("Store.list")(function* list(
    opts: { repo?: string; limit?: number } = {}
  ) {
    const seals = yield* Effect.forEach(
      yield* ids,
      (id) => load(id).pipe(Effect.orElseSucceed(Function.constUndefined)),
      { concurrency: IO_CONCURRENCY }
    );

    const out = seals.filter(
      (s): s is Seal => s !== undefined && (!opts.repo || s.repo === opts.repo)
    );

    return opts.limit ? out.slice(0, opts.limit) : out;
  });

  /** Seals in the store except the `skip` ids, newest first, without reading the skipped ones. */
  const listWithout = Effect.fn("Store.listWithout")(function* listWithout(
    skip: ReadonlySet<string>
  ) {
    const seals = yield* Effect.forEach(
      (yield* ids).filter((id) => !skip.has(id)),
      (id) => load(id).pipe(Effect.orElseSucceed(Function.constUndefined)),
      { concurrency: IO_CONCURRENCY }
    );

    return seals.filter((s): s is Seal => s !== undefined);
  });

  /** Removes seals not written for KEEP_DAYS. */
  const gc = Effect.fn("Store.gc")(function* gc() {
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(
      yield* ids,
      Effect.fnUntraced(function* prune(id) {
        const mtime = yield* modified(file(id));

        if (mtime !== undefined && now - mtime > KEEP_DAYS * 86_400_000) {
          yield* fs.remove(file(id), { force: true, recursive: true });
        }
      }),
      { concurrency: IO_CONCURRENCY, discard: true }
    );
  });

  /** The saved report of a reported seal. */
  const readReport = (id: string) =>
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

  const writeSnapshot = Effect.fn("Store.writeSnapshot")(
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

        if (st && st.type !== "Directory") {
          yield* fs.remove(p, { force: true });
        }
      }

      yield* fs.makeDirectory(paths.dirname(dest), { recursive: true });

      if (
        (yield* fs
          .lstat(dest)
          .pipe(Effect.orElseSucceed(Function.constUndefined)))?.type ===
        "Directory"
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
    gc,
    list,
    listWithout,
    load,
    loadLedger,
    publish,
    readDiff,
    readReport,
    readSnapshot,
    resetSnapshot,
    root,
    save,
    /** The ledger and the seal, written together. */
    saveBoth: (s: Seal, l: Ledger) =>
      saveLedger(s.id, l).pipe(Effect.andThen(save(s)), Effect.uninterruptible),
    saveLedger,
    withLock,
    writeDiff,
    writeSnapshot,
  };
});

export class Store extends Context.Service<
  Store,
  Effect.Success<typeof make>
>()("directorate/Store") {
  static readonly layer = Layer.effect(Store, make);
}
