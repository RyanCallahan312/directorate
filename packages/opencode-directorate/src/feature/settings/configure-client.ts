// The configure flow's host adapter: runs the dialog walk from an OpenCode command callback (tui.ts, gui.ts), turning host
// promises and throws into SettingsError and a failed walk into the alert the user sees.
import { Cause, Effect, Exit, Predicate } from "effect";

import { configure, SettingsError } from "./configure-flow.ts";
import type { Backend, Dialogs } from "./configure-flow.ts";

export { backend, isWarning } from "./configure-flow.ts";

const hostError = (cause: unknown) =>
  new SettingsError({
    message: Predicate.hasProperty(cause, "message")
      ? String(cause.message)
      : String(cause),
  });

export const fromHost = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({ catch: hostError, try: call });

export const showToast = (show: () => void) =>
  Effect.try({ catch: hostError, try: show });

/** The OpenCode command callback owns this run. */
export const configureFromHost = async (
  dialogs: Dialogs,
  backend: Backend,
  signal?: AbortSignal
) => {
  const program = configure(dialogs, backend).pipe(
    Effect.catchTag("DirectorateSettingsError", ({ message }) =>
      dialogs.alert({
        description: message,
        title: "The Directorate // Settings",
      })
    )
  );

  const exit = await Effect.runPromiseExit(program, { signal });

  if (
    Exit.isSuccess(exit) ||
    (signal?.aborted && Cause.hasInterruptsOnly(exit.cause))
  ) {
    return;
  }

  const cause = Cause.squash(exit.cause);

  throw cause instanceof Error ? cause : new Error(String(cause));
};
