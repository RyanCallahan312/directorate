// Directorate seal store: one directory per seal under the state root, holding seal.json, ledger.json, each generation's diff
// and snapshot, the report, and the cross-process mutation lock.
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

import { LedgerJson } from "../feature/ledger/entry.ts";
import type { Ledger } from "../feature/ledger/entry.ts";
import { SealJson } from "../seal/record.ts";
import type { Seal } from "../seal/record.ts";
import { mutationLocks } from "./locks.ts";
import { retentionOf } from "./retention.ts";
import { StateRoot } from "./state-root.ts";

const IO_CONCURRENCY = 16;
const SEAL_ID = /^directorate-\d{14}-[0-9a-f]{6}$/u;

const decodeSeal = Schema.decodeEffect(SealJson);
const decodeLedger = Schema.decodeEffect(LedgerJson);

// Encoding validates too: a malformed in-memory seal or ledger is a bug, never a file on disk.
const encodeSeal = (s: Seal) =>
  Schema.encodeEffect(SealJson)(s).pipe(Effect.orDie);

const encodeLedger = (l: Ledger) =>
  Schema.encodeEffect(LedgerJson)(l).pipe(Effect.orDie);

export const emptyLedger: Ledger = { entries: [], notes: [] };

/** No seal by that id: a malformed id, or one with no record under the state root. */
export class SealNotFound extends Schema.TaggedError<
  SealNotFound,
  { readonly brand: unique symbol }
>()("SealNotFound", { message: Schema.String }) {}

/** A review record that exists, or must, cannot be read: unreadable, missing, or failing its schema. */
export class RecordDamaged extends Schema.TaggedError<
  RecordDamaged,
  { readonly brand: unique symbol }
>()("RecordDamaged", { message: Schema.String }) {}

const make = Effect.gen(function* make() {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = yield* StateRoot;
  const { locked } = yield* mutationLocks;

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

  /** Runs body under the seal's cross-process lock. */
  const withLock = <A, E, R>(id: string, body: Effect.Effect<A, E, R>) =>
    Effect.gen(function* withSealLock() {
      if (!SEAL_ID.test(id)) {
        return yield* new SealNotFound({
          message: `Unknown seal id "${id}". Call directorate_seal first.`,
        });
      }

      return yield* locked(id, file(id, "mutation.lock"), body);
    });

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

  const load = Effect.fn("Store.load")(function* load(id: string) {
    if (!SEAL_ID.test(id)) {
      return yield* new SealNotFound({
        message: `Unknown seal id "${id}". Call directorate_seal first, or directorate_ledger_list with no seal to list recent seals.`,
      });
    }

    const raw = yield* fs.readFileString(file(id, "seal.json")).pipe(
      Effect.catchReason(
        "PlatformError",
        "NotFound",
        () =>
          Effect.fail(
            new SealNotFound({ message: `Seal ${id} not found under ${root}.` })
          ),
        (_, e) =>
          Effect.fail(
            new RecordDamaged({
              message: `Cannot read seal ${id}: ${e.message}`,
            })
          )
      )
    );

    return yield* decodeSeal(raw).pipe(
      Effect.mapError(
        (e) =>
          new RecordDamaged({ message: `Seal ${id} is damaged: ${e.message}` })
      )
    );
  });

  const save = (s: Seal) =>
    encodeSeal(s).pipe(
      Effect.flatMap((text) => writeText(file(s.id, "seal.json"), text))
    );

  const loadLedger = Effect.fn("Store.loadLedger")(function* loadLedger(
    id: string,
    options?: { required: boolean }
  ) {
    const raw = yield* fs
      .readFileString(file(id, "ledger.json"))
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined)
      );

    if (raw === undefined) {
      return options?.required
        ? yield* new RecordDamaged({
            message: `The ledger for ${id} is missing.`,
          })
        : emptyLedger;
    }

    return yield* decodeLedger(raw).pipe(
      Effect.mapError(
        (e) =>
          new RecordDamaged({
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

  const { gc } = yield* retentionOf(file, ids);

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
    withShipLock,
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
