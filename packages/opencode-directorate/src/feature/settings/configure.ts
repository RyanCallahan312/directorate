// Directorate configuration: show and write directorate.json, for /directorate-configure (through the RPC in rpc.ts)
// and for the directorate_configure tool. Settings are checked before they are written: unknown lenses and values fail
// to decode, and each panel model and thinking level must be one OpenCode can run. A hand-edited file with an unknown
// key is rejected when read; tool input drops unknown keys, so the tool's result shows exactly what was stored.
import { Effect, Match, Predicate, Schema } from "effect";

import { ignore } from "../../platform/error.ts";
import { actor, Host, optional, str } from "../../platform/platform.ts";
import type { DefineTool } from "../../platform/platform.ts";
import { Sessions } from "../../seal/seal.ts";
import {
  DEFAULT_BUDGET,
  DEFAULT_MODE,
  DEFAULT_REVIEW_SCOPE,
  ModeSchema,
  PANEL_BUDGET_FACTOR,
} from "../../workflow/review/request.ts";
import { DEFAULT_PANEL } from "../dispatch/seat.ts";
import { LensSchema } from "../ledger/entry.ts";
import { NO_GLOBAL_FILE, NO_PROJECT_FILE } from "./configure-flow.ts";
import {
  describe,
  isUnset,
  SettingsFailureSchema,
  SettingsSchema,
  SettingsScopeSchema,
} from "./file.ts";
import type { Settings, SettingsScope } from "./file.ts";
import { DirectorateRpc } from "./rpc.ts";
import { settingsUnavailable, SettingsStore } from "./store.ts";
import type {
  SettingsBusy,
  SettingsChanged,
  SettingsUnavailable,
} from "./store.ts";

/** A settings change the tool refuses: a review agent's, an incomplete write, or models the host does not have. */
class SettingsRejected extends Schema.TaggedError<
  SettingsRejected,
  { readonly brand: unique symbol }
>()("SettingsRejected", { message: Schema.String }) {}

/** Why a settings read or write was refused, as the settings RPC reports it. */
const failureOf = Match.type<
  SettingsBusy | SettingsChanged | SettingsRejected | SettingsUnavailable
>().pipe(
  Match.tag("SettingsBusy", () => SettingsFailureSchema.make("busy")),
  Match.tag("SettingsChanged", () => SettingsFailureSchema.make("changed")),
  Match.tag("SettingsRejected", () => SettingsFailureSchema.make("invalid")),
  Match.tag("SettingsUnavailable", () =>
    SettingsFailureSchema.make("unavailable")
  ),
  Match.exhaustive
);

