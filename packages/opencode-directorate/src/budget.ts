// Directorate time budget: normal until the last 20% (at least 6 minutes when the budget allows), then drain, then locked.
import { Clock, DateTime, Effect, Schema } from "effect";

import { PANELIST, REFUTER, REVIEWER, ROLES, SCOUT } from "./model.ts";
import type { Seal } from "./model.ts";

export const PhaseSchema = Schema.Literals(["normal", "drain", "locked"]);

export type Phase = typeof PhaseSchema.Type;

const RoleSchema = Schema.Literals(ROLES);

const isRole = Schema.is(RoleSchema);

const PhaseBriefSchema = Schema.Struct({
  header: Schema.String,
  text: Schema.Record(RoleSchema, Schema.String),
});

const BudgetSchema = Schema.Struct({
  minutesLeft: Schema.Number,
  phase: PhaseSchema,
});

/** Each phase's header and the instruction every role reads in it. */
const PHASES = Schema.Record(PhaseSchema, PhaseBriefSchema).make({
  drain: {
    header: "DIRECTORATE // EVACUATION",
    text: {
      [REVIEWER]:
        "DRAIN: dispatch no new Auditors or Seats; route open entries to Compliance, then call directorate_report",
      [SCOUT]: "DRAIN: file surviving candidates now and hand off",
      [PANELIST]:
        "DRAIN: file surviving candidates now, note what you did not reach, and hand off",
      [REFUTER]:
        "DRAIN: finish the entry in hand; decide the rest only where evidence is clear, then hand off",
    },
  },
  locked: {
    header: "DIRECTORATE // LOCKDOWN",
    text: {
      [REVIEWER]:
        "LOCKED: <Containment/Window> expired — call directorate_report now",
      [SCOUT]: "LOCKED: file final candidates or notes and stop",
      [PANELIST]: "LOCKED: file final candidates or notes and stop",
      [REFUTER]: "LOCKED: record proved verdicts and stop",
    },
  },
  normal: {
    header: "DIRECTORATE // WINDOW",
    text: {
      [REVIEWER]: "observe and investigate",
      [SCOUT]: "investigate",
      [PANELIST]: "review in isolation",
      [REFUTER]: "verify",
    },
  },
});

export const budget = Effect.fnUntraced(function* budget(
  seal: Pick<Seal, "createdAt" | "deadline">
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

/** "[header] <middle> · <role instruction>"; unknown agents read the Liaison's instruction. */
const phaseLine = (phase: Phase, agent: string, middle: string) => {
  const { header, text } = PHASES[phase];

  return `[${header}] ${middle} · ${text[isRole(agent) ? agent : REVIEWER]}`;
};

export const budgetLine = Effect.fnUntraced(function* budgetLine(
  seal: Pick<Seal, "createdAt" | "deadline" | "budgetMinutes">,
  agent: string = REVIEWER
) {
  const b = yield* budget(seal);

  return phaseLine(
    b.phase,
    agent,
    `${b.minutesLeft} min left of ${seal.budgetMinutes} · phase ${b.phase}`
  );
});

/** Static phase notice for system prompts (no ticking minutesLeft, so KV-cache prefixes stay stable). */
export const budgetNotice = (phase: Phase, agent: string = REVIEWER) =>
  phaseLine(phase, agent, `phase ${phase}`);
