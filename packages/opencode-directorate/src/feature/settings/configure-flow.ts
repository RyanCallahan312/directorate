// /directorate-configure's dialog walk over one directorate.json, shared by the TUI part (tui.ts) and the GUI part (gui.ts): each
// adapts its host's dialogs to Dialogs and binds the settings RPC (rpc.ts) to a location as Backend. The server checks
// models and thinking levels and writes the file. The flow only orchestrates dialogs and the settings RPC.
import { Effect, Match, Result, Schema } from "effect";

import {
  DEFAULT_BUDGET,
  DEFAULT_MODE,
  DEFAULT_REVIEW_SCOPE,
  ModeSchema,
  PANEL_BUDGET_FACTOR,
  ReviewScopeSchema,
} from "../../workflow/review/request.ts";
import type { Mode, ReviewScope } from "../../workflow/review/request.ts";
import { DEFAULT_PANEL, seatRef } from "../dispatch/seat.ts";
import type { SeatSpec } from "../dispatch/seat.ts";
import { LensSchema } from "../ledger/entry.ts";
import type { Lens } from "../ledger/entry.ts";
import {
  isProjectScope,
  normalizeSettings,
  sameSettings,
  SettingsScopeSchema,
} from "./file.ts";
import type { Settings, SettingsScope } from "./file.ts";
import type { SettingsView, WriteInput, WriteResult } from "./rpc.ts";

/** How a choice in a select reads. A host without disabled options leaves disabled ones out. */
const ChoiceLabelSchema = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  disabled: Schema.optionalKey(Schema.Boolean),
  group: Schema.optionalKey(Schema.String),
  title: Schema.String,
});

/** One choice in a select: how it reads, and the value it stands for. */
export type DialogChoice<V> = typeof ChoiceLabelSchema.Type & {
  readonly value: V;
};

/** A select's title and the hint it shows before a choice. */
const SelectDialogSchema = Schema.Struct({
  placeholder: Schema.optionalKey(Schema.String),
  title: Schema.String,
});

/** A text prompt: its title, its help, and the text it starts with. */
const PromptDialogSchema = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  title: Schema.String,
  value: Schema.optionalKey(Schema.String),
});

/** A question and the labels of its two answers. */
const ConfirmDialogSchema = Schema.Struct({
  cancel: Schema.String,
  confirm: Schema.String,
  description: Schema.String,
  title: Schema.String,
});

/** A message the user dismisses. */
const AlertDialogSchema = Schema.Struct({
  description: Schema.String,
  title: Schema.String,
});

/** How a toast reads: done, worth a look, or failed. */
const ToastVariantSchema = Schema.Literals(["success", "warning", "error"]);

/** A host with no warning toast shows its default one instead. */
export const isWarning = Schema.is(ToastVariantSchema.pick(["warning"]));

/** A passing notice; without a title the host shows its own. */
const ToastSchema = Schema.Struct({
  description: Schema.String,
  title: Schema.optionalKey(Schema.String),
  variant: ToastVariantSchema,
});

/** The dialogs the walk needs; each resolves undefined (false for confirm) when the user backs out. */
export interface Dialogs {
  select: <V>(
    options: typeof SelectDialogSchema.Type & {
      readonly current?: V | undefined;
      readonly options: readonly DialogChoice<V>[];
    }
  ) => Effect.Effect<V | undefined, SettingsError>;
  prompt: (
    options: typeof PromptDialogSchema.Type
  ) => Effect.Effect<string | undefined, SettingsError>;
  confirm: (
    options: typeof ConfirmDialogSchema.Type
  ) => Effect.Effect<boolean | undefined, SettingsError>;
  alert: (
    options: typeof AlertDialogSchema.Type
  ) => Effect.Effect<void, SettingsError>;
  toast: (
    options: typeof ToastSchema.Type
  ) => Effect.Effect<void, SettingsError>;
  /** A path for display, such as with the home directory abbreviated. */
  path: (path: string) => string;
}

/**
 * The settings RPC, bound to the location being configured. The walk's writes always say what the file held when it was
 * read, so a file changed since is not overwritten.
 */
export const backend = (
  settings: Effect.Effect<SettingsView, SettingsError>,
  write: (
    input: Required<WriteInput>
  ) => Effect.Effect<WriteResult, SettingsError>
) => ({ settings, write });

export type Backend = ReturnType<typeof backend>;

/** The settings menu's items, in menu order. */
const MenuItemSchema = Schema.Literals([
  "review-scope",
  "mode",
  "panel",
  "seats",
  "budgets",
  "lenses",
  "clear",
  "save",
]);

type MenuItem = typeof MenuItemSchema.Type;

