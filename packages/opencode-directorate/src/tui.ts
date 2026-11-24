// Directorate TUI part (the package's ./tui): /directorate-configure in the prompt and the command palette. It runs the shared dialog
// walk (configure-flow.ts) on the TUI's dialogs and the settings RPC (rpc.ts) at the TUI's location.
import type { Plugin } from "@opencode/plugin/tui";

import { configure, type Dialogs, messageOf } from "./configure-flow.ts";
import { DirectorateRpc } from "./rpc.ts";

/** The TUI's dialogs and toasts as the walk asks for them. */
export function tuiDialogs(context: Plugin.Context): Dialogs {
  const { dialog, toast, format } = context.ui;
  return {
    select: (o) =>
      dialog.select({
        ...o,
        options: o.options.map(({ group, ...rest }) => ({
          ...rest,
          category: group,
        })),
      }),
    prompt: (o) => dialog.prompt(o),
    confirm: (o) =>
      dialog.confirm({
        title: o.title,
        message: o.description,
        label: { confirm: o.confirm, cancel: o.cancel },
      }),
    alert: (o) => dialog.alert({ title: o.title, message: o.description }),
    toast: (o) =>
      toast.show({
        title: o.title,
        message: o.description,
        variant: o.variant,
      }),
    path: (p) => format.path(p),
  };
}

// Plugin.define returns its argument; importing only its type keeps this module loadable outside the TUI (tests).
const plugin: Plugin.Definition = {
  id: "directorate",
  setup(context) {
    context.keymap.layer(() => ({
      // A layer without a mode is limited to "base", which is not active while typing in the prompt: its slash
      // command would never complete. The host's own slash commands are global too.
      mode: "global",
      commands: [
        {
          id: "directorate.configure",
          title: "Configure The Directorate",
          description:
            "Default review mode, Directorate Seats (panel models) and thinking levels, time budgets, and disabled lenses",
          group: "The Directorate",
          palette: true,
          slash: { name: "directorate-configure" },
          run: () => {
            const location =
              context.location ?? context.data.location.default();
            const directorate = context.client.rpc(DirectorateRpc);
            return configure(tuiDialogs(context), {
              settings: () => directorate.settings(undefined, { location }),
              write: (input) => directorate.write(input, { location }),
            }).catch((e) =>
              context.ui.dialog.alert({
                title: "The Directorate // Settings",
                message: messageOf(e),
              })
            );
          },
        },
      ],
    }));
  },
};
export default plugin;
