// directorate.json: its schema, its scopes, how two settings compare, and how they merge and resolve. The project's file
// (<repo>/.opencode/directorate.json) overrides the global one (directorate.json in OpenCode's global config directory,
// ~/.config/opencode) key by key; a directorate_seal input overrides both.
import { Schema } from "effect";

import {
  ModeSchema,
  ReviewScopeSchema,
} from "../../workflow/review/request.ts";
import type { Mode } from "../../workflow/review/request.ts";
import { DEFAULT_PANEL, SeatSpecSchema, seatRef } from "../dispatch/seat.ts";
import { LensSchema } from "../ledger/entry.ts";

/** Which directorate.json: global (in OpenCode's global config directory, ~/.config/opencode) or the project's (<repo>/.opencode). */
export const SettingsScopeSchema = Schema.Literals(["global", "project"]);

export type SettingsScope = typeof SettingsScopeSchema.Type;

const Minutes = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(2),
  Schema.isLessThanOrEqualTo(240)
);

/** directorate.json. Every key is optional; an absent key falls through to the global file, then to Directorate defaults. */
export const SettingsSchema = Schema.Struct({
  budget_minutes: Schema.optionalKey(
    Schema.Struct({
      "code-quality": Schema.optionalKey(Minutes),
      default: Schema.optionalKey(Minutes),
      full: Schema.optionalKey(Minutes),
    }).annotate({
      description: "Time budget per mode, used as-is (panel reviews too).",
    })
  ),
  default_scope: Schema.optionalKey(
    ReviewScopeSchema.annotate({
      description: "Review scope when the request names no scope or target.",
    })
  ),
  lenses: Schema.optionalKey(
    Schema.Struct({
      disabled: Schema.optionalKey(
        Schema.Array(LensSchema).annotate({
          description: "Lenses reviews skip; entries under them are rejected.",
        })
      ),
    })
  ),
  mode: Schema.optionalKey(
    ModeSchema.annotate({
      description: "Review mode when the request names none.",
    })
  ),
  panel: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(
        Schema.Boolean.annotate({
          description:
            "Run a panel review unless the request asks for a single model.",
        })
      ),
      models: Schema.optionalKey(
        Schema.Array(SeatSpecSchema)
          .check(Schema.isMinLength(1))
          .annotate({ description: "The panel's seats, in order." })
      ),
    })
  ),
});

export type Settings = typeof SettingsSchema.Type;

/** Drops unset fields and empty sections, but keeps an explicit empty disabled-lens list. */
export const normalizeSettings = (s: Settings): Settings => {
  const b = s.budget_minutes;

  const budgets = {
    ...(b?.["code-quality"] !== undefined && {
      "code-quality": b["code-quality"],
    }),
    ...(b?.default !== undefined && { default: b.default }),
    ...(b?.full !== undefined && { full: b.full }),
  };

  const p = s.panel;

  const panel = {
    ...(p?.enabled !== undefined && { enabled: p.enabled }),
    ...(p?.models?.length && { models: p.models }),
  };

  return {
    ...(Object.keys(budgets).length && { budget_minutes: budgets }),
    ...(s.default_scope && { default_scope: s.default_scope }),
    ...(s.lenses?.disabled !== undefined && {
      lenses: { disabled: s.lenses.disabled },
    }),
    ...(s.mode && { mode: s.mode }),
    ...(Object.keys(panel).length && { panel }),
  };
};

/** No key set: writing these settings removes the file. */
export const isUnset = (s: Settings) =>
  Object.keys(normalizeSettings(s)).length === 0;

const settingsEquivalent = Schema.toEquivalence(SettingsSchema);

export const sameSettings = (a: Settings, b: Settings) =>
  settingsEquivalent(normalizeSettings(a), normalizeSettings(b));

export const SettingsJson = Schema.fromJsonString(SettingsSchema, { space: 2 });

/** The project's settings over the global ones, key by key within each section. */
export const merge = (global: Settings, project: Settings): Settings => ({
  ...global,
  ...project,
  ...((global.budget_minutes || project.budget_minutes) && {
    budget_minutes: { ...global.budget_minutes, ...project.budget_minutes },
  }),
  ...((global.lenses || project.lenses) && {
    lenses: { ...global.lenses, ...project.lenses },
  }),
  ...((global.panel || project.panel) && {
    panel: { ...global.panel, ...project.panel },
  }),
});

/** What a new review gets from settings: its mode, whether it is a panel and with which seats, its budget, and lenses off. */
export const resolve = (
  s: Settings,
  input: {
    mode?: Mode | undefined;
    panel?: boolean | undefined;
    panelModels?: readonly string[] | undefined;
    budgetMinutes?: number | undefined;
  }
) => {
  const mode = input.mode ?? s.mode ?? "default";

  const defaultPanel =
    (input.panel ?? s.panel?.enabled)
      ? (s.panel?.models?.map(seatRef) ?? DEFAULT_PANEL)
      : undefined;

  const panel = input.panelModels?.length ? input.panelModels : defaultPanel;

  return {
    budgetMinutes: input.budgetMinutes ?? s.budget_minutes?.[mode],
    lensesOff: s.lenses?.disabled?.length ? s.lenses.disabled : undefined,
    mode,
    panel,
  };
};

/** One line for a model: the effective settings, or nothing when no file sets anything. */
export const describe = (settings: Settings): string | undefined => {
  const s = normalizeSettings(settings);

  const parts = [
    s.mode && `mode ${s.mode}`,
    s.default_scope && `scope ${s.default_scope}`,
    s.panel?.enabled !== undefined && `panel ${s.panel.enabled ? "on" : "off"}`,
    s.panel?.models && `panel models ${s.panel.models.map(seatRef).join(", ")}`,
    s.budget_minutes &&
      `budgets ${Object.entries(s.budget_minutes)
        .map(([m, n]) => `${m} ${n} min`)
        .join(", ")}`,
    s.lenses?.disabled?.length && `lenses off ${s.lenses.disabled.join(", ")}`,
  ].filter(Boolean);

  return parts.length ? parts.join(" · ") : undefined;
};
