// /directorate-configure's dialog walk over one directorate.json, shared by the TUI part (tui.ts) and the GUI part (gui.ts): each
// adapts its host's dialogs to Dialogs and binds the settings RPC (rpc.ts) to a location as Backend. The server checks
// models and thinking levels and writes the file; this only asks. The TUI and GUI plugin APIs are promise-based, so
// this is plain async code.
import { Predicate } from "effect";

import {
  DEFAULT_BUDGET,
  DEFAULT_PANEL,
  DEFAULT_REVIEW_SCOPE,
  LENSES,
  ModeSchema,
  PANEL_BUDGET_FACTOR,
  ReviewScopeSchema,
  seatRef,
} from "./model.ts";
import type {
  Mode,
  ReviewScope,
  Seat,
  Settings,
  SettingsScope,
} from "./model.ts";
import type { SettingsView, WriteResult } from "./rpc.ts";

/** One choice in a select. A host without disabled options leaves disabled ones out. */
export interface Option<V> {
  readonly title: string;
  readonly value: V;
  readonly description?: string;
  readonly group?: string;
  readonly disabled?: boolean;
}

/** The dialogs the walk needs; each resolves undefined (false for confirm) when the user backs out. */
export interface Dialogs {
  select: <V>(options: {
    readonly title: string;
    readonly placeholder?: string;
    readonly current?: V | undefined;
    readonly options: readonly Option<V>[];
  }) => Promise<V | undefined>;
  prompt: (options: {
    readonly title: string;
    readonly description?: string;
    readonly value?: string;
  }) => Promise<string | undefined>;
  confirm: (options: {
    readonly title: string;
    readonly description: string;
    readonly confirm: string;
    readonly cancel: string;
  }) => Promise<boolean | undefined>;
  alert: (options: {
    readonly title: string;
    readonly description: string;
  }) => Promise<void>;
  toast: (options: {
    readonly title?: string;
    readonly description: string;
    readonly variant: "success" | "warning" | "error";
  }) => void;
  /** A path for display, such as with the home directory abbreviated. */
  path: (path: string) => string;
}

/** The settings RPC, bound to the location being configured. */
export interface Backend {
  settings: () => Promise<SettingsView>;
  write: (input: {
    readonly scope: SettingsScope;
    readonly settings: Settings;
  }) => Promise<WriteResult>;
}

type Lens = (typeof LENSES)[number];

type Item =
  | "mode"
  | "review-scope"
  | "panel"
  | "seats"
  | "budgets"
  | "lenses"
  | "clear"
  | "save";

interface Choice {
  readonly ref: string;
  readonly name: string;
  readonly variants: readonly string[];
}

interface FlowContext {
  readonly base: Settings;
  readonly dialog: Dialogs;
  readonly directorate: Backend;
  readonly now: SettingsView;
  readonly scope: SettingsScope;
}

const MODE_HINT: Record<Mode, string> = {
  "code-quality": "adds maintainability and design",
  default: "functionality and test coverage",
  full: "every applicable lens",
};

const SCOPE_HINT: Record<ReviewScope, string> = {
  branch: "branch commits beyond the default branch plus uncommitted changes",
  local: "uncommitted changes only",
  repository: "whole repository, including unchanged files",
};

export const messageOf = (cause: unknown) =>
  Predicate.hasProperty(cause, "message")
    ? String(cause.message)
    : String(cause);

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