const isSave = Schema.is(MenuItemSchema.pick(["save"]));

/** Each scope's name in the menu's title. */
const SCOPE_TITLES = Schema.Record(SettingsScopeSchema, Schema.String).make({
  global: "Global Charter",
  project: "Local Jurisdiction",
});

/** What can be done to one seat. */
const SeatActionSchema = Schema.Literals(["variant", "up", "remove"]);

type SeatAction = typeof SeatActionSchema.Type;

/** The seats menu's commands besides picking a seat. */
const SeatsCommandSchema = Schema.Literals(["add", "clear"]);

type SeatsCommand = typeof SeatsCommandSchema.Type;

const isAddSeat = Schema.is(SeatsCommandSchema.pick(["add"]));

const isClearSeats = Schema.is(SeatsCommandSchema.pick(["clear"]));

/** The lenses menu's choice to drop this file's lenses and use the global setting. */
const isInherit = Schema.is(Schema.Literal("inherit"));

/** The Unset choice each key's menu offers: the key is dropped and falls back to the base. */
const isUnsetChoice = Schema.is(Schema.Literal("unset"));

/** The panel's choices. */
const PanelChoiceSchema = Schema.Literals(["on", "off", "unset"]);

type PanelChoice = typeof PanelChoiceSchema.Type;

const isPanelOn = Schema.is(PanelChoiceSchema.pick(["on"]));

/** A chat model a Directorate Seat can use, as the settings RPC lists it. */
type Choice = SettingsView["models"][number];

const MODE_HINT = Schema.Record(ModeSchema, Schema.String).make({
  "code-quality": "adds maintainability and design",
  default: "functionality and test coverage",
  full: "every applicable lens",
});

const SCOPE_HINT = Schema.Record(ReviewScopeSchema, Schema.String).make({
  branch: "branch commits beyond the default branch plus uncommitted changes",
  local: "uncommitted changes only",
  repository: "whole repository, including unchanged files",
});

/** A dialog or the settings RPC failed; the walk shows its message in an alert. */
export class SettingsError extends Schema.TaggedError<
  SettingsError,
  { readonly brand: unique symbol }
>()("DirectorateSettingsError", { message: Schema.String }) {}

const unset = (fallback: string) => `unset: ${fallback}`;

const budgetOf = (s: Settings, m: Mode) => s.budget_minutes?.[m];

const budgetFallback = (base: Settings, m: Mode) =>
  budgetOf(base, m) ??
  `${DEFAULT_BUDGET[m]}, ×${PANEL_BUDGET_FACTOR} for panels`;

const seatsFallback = (base: Settings) =>
  (base.panel?.models ?? []).map(seatRef).join(", ") ||
  DEFAULT_PANEL.join(", ");

const lensesOff = (base: Settings, s: Settings) =>
  s.lenses?.disabled ?? base.lenses?.disabled ?? [];

const panelState = (enabled: boolean | undefined): PanelChoice => {
  if (enabled === undefined) {
    return "unset";
  }

  return enabled ? "on" : "off";
};

const panelDescription = (base: Settings, draft: Settings): string => {
  if (draft.panel?.enabled === undefined) {
    return unset(base.panel?.enabled ? "on" : "off");
  }

  return draft.panel.enabled ? "on" : "off";
};

/**
 * The walk's context: the dialogs, the settings RPC, both files as read, the scope being edited, and what its unset keys
 * fall back to: the global file under a project's, then Directorate defaults.
 */
const flowContext = (
  dialog: Dialogs,
  directorate: Backend,
  now: SettingsView,
  scope: SettingsScope
) => ({
  base: isProjectScope(scope) ? now.global : {},
  dialog,
  directorate,
  now,
  scope,
});

type FlowContext = ReturnType<typeof flowContext>;

const choose = <V>(
  dialog: Dialogs,
  title: string,
  current: V,
  options: readonly DialogChoice<V>[]
) => dialog.select<V>({ current, options, title });

const selectScope = (dialog: Dialogs, now: SettingsView) =>
  dialog.select<SettingsScope>({
    options: [
      {
        description: `${dialog.path(now.files.global)}: every repository`,
        title: "Global Charter",
        value: "global",
      },
      now.files.project
        ? {
            description: `${dialog.path(now.files.project)}: overrides global key by key`,
            title: "Local Jurisdiction (This project)",
            value: "project",
          }
        : {
            description:
              "none here: this project's .opencode/directorate.json is the global file",
            disabled: true,
            title: "Local Jurisdiction (This project)",
            value: "project",
          },
    ],
    title: "The Directorate // Settings",
  });

