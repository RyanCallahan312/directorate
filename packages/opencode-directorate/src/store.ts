// Directorate seal store: one directory per seal under the state root, holding seal.json, ledger.json, each generation's diff
// and snapshot, the report, and the cross-process mutation lock.
import {
  Clock,
  Config,
  Context,
  Data,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schedule,
  Schema,
} from "effect";

import { failure, ReviewError } from "./error.ts";
import { type Ledger, type Seal, LedgerJson, SealJson } from "./model.ts";

const KEEP_DAYS = 14;
const IO_CONCURRENCY = 16;
const SEAL_ID = /^directorate-\d{14}-[0-9a-f]{6}$/;

/** Where seals live: DIRECTORATE_STATE_DIR, else $XDG_STATE_HOME/opencode-directorate, else ~/.local/state/opencode-directorate. */
export class StateRoot extends Context.Service<StateRoot, string>()(
  "directorate/StateRoot"
) {
  static readonly layer = Layer.effect(
    StateRoot,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return yield* Config.NonEmptyString("DIRECTORATE_STATE_DIR").pipe(
        Config.orElse(() =>
          Config.NonEmptyString("XDG_STATE_HOME").pipe(
            Config.map((dir) => path.join(dir, "opencode-directorate"))
          )
        ),
        Config.orElse(() =>
          Config.NonEmptyString("HOME").pipe(
            Config.map((home) =>
              path.join(home, ".local", "state", "opencode-directorate")
            )
          )
        )
      );
    }).pipe(Effect.orDie)
  );
}

/** Another writer holds the seal's mutation lock. */
class LockBusy extends Data.TaggedError("DirectorateLockBusy") {}

const decodeSeal = Schema.decodeEffect(SealJson);
const decodeLedger = Schema.decodeEffect(LedgerJson);
// Encoding validates too: a malformed in-memory seal or ledger is a bug, never a file on disk.
const encodeSeal = (s: Seal) =>
  Schema.encodeEffect(SealJson)(s).pipe(Effect.orDie);
const encodeLedger = (l: Ledger) =>
  Schema.encodeEffect(LedgerJson)(l).pipe(Effect.orDie);
