// Directorate agents: what each agent is and may do, who acted, and what each agent reads in each phase of the budget
// (Window × Agent).
import { Effect, Schema } from "effect";

import {
  budget,
  PHASE_HEADERS,
  PhaseSchema,
} from "../../workflow/review/window.ts";
import type { Phase, Window } from "../../workflow/review/window.ts";

/**
 * The Directorate agents, in registration order: the Liaison (lead reviewer), Auditors (narrow investigators), Directorate
 * Seats (independent panel reviewers, one model each), and Compliance (the adversarial verifier).
 */
export const AgentIdSchema = Schema.Literals([
  "directorate_liaison",
  "directorate_auditor",
  "directorate_seat",
  "directorate_compliance",
]);

type AgentId = typeof AgentIdSchema.Type;

/** An agent of a kind: whom it dispatches, the phases it may be launched in, and its orders in each phase. */
export class Agent extends Schema.Class<
  Agent,
  { readonly brand: unique symbol }
>("directorate/Agent")({
  dispatches: Schema.Array(AgentIdSchema),
  id: AgentIdSchema,
  launchableIn: Schema.Array(PhaseSchema),
  orders: Schema.Record(PhaseSchema, Schema.String),
  title: Schema.String,
}) {
  /** Whether this agent may launch `child` in `phase`. */
  mayLaunch(child: Agent, phase: Phase) {
    return (
      this.dispatches.includes(child.id) && child.launchableIn.includes(phase)
    );
  }

  /** What this agent reads in `phase`. */
  orderFor(phase: Phase) {
    return this.orders[phase];
  }
}

export const Liaison = Agent.make({
  dispatches: [
    "directorate_auditor",
    "directorate_seat",
    "directorate_compliance",
  ],
  id: "directorate_liaison",
  launchableIn: [],
  orders: {
    drain:
      "DRAIN: dispatch no new Auditors or Seats; route open entries to Compliance, then call directorate_report",
    locked:
      "LOCKED: <Containment/Window> expired — call directorate_report now",
    normal: "observe and investigate",
  },
  title: "Liaison",
});

export const Auditor = Agent.make({
  dispatches: [],
  id: "directorate_auditor",
  launchableIn: ["normal"],
  orders: {
    drain: "DRAIN: file surviving candidates now and hand off",
    locked: "LOCKED: file final candidates or notes and stop",
    normal: "investigate",
  },
  title: "Auditor",
});

export const Seat = Agent.make({
  dispatches: [],
  id: "directorate_seat",
  launchableIn: ["normal"],
  orders: {
    drain:
      "DRAIN: file surviving candidates now, note what you did not reach, and hand off",
    locked: "LOCKED: file final candidates or notes and stop",
    normal: "review in isolation",
  },
  title: "Directorate Seat",
});

export const Compliance = Agent.make({
  dispatches: [],
  id: "directorate_compliance",
  launchableIn: ["normal", "drain"],
  orders: {
    drain:
      "DRAIN: finish the entry in hand; decide the rest only where evidence is clear, then hand off",
    locked: "LOCKED: record proved verdicts and stop",
    normal: "verify",
  },
  title: "Compliance",
});

const Agents = Schema.Record(AgentIdSchema, Agent).make({
  directorate_auditor: Auditor,
  directorate_compliance: Compliance,
  directorate_liaison: Liaison,
  directorate_seat: Seat,
});

export const agentOf = (id: AgentId) => Agents[id];

const isAgentId = Schema.is(AgentIdSchema);

/** The Directorate agent a host-supplied name denotes, or undefined for any other agent. */
export const agentNamed = (name: string | undefined) =>
  isAgentId(name) ? agentOf(name) : undefined;

/** The Auditor, Seat, or Compliance a name denotes: an agent the Liaison dispatches, or undefined for any other name. */
export const dispatchableNamed = (name: string | undefined) => {
  const agent = agentNamed(name);

  return agent && Liaison.dispatches.includes(agent.id) ? agent : undefined;
};

/**
 * Who acted: the agent and session of a tool call, decoded once at the edge (platform's `actor`). Stored in ledger.json
 * entries, verdicts, and notes; the agent stays any string there, since other agents and older versions wrote them.
 */
export class Actor extends Schema.Class<
  Actor,
  { readonly brand: unique symbol }
>("directorate/Actor")({
  agent: Schema.String,
  session: Schema.String,
}) {
  /** The Directorate agent that acted, or undefined for any other agent. */
  get role() {
    return agentNamed(this.agent);
  }
}

/** "[header] <middle> · <agent's order>" */
const phaseLine = (agent: Agent, phase: Phase, middle: string) =>
  `[${PHASE_HEADERS[phase]}] ${middle} · ${agent.orderFor(phase)}`;

/** The ticking budget footer under a tool result. */
export const budgetLine = Effect.fnUntraced(function* budgetLine(
  agent: Agent,
  window: Window
) {
  const b = yield* budget(window);

  return phaseLine(
    agent,
    b.phase,
    `${b.minutesLeft} min left of ${window.budgetMinutes} · phase ${b.phase}`
  );
});

/** Static phase notice for system prompts (no ticking minutesLeft, so KV-cache prefixes stay stable). */
export const budgetNotice = (agent: Agent, phase: Phase) =>
  phaseLine(agent, phase, `phase ${phase}`);
