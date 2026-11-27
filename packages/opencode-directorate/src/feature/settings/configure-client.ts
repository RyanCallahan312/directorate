// The configure flow's host adapter: runs the dialog walk from an OpenCode command callback (tui.ts, gui.ts), turning host
// promises and throws into SettingsError and a failed walk into the alert the user sees.
import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect";

import { backend, configure, SettingsError } from "./configure-flow.ts";
import type { Backend, Dialogs } from "./configure-flow.ts";
import { SettingsFailureSchema } from "./file.ts";
import type { SettingsView, WriteInput, WriteResult } from "./rpc.ts";

export { isWarning } from "./configure-flow.ts";

/** What /directorate-configure does, as both apps list the command. */
export const CONFIGURE_DESCRIPTION =
  "Default review scope and mode, Directorate Seats (panel models) and thinking levels, time budgets, and disabled lenses";

/** A settings RPC rejection carries why the server refused. */
const rejectionOf = Schema.decodeUnknownOption(
  Schema.Struct({ data: Schema.Struct({ reason: SettingsFailureSchema }) })
);

const hostError = (cause: unknown) => {
  const message = Predicate.hasProperty(cause, "message")
    ? String(cause.message)
    : String(cause);

  return Option.match(rejectionOf(cause), {
    onNone: () => new SettingsError({ message }),
    onSome: ({ data }) => new SettingsError({ message, reason: data.reason }),
  });
};

export const fromHost = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({ catch: hostError, try: call });

export const showToast = (show: () => void) =>
  Effect.try({ catch: hostError, try: show });

/** The settings RPC's promise client (`client.rpc(DirectorateRpc)` in either app), called with the same options each time. */
export const rpcBackend = <O>(
  rpc: {
    readonly settings: (input: undefined, options: O) => Promise<SettingsView>;
    readonly write: (input: WriteInput, options: O) => Promise<WriteResult>;
  },
  options: O
) =>
  backend(
    fromHost(() => rpc.settings(undefined, options)),
    (input) => fromHost(() => rpc.write(input, options))
  );

/** The OpenCode command callback owns this run; an interrupted walk ends quietly. */
export const configureFromHost = async (
  dialogs: Dialogs,
  directorate: Backend,
  signal?: AbortSignal
) => {
  const program = configure(dialogs, directorate).pipe(
    Effect.catchTag("DirectorateSettingsError", ({ message }) =>
      dialogs.alert({
        description: message,
        title: "The Directorate // Settings",
      })
    )
  );

  const exit = await Effect.runPromiseExit(program, { signal });

  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
    return;
  }

  throw new Error(Cause.pretty(exit.cause), {
    cause: Cause.squash(exit.cause),
  });
};
