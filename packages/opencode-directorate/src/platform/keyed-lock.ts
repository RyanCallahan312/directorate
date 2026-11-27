// A lock per key, such as a session id: one fiber at a time runs under each key, and a key's entry is dropped once its
// last holder or waiter leaves, even on interruption.
import { Effect, Semaphore } from "effect";

/** One key's lock: its permit, and how many fibers hold or wait for it. */
const makeEntry = () => ({ permit: Semaphore.makeUnsafe(1), users: 0 });

/** A keyed lock outside any Effect, for one that must outlive a plugin instance; prefer `keyedLock`. */
export const keyedLockUnsafe = () => {
  const entries = new Map<string, ReturnType<typeof makeEntry>>();

  /** Runs body while holding key's permit. */
  const withLock = <A, E, R>(key: string, body: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = entries.get(key) ?? makeEntry();

        entry.users += 1;
        entries.set(key, entry);

        return entry;
      }),
      ({ permit }) => permit.withPermit(body),
      (entry) =>
        Effect.sync(() => {
          entry.users -= 1;

          if (entry.users === 0) {
            entries.delete(key);
          }
        })
    );

  /** How many keys are held or waited for now. */
  const size = Effect.sync(() => entries.size);

  return { size, withLock };
};

/** A keyed lock that lasts as long as whatever made it. */
export const keyedLock = Effect.sync(keyedLockUnsafe);
