// /directorate-configure's dialog walk over one directorate.json, shared by the TUI part (tui.ts) and the GUI part (gui.ts): each
// adapts its host's dialogs to Dialogs and binds the settings RPC (rpc.ts) to a location as Backend. The server checks
// models and thinking levels and writes the file; this only asks. The TUI and GUI plugin APIs are promise-based, so
// this is plain async code.
import {
  DEFAULT_BUDGET,
  DEFAULT_PANEL,
  LENSES,
  Mode,
  PANEL_BUDGET_FACTOR,
  type Seat,
  seatRef,
  type Settings,
  type SettingsScope,
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
  select<V>(options: {
    readonly title: string;
    readonly placeholder?: string;
    readonly current?: V;
    readonly options: readonly Option<V>[];
  }): Promise<V | undefined>;
  prompt(options: {
    readonly title: string;
    readonly description?: string;
    readonly value?: string;
  }): Promise<string | undefined>;
  confirm(options: {
    readonly title: string;
    readonly description: string;
    readonly confirm: string;
    readonly cancel: string;
  }): Promise<boolean | undefined>;
  alert(options: {
    readonly title: string;
    readonly description: string;
  }): Promise<void>;
  toast(options: {
    readonly title?: string;
    readonly description: string;
    readonly variant: "success" | "warning" | "error";
  }): void;
  /** A path for display, such as with the home directory abbreviated. */
  path(path: string): string;
}
/** The settings RPC, bound to the location being configured. */
export interface Backend {
  settings(): Promise<SettingsView>;
  write(input: {
    readonly scope: SettingsScope;
    readonly settings: Settings;
  }): Promise<WriteResult>;
}

type Lens = (typeof LENSES)[number];
type Item =
  | "mode"
  | "panel"
  | "seats"
  | "budgets"
  | "lenses"
  | "clear"
  | "save";
type Choice = {
  readonly ref: string;
  readonly name: string;
  readonly variants: readonly string[];
};

const MODE_HINT: Record<Mode, string> = {
  default: "functionality and test coverage",
  "code-quality": "adds maintainability and design",
  full: "every applicable lens",
};

export const messageOf = (e: unknown) =>
  typeof e === "object" && e !== null && "message" in e
    ? String(e.message)
    : String(e);
/** Drops keys left unset and sections left empty, so they fall through again; a panel needs at least one seat. */
function tidy(s: Settings): Settings {
  const keep = <T extends object>(o: T): T | undefined => {
    const set = Object.entries(o).filter(
      ([k, v]) =>
        v !== undefined && !(k === "models" && Array.isArray(v) && !v.length)
    );
    return set.length ? (Object.fromEntries(set) as T) : undefined;
  };
  return (
    keep({
      mode: s.mode,
      budget_minutes: s.budget_minutes && keep(s.budget_minutes),
      panel: s.panel && keep(s.panel),
      lenses: s.lenses && keep(s.lenses),
    }) ?? {}
  );
}
const same = (a: Settings, b: Settings) =>
  JSON.stringify(tidy(a)) === JSON.stringify(tidy(b));

