// Directorate configuration: show and write directorate.json, for /directorate-configure (through the RPC in rpc.ts)
// and for the directorate_configure tool. Settings are checked before they are written: unknown lenses and values fail
// to decode, and each panel model and thinking level must be one OpenCode can run. A hand-edited file with an unknown
// key is rejected when read; tool input drops unknown keys, so the tool's result shows exactly what was stored.
import { Effect, Schema } from "effect";

import { failure, ignore } from "./error.ts";
import {
  DEFAULT_PANEL,
  isUnset,
  LENSES,
  PANELIST,
  REFUTER,
  REVIEWER,
  SCOUT,
  Settings,
  SettingsScope,
} from "./model.ts";
import { DirectorateRpc } from "./rpc.ts";
import { Host, Sessions } from "./session.ts";
import { describe, SettingsStore } from "./settings.ts";
import { type DefineTool, optional, str } from "./tool.ts";

const REVIEW_ROLES = new Set([REVIEWER, SCOUT, PANELIST, REFUTER]);
const MAX_LISTED = 40;

const make = Effect.gen(function* () {
  const host = yield* Host;
  const store = yield* SettingsStore;
  /** Available chat models, as "providerID/modelID" with their thinking levels. */
  const models = Effect.fn("Directorate.models")(function* (directory: string) {
    const out = yield* host.model
      .list({ location: { directory }, types: ["chat"] })
      .pipe(Effect.catch((e) => failure(`Cannot list models: ${String(e)}`)));
    return out.data
      .filter((m) => m.enabled)
      .map((m) => ({
        ref: `${m.providerID}/${m.id}`,
        name: m.name,
        variants: m.variants.map((v) => String(v.id)),
      }));
  });
  /** Writes one scope's file once every panel seat names an available model and one of its thinking levels. */
  const save = Effect.fn("Directorate.saveSettings")(function* (
    scope: SettingsScope,
    directory: string,
    settings: Settings
  ) {
    const seats = settings.panel?.models ?? [];
    if (seats.length) {
      const available = yield* models(directory);
      const bad = seats.flatMap((s) => {
        const m = available.find((x) => x.ref === s.model);
        if (!m) return [`${s.model} is not an available chat model`];
        if (s.variant && !m.variants.includes(s.variant))
          return [
            `${s.model} has no thinking level "${s.variant}" (it has: ${m.variants.join(", ") || "none"})`,
          ];
        return [];
      });
      if (bad.length) return yield* failure(`Not written: ${bad.join("; ")}.`);
    }
    const { path, effective } = yield* store.write(scope, directory, settings);
    return {
      path,
      removed: isUnset(settings),
      effective: describe(effective) ?? "Directorate defaults",
    };
  });
  return { models, save, load: store.load };
});

export function configureTool(tool: DefineTool) {
  tool({
    name: "directorate_configure",
    description:
      "Show or write Directorate settings (directorate.json): default review scope and mode, panel on/off and its models (Directorate Seats) with thinking levels, time budgets, and disabled lenses. show: both files and the effective settings; with find, also the available models and their thinking levels. write: replaces one scope's file (global: OpenCode's config directory, ~/.config/opencode/directorate.json; project: <repo>/.opencode/directorate.json) with settings; {} removes it. Use only when the user asks to configure The Directorate.",
    input: Schema.Struct({
      action: Schema.Literals(["show", "write"]),
      scope: optional(
        SettingsScope.annotate({
          description:
            "For write: global (every repository) or project (this repository).",
        })
      ),
      settings: optional(
        Settings.annotate({
          description: "For write: the complete settings for the scope.",
        })
      ),
      find: optional(
        str.annotate({
          description:
            "For show: list available models whose id or name contains this text.",
        })
      ),
    }),
    execute: function* (input, c) {
      if (REVIEW_ROLES.has(c.agent))
        return yield* failure(
          "Directorate review agents cannot modify Directorate settings."
        );
      const host = yield* Host;
      const directorate = yield* make;
      const directory =
        (yield* (yield* Sessions).directory(c.sessionID)) ??
        host.location.directory;
      if (input.action === "write") {
        if (!input.scope || !input.settings)
          return yield* failure(
            `write needs scope and settings ({} removes the scope's file).`
          );
        const out = yield* directorate
          .save(input.scope, directory, input.settings)
          .pipe(
            Effect.catch((e) =>
              failure(
                `${e.message} Look models up with action "show" and find.`
              )
            )
          );
        const stored = out.removed
          ? `Removed ${out.path}.`
          : `Wrote ${out.path} (keys not shown were not recognized and were dropped):\n\`\`\`json\n${JSON.stringify(input.settings, null, 2)}\n\`\`\``;
        return { content: `${stored}\nEffective settings: ${out.effective}.` };
      }
      const now = yield* directorate.load(directory);
      const show = (label: string, file: string, s: Settings) =>
        `${label} (${file}): ${describe(s) ? `\n\`\`\`json\n${JSON.stringify(s, null, 2)}\n\`\`\`` : "not set"}`;
      const lines = [
        show("Global", now.files.global, now.global),
        show(
          "Project",
          now.files.project ??
            "none here: this project's .opencode/directorate.json is the global file",
          now.project
        ),
        `Effective: ${describe(now.effective) ?? "Directorate defaults"}.`,
        `Unset keys keep Directorate defaults: scope branch; mode default; panel off, with seats ${DEFAULT_PANEL.join(", ")}; budgets 20, 30, 60 min (default, code-quality, full), half again for panels; no lenses disabled.`,
        `Lenses: ${LENSES.join(", ")}.`,
      ];
      if (input.find !== undefined) {
        const q = input.find.toLowerCase();
        const found = (yield* directorate.models(directory)).filter(
          (m) =>
            m.ref.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
        );
        lines.push(
          "",
          `Models matching "${input.find}" (thinking levels in brackets):`,
          ...found
            .slice(0, MAX_LISTED)
            .map(
              (m) =>
                `- ${m.ref} (${m.name}) [${m.variants.join(", ") || "none"}]`
            )
        );
        if (found.length > MAX_LISTED)
          lines.push(`… ${found.length - MAX_LISTED} more; narrow find.`);
        if (!found.length) lines.push("none");
      }
      return { content: lines.join("\n") };
    },
  });
}

/**
 * The RPC behind /directorate-configure, for this plugin instance's location; registered for the plugin's lifetime.
 * Reviews do not depend on it, so a failed registration only costs the UI command.
 */
export const configureRpc = Effect.fn("Directorate.configureRpc")(function* () {
  const host = yield* Host;
  const directorate = yield* make;
  const directory = host.location.directory;
  yield* host.rpc
    .register(DirectorateRpc, {
      settings: (_, c) =>
        Effect.gen(function* () {
          const now = yield* directorate.load(directory);
          return {
            files: now.files.project ? now.files : { global: now.files.global },
            global: now.global,
            project: now.project,
            effective: describe(now.effective) ?? "Directorate defaults",
            models: yield* directorate.models(directory),
          };
        }).pipe(Effect.mapError((e) => c.error("rejected", e.message, {}))),
      write: ({ scope, settings }, c) =>
        directorate
          .save(scope, directory, settings)
          .pipe(Effect.mapError((e) => c.error("rejected", e.message, {}))),
    })
    .pipe(
      ignore(
        "settings RPC registration failed; /directorate-configure is unavailable",
        "Warn"
      )
    );
});