export const emptyLedger: Ledger = { entries: [], notes: [] };

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = yield* StateRoot;
  const file = (id: string, ...names: string[]) =>
    paths.join(root, id, ...names);
  const snapDir = (s: Pick<Seal, "id" | "gen">) =>
    file(s.id, s.gen ? `snapshot.g${s.gen}` : "snapshot");
  /** The diff of the seal's current generation; earlier generations stay beside it. */
  const diffFile = (s: Pick<Seal, "id" | "gen">) =>
    file(s.id, s.gen ? `diff.g${s.gen}.patch` : "diff.patch");

  const writeText = Effect.fn("Store.writeText")(function* (
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

  /** Runs body under the seal's cross-process lock. */
  const withLock = Effect.fn("Store.withLock")(function* <A, E, R>(
    id: string,
    body: Effect.Effect<A, E, R>
  ) {
    if (!SEAL_ID.test(id))
      return yield* failure(
        `Unknown seal id "${id}". Call directorate_seal first.`
      );
    const path = file(id, "mutation.lock");
    const acquire = Effect.acquireRelease(
      fs.makeDirectory(path).pipe(
        Effect.catchReason(
          "PlatformError",
          "AlreadyExists",
          () => Effect.fail(new LockBusy()),
          (_, e) => failure(`${id}: ${e.message}`)
        )
      ),
      () => fs.remove(path, { recursive: true }).pipe(Effect.orDie)
    );
    // Retry outside acquisition: a waiting fiber can stop, but mkdir and release registration are atomic.
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

  const load = Effect.fn("Store.load")(function* (id: string) {
    if (!SEAL_ID.test(id))
      return yield* failure(
        `Unknown seal id "${id}". Call directorate_seal first, or directorate_ledger_list with no seal to list recent seals.`
      );
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
  const loadLedger = Effect.fn("Store.loadLedger")(function* (id: string) {
    const raw = yield* fs
      .readFileString(file(id, "ledger.json"))
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined)
      );
    if (raw === undefined) return emptyLedger;
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
    fs.makeDirectory(root, { recursive: true, mode: 0o700 }).pipe(
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
                      : fs.remove(file(id), { recursive: true, force: true })
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
        .sort()
        .reverse()
    )
  );
  const modified = (path: string) =>
    fs.stat(path).pipe(
      Effect.map((st) => Option.getOrUndefined(st.mtime)?.getTime()),
      Effect.orElseSucceed(() => undefined)
    );
  /** Seals in the store, newest first. `maxAgeMs` is measured from createdAt, which resuming moves. */
  const list = Effect.fn("Store.list")(function* (
    opts: { repo?: string; limit?: number; maxAgeMs?: number } = {}
  ) {
    const now = yield* Clock.currentTimeMillis;
    const young = (millis: number | undefined) =>
      opts.maxAgeMs === undefined ||
      (millis !== undefined && now - millis <= opts.maxAgeMs);
    const seals = yield* Effect.forEach(
      yield* ids,
      Effect.fnUntraced(function* (id) {
        // createdAt is never later than the seal's last write, so seals not written since the cutoff are skipped unread.
        if (
          opts.maxAgeMs !== undefined &&
          !young(yield* modified(file(id, "seal.json")))
        )
          return undefined;
        return yield* load(id).pipe(Effect.orElseSucceed(() => undefined));
      }),
      { concurrency: IO_CONCURRENCY }
    );
    const out = seals.filter(
      (s): s is Seal =>
        s !== undefined &&
        (!opts.repo || s.repo === opts.repo) &&
        young(DateTime.toEpochMillis(s.createdAt))
    );
    return opts.limit ? out.slice(0, opts.limit) : out;
  });
  /** Removes seals not written for KEEP_DAYS. */
  const gc = Effect.fn("Store.gc")(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(
      yield* ids,
      Effect.fnUntraced(function* (id) {
        const mtime = yield* modified(file(id));
        if (mtime !== undefined && now - mtime > KEEP_DAYS * 86_400_000)
          yield* fs.remove(file(id), { recursive: true, force: true });
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
      .remove(snapDir(s), { recursive: true, force: true })
      .pipe(Effect.andThen(fs.makeDirectory(snapDir(s), { recursive: true })));
  const writeSnapshot = Effect.fn("Store.writeSnapshot")(function* (
    s: Seal,
    path: string,
    buf: Buffer
  ) {
    const dir = snapDir(s);
    const dest = paths.join(dir, path);
    for (
      let p = paths.dirname(dest);
      p.length > dir.length;
      p = paths.dirname(p)
    ) {
      const st = yield* fs.lstat(p).pipe(Effect.orElseSucceed(() => undefined));
      if (st && st.type !== "Directory") yield* fs.remove(p, { force: true });
    }
    yield* fs.makeDirectory(paths.dirname(dest), { recursive: true });
    if (
      (yield* fs.lstat(dest).pipe(Effect.orElseSucceed(() => undefined)))
        ?.type === "Directory"
    )
      yield* fs.remove(dest, { recursive: true, force: true });
    yield* fs.writeFile(dest, buf);
  });
  const readSnapshot = (s: Seal, path: string) =>
    fs.readFile(paths.join(snapDir(s), path)).pipe(
      Effect.map(Buffer.from),
      Effect.orElseSucceed(() => undefined)
    );
  const dropSnapshot = (s: Seal, path: string) =>
    fs.remove(paths.join(snapDir(s), path), { force: true });

  return {
    root,
    diffFile,
    withLock,
    load,
    save,
    loadLedger,
    saveLedger,
    create,
    list,
    gc,
    readReport,
    publish,
    readDiff,
    writeDiff,
    resetSnapshot,
    writeSnapshot,
    readSnapshot,
    dropSnapshot,
    /** The ledger and the seal, written together. */
    saveBoth: (s: Seal, l: Ledger) =>
      saveLedger(s.id, l).pipe(Effect.andThen(save(s)), Effect.uninterruptible),
  };
});

export class Store extends Context.Service<
  Store,
  Effect.Success<typeof make>
>()("directorate/Store") {
  static readonly layer = Layer.effect(Store, make);
}
