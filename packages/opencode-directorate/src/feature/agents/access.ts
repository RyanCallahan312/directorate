// Access: only Directorate agents call the review tools, only the Liaison dispatches, no new Auditors or Seats in drain,
// nothing new once locked; and what each agent still holds in its session prefix.
import type { SessionContext } from "@opencode/plugin/effect/session";
import { Effect } from "effect";

import { adapter, Host } from "../../platform/platform.ts";
import type { Seal } from "../../seal/record.ts";
import { Sessions } from "../../seal/seal.ts";
import { budget } from "../../workflow/review/window.ts";
import {
  budgetNotice,
  CHILD_ROLE_SET,
  LOCKED_TOOLS,
  REFUTER,
  REVIEWER,
  ROLE_SET,
} from "./agent.ts";

const GENERAL_TOOLS = new Set([
  "directorate_configure",
  "directorate_export",
  "directorate_export_list",
]);

/** Why another agent may not use the review harness: the Liaison runs the whole review, so callers dispatch it. */
const LIAISON_ONLY =
  "Only directorate_liaison runs a Directorate review: it seals, reads, dispatches its own Auditors, Seats, and Compliance, and returns the Directive. Dispatch directorate_liaison with the target and focus, and relay its Directive verbatim. If you already dispatched one, send the follow-up to that session instead of starting another. To re-check after fixes, send that session a follow-up asking for a re-check, or dispatch a new Liaison with the seal id from the Directive's Containment line.";

/** True for a request of an agent outside The Directorate, whose tools then keep only those to configure and export. */
export const withholdHarness = (event: SessionContext) => {
  const agent: string = event.agent;

  if (ROLE_SET.has(agent)) {
    return false;
  }

  // Other agents can configure and export without getting the review harness.
  for (const name of Object.keys(event.tools ?? {})) {
    if (name.startsWith("directorate_") && !GENERAL_TOOLS.has(name)) {
      Reflect.deleteProperty(event.tools, name);
    }
  }

  return true;
};

/** Once the seal's budget is locked: the lockdown notice, and only the tools the agent keeps at lockdown. */
export const lockdown = Effect.fnUntraced(function* lockdown(
  event: SessionContext,
  seal: Seal
) {
  const agent: string = event.agent;
  const b = yield* budget(seal);

  if (b.phase !== "locked") {
    return;
  }

  event.system.push({ text: budgetNotice(b.phase, agent), type: "text" });

  const keep = LOCKED_TOOLS.get(agent);

  for (const name of Object.keys(event.tools ?? {})) {
    if (!keep?.has(name)) {
      Reflect.deleteProperty(event.tools, name);
    }
  }
});

/**
 * Only the Liaison dispatches Auditors, Seats, and Compliance, and only Directorate agents call the review tools. No new
 * Auditors or Seats once the budget drains; Compliance stays available until lock.
 */
export const registerAccess = Effect.fnUntraced(function* registerAccess() {
  const host = yield* Host;
  const sessions = yield* Sessions;
  const { hook } = yield* adapter<Sessions>();

  yield* host.permission.hook(
    "evaluate",
    hook("evaluate", function* onEvaluate(event) {
      const target = String(event.resources?.[0] ?? "");

      const covered =
        event.action === "subagent"
          ? CHILD_ROLE_SET.has(target)
          : event.action.startsWith("directorate_") &&
            !GENERAL_TOOLS.has(event.action);

      // A request that names no agent is the session's agent's, as the host resolves it.
      const caller = covered
        ? (event.agent ?? (yield* sessions.agent(event.sessionID)))
        : undefined;

      if (
        caller !== undefined &&
        (event.action === "subagent"
          ? caller !== REVIEWER
          : !ROLE_SET.has(caller))
      ) {
        event.effect = "deny";
        event.message = LIAISON_ONLY;

        return;
      }

      if (event.action !== "subagent") {
        return;
      }

      const seal = yield* sessions.active(event.sessionID);

      if (!seal) {
        return;
      }

      const b = yield* budget(seal);

      if (b.phase === "locked" || (b.phase === "drain" && target !== REFUTER)) {
        const stage = b.phase === "locked" ? "lockdown" : "evacuation";
        event.effect = "deny";
        event.message = `Directorate ${stage} (${b.phase}): <We/The Directorate> deny new ${target || "subagent"} dispatches. Verify what you hold and call directorate_report.`;
      }
    })
  );
});