const pickVariant = Effect.fnUntraced(function* pickVariant(
  dialog: Dialogs,
  choice: Choice,
  current?: string
) {
  if (!choice.variants.length) {
    return { model: choice.ref };
  }

  const variant = yield* dialog.select<string | null>({
    current: current ?? null,
    options: [
      ...choice.variants.map((v) => ({ title: v, value: v })),
      { title: "Model default", value: null },
    ],
    title: `Thinking level · ${choice.ref}`,
  });

  if (variant === undefined) {
    return;
  }

  return variant === null
    ? { model: choice.ref }
    : { model: choice.ref, variant };
});

const addSeat = Effect.fnUntraced(function* addSeat(ctx: FlowContext) {
  const choice = yield* ctx.dialog.select<Choice>({
    options: ctx.now.models.map((m) => ({
      description: m.name,
      group: m.ref.split("/")[0] ?? m.ref,
      title: m.ref,
      value: m,
    })),
    placeholder: "Search models",
    title: "Seat a model on The Directorate",
  });

  return choice ? yield* pickVariant(ctx.dialog, choice) : undefined;
});

const editSeatAt = Effect.fnUntraced(function* editSeatAt(
  ctx: FlowContext,
  seats: readonly SeatSpec[],
  index: number
) {
  const seat = seats[index];

  if (!seat) {
    return seats;
  }

  const action = yield* ctx.dialog.select<SeatAction>({
    options: [
      { title: "Thinking level…", value: "variant" },
      { disabled: index === 0, title: "Move up", value: "up" },
      { title: "Remove", value: "remove" },
    ],
    title: seatRef(seat),
  });

  if (!action) {
    return seats;
  }

  return yield* Match.value(action).pipe(
    Match.when("remove", () =>
      Effect.succeed(seats.filter((_, i) => i !== index))
    ),
    Match.when("up", () => {
      if (index === 0) {
        return Effect.succeed(seats);
      }

      const next = [...seats];
      next.splice(index - 1, 0, ...next.splice(index, 1));

      return Effect.succeed(next);
    }),
    Match.when("variant", () =>
      Effect.gen(function* editVariant() {
        const choice = ctx.now.models.find((m) => m.ref === seat.model);

        if (!choice) {
          yield* ctx.dialog.toast({
            description: `${seat.model} is not an available chat model on this plane; remove it or pick another.`,
            variant: "warning",
          });

          return seats;
        }

        const next = yield* pickVariant(ctx.dialog, choice, seat.variant);

        return next ? seats.map((s, i) => (i === index ? next : s)) : seats;
      })
    ),
    Match.exhaustive
  );
});

const editSeats = Effect.fnUntraced(function* editSeats(
  ctx: FlowContext,
  draft: Settings
) {
  let seats = draft.panel?.models ?? [];
  let at: number | SeatsCommand | undefined;

  while (true) {
    const pick = yield* ctx.dialog.select<number | SeatsCommand>({
      current: at,
      options: [
        ...seats.map((s, i) => ({
          description: s.variant
            ? `thinking ${s.variant}`
            : "model's default thinking",
          group: "Seats",
          title: s.model,
          value: i,
        })),
        { group: "Change", title: "Add a Seat…", value: "add" as const },
        {
          description: unset(seatsFallback(ctx.base)),
          disabled: !seats.length,
          group: "Change",
          title: "Remove all",
          value: "clear" as const,
        },
      ],
      title: "Directorate Seats (panel models)",
    });

    if (pick === undefined) {
      return { ...draft, panel: { ...draft.panel, models: seats } };
    }

    at = pick;

    if (isClearSeats(pick)) {
      seats = [];
      continue;
    }

    if (isAddSeat(pick)) {
      const seat = yield* addSeat(ctx);

      seats = seat ? [...seats, seat] : seats;
      continue;
    }

    seats = yield* editSeatAt(ctx, seats, pick);
  }
});

