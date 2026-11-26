// The cross-process mutation lock: a directory that appears with its holder record, reclaimed when its holder is gone.
import {
  Clock,
  Effect,
  FileSystem,
  Function,
  Option,
  Path,
  Random,
  Schedule,
  Schema,
} from "effect";

import { ProcessIdentity } from "../platform/platform.ts";

/** Another writer holds the lock at `path`. */
class LockBusy extends Schema.TaggedError<
  LockBusy,
  { readonly brand: unique symbol }
>()("LockBusy", { id: Schema.String, path: Schema.String }) {
  override get message() {
    return `${this.id} is busy. If all writers have stopped, remove the orphaned lock directory at ${this.path}.`;
  }
}

const isLockBusy = Schema.is(LockBusy);

/** The lock for `id` could not be placed. */
class LockFailed extends Schema.TaggedError<
  LockFailed,
  { readonly brand: unique symbol }
>()("LockFailed", { id: Schema.String, reason: Schema.String }) {
  override get message() {
    return `${this.id}: ${this.reason}`;
  }
}

/** A mutation lock older than this is orphaned: far above the longest locked section (git calls stop at 120 s). */
const LOCK_STALE_MS = 10 * 60_000;

const LockHolder = Schema.fromJsonString(
  Schema.Struct({ at: Schema.Finite, pid: Schema.Finite, token: Schema.String })
);

const decodeHolder = Schema.decodeUnknownOption(LockHolder);
const encodeHolder = Schema.encodeSync(LockHolder);

/** Locking with the store's filesystem and this process's identity. */
export const mutationLocks = Effect.gen(function* mutationLocks() {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const identity = yield* ProcessIdentity;

  const removeDir = (dir: string) =>
    fs.remove(dir, { force: true, recursive: true });

  const locked = Effect.fnUntraced(function* locked<A, E, R>(
    id: string,
    path: string,
    body: Effect.Effect<A, E, R>
  ) {
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
          .makeTempDirectory({
            directory: paths.dirname(path),
            prefix: ".mutation.lock-",
          })
          .pipe(
            Effect.mapError(
              (error) => new LockFailed({ id, reason: error.message })
            )
          );

        const discard = removeDir(tmp).pipe(Effect.ignore);

        yield* fs
          .writeFileString(paths.join(tmp, "holder"), holder)
          .pipe(
            Effect.catch((error) =>
              discard.pipe(
                Effect.andThen(
                  Effect.fail(new LockFailed({ id, reason: error.message }))
                )
              )
            )
          );

        // Renaming onto a held lock fails because the lock directory is never empty.
        yield* fs
          .rename(tmp, path)
          .pipe(
            Effect.catch(() =>
              discard.pipe(
                Effect.andThen(reclaim()),
                Effect.andThen(Effect.fail(new LockBusy({ id, path })))
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
            while: isLockBusy,
          })
        ),
        body
      )
    );
  });

  return { locked };
});
