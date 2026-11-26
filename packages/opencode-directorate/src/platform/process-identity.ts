import { Context, Effect, Layer, Predicate, Schema } from "effect";

/** Node's error code when no process has the PID. */
const isNoSuchProcess = Schema.is(Schema.Literal("ESRCH"));

// Node can probe a PID outside the child-process handles managed by Effect.
const make = () => ({
  isAlive: (pid: number) =>
    Effect.try(() => process.kill(pid, 0)).pipe(
      Effect.match({
        // EPERM and unrecognized failures leave the holder in place.
        onFailure: ({ cause }) =>
          !(
            Predicate.hasProperty(cause, "code") && isNoSuchProcess(cause.code)
          ),
        onSuccess: () => true,
      })
    ),
  pid: process.pid,
});

export class ProcessIdentity extends Context.Service<
  ProcessIdentity,
  ReturnType<typeof make>
>()("directorate/ProcessIdentity") {}

export const nodeProcessIdentity = Layer.sync(ProcessIdentity, make);
