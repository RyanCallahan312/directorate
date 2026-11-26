import { Context, Effect, Layer, Predicate } from "effect";

export class ProcessIdentity extends Context.Service<
  ProcessIdentity,
  {
    readonly pid: number;
    readonly isAlive: (pid: number) => Effect.Effect<boolean>;
  }
>()("directorate/ProcessIdentity") {}

// Node can probe a PID outside the child-process handles managed by Effect.
export const nodeProcessIdentity = Layer.sync(ProcessIdentity, () =>
  ProcessIdentity.of({
    isAlive: (pid) =>
      Effect.try(() => process.kill(pid, 0)).pipe(
        Effect.match({
          // EPERM and unrecognized failures leave the holder in place.
          onFailure: ({ cause }) =>
            !(Predicate.hasProperty(cause, "code") && cause.code === "ESRCH"),
          onSuccess: () => true,
        })
      ),
    pid: process.pid,
  })
);
