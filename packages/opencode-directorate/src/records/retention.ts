// Retention: seals not written for KEEP_DAYS are removed.
import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { ignore } from "../platform/error.ts";
import { IO_CONCURRENCY } from "../platform/platform.ts";
import type { SealId } from "../seal/seal-id.ts";

const KEEP_DAYS = 31;
const KEEP_MS = KEEP_DAYS * 86_400_000;

/** locks.ts's LockBusy, which it keeps private: the review's lock is held, so eviction waits for the next sweep. */
const isLockBusy = Schema.is(Schema.TaggedStruct("LockBusy", {}));

/** When `path` was last modified, in epoch milliseconds; undefined when it cannot be read. */
export const mtimeOf = (fs: FileSystem.FileSystem, path: string) =>
  fs.stat(path).pipe(
    Effect.map((st) => Option.getOrUndefined(st.mtime)?.getTime()),
    Effect.orElseSucceed((): number | undefined => undefined)
  );

/**
 * Pruning of the seal directories `ids` lists; `file(id)` is a seal's directory, `isRecordFile` names the files its
 * writes replace, and `lockReview` runs a body under the review's mutation lock without waiting for a busy one.
 */
export const retentionOf = <E>(
  file: (id: string) => string,
  ids: Effect.Effect<SealId[]>,
  isRecordFile: (name: string) => boolean,
  lockReview: (
    id: SealId,
    body: Effect.Effect<void, PlatformError>
  ) => Effect.Effect<void, E>
) =>
  Effect.gen(function* retention() {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;

    const modified = (path: string) => mtimeOf(fs, path);

    /**
     * When the review was last written: its newest record file. Taking the lock changes the directory's own mtime, so
     * under the lock only the record files count; a directory without one keeps the mtime seen before locking.
     */
    const lastWritten = Effect.fnUntraced(function* lastWritten(
      id: string,
      seen: number
    ) {
      const names = (yield* fs
        .readDirectory(file(id))
        .pipe(Effect.orElseSucceed((): string[] => []))).filter((name) =>
        isRecordFile(name)
      );

      const times = yield* Effect.forEach(
        names,
        (name) => modified(paths.join(file(id), name)),
        { concurrency: IO_CONCURRENCY }
      );

      const known = times.filter((t): t is number => t !== undefined);

      return known.length ? Math.max(...known) : seen;
    });

    /**
     * Removes seals not written for KEEP_DAYS. Each removal holds the review's lock and checks the age again under it,
     * so a writer that made the review current first keeps it; a review whose lock is busy stays until the next sweep.
     */
    const gc = Effect.fn("Records.gc")(function* gc() {
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(
        yield* ids,
        Effect.fnUntraced(function* prune(id) {
          const seen = yield* modified(file(id));

          if (seen === undefined || now - seen <= KEEP_MS) {
            return;
          }

          yield* lockReview(
            id,
            Effect.gen(function* evict() {
              if (now - (yield* lastWritten(id, seen)) > KEEP_MS) {
                yield* fs.remove(file(id), { force: true, recursive: true });
              }
            })
          ).pipe(
            // A busy lock is expected: the seal waits for the next sweep.
            Effect.catchIf(isLockBusy, () =>
              Effect.logDebug(
                `[directorate] seal ${id} is busy; evicting it next sweep`
              )
            ),
            ignore(`evicting aged seal ${id}`, "Warn")
          );
        }),
        { concurrency: IO_CONCURRENCY, discard: true }
      );
    });

    return { gc };
  });
