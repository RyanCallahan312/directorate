// directorate.json: its schema, its scopes, and how two settings compare.
import { Schema } from "effect";

import {
  ModeSchema,
  ReviewScopeSchema,
} from "../../workflow/review/request.ts";
import { SeatSchema } from "../dispatch/seat.ts";
import { Lens } from "../ledger/entry.ts";

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
        Schema.Array(Lens).annotate({
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
        Schema.Array(SeatSchema)
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
