// Directorate time budget: normal until the last 20% (at least 6 minutes when the budget allows), then drain, then locked.
import { Clock, DateTime, Effect, Schema } from "effect";

import { Time } from "../../platform/stored.ts";
import type { Mode } from "./request.ts";

export const PhaseSchema = Schema.Literals(["normal", "drain", "locked"]);

export type Phase = typeof PhaseSchema.Type;

/**
 * Minutes a review gets when neither the request nor directorate.json sets them. A panel's verification load grows with its
 * seats, so its default is PANEL_BUDGET_FACTOR times longer.
 */
export const DEFAULT_BUDGET: Record<Mode, number> = {
  "code-quality": 30,
  default: 20,
  full: 60,
};

export const PANEL_BUDGET_FACTOR = 1.5;

/** The Window field group of seal.json. */
export const StoredWindow = Schema.Struct({
  budgetMinutes: Schema.Finite,
  createdAt: Time,
  deadline: Time,
});

const BudgetSchema = Schema.Struct({
  minutesLeft: Schema.Number,
  phase: PhaseSchema,
});

/** Each phase's header; the instruction every role reads in it is the role's own. */
export const PHASE_HEADERS = Schema.Record(PhaseSchema, Schema.String).make({
  drain: "DIRECTORATE // EVACUATION",
  locked: "DIRECTORATE // LOCKDOWN",
  normal: "DIRECTORATE // WINDOW",
});

export const budget = Effect.fnUntraced(function* budget(
  seal: Pick<typeof StoredWindow.Type, "createdAt" | "deadline">
) {
  const now = yield* Clock.currentTimeMillis;
  const start = DateTime.toEpochMillis(seal.createdAt);
  const end = DateTime.toEpochMillis(seal.deadline);
  const total = Math.max(1, end - start);
  const drainMs = Math.max(0.2 * total, Math.min(6 * 60_000, 0.5 * total));

  const openPhase = now >= end - drainMs ? "drain" : "normal";
  const phase = now >= end ? "locked" : openPhase;

  return BudgetSchema.make({
    minutesLeft: Math.max(0, Math.round((end - now) / 6000) / 10),
    phase,
  });
});