const editBudgets = Effect.fnUntraced(function* editBudgets(
  ctx: FlowContext,
  draft: Settings
) {
  const budgets = new Map(
    ModeSchema.literals.map((mode) => [mode, budgetOf(draft, mode)] as const)
  );

  let at: Mode | undefined;

  while (true) {
    const mode = yield* ctx.dialog.select<Mode>({
      current: at,
      options: ModeSchema.literals.map((m) => {
        const currentMinutes = budgets.get(m);

        return {
          description:
            currentMinutes === undefined
              ? unset(`${budgetFallback(ctx.base, m)} min`)
              : `${currentMinutes} min`,
          title: m,
          value: m,
        };
      }),
      title: "Time budgets (minutes)",
    });

    if (!mode) {
      return { ...draft, budget_minutes: Object.fromEntries(budgets) };
    }

    const text = yield* ctx.dialog.prompt({
      description: `Minutes, 2–240; used as-is for panels too. Type "unset" to fall back to ${budgetFallback(ctx.base, mode)} min.`,
      title: `${mode} budget`,
      value: String(budgets.get(mode) ?? ""),
    });

    at = mode;

    if (text === undefined) {
      continue;
    }

    const minutes = ["", "unset"].includes(text.trim().toLowerCase())
      ? undefined
      : Number(text);

    if (minutes !== undefined && !(minutes >= 2 && minutes <= 240)) {
      yield* ctx.dialog.toast({
        description: `"${text}" is not 2–240 minutes.`,
        variant: "error",
      });

      continue;
    }

    budgets.set(mode, minutes);
  }
});

const editLenses = Effect.fnUntraced(function* editLenses(
  ctx: FlowContext,
  draft: Settings
) {
  let current = draft;
  let at: Lens | "inherit" | undefined;

  while (true) {
    const off = new Set(lensesOff(ctx.base, current));

    const pick = yield* ctx.dialog.select<Lens | "inherit">({
      current: at,
      options: [
        ...LensSchema.literals.map((l) => ({
          description: off.has(l) ? "off" : "on",
          title: l,
          value: l,
        })),
        ...(isProjectScope(ctx.scope)
          ? [
              {
                disabled: !current.lenses?.disabled,
                title: "Use the global setting",
                value: "inherit" as const,
              },
            ]
          : []),
      ],
      title: "Lenses: Enter turns one on or off; Escape when done",
    });

    if (!pick) {
      return current;
    }

    at = pick;

    if (isInherit(pick)) {
      const { lenses: _, ...rest } = current;

      current = rest;
      continue;
    }

    if (!off.delete(pick)) {
      off.add(pick);
    }

    current = {
      ...current,
      lenses: { disabled: LensSchema.literals.filter((l) => off.has(l)) },
    };
  }
});

const editReviewScope = Effect.fnUntraced(function* editReviewScope(
  ctx: FlowContext,
  draft: Settings
) {
  const reviewScope = yield* choose<ReviewScope | "unset">(
    ctx.dialog,
    "Default review scope",
    draft.default_scope ?? "unset",
    [
      ...ReviewScopeSchema.literals.map((value) => ({
        description: SCOPE_HINT[value],
        title: value,
        value,
      })),
      {
        description: unset(ctx.base.default_scope ?? DEFAULT_REVIEW_SCOPE),
        title: "Unset",
        value: "unset",
      },
    ]
  );

  if (isUnsetChoice(reviewScope)) {
    const { default_scope: _, ...rest } = draft;

    return rest;
  }

  return reviewScope ? { ...draft, default_scope: reviewScope } : draft;
});

const editMode = Effect.fnUntraced(function* editMode(
  ctx: FlowContext,
  draft: Settings
) {
  const mode = yield* choose<Mode | "unset">(
    ctx.dialog,
    "Default mode",
    draft.mode ?? "unset",
    [
      ...ModeSchema.literals.map((m) => ({
        description: MODE_HINT[m],
        title: m,
        value: m,
      })),
      {
        description: unset(ctx.base.mode ?? DEFAULT_MODE),
        title: "Unset",
        value: "unset",
      },
    ]
  );

  if (!mode) {
    return draft;
  }

  const { mode: _, ...rest } = draft;

  return isUnsetChoice(mode) ? rest : { ...rest, mode };
});

const editPanel = Effect.fnUntraced(function* editPanel(
  ctx: FlowContext,
  draft: Settings
) {
  const on = yield* choose<PanelChoice>(
    ctx.dialog,
    "Panel by default",
    panelState(draft.panel?.enabled),
    [
      {
        description:
          "every review convenes Directorate Seats unless the request asks for one model",
        title: "On",
        value: "on",
      },
      {
        description:
          "Directorate Seats convene only when the request asks for a panel",
        title: "Off",
        value: "off",
      },
      {
        description: unset(ctx.base.panel?.enabled ? "on" : "off"),
        title: "Unset",
        value: "unset",
      },
    ]
  );

  if (!on) {
    return draft;
  }

  const { enabled: _, ...panel } = draft.panel ?? {};

  return {
    ...draft,
    panel: isUnsetChoice(on) ? panel : { ...panel, enabled: isPanelOn(on) },
  };
});

