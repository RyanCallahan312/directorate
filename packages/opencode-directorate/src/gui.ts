// Directorate GUI part (the package's ./gui-experimental, built to dist/ by vite.config.ts): /directorate-configure in OpenCode
// Desktop's command palette and composer. It runs the shared dialog walk (configure-flow.ts) on the app's dialogs and
// the settings RPC (rpc.ts) of the open session's server, at its location; with no session open, the app's own server.
import { Command, Plugin } from "@opencode/plugin/gui";
import type { Context } from "@opencode/plugin/gui";

import {
  backend,
  configureFromHost,
  fromHost,
  isWarning,
  showToast,
} from "./feature/settings/configure-client.ts";
import type { Dialogs } from "./feature/settings/configure-flow.ts";
import { DirectorateRpc } from "./rpc.ts";

/** The app's dialogs and toasts as the walk asks for them. Its select has no disabled options: those are left out. */
export const guiDialogs = (ctx: Context): Dialogs => ({
  alert: (o) => fromHost(() => ctx.dialogs.alert(o)),
  confirm: (o) => fromHost(() => ctx.dialogs.confirm(o)),
  path: (p) => p,
  prompt: (o) => fromHost(() => ctx.dialogs.prompt(o)),
  select: (o) =>
    fromHost(() =>
      ctx.dialogs.select({
        ...o,
        options: o.options.flatMap(({ disabled, ...option }) =>
          disabled ? [] : [option]
        ),
      })
    ),
  toast: (o) =>
    showToast(() => {
      ctx.toast.show({
        description: o.description,
        title: o.title ?? "The Directorate",
        variant: isWarning(o.variant) ? "default" : o.variant,
      });
    }),
});

/** /directorate-configure against the server and location of the session in front, read when it runs. */
export const configureInGui = (ctx: Context): Promise<void> => {
  const session = ctx.sessions.current();

  const directorate = (session?.server.client ?? ctx.client).rpc(
    DirectorateRpc
  );

  const location = session?.location;

  return configureFromHost(
    guiDialogs(ctx),
    backend(
      fromHost(() => directorate.settings(undefined, { location })),
      (input) => fromHost(() => directorate.write(input, { location }))
    ),
    ctx.signal
  );
};

export default Plugin.define({
  setup(ctx) {
    ctx.add(Command, () => ({
      description:
        "Default review scope and mode, Directorate Seats (panel models) and thinking levels, time budgets, and disabled lenses",
      group: "The Directorate",
      id: "configure",
      keywords: "directorate review panel seats lenses budget settings",
      run: () => configureInGui(ctx),
      slash: { name: "directorate-configure" },
      title: "Configure The Directorate",
    }));
  },
});
