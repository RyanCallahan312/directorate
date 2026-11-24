// Directorate time budget: normal until the last 20% (at least 6 minutes when the budget allows), then drain, then locked.
import { DateTime } from "effect";

import { PANELIST, REFUTER, REVIEWER, SCOUT, type Seal } from "./model.ts";

export type Phase = "normal" | "drain" | "locked";
export function budget(
  seal: Pick<Seal, "createdAt" | "deadline">,
  now: number
) {
  const start = DateTime.toEpochMillis(seal.createdAt);
  const end = DateTime.toEpochMillis(seal.deadline);
  const total = Math.max(1, end - start);
  const drainMs = Math.max(0.2 * total, Math.min(6 * 60_000, 0.5 * total));
  const phase: Phase =
    now >= end ? "locked" : now >= end - drainMs ? "drain" : "normal";
  return {
    phase,
    minutesLeft: Math.max(0, Math.round((end - now) / 6000) / 10),
  };
}
const PHASE_HEADER: Record<Phase, string> = {
  normal: "DIRECTORATE // WINDOW",
  drain: "DIRECTORATE // EVACUATION",
  locked: "DIRECTORATE // LOCKDOWN",
};
const PHASE_TEXT: Record<string, Record<Phase, string>> = {
  [REVIEWER]: {
    normal: "observe and investigate",
    drain:
      "DRAIN: dispatch no new Auditors or Seats; route open entries to Compliance, then call directorate_report",
    locked:
      "LOCKED: <Containment/Window> expired — call directorate_report now",
  },
  [SCOUT]: {
    normal: "investigate",
    drain: "DRAIN: file surviving candidates now and hand off",
    locked: "LOCKED: file final candidates or notes and stop",
  },
  [PANELIST]: {
    normal: "review in isolation",
    drain:
      "DRAIN: file surviving candidates now, note what you did not reach, and hand off",
    locked: "LOCKED: file final candidates or notes and stop",
  },
  [REFUTER]: {
    normal: "verify",
    drain:
      "DRAIN: finish the entry in hand; decide the rest only where evidence is clear, then hand off",
    locked: "LOCKED: record proved verdicts and stop",
  },
};
export function budgetLine(
  seal: Pick<Seal, "createdAt" | "deadline" | "budgetMinutes">,
  now: number,
  agent: string = REVIEWER
) {
  const b = budget(seal, now);
  return `[${PHASE_HEADER[b.phase]}] ${b.minutesLeft} min left of ${seal.budgetMinutes} · phase ${b.phase} · ${(PHASE_TEXT[agent] ?? PHASE_TEXT[REVIEWER])[b.phase]}`;
}