const menuOptions = (ctx: FlowContext, draft: Settings, changed: boolean) =>
  [
    {
      description:
        draft.default_scope ??
        unset(ctx.base.default_scope ?? DEFAULT_REVIEW_SCOPE),
      title: "Default review scope",
      value: "review-scope",
    },
    {
      description: draft.mode ?? unset(ctx.base.mode ?? DEFAULT_MODE),
      title: "Default mode",
      value: "mode",
    },
    {
      description: panelDescription(ctx.base, draft),
      title: "Panel by default",
      value: "panel",
    },
    {
      description:
        draft.panel?.models?.map(seatRef).join(", ") ??
        unset(seatsFallback(ctx.base)),
      title: "Directorate Seats (panel models)",
      value: "seats",
    },
    {
      description: `${ModeSchema.literals
        .map(
          (m) =>
            `${m} ${budgetOf(draft, m) ?? budgetOf(ctx.base, m) ?? DEFAULT_BUDGET[m]}`
        )
        .join(" · ")} min`,
      title: "Time budgets",
      value: "budgets",
    },
    {
      description: lensesOff(ctx.base, draft).join(", ") || "none",
      title: "Disabled lenses",
      value: "lenses",
    },
    {
      description: "unset every key; saving removes the file",
      group: "File",
      title: "Clear this file",
      value: "clear",
    },
    {
      description: ctx.dialog.path(ctx.now.files[ctx.scope] ?? ""),
      group: "File",
      title: changed ? "Save" : "Save (no changes)",
      value: "save",
    },
  ] satisfies readonly DialogChoice<MenuItem>[];

/** The editor behind a menu item other than Save. */
const menuAction = (item: Exclude<MenuItem, "save">) =>
  Match.value(item).pipe(
    Match.when("review-scope", () => editReviewScope),
    Match.when("mode", () => editMode),
    Match.when("panel", () => editPanel),
    Match.when("seats", () => editSeats),
    Match.when("budgets", () => editBudgets),
    Match.when("lenses", () => editLenses),
    Match.when(
      "clear",
      () => (_ctx: FlowContext, _draft: Settings) =>
        Effect.succeed<Settings>({})
    ),
    Match.exhaustive
  );

const saveSettings = Effect.fn("Directorate.saveSettings")(
  function* saveSettings(ctx: FlowContext, draft: Settings) {
    const saved = yield* ctx.directorate
      .write({
        previous: ctx.now[ctx.scope],
        scope: ctx.scope,
        settings: draft,
      })
      .pipe(Effect.result);

    if (Result.isFailure(saved)) {
      yield* ctx.dialog.alert({
        description: saved.failure.message,
        title: "Directorate settings <rejected/not saved>",
      });

      return false;
    }

    const out = saved.success;
    yield* ctx.dialog.toast({
      description: `${out.removed ? "Revoked" : "<Filed/Saved>"} ${ctx.dialog.path(out.path)}. Effective: ${out.effective}.`,
      title: "The Directorate",
      variant: "success",
    });

    return true;
  }
);

const confirmDiscard = Effect.fnUntraced(function* confirmDiscard(
  dialog: Dialogs,
  changed: boolean
) {
  if (!changed) {
    return true;
  }

  const discard = yield* dialog.confirm({
    cancel: "Keep editing",
    confirm: "Discard",
    description: "Your Directorate settings changes have not been filed.",
    title: "Discard <unsaved/unfiled> changes?",
  });

  return Boolean(discard);
});

const runMenu = Effect.fnUntraced(function* runMenu(
  ctx: FlowContext,
  saved: Settings
) {
  let draft = saved;
  let at: MenuItem | undefined;

  while (true) {
    const changed = !sameSettings(draft, saved);

    const item = yield* ctx.dialog.select<MenuItem>({
      current: at,
      options: menuOptions(ctx, draft, changed),
      title: `The Directorate // ${SCOPE_TITLES[ctx.scope]}${changed ? " (unsaved)" : ""}`,
    });

    if (item === undefined) {
      if (yield* confirmDiscard(ctx.dialog, changed)) {
        return;
      }

      continue;
    }

    at = item;

    if (isSave(item)) {
      if (!changed || (yield* saveSettings(ctx, draft))) {
        return;
      }

      continue;
    }

    draft = normalizeSettings(yield* menuAction(item)(ctx, draft));
  }
});

/** /directorate-configure: pick a scope, change its settings, save. Escape goes back a step; nothing is written until Save. */
export const configure = Effect.fn("Directorate.configure")(function* configure(
  dialog: Dialogs,
  directorate: Backend
) {
  const now = yield* directorate.settings;
  const scope = yield* selectScope(dialog, now);

  if (!scope) {
    return;
  }

  yield* runMenu(flowContext(dialog, directorate, now, scope), now[scope]);
});
