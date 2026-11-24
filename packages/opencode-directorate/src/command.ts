import { Data, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class CommandError extends Data.TaggedError("DirectorateCommandError")<{
  message: string;
  code?: number | "NotFound";
  stdout?: Buffer;
}> {}

// The process runner for git and gh, shaped like OpenCode's own AppProcess.run (packages/util/src/process.ts), which
// external plugins are not given. ChildProcessSpawner.string would drop the exit code and the bytes, and has no bound;
// unlike AppProcess, an oversized stream fails instead of being cut, so a truncated diff is never sealed.
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

// Bound each stream independently, before concatenating, and drain both to avoid pipe deadlocks.
const collect = (name: string, limit: number) =>
  Stream.runFoldEffect(
    () => ({ chunks: [] as Uint8Array[], bytes: 0 }),
    (acc, chunk: Uint8Array) => {
      if (acc.bytes + chunk.length > limit)
        return Effect.fail(
          new CommandError({ message: `${name} exceeded ${limit} bytes` })
        );
      acc.chunks.push(chunk);
      acc.bytes += chunk.length;
      return Effect.succeed(acc);
    }
  );

export const command = Effect.fn("Directorate.command")(
  function* (
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
        shell: false,
        stdin: "ignore",
        killSignal: "SIGKILL",
        forceKillAfter: "1 second",
      })
    );
    const { stdout, stderr, code } = yield* Effect.all(
      {
        stdout: child.stdout.pipe(collect("stdout", maxOutputBytes)),
        stderr: child.stderr.pipe(collect("stderr", maxOutputBytes)),
        code: child.exitCode,
      },
      { concurrency: 3 }
    );
    const output = Buffer.concat(stdout.chunks, stdout.bytes);
    if (code === 0) return output;
    return yield* new CommandError({
      message:
        Buffer.concat(stderr.chunks, stderr.bytes).toString("utf8").trim() ||
        `exited with code ${code}`,
      code,
      stdout: output,
    });
  },
  Effect.scoped,
  Effect.catchReason(
    "PlatformError",
    "NotFound",
    (reason) =>
      Effect.fail(
        new CommandError({ message: reason.message, code: "NotFound" })
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
