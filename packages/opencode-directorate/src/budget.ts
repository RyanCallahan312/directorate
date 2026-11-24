// Directorate time budget: normal until the last 20% (at least 6 minutes when the budget allows), then drain, then locked.
import { DateTime } from "effect";

import { PANELIST, REFUTER, REVIEWER, SCOUT } from "./model.ts";
import type { Seal } from "./model.ts";

export type Phase = "normal" | "drain" | "locked";

export const budget = (
  seal: Pick<Seal, "createdAt" | "deadline">,
  now: number
) => {
  const start = DateTime.toEpochMillis(seal.createdAt);
  const end = DateTime.toEpochMillis(seal.deadline);
  const total = Math.max(1, end - start);
  const drainMs = Math.max(0.2 * total, Math.min(6 * 60_000, 0.5 * total));

  const openPhase: Phase = now >= end - drainMs ? "drain" : "normal";
  const phase: Phase = now >= end ? "locked" : openPhase;

  return {
    minutesLeft: Math.max(0, Math.round((end - now) / 6000) / 10),
    phase,
  };
};

const PHASE_HEADER: Record<Phase, string> = {
  drain: "DIRECTORATE // EVACUATION",
  locked: "DIRECTORATE // LOCKDOWN",
  normal: "DIRECTORATE // WINDOW",
};

const REVIEWER_TEXT: Record<Phase, string> = {
  drain:
    "DRAIN: dispatch no new Auditors or Seats; route open entries to Compliance, then call directorate_report",
  locked: "LOCKED: <Containment/Window> expired — call directorate_report now",
  normal: "observe and investigate",
};

const PHASE_TEXT = new Map<string, Record<Phase, string>>(
  Object.entries({
    [REVIEWER]: REVIEWER_TEXT,
    [SCOUT]: {
      drain: "DRAIN: file surviving candidates now and hand off",
      locked: "LOCKED: file final candidates or notes and stop",
      normal: "investigate",
    },
    [PANELIST]: {
      drain:
        "DRAIN: file surviving candidates now, note what you did not reach, and hand off",
      locked: "LOCKED: file final candidates or notes and stop",
      normal: "review in isolation",
    },
    [REFUTER]: {
      drain:
        "DRAIN: finish the entry in hand; decide the rest only where evidence is clear, then hand off",
      locked: "LOCKED: record proved verdicts and stop",
      normal: "verify",
    },
  })
);

const phaseText = (agent: string, phase: Phase) =>
  (PHASE_TEXT.get(agent) ?? REVIEWER_TEXT)[phase];

export const budgetLine = (
  seal: Pick<Seal, "createdAt" | "deadline" | "budgetMinutes">,
  now: number,
  agent: string = REVIEWER
) => {
  const b = budget(seal, now);

  return `[${PHASE_HEADER[b.phase]}] ${b.minutesLeft} min left of ${seal.budgetMinutes} · phase ${b.phase} · ${phaseText(agent, b.phase)}`;
};

/** Static phase notice for system prompts (no ticking minutesLeft, so KV-cache prefixes stay stable). */
export const budgetNotice = (phase: Phase, agent: string = REVIEWER) =>
  `[${PHASE_HEADER[phase]}] phase ${phase} · ${phaseText(agent, phase)}`;
