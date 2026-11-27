// Access: only Directorate agents call the review tools, only the Liaison dispatches, no new Auditors or Seats in drain,
// nothing new once locked; and what each agent still holds in its session prefix.
import type { SessionContext } from "@opencode/plugin/effect/session";
import { Effect } from "effect";

import {
  adapter,
  Host,
  isSubagentTool,
  ToolCatalog,
} from "../../platform/platform.ts";
import type { Seal } from "../../seal/record.ts";
import { Sessions } from "../../seal/seal.ts";
import {
  budget,
  isLocked,
  isNormal,
  PHASE_STAGES,
} from "../../workflow/review/window.ts";
import {
  agentNamed,
  budgetNotice,
  dispatchableNamed,
  Liaison,
} from "./agent.ts";
import type { Agent } from "./agent.ts";

/** Why another agent may not use the review harness: the Liaison runs the whole review, so callers dispatch it. */
const LIAISON_ONLY = `Only ${Liaison.id} runs a Directorate review: it seals, reads, dispatches its own Auditors, Seats, and Compliance, and returns the Directive. Dispatch ${Liaison.id} with the target and focus, and relay its Directive verbatim. If you already dispatched one, send the follow-up to that session instead of starting another. To re-check after fixes, send that session a follow-up asking for a re-check, or dispatch a new Liaison with the seal id from the Directive's Containment line.`;

/** Removes from the request's tools each one `drops` holds for. */
const dropTools = <E, R>(
  event: SessionContext,
  drops: (name: string) => Effect.Effect<boolean, E, R>
) =>
  Effect.gen(function* dropEach() {
    for (const name of Object.keys(event.tools ?? {})) {
      if (yield* drops(name)) {
        Reflect.deleteProperty(event.tools, name);
      }
    }
  });

/** True for a request of an agent outside The Directorate, whose tools then keep only those to configure and export. */
export const withholdHarness = Effect.fnUntraced(function* withholdHarness(
  event: SessionContext
) {
  if (agentNamed(event.agent)) {
    return false;
  }

  const catalog = yield* ToolCatalog;

  // Other agents can configure and export without getting the review harness.
  yield* dropTools(event, catalog.harness);

  return true;
});

/** Once the seal's budget is locked: the lockdown notice, and only the tools the agent keeps at lockdown. */
export const lockdown = Effect.fnUntraced(function* lockdown(
  event: SessionContext,
  seal: Seal
) {
  const b = yield* budget(seal.window);

  if (!isLocked(b.phase)) {
    return;
  }

  const catalog = yield* ToolCatalog;

  // Unknown agents read the Liaison's notice.
  event.system.push({
    text: budgetNotice(agentNamed(event.agent) ?? Liaison, b.phase),
    type: "text",
  });

  yield* dropTools(event, (name) =>
    Effect.map(catalog.keeps(event.agent, name), (keeps) => !keeps)
  );
});

/**
 * Whether `caller` is refused a review-harness tool or, when `child` is set, the dispatch of that Directorate subagent:
 * any caller that does not resolve to a Directorate agent is, including one neither the request nor the session's
 * record names, and so is a Directorate agent that does not dispatch `child`. Dispatching the Liaison and every
 * non-harness tool are not asked here; the host's own rules decide them.
 */
export const refusesCaller = (
  caller: string | undefined,
  child: Agent | undefined
) => {
  const by = agentNamed(caller);

  return child ? !by?.dispatches.includes(child.id) : !by;
};

/**
 * Only the Liaison dispatches Auditors, Seats, and Compliance, and only Directorate agents call the review tools. No new
 * Auditors or Seats once the budget drains; Compliance stays available until lock.
 */
export const registerAccess = Effect.fnUntraced(function* registerAccess() {
  const host = yield* Host;
  const sessions = yield* Sessions;
  const catalog = yield* ToolCatalog;
  const { hook } = yield* adapter<never>();

  yield* host.permission.hook(
    "evaluate",
    hook("evaluate", function* onEvaluate(event) {
      const target = String(event.resources?.[0] ?? "");
      const dispatching = isSubagentTool(event.action);
      const child = dispatching ? dispatchableNamed(target) : undefined;

      const covered = dispatching
        ? child !== undefined
        : yield* catalog.harness(event.action);

      // A request that names no agent is the session's agent's, as the host resolves it; with neither, it is refused.
      if (
        covered &&
        refusesCaller(
          event.agent ?? (yield* sessions.agent(event.sessionID)),
          child
        )
      ) {
        event.effect = "deny";
        event.message = LIAISON_ONLY;

        return;
      }

      if (!dispatching) {
        return;
      }

      const seal = yield* sessions.active(event.sessionID);

      if (!seal) {
        return;
      }

      const b = yield* budget(seal.window);

      // Any other subagent launches only while the budget is normal, as Auditors and Seats do.
      const launchable = child
        ? Liaison.mayLaunch(child, b.phase)
        : isNormal(b.phase);

      if (!launchable) {
        event.effect = "deny";
        event.message = `Directorate ${PHASE_STAGES[b.phase]} (${b.phase}): <We/The Directorate> deny new ${target || "subagent"} dispatches. Verify what you hold and call directorate_report.`;
      }
    })
  );
});
