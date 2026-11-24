import { Cause, Data, Effect } from "effect";
import type { LogLevel } from "effect";

/** An expected review failure; its message is what the model sees. */
export class ReviewError extends Data.TaggedError("DirectorateReviewError")<{
  message: string;
}> {}

export const failure = (message: string) =>
  Effect.fail(new ReviewError({ message }));

/** Best-effort steps still leave a trace: the full cause is logged at the given level. */
export const ignore = (message: string, log: LogLevel.Severity = "Debug") =>
  Effect.ignore({ log, message: `[directorate] ${message}` });

/** Logs failures instead of raising them; interruption propagates with its original reasons. */
export const recover =
  (name: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(
              Cause.fromReasons<never>(
                cause.reasons.filter(Cause.isInterruptReason)
              )
            )
          : Effect.logWarning(`[directorate] ${name}: ${Cause.pretty(cause)}`)
      )
    );