const show = (label: string, file: string, s: Settings) =>
  `${label} (${file}): ${isUnset(s) ? "not set" : `\n\`\`\`json\n${JSON.stringify(s, null, 2)}\n\`\`\``}`;

const MAX_LISTED = 40;

/** What directorate_configure does: show the settings, or write one scope's file. */
const ConfigureActionSchema = Schema.Literals(["show", "write"]);

const isWrite = Schema.is(ConfigureActionSchema.pick(["write"]));

/** Both settings files and what they add up to. */
const load = (directory: string) =>
  SettingsStore.use((store) => store.load(directory));

/** Available chat models, as "providerID/modelID" with their thinking levels. */
const models = Effect.fn("Directorate.models")(function* models(
  directory: string
) {
  const out = yield* (yield* Host).model
    .list({ location: { directory }, types: ["chat"] })
    .pipe(
      Effect.mapError((error) =>
        settingsUnavailable(
          "Cannot list models",
          Predicate.isError(error) ? error : new Error(String(error))
        )
      )
    );

  return out.data
    .filter((m) => m.enabled)
    .map((m) => ({
      name: m.name,
      ref: `${m.providerID}/${m.id}`,
      variants: m.variants.map((v) => String(v.id)),
    }));
});

/** Writes one scope's file once every panel seat names an available model and one of its thinking levels. */
const save = Effect.fn("Directorate.saveSettings")(function* save(
  scope: SettingsScope,
  directory: string,
  input: Settings,
  previous?: Settings
) {
  const seats = input.panel?.models ?? [];

  if (seats.length) {
    const available = yield* models(directory);

    const bad = seats.flatMap((s) => {
      const m = available.find((x) => x.ref === s.model);

      if (!m) {
        return [`${s.model} is not an available chat model`];
      }

      if (s.variant && !m.variants.includes(s.variant)) {
        return [
          `${s.model} has no thinking level "${s.variant}" (it has: ${m.variants.join(", ") || "none"})`,
        ];
      }

      return [];
    });

    if (bad.length) {
      return yield* new SettingsRejected({
        message: `Not written: ${bad.join("; ")}.`,
      });
    }
  }

  const { path, effective, removed, settings } =
    yield* (yield* SettingsStore).write(scope, directory, input, previous);

  return {
    effective: describe(effective) ?? "Directorate defaults",
    path,
    removed,
    settings,
  };
});

export const configureTool = (
  tool: DefineTool<Sessions | Host | SettingsStore>
) => {
  tool({
    description:
      "Show or write Directorate settings (directorate.json): default review scope and mode, panel on/off and its models (Directorate Seats) with thinking levels, time budgets, and disabled lenses. show: both files and the effective settings; with find, also the available models and their thinking levels. write: replaces one scope's file (global: OpenCode's config directory, ~/.config/opencode/directorate.json; project: <repo>/.opencode/directorate.json) with settings; {} removes it. Use only when the user asks to configure The Directorate.",
    *execute(input, c) {
      if (actor(c).role) {
        return yield* new SettingsRejected({
          message:
            "Directorate review agents cannot modify Directorate settings.",
        });
      }

      const host = yield* Host;

      const directory =
        (yield* (yield* Sessions).directory(c.sessionID)) ??
        host.location.directory;

      if (isWrite(input.action)) {
        if (!input.scope || !input.settings) {
          return yield* new SettingsRejected({
            message: `write needs scope and settings ({} removes the scope's file).`,
          });
        }

        const out = yield* save(input.scope, directory, input.settings).pipe(
          Effect.catchTag("SettingsRejected", (error) =>
            Effect.fail(
              new SettingsRejected({
                message: `${error.message} Look models up with action "show" and find.`,
              })
            )
          )
        );

        const stored = out.removed
          ? `Removed ${out.path}.`
          : `Wrote ${out.path}:\n\`\`\`json\n${JSON.stringify(out.settings, null, 2)}\n\`\`\``;

        return { content: `${stored}\nEffective settings: ${out.effective}.` };
      }

      const now = yield* load(directory);

      const lines = [
        show("Global", now.files.global ?? NO_GLOBAL_FILE, now.global),
        show("Project", now.files.project ?? NO_PROJECT_FILE, now.project),
        `Effective: ${describe(now.effective) ?? "Directorate defaults"}.`,
        `Unset keys keep Directorate defaults: scope ${DEFAULT_REVIEW_SCOPE}; mode ${DEFAULT_MODE}; panel off, with seats ${DEFAULT_PANEL.join(", ")}; budgets ${ModeSchema.literals.map((m) => DEFAULT_BUDGET[m]).join(", ")} min (${ModeSchema.literals.join(", ")}), ×${PANEL_BUDGET_FACTOR} for panels; no lenses disabled.`,
        `Lenses: ${LensSchema.literals.join(", ")}.`,
      ];

      if (input.find !== undefined) {
        const q = input.find.toLowerCase();

        const found = (yield* models(directory)).filter(
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

        if (found.length > MAX_LISTED) {
          lines.push(`… ${found.length - MAX_LISTED} more; narrow find.`);
        }

        if (!found.length) {
          lines.push("none");
        }
      }

      return { content: lines.join("\n") };
    },
    harness: false,
    input: Schema.Struct({
      action: ConfigureActionSchema,
      find: optional(
        str.annotate({
          description:
            "For show: list available models whose id or name contains this text.",
        })
      ),
      scope: optional(
        SettingsScopeSchema.annotate({
          description:
            "For write: global (every repository) or project (this repository).",
        })
      ),
      settings: optional(
        SettingsSchema.annotate({
          description: "For write: the complete settings for the scope.",
        })
      ),
    }),
    name: "directorate_configure",
  });
};

/**
 * The RPC behind /directorate-configure, for this plugin instance's location; registered for the plugin's lifetime.
 * Reviews do not depend on it, so a failed registration only costs the UI command.
 */
export const configureRpc = Effect.fn("Directorate.configureRpc")(
  function* configureRpc() {
    const host = yield* Host;
    const services = yield* Effect.context<Host | SettingsStore>();
    const { directory } = host.location;
    yield* host.rpc
      .register(DirectorateRpc, {
        settings: (_, c) =>
          Effect.gen(function* settings() {
            const now = yield* load(directory);

            return {
              effective: describe(now.effective) ?? "Directorate defaults",
              files: now.files,
              global: now.global,
              models: yield* models(directory),
              project: now.project,
            };
          }).pipe(
            Effect.provideContext(services),
            Effect.mapError((e) =>
              c.error("rejected", e.message, { reason: failureOf(e) })
            )
          ),
        write: ({ previous, scope, settings }, c) =>
          save(scope, directory, settings, previous).pipe(
            Effect.map(({ effective, path, removed }) => ({
              effective,
              path,
              removed,
            })),
            Effect.provideContext(services),
            Effect.mapError((e) =>
              c.error("rejected", e.message, { reason: failureOf(e) })
            )
          ),
      })
      .pipe(
        ignore(
          "settings RPC registration failed; /directorate-configure is unavailable",
          "Warn"
        )
      );
  }
);
