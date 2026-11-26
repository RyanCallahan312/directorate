// Directorate time budget: normal until the last 20% (at least 6 minutes when the budget allows), then drain, then locked.
import { DateTime, Effect, Schema } from "effect";

import { Time } from "../../platform/stored.ts";
import type { Seal } from "../../seal/record.ts";
import { ModeSchema } from "./request.ts";

export const PhaseSchema = Schema.Literals(["normal", "drain", "locked"]);

export type Phase = typeof PhaseSchema.Type;

/**
 * Minutes a review gets when neither the request nor directorate.json sets them. A panel's verification load grows with its
 * seats, so its default is PANEL_BUDGET_FACTOR times longer.
 */
export const DEFAULT_BUDGET = Schema.Record(ModeSchema, Schema.Finite).make({
  "code-quality": 30,
  default: 20,
  full: 60,
});

export const PANEL_BUDGET_FACTOR = 1.5;

/** How long after the deadline the watchdog waits for the Liaison's own report. */
export const GRACE_MS = 120_000;

/** A taken-over review whose budget was spent restarts with half of it, at least this many minutes. */
const TAKEOVER_MIN_MINUTES = 5;

/** Each phase's header; the instruction every agent reads in it is the agent's own. */
export const PHASE_HEADERS = Schema.Record(PhaseSchema, Schema.String).make({
  drain: "DIRECTORATE // EVACUATION",
  locked: "DIRECTORATE // LOCKDOWN",
  normal: "DIRECTORATE // WINDOW",
});

/** A window's deadline never precedes its start. Spreading StoredWindow's fields drops it, so the seal root re-applies it. */
export const windowCheck = Schema.makeFilter(
  (w: { readonly createdAt: DateTime.Utc; readonly deadline: DateTime.Utc }) =>
    !DateTime.isLessThan(w.deadline, w.createdAt) ||
    "deadline must not precede createdAt"
);

/** The Window field group of seal.json. */
export const StoredWindow = Schema.Struct({
  budgetMinutes: Schema.Finite,
  createdAt: Time,
  deadline: Time,
}).check(windowCheck);

/** A review's clock: when it opened, when it locks, and the minutes it was given. */
export class Window extends Schema.Class<
  Window,
  { readonly brand: unique symbol }
>("directorate/Window")(
  Schema.Struct({
    budgetMinutes: Schema.Finite,
    createdAt: Schema.DateTimeUtc,
    deadline: Schema.DateTimeUtc,
  }).check(windowCheck)
) {
  /** A window of `minutes` opening at `createdAt`. */
  static open(createdAt: DateTime.Utc, minutes: number) {
    return Window.make({
      budgetMinutes: minutes,
      createdAt,
      deadline: DateTime.add(createdAt, { minutes }),
    });
  }

  /** A taken-over review's restart at `now`: half the budget, at least TAKEOVER_MIN_MINUTES. */
  takeover(now: DateTime.Utc) {
    return Window.open(
      now,
      Math.max(TAKEOVER_MIN_MINUTES, Math.round(this.budgetMinutes / 2))
    );
  }

  /** Normal, then drain for the last 20% (6 minutes if longer, but never more than half), then locked at the deadline. */
  phaseAt(now: DateTime.Utc) {
    const at = DateTime.toEpochMillis(now);
    const end = DateTime.toEpochMillis(this.deadline);
    const total = Math.max(1, end - DateTime.toEpochMillis(this.createdAt));
    const drainMs = Math.max(0.2 * total, Math.min(6 * 60_000, 0.5 * total));

    if (at >= end) {
      return "locked";
    }

    return at >= end - drainMs ? "drain" : "normal";
  }

  /** Minutes left at `now`, to a tenth, never negative. */
  minutesLeftAt(now: DateTime.Utc) {
    return Math.max(
      0,
      Math.round(
        (DateTime.toEpochMillis(this.deadline) - DateTime.toEpochMillis(now)) /
          6000
      ) / 10
    );
  }
}

/** A resumed review's new clock: a takeover's restart, or the budget its caller named. */
export const restarted = (seal: Seal, window: Window) =>
  seal.withWindow(window);

const BudgetSchema = Schema.Struct({
  minutesLeft: Schema.Finite,
  phase: PhaseSchema,
});

/** The window's phase and minutes left now. */
export const budget = Effect.fnUntraced(function* budget(window: Window) {
  const now = yield* DateTime.now;

  return BudgetSchema.make({
    minutesLeft: window.minutesLeftAt(now),
    phase: window.phaseAt(now),
  });
});