const panelState = (enabled: boolean | undefined): "on" | "off" | "unset" => {
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

const tidyBudgets = (
  budgets: Settings["budget_minutes"]
): Settings["budget_minutes"] => {
  if (!budgets) {
    return undefined;
  }

  const next: NonNullable<Settings["budget_minutes"]> = {
    ...(budgets["code-quality"] !== undefined && {
      "code-quality": budgets["code-quality"],
    }),
    ...(budgets.default !== undefined && { default: budgets.default }),
    ...(budgets.full !== undefined && { full: budgets.full }),
  };

  return Object.keys(next).length ? next : undefined;
};

const tidyPanel = (panel: Settings["panel"]): Settings["panel"] => {
  if (!panel) {
    return undefined;
  }

  const next: NonNullable<Settings["panel"]> = {
    ...(panel.enabled !== undefined && { enabled: panel.enabled }),
    ...(panel.models && panel.models.length > 0 && { models: panel.models }),
  };

  return Object.keys(next).length ? next : undefined;
};

const tidyLenses = (lenses: Settings["lenses"]): Settings["lenses"] =>
  lenses?.disabled === undefined ? undefined : { disabled: lenses.disabled };

/** Drops keys left unset and sections left empty, so they fall through again; a panel needs at least one seat. */
const tidy = (s: Settings): Settings => {
  const budgets = tidyBudgets(s.budget_minutes);
  const panel = tidyPanel(s.panel);
  const lenses = tidyLenses(s.lenses);

  return {
    ...(budgets && { budget_minutes: budgets }),
    ...(s.default_scope && { default_scope: s.default_scope }),
    ...(lenses && { lenses }),
    ...(s.mode && { mode: s.mode }),
    ...(panel && { panel }),
  };
};

const same = (a: Settings, b: Settings) =>
  JSON.stringify(tidy(a)) === JSON.stringify(tidy(b));

const choose = <V>(
  dialog: Dialogs,
  title: string,
  current: V,
  options: readonly Option<V>[]
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

const pickVariant = async (
  dialog: Dialogs,
  choice: Choice,
  current?: string
): Promise<Seat | undefined> => {
  if (!choice.variants.length) {
    return { model: choice.ref };
  }

  const variant = await dialog.select<string | null>({
    current: current ?? null,
    options: [
      ...choice.variants.map((v) => ({ title: v, value: v })),
      { title: "Model default", value: null },
    ],
    title: `Thinking level · ${choice.ref}`,
  });

  if (variant === undefined) {
    return undefined;
  }

  return variant === null
    ? { model: choice.ref }
    : { model: choice.ref, variant };
};

const addSeat = async (ctx: FlowContext): Promise<Seat | undefined> => {
  const choice = await ctx.dialog.select<Choice>({
    options: ctx.now.models.map((m) => ({
      description: m.name,
      group: m.ref.split("/")[0] ?? m.ref,
      title: m.ref,
      value: m,
    })),
    placeholder: "Search models",
    title: "Seat a model on The Directorate",
  });

  return choice ? pickVariant(ctx.dialog, choice) : undefined;
};

const editSeatAt = async (
  ctx: FlowContext,
  seats: readonly Seat[],
  index: number
): Promise<readonly Seat[]> => {
  const seat = seats[index];

  if (!seat) {
    return seats;
  }

  const action = await ctx.dialog.select<"variant" | "up" | "remove">({
    options: [
      { title: "Thinking level…", value: "variant" },
      { disabled: index === 0, title: "Move up", value: "up" },
      { title: "Remove", value: "remove" },
    ],
    title: seatRef(seat),
  });

  if (action === "remove") {
    return seats.filter((_, i) => i !== index);
  }

  if (action === "up" && index > 0) {
    const next = [...seats];
    next.splice(index - 1, 0, ...next.splice(index, 1));

    return next;
  }

  if (action === "variant") {
    const choice = ctx.now.models.find((m) => m.ref === seat.model);

    if (!choice) {
      ctx.dialog.toast({
        description: `${seat.model} is not an available chat model on this plane; remove it or pick another.`,
        variant: "warning",
      });

      return seats;
    }

    const next = await pickVariant(ctx.dialog, choice, seat.variant);

    return next ? seats.map((s, i) => (i === index ? next : s)) : seats;
  }

  return seats;
};

const editSeats = (ctx: FlowContext, draft: Settings): Promise<Settings> => {
  const step = async (
    seats: readonly Seat[],
    at?: number | "add" | "clear"
  ): Promise<Settings> => {
    const pick = await ctx.dialog.select<number | "add" | "clear">({
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

    if (pick === "clear") {
      return step([], pick);
    }

    if (pick === "add") {
      const seat = await addSeat(ctx);

      return step(seat ? [...seats, seat] : seats, pick);
    }

    const next = await editSeatAt(ctx, seats, pick);

    return step(next, pick);
  };

  return step(draft.panel?.models ?? []);
};

const editBudgets = (ctx: FlowContext, draft: Settings): Promise<Settings> => {
  const step = async (current: Settings, at?: Mode): Promise<Settings> => {
    const mode = await ctx.dialog.select<Mode>({
      current: at,
      options: ModeSchema.literals.map((m) => {
        const currentMinutes = budgetOf(current, m);

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
      return current;
    }

    const text = await ctx.dialog.prompt({
      description: `Minutes, 2–240; used as-is for panels too. Type "unset" to fall back to ${budgetFallback(ctx.base, mode)} min.`,
      title: `${mode} budget`,
      value: String(budgetOf(current, mode) ?? ""),
    });

    if (text === undefined) {
      return step(current, mode);
    }

    const minutes = ["", "unset"].includes(text.trim().toLowerCase())
      ? undefined
      : Number(text);

    if (minutes !== undefined && !(minutes >= 2 && minutes <= 240)) {
      ctx.dialog.toast({
        description: `"${text}" is not 2–240 minutes.`,
        variant: "error",
      });

      return step(current, mode);
    }

    return step(
      {
        ...current,
        budget_minutes: { ...current.budget_minutes, [mode]: minutes },
      },
      mode
    );
  };

  return step(draft);
};

const editLenses = (ctx: FlowContext, draft: Settings): Promise<Settings> => {
  const step = async (
    current: Settings,
    at?: Lens | "inherit"
  ): Promise<Settings> => {
    const off = new Set(lensesOff(ctx.base, current));

    const pick = await ctx.dialog.select<Lens | "inherit">({
      current: at,
      options: [
        ...LENSES.map((l) => ({
          description: off.has(l) ? "off" : "on",
          title: l,
          value: l,
        })),
        ...(ctx.scope === "project"
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

    if (pick === "inherit") {
      const { lenses: _, ...rest } = current;

      return step(rest, pick);
    }

    if (!off.delete(pick)) {
      off.add(pick);
    }

    return step(
      {
        ...current,
        lenses: { disabled: LENSES.filter((l) => off.has(l)) },
      },
      pick
    );
  };

  return step(draft);
};

const editReviewScope = async (
  ctx: FlowContext,
  draft: Settings
): Promise<Settings> => {
  const reviewScope = await choose<ReviewScope | "unset">(
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

  if (reviewScope === "unset") {
    const { default_scope: _, ...rest } = draft;

    return rest;
  }

  return reviewScope ? { ...draft, default_scope: reviewScope } : draft;
};

const editMode = async (
  ctx: FlowContext,
  draft: Settings
): Promise<Settings> => {
  const mode = await choose<Mode | "unset">(
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
        description: unset(ctx.base.mode ?? "default"),
        title: "Unset",
        value: "unset",
      },
    ]
  );

  if (!mode) {
    return draft;
  }

  const { mode: _, ...rest } = draft;

  return mode === "unset" ? rest : { ...rest, mode };
};

const editPanel = async (
  ctx: FlowContext,
  draft: Settings
): Promise<Settings> => {
  const on = await choose<"on" | "off" | "unset">(
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
    panel: on === "unset" ? panel : { ...panel, enabled: on === "on" },
  };
};

const menuOptions = (
  ctx: FlowContext,
  draft: Settings,
  changed: boolean
): readonly Option<Item>[] => [
  {
    description:
      draft.default_scope ??
      unset(ctx.base.default_scope ?? DEFAULT_REVIEW_SCOPE),
    title: "Default review scope",
    value: "review-scope",
  },
  {
    description: draft.mode ?? unset(ctx.base.mode ?? "default"),
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
];

const MENU_ACTIONS: Record<
  Exclude<Item, "save">,
  (ctx: FlowContext, draft: Settings) => Promise<Settings>
> = {
  budgets: editBudgets,
  clear: () => Promise.resolve({}),
  lenses: editLenses,
  mode: editMode,
  panel: editPanel,
  "review-scope": editReviewScope,
  seats: editSeats,
};

const saveSettings = async (
  ctx: FlowContext,
  draft: Settings
): Promise<boolean> => {
  try {
    const out = await ctx.directorate.write({
      scope: ctx.scope,
      settings: tidy(draft),
    });

    ctx.dialog.toast({
      description: `${out.removed ? "Revoked" : "<Filed/Saved>"} ${ctx.dialog.path(out.path)}. Effective: ${out.effective}.`,
      title: "The Directorate",
      variant: "success",
    });

    return true;
  } catch (error) {
    await ctx.dialog.alert({
      description: messageOf(error),
      title: "Directorate settings <rejected/not saved>",
    });

    return false;
  }
};

const confirmDiscard = async (
  dialog: Dialogs,
  changed: boolean
): Promise<boolean> => {
  if (!changed) {
    return true;
  }

  const discard = await dialog.confirm({
    cancel: "Keep editing",
    confirm: "Discard",
    description: "Your Directorate settings changes have not been filed.",
    title: "Discard <unsaved/unfiled> changes?",
  });

  return Boolean(discard);
};

const runMenu = async (
  ctx: FlowContext,
  draft: Settings,
  at?: Item
): Promise<void> => {
  const changed = !same(draft, ctx.now[ctx.scope]);

  const item = await ctx.dialog.select<Item>({
    current: at,
    options: menuOptions(ctx, draft, changed),
    title: `The Directorate // ${ctx.scope === "global" ? "Global Charter" : "Local Jurisdiction"}${changed ? " (unsaved)" : ""}`,
  });

  if (item === undefined) {
    if (await confirmDiscard(ctx.dialog, changed)) {
      return;
    }

    return runMenu(ctx, draft, at);
  }

  if (item === "save") {
    if (await saveSettings(ctx, draft)) {
      return;
    }

    return runMenu(ctx, draft, item);
  }

  const next = tidy(await MENU_ACTIONS[item](ctx, draft));

  return runMenu(ctx, next, item);
};

/** /directorate-configure: pick a scope, change its settings, save. Escape goes back a step; nothing is written until Save. */
export const configure = async (dialog: Dialogs, directorate: Backend) => {
  const now = await directorate.settings();
  const scope = await selectScope(dialog, now);

  if (!scope) {
    return;
  }

  // What an unset key falls back to: the global file under a project's, then Directorate defaults.
  const base: Settings = scope === "project" ? now.global : {};
  await runMenu({ base, dialog, directorate, now, scope }, now[scope]);
};
