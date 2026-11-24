// Directorate RPC (the package's ./rpc): what /directorate-configure reads and writes, in the TUI and the GUI. The server part
// registers the handlers (configure.ts), so files are read, checked, and written in one place; the TUI (tui.ts) and GUI
// (gui.ts) parts only ask. Each schema is also a Standard Schema, so their promise clients accept the same definition.
import { Rpc } from "@opencode/plugin/rpc";
import { Schema } from "effect";

import { SettingsSchema, SettingsScopeSchema } from "./model.ts";

const std = Schema.toStandardSchemaV1;

/** Why the server refused: an unreadable or changed settings file, or a model or thinking level OpenCode cannot run. */
const rejected = { rejected: std(Schema.Struct({})) };

/** What the settings method returns. */
const SettingsViewSchema = Schema.Struct({
  effective: Schema.String,
  /** No project file where the project directory holds the global one. */
  files: Schema.Struct({
    global: Schema.String,
    project: Schema.optionalKey(Schema.String),
  }),
  global: SettingsSchema,
  models: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      ref: Schema.String,
      variants: Schema.Array(Schema.String),
    })
  ),
  project: SettingsSchema,
});

export type SettingsView = typeof SettingsViewSchema.Type;

const WriteResultSchema = Schema.Struct({
  effective: Schema.String,
  path: Schema.String,
  removed: Schema.Boolean,
});

export type WriteResult = typeof WriteResultSchema.Type;

export const DirectorateRpc = Rpc.define({
  events: {},
  id: "directorate",
  methods: {
    /** Both files, what they add up to, and the chat models a Directorate Seat can use. */
    settings: {
      errors: rejected,
      input: std(Schema.Undefined),
      output: std(SettingsViewSchema),
    },
    /** Replaces one scope's file; {} removes it. */
    write: {
      errors: rejected,
      input: std(
        Schema.Struct({
          previous: Schema.optionalKey(SettingsSchema),
          scope: SettingsScopeSchema,
          settings: SettingsSchema,
        })
      ),
      output: std(WriteResultSchema),
    },
  },
});
