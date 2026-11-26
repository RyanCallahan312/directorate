// Directorate agents: the roles, who acted, and what each role reads in each phase of the budget (Window × Agent).
import { Effect, Schema } from "effect";

import {
  budget,
  PHASE_HEADERS,
  PhaseSchema,
} from "../../workflow/review/window.ts";
import type { Phase, StoredWindow } from "../../workflow/review/window.ts";

/**
 * The Directorate roles: the Liaison (lead reviewer), Auditors (narrow investigators), Directorate Seats (independent
 * panel reviewers, one model each), and Compliance (the adversarial verifier).
 */
export const REVIEWER = "directorate_liaison";
export const REFUTER = "directorate_compliance";
export const SCOUT = "directorate_auditor";
export const PANELIST = "directorate_seat";

/** Every Directorate role, in registration order. */
export const ROLES = [REVIEWER, SCOUT, PANELIST, REFUTER] as const;

/** The roles the Liaison dispatches as child sessions. */
export const CHILD_ROLES = [SCOUT, PANELIST, REFUTER] as const;
export const ROLE_SET: ReadonlySet<string> = new Set(ROLES);
export const CHILD_ROLE_SET: ReadonlySet<string> = new Set(CHILD_ROLES);

/** What each role may still call once the budget is locked. */
export const LOCKED_TOOLS = new Map([
  [
    REVIEWER,
    new Set([
      "directorate_report",
      "directorate_ledger_list",
      "directorate_note",
    ]),
  ],
  [SCOUT, new Set(["directorate_ledger_add", "directorate_note"])],
  [PANELIST, new Set(["directorate_ledger_add", "directorate_note"])],
  [REFUTER, new Set(["directorate_ledger_verdict", "directorate_ledger_list"])],
]);

export const ActorSchema = Schema.Struct({
  agent: Schema.String,
  session: Schema.String,
});

export type Actor = typeof ActorSchema.Type;

const RoleSchema = Schema.Literals(ROLES);

const isRole = Schema.is(RoleSchema);

/** The instruction every role reads in each phase. */
const PHASE_TEXT = Schema.Record(
  PhaseSchema,
  Schema.Record(RoleSchema, Schema.String)
).make({
  drain: {
    [REVIEWER]:
      "DRAIN: dispatch no new Auditors or Seats; route open entries to Compliance, then call directorate_report",
    [SCOUT]: "DRAIN: file surviving candidates now and hand off",
    [PANELIST]:
      "DRAIN: file surviving candidates now, note what you did not reach, and hand off",
    [REFUTER]:
      "DRAIN: finish the entry in hand; decide the rest only where evidence is clear, then hand off",
  },
  locked: {
    [REVIEWER]:
      "LOCKED: <Containment/Window> expired — call directorate_report now",
    [SCOUT]: "LOCKED: file final candidates or notes and stop",
    [PANELIST]: "LOCKED: file final candidates or notes and stop",
    [REFUTER]: "LOCKED: record proved verdicts and stop",
  },
  normal: {
    [REVIEWER]: "observe and investigate",
    [SCOUT]: "investigate",
    [PANELIST]: "review in isolation",
    [REFUTER]: "verify",
  },
});

/** "[header] <middle> · <role instruction>"; unknown agents read the Liaison's instruction. */
const phaseLine = (phase: Phase, agent: string, middle: string) =>
  `[${PHASE_HEADERS[phase]}] ${middle} · ${PHASE_TEXT[phase][isRole(agent) ? agent : REVIEWER]}`;

export const budgetLine = Effect.fnUntraced(function* budgetLine(
  seal: typeof StoredWindow.Type,
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
