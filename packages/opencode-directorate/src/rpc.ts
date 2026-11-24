// Directorate RPC (the package's ./rpc): what /directorate-configure reads and writes, in the TUI and the GUI. The server part
// registers the handlers (configure.ts), so files are read, checked, and written in one place; the TUI (tui.ts) and GUI
// (gui.ts) parts only ask. Each schema is also a Standard Schema, so their promise clients accept the same definition.
import { Rpc } from "@opencode/plugin/rpc";
import { Schema } from "effect";

import { Settings, SettingsScope } from "./model.ts";

const std = Schema.toStandardSchemaV1;
/** Why the server refused: a settings file it cannot read, or a model or thinking level OpenCode cannot run. */
const rejected = { rejected: std(Schema.Struct({})) };

/** What the settings method returns. */
const SettingsViewSchema = Schema.Struct({
  /** No project file where the project directory holds the global one. */
  files: Schema.Struct({
    global: Schema.String,
    project: Schema.optionalKey(Schema.String),
  }),
  global: Settings,
  project: Settings,
  effective: Schema.String,
  models: Schema.Array(
    Schema.Struct({
      ref: Schema.String,
      name: Schema.String,
      variants: Schema.Array(Schema.String),
    })
  ),
});
export type SettingsView = typeof SettingsViewSchema.Type;
const WriteResultSchema = Schema.Struct({
  path: Schema.String,
  removed: Schema.Boolean,
  effective: Schema.String,
});
export type WriteResult = typeof WriteResultSchema.Type;

export const DirectorateRpc = Rpc.define({
  id: "directorate",
  methods: {
    /** Both files, what they add up to, and the chat models a Directorate Seat can use. */
    settings: {
      input: std(Schema.Undefined),
      output: std(SettingsViewSchema),
      errors: rejected,
    },
    /** Replaces one scope's file; {} removes it. */
    write: {
      input: std(Schema.Struct({ scope: SettingsScope, settings: Settings })),
      output: std(WriteResultSchema),
      errors: rejected,
    },
  },
  events: {},
});
