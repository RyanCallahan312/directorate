// Directorate TUI part (the package's ./tui): /directorate-configure in the prompt and the command palette. It runs the shared dialog
// walk (configure-flow.ts) on the TUI's dialogs and the settings RPC (rpc.ts) at the TUI's location.
import type { Plugin } from "@opencode/plugin/tui";

import { configure, messageOf } from "./configure-flow.ts";
import type { Dialogs } from "./configure-flow.ts";
import { DirectorateRpc } from "./rpc.ts";

/** The TUI's dialogs and toasts as the walk asks for them. */
export const tuiDialogs = (context: Plugin.Context): Dialogs => {
  const { dialog, toast, format } = context.ui;

  return {
    alert: (o) => dialog.alert({ message: o.description, title: o.title }),
    confirm: (o) =>
      dialog.confirm({
        label: { cancel: o.cancel, confirm: o.confirm },
        message: o.description,
        title: o.title,
      }),
    path: (p) => format.path(p),
    prompt: (o) => dialog.prompt(o),
    select: (o) =>
      dialog.select({
        ...o,
        options: o.options.map(({ group, ...rest }) =>
          group === undefined ? rest : { ...rest, category: group }
        ),
      }),
    toast: ({ description, title, variant }) => {
      const options = { message: description, variant };
      toast.show(title === undefined ? options : { ...options, title });
    },
  };
};

// Plugin.define returns its argument; importing only its type keeps this module loadable outside the TUI (tests).
const plugin: Plugin.Definition = {
  id: "directorate",
  setup(context) {
    context.keymap.layer(() => ({
      // A layer without a mode is limited to "base", which is not active while typing in the prompt: its slash
      // command would never complete. The host's own slash commands are global too.
      commands: [
        {
          description:
            "Default review scope and mode, Directorate Seats (panel models) and thinking levels, time budgets, and disabled lenses",
          group: "The Directorate",
          id: "directorate.configure",
          palette: true,
          run: async () => {
            const location =
              context.location ?? context.data.location.default();

            const directorate = context.client.rpc(DirectorateRpc);

            try {
              await configure(tuiDialogs(context), {
                settings: () => directorate.settings(undefined, { location }),
                write: (input) => directorate.write(input, { location }),
              });
            } catch (error) {
              await context.ui.dialog.alert({
                message: messageOf(error),
                title: "The Directorate // Settings",
              });
            }
          },
          slash: { name: "directorate-configure" },
          title: "Configure The Directorate",
        },
      ],
      mode: "global",
    }));
  },
};

export default plugin;
