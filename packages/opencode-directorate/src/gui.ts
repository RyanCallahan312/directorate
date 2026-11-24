// Directorate GUI part (the package's ./gui-experimental, built to dist/ by vite.config.ts): /directorate-configure in OpenCode
// Desktop's command palette and composer. It runs the shared dialog walk (configure-flow.ts) on the app's dialogs and
// the settings RPC (rpc.ts) of the open session's server, at its location; with no session open, the app's own server.
import { Command, Plugin, type SetupContext } from "@opencode/plugin/gui";

import { configure, type Dialogs, messageOf } from "./configure-flow.ts";
import { DirectorateRpc } from "./rpc.ts";

/** The app's dialogs and toasts as the walk asks for them. Its select has no disabled options: those are left out. */
export function guiDialogs(ctx: SetupContext<{}>): Dialogs {
  return {
    select: (o) =>
      ctx.dialogs.select({
        ...o,
        options: o.options
          .filter((x) => !x.disabled)
          .map(({ disabled: _, ...rest }) => rest),
      }),
    prompt: (o) => ctx.dialogs.prompt(o),
    confirm: (o) => ctx.dialogs.confirm(o),
    alert: (o) => ctx.dialogs.alert(o),
    toast: (o) =>
      void ctx.toast.show({
        title: o.title ?? "The Directorate",
        description: o.description,
        variant: o.variant === "warning" ? "default" : o.variant,
      }),
    path: (p) => p,
  };
}

/** /directorate-configure against the server and location of the session in front, read when it runs. */
export async function configureInGui(ctx: SetupContext<{}>): Promise<void> {
  const session = ctx.sessions.current();
  const directorate = (session?.server.client ?? ctx.client).rpc(
    DirectorateRpc
  );
  const location = session?.location;
  await configure(guiDialogs(ctx), {
    settings: () => directorate.settings(undefined, { location }),
    write: (input) => directorate.write(input, { location }),
  }).catch((e) =>
    ctx.dialogs.alert({
      title: "The Directorate // Settings",
      description: messageOf(e),
    })
  );
}

export default Plugin.define({
  setup(ctx) {
    ctx.add(Command, () => ({
      id: "configure",
      title: "Configure The Directorate",
      description:
        "Default review mode, Directorate Seats (panel models) and thinking levels, time budgets, and disabled lenses",
      keywords: "directorate review panel seats lenses budget settings",
      group: "The Directorate",
      slash: { name: "directorate-configure" },
      run: () => configureInGui(ctx),
    }));
  },
});
