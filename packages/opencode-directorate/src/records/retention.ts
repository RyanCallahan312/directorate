// Retention: seals not written for KEEP_DAYS are removed.
import { Clock, Effect, FileSystem, Option } from "effect";

import { IO_CONCURRENCY } from "../platform/platform.ts";

const KEEP_DAYS = 31;

/** Pruning of the seal directories `ids` lists; `file(id)` is a seal's directory. */
export const retentionOf = (
  file: (id: string) => string,
  ids: Effect.Effect<string[]>
) =>
  Effect.gen(function* retention() {
    const fs = yield* FileSystem.FileSystem;

    const modified = (path: string) =>
      fs.stat(path).pipe(
        Effect.map((st) => Option.getOrUndefined(st.mtime)?.getTime()),
        Effect.orElseSucceed((): number | undefined => undefined)
      );

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

    return { gc };
  });
