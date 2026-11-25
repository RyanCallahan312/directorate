import { ByteSize, Effect, FileSystem, Option, Path, Stream } from "effect";
import { Zip } from "effect/encoding";
import type { PlatformError } from "effect/PlatformError";

import { failure, ReviewError } from "./error.ts";

type ArchiveEntry = Zip.ContentEntry | Zip.Entry<PlatformError>;

export const writeArchive = Effect.fn("Directorate.writeArchive")(
  function* writeArchive(
    root: string,
    destination: string,
    entries: readonly string[]
  ) {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;

    const entry = (
      name: string
    ): Stream.Stream<ArchiveEntry, PlatformError | ReviewError> =>
      Stream.unwrap(
        Effect.gen(function* readEntry() {
          const source = paths.join(root, name);
          const info = yield* fs.lstat(source);
          const mtime = Option.getOrUndefined(info.mtime);

          if (info.type === "Directory") {
            const children = yield* fs.readDirectory(source);

            return Stream.make(Zip.directory(name, { mtime })).pipe(
              Stream.concat(
                Stream.fromIterable(children.toSorted()).pipe(
                  Stream.flatMap((child) => entry(`${name}/${child}`))
                )
              )
            );
          }

          if (info.type !== "File") {
            return yield* failure(`Not a regular export artifact: ${name}`);
          }

          return Stream.make(
            Zip.fileStream(name, fs.stream(source), {
              mtime,
              size: Option.getOrUndefined(ByteSize.toNumber(info.size)),
            })
          );
        })
      );

    return yield* Stream.fromIterable(entries).pipe(
      Stream.flatMap(entry),
      Stream.pipeThroughChannel(
        Zip.encode<PlatformError | ReviewError, unknown, ArchiveEntry>()
      ),
      Stream.catchTag("ZipError", (cause) =>
        Stream.fail(
          new ReviewError({
            message: `Cannot create export archive: ${cause.message}`,
          })
        )
      ),
      Stream.withSpan("Directorate.archiveBytes"),
      Stream.run(fs.sink(destination, { flag: "wx", mode: 0o600 }))
    );
  },
  Effect.timeoutOrElse({
    duration: "2 minutes",
    orElse: () =>
      failure("Creating the export archive timed out after 2 minutes"),
  })
);