/** /directorate-configure: pick a scope, change its settings, save. Escape goes back a step; nothing is written until Save. */
export async function configure(dialog: Dialogs, directorate: Backend) {
  const now = await directorate.settings();
  const scope = await dialog.select<SettingsScope>({
    title: "The Directorate // Settings",
    options: [
      {
        title: "Global Charter",
        value: "global",
        description: `${dialog.path(now.files.global)}: every repository`,
      },
      now.files.project
        ? {
            title: "Local Jurisdiction (This project)",
            value: "project",
            description: `${dialog.path(now.files.project)}: overrides global key by key`,
          }
        : {
            title: "Local Jurisdiction (This project)",
            value: "project",
            description:
              "none here: this project's .opencode/directorate.json is the global file",
            disabled: true,
          },
    ],
  });
  if (!scope) return;
  // What an unset key falls back to: the global file under a project's, then Directorate defaults.
  const base: Settings = scope === "project" ? now.global : {};
  const unset = (fallback: string) => `unset: ${fallback}`;
  const budgetOf = (s: Settings, m: Mode) => s.budget_minutes?.[m];
  const budgetFallback = (m: Mode) =>
    budgetOf(base, m) ??
    `${DEFAULT_BUDGET[m]}, ×${PANEL_BUDGET_FACTOR} for panels`;
  const seatsFallback = () =>
    (base.panel?.models ?? []).map(seatRef).join(", ") ||
    DEFAULT_PANEL.join(", ");
  const lensesOff = (s: Settings) =>
    s.lenses?.disabled ?? base.lenses?.disabled ?? [];

  const pickVariant = async (choice: Choice, current?: string) => {
    if (!choice.variants.length) return { model: choice.ref };
    const variant = await dialog.select<string | null>({
      title: `Thinking level · ${choice.ref}`,
      current: current ?? null,
      options: [
        ...choice.variants.map((v) => ({ title: v, value: v })),
        { title: "Model default", value: null },
      ],
    });
    if (variant === undefined) return undefined;
    return variant === null
      ? { model: choice.ref }
      : { model: choice.ref, variant };
  };

  const editSeats = async (draft: Settings): Promise<Settings> => {
    const seats: Seat[] = [...(draft.panel?.models ?? [])];
    let at: number | "add" | "clear" | undefined;
    for (;;) {
      const pick = await dialog.select<number | "add" | "clear">({
        title: "Directorate Seats (panel models)",
        current: at,
        options: [
          ...seats.map((s, i) => ({
            title: s.model,
            value: i,
            description: s.variant
              ? `thinking ${s.variant}`
              : "model's default thinking",
            group: "Seats",
          })),
          { title: "Add a Seat…", value: "add" as const, group: "Change" },
          {
            title: "Remove all",
            value: "clear" as const,
            description: unset(seatsFallback()),
            group: "Change",
            disabled: !seats.length,
          },
        ],
      });
      if (pick === undefined)
        return { ...draft, panel: { ...draft.panel, models: seats } };
      at = pick;
      if (pick === "clear") seats.length = 0;
      else if (pick === "add") {
        const choice = await dialog.select<Choice>({
          title: "Seat a model on The Directorate",
          placeholder: "Search models",
          options: now.models.map((m) => ({
            title: m.ref,
            value: m,
            description: m.name,
            group: m.ref.split("/")[0],
          })),
        });
        const seat = choice && (await pickVariant(choice));
        if (seat) seats.push(seat);
      } else {
        const seat = seats[pick]!;
        const action = await dialog.select<"variant" | "up" | "remove">({
          title: seatRef(seat),
          options: [
            { title: "Thinking level…", value: "variant" },
            { title: "Move up", value: "up", disabled: pick === 0 },
            { title: "Remove", value: "remove" },
          ],
        });
        if (action === "remove") seats.splice(pick, 1);
        else if (action === "up")
          seats.splice(pick - 1, 0, ...seats.splice(pick, 1));
        else if (action === "variant") {
          const choice = now.models.find((m) => m.ref === seat.model);
          if (!choice)
            dialog.toast({
              variant: "warning",
              description: `${seat.model} is not an available chat model on this plane; remove it or pick another.`,
            });
          const next = choice && (await pickVariant(choice, seat.variant));
          if (next) seats[pick] = next;
        }
      }
    }
  };

  const editBudgets = async (draft: Settings): Promise<Settings> => {
    let at: Mode | undefined;
    for (;;) {
      const mode = await dialog.select<Mode>({
        title: "Time budgets (minutes)",
        current: at,
        options: Mode.literals.map((m) => ({
          title: m,
          value: m,
          description:
            budgetOf(draft, m) !== undefined
              ? `${budgetOf(draft, m)} min`
              : unset(`${budgetFallback(m)} min`),
        })),
      });
      if (!mode) return draft;
      at = mode;
      const text = await dialog.prompt({
        title: `${mode} budget`,
        description: `Minutes, 2–240; used as-is for panels too. Type "unset" to fall back to ${budgetFallback(mode)} min.`,
        value: String(budgetOf(draft, mode) ?? ""),
      });
      if (text === undefined) continue;
      const minutes = ["", "unset"].includes(text.trim().toLowerCase())
        ? undefined
        : Number(text);
      if (minutes !== undefined && !(minutes >= 2 && minutes <= 240)) {
        dialog.toast({
          variant: "error",
          description: `"${text}" is not 2–240 minutes.`,
        });
        continue;
      }
      draft = {
        ...draft,
        budget_minutes: { ...draft.budget_minutes, [mode]: minutes },
      };
    }
  };

  const editLenses = async (draft: Settings): Promise<Settings> => {
    let at: Lens | "inherit" | undefined;
    for (;;) {
      const off = new Set(lensesOff(draft));
      const pick = await dialog.select<Lens | "inherit">({
        title: "Lenses: Enter turns one on or off; Escape when done",
        current: at,
        options: [
          ...LENSES.map((l) => ({
            title: l,
            value: l,
            description: off.has(l) ? "off" : "on",
          })),
          ...(scope === "project"
            ? [
                {
                  title: "Use the global setting",
                  value: "inherit" as const,
                  disabled: !draft.lenses?.disabled,
                },
              ]
            : []),
        ],
      });
      if (!pick) return draft;
      at = pick;
      if (pick === "inherit") draft = { ...draft, lenses: undefined };
      else {
        if (!off.delete(pick)) off.add(pick);
        draft = {
          ...draft,
          lenses: { disabled: LENSES.filter((l) => off.has(l)) },
        };
      }
    }
  };

  const choose = async <V>(
    title: string,
    current: V,
    options: readonly { title: string; value: V; description?: string }[]
  ) => dialog.select<V>({ title, current, options });

  let draft = now[scope];
  let at: Item | undefined;
  for (;;) {
    const changed = !same(draft, now[scope]);
    const item = await dialog.select<Item>({
      title: `The Directorate // ${scope === "global" ? "Global Charter" : "Local Jurisdiction"}${changed ? " (unsaved)" : ""}`,
      current: at,
      options: [
        {
          title: "Default mode",
          value: "mode",
          description: draft.mode ?? unset(base.mode ?? "default"),
        },
        {
          title: "Panel by default",
          value: "panel",
          description:
            draft.panel?.enabled === undefined
              ? unset(base.panel?.enabled ? "on" : "off")
              : draft.panel.enabled
                ? "on"
                : "off",
        },
        {
          title: "Directorate Seats (panel models)",
          value: "seats",
          description:
            draft.panel?.models?.map(seatRef).join(", ") ??
            unset(seatsFallback()),
        },
        {
          title: "Time budgets",
          value: "budgets",
          description:
            Mode.literals
              .map(
                (m) =>
                  `${m} ${budgetOf(draft, m) ?? budgetOf(base, m) ?? DEFAULT_BUDGET[m]}`
              )
              .join(" · ") + " min",
        },
        {
          title: "Disabled lenses",
          value: "lenses",
          description: lensesOff(draft).join(", ") || "none",
        },
        {
          title: "Clear this file",
          value: "clear",
          description: "unset every key; saving removes the file",
          group: "File",
        },
        {
          title: changed ? "Save" : "Save (no changes)",
          value: "save",
          description: dialog.path(now.files[scope] ?? ""),
          group: "File",
        },
      ],
    });
    if (item === undefined) {
      if (!changed) return;
      const discard = await dialog.confirm({
        title: "Discard <unsaved/unfiled> changes?",
        description: "Your Directorate settings changes have not been filed.",
        confirm: "Discard",
        cancel: "Keep editing",
      });
      if (discard) return;
      continue;
    }
    at = item;
    if (item === "save") {
      try {
        const out = await directorate.write({ scope, settings: tidy(draft) });
        dialog.toast({
          title: "The Directorate",
          description: `${out.removed ? "Revoked" : "<Filed/Saved>"} ${dialog.path(out.path)}. Effective: ${out.effective}.`,
          variant: "success",
        });
        return;
      } catch (e) {
        await dialog.alert({
          title: "Directorate settings <rejected/not saved>",
          description: messageOf(e),
        });
        continue;
      }
    }
    if (item === "clear") draft = {};
    if (item === "mode") {
      const mode = await choose<Mode | "unset">(
        "Default mode",
        draft.mode ?? "unset",
        [
          ...Mode.literals.map((m) => ({
            title: m,
            value: m,
            description: MODE_HINT[m],
          })),
          {
            title: "Unset",
            value: "unset",
            description: unset(base.mode ?? "default"),
          },
        ]
      );
      if (mode) draft = { ...draft, mode: mode === "unset" ? undefined : mode };
    }
    if (item === "panel") {
      const on = await choose<"on" | "off" | "unset">(
        "Panel by default",
        draft.panel?.enabled === undefined
          ? "unset"
          : draft.panel.enabled
            ? "on"
            : "off",
        [
          {
            title: "On",
            value: "on",
            description:
              "every review convenes Directorate Seats unless the request asks for one model",
          },
          {
            title: "Off",
            value: "off",
            description:
              "Directorate Seats convene only when the request asks for a panel",
          },
          {
            title: "Unset",
            value: "unset",
            description: unset(base.panel?.enabled ? "on" : "off"),
          },
        ]
      );
      if (on)
        draft = {
          ...draft,
          panel: {
            ...draft.panel,
            enabled: on === "unset" ? undefined : on === "on",
          },
        };
    }
    if (item === "seats") draft = await editSeats(draft);
    if (item === "budgets") draft = await editBudgets(draft);
    if (item === "lenses") draft = await editLenses(draft);
    draft = tidy(draft);
  }
}
