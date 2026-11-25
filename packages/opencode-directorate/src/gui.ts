// Directorate GUI part (the package's ./gui-experimental, built to dist/ by vite.config.ts): /directorate-configure in OpenCode
// Desktop's command palette and composer. It runs the shared dialog walk (configure-flow.ts) on the app's dialogs and
// the settings RPC (rpc.ts) of the open session's server, at its location; with no session open, the app's own server.
import { Command, Plugin } from "@opencode/plugin/gui";
import type { Context } from "@opencode/plugin/gui";

import { configure, messageOf } from "./configure-flow.ts";
import type { Dialogs } from "./configure-flow.ts";
import { DirectorateRpc } from "./rpc.ts";

/** The app's dialogs and toasts as the walk asks for them. Its select has no disabled options: those are left out. */
export const guiDialogs = (ctx: Context): Dialogs => ({
  alert: (o) => ctx.dialogs.alert(o),
  confirm: (o) => ctx.dialogs.confirm(o),
  path: (p) => p,
  prompt: (o) => ctx.dialogs.prompt(o),
  select: (o) =>
    ctx.dialogs.select({
      ...o,
      options: o.options.flatMap(({ disabled, ...option }) =>
        disabled ? [] : [option]
      ),
    }),
  toast: (o) => {
    ctx.toast.show({
      description: o.description,
      title: o.title ?? "The Directorate",
      variant: o.variant === "warning" ? "default" : o.variant,
    });
  },
});

/** /directorate-configure against the server and location of the session in front, read when it runs. */
export const configureInGui = async (ctx: Context): Promise<void> => {
  const session = ctx.sessions.current();

  const directorate = (session?.server.client ?? ctx.client).rpc(
    DirectorateRpc
  );

  const location = session?.location;
  await configure(guiDialogs(ctx), {
    settings: () => directorate.settings(undefined, { location }),
    write: (input) => directorate.write(input, { location }),
  }).catch((error) =>
    ctx.dialogs.alert({
      description: messageOf(error),
      title: "The Directorate // Settings",
    })
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
