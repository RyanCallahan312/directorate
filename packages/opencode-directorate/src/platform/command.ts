import { Bytes, Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { decodeUtf8 } from "./utf8.ts";

/** A command failed to run or exited nonzero: its exit code (NotFound when it is not installed) and what it printed. */
const NotFoundSchema = Schema.Literal("NotFound");

const isNotFound = Schema.is(NotFoundSchema);

class CommandError extends Schema.TaggedError<
  CommandError,
  { readonly brand: unique symbol }
>()("DirectorateCommandError", {
  code: Schema.optionalKey(Schema.Union([Schema.Int, NotFoundSchema])),
  message: Schema.String,
  stdout: Schema.optionalKey(Schema.Uint8Array),
}) {
  /** The command is not installed. */
  get notInstalled() {
    return isNotFound(this.code);
  }
}

/** How to run a command: where, with what environment, for how long, and how much each stream may print. */
const CommandOptionsSchema = Schema.Struct({
  cwd: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  maxOutputBytes: Schema.optionalKey(Schema.Finite),
  timeout: Schema.Finite,
});

type CommandOptions = typeof CommandOptionsSchema.Type;

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
    options: CommandOptions
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
        new CommandError({
          code: NotFoundSchema.make("NotFound"),
          message: reason.message,
        })
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
