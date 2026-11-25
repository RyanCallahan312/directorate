import { Bytes, Data, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { decodeUtf8 } from "./utf8.ts";

class CommandError extends Data.TaggedError("DirectorateCommandError")<{
  message: string;
  code?: number | "NotFound";
  stdout?: Uint8Array;
}> {}

// The process runner for git and gh, shaped like OpenCode's own AppProcess.run (packages/util/src/process.ts), which
// external plugins are not given. ChildProcessSpawner.string would drop the exit code and the bytes, and has no bound;
// unlike AppProcess, an oversized stream fails instead of being cut, so a truncated diff is never sealed.
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

const emptyOutput = () => {
  const chunks: Uint8Array[] = [];

  return { bytes: 0, chunks };
};

// Bound each stream independently, before concatenating, and drain both to avoid pipe deadlocks.
const collect = (name: string, limit: number) =>
  Stream.runFoldEffect(emptyOutput, (acc, chunk: Uint8Array) => {
    if (acc.bytes + chunk.length > limit) {
      return Effect.fail(
        new CommandError({ message: `${name} exceeded ${limit} bytes` })
      );
    }

    acc.chunks.push(chunk);
    acc.bytes += chunk.length;

    return Effect.succeed(acc);
  });

export const command = Effect.fn("Directorate.command")(
  function* command(
    name: string,
    args: readonly string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      timeout: number;
      maxOutputBytes?: number;
    }
  ) {
    const { cwd, env, maxOutputBytes = MAX_OUTPUT_BYTES } = options;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const child = yield* spawner.spawn(
      ChildProcess.make(name, args, {
        cwd,
        env,
        extendEnv: true,
        forceKillAfter: "1 second",
        killSignal: "SIGKILL",
        shell: false,
        stdin: "ignore",
      })
    );

    const { stdout, stderr, code } = yield* Effect.all(
      {
        code: child.exitCode,
        stderr: child.stderr.pipe(collect("stderr", maxOutputBytes)),
        stdout: child.stdout.pipe(collect("stdout", maxOutputBytes)),
      },
      { concurrency: 3 }
    );

    const output = Bytes.concat(stdout.chunks);

    if (code === 0) {
      return output;
    }

    return yield* new CommandError({
      code,
      message:
        decodeUtf8(Bytes.concat(stderr.chunks)).trim() ||
        `exited with code ${code}`,
      stdout: output,
    });
  },
  Effect.scoped,
  Effect.catchReason(
    "PlatformError",
    "NotFound",
    (reason) =>
      Effect.fail(
        new CommandError({ code: "NotFound", message: reason.message })
      ),
    (_, error) => Effect.fail(new CommandError({ message: error.message }))
  ),
  (effect, _name, _args, { timeout }) =>
    Effect.timeoutOrElse(effect, {
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new CommandError({ message: `timed out after ${timeout / 1000}s` })
        ),
    })
);
