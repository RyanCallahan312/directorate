// Access: only Directorate agents call the review tools, only the Liaison dispatches, no new Auditors or Seats in drain,
// nothing new once locked; and what each agent still holds in its session prefix.
import type { SessionContext } from "@opencode/plugin/effect/session";
import { Effect } from "effect";

import { adapter, Host, ToolCatalog } from "../../platform/platform.ts";
import type { Seal } from "../../seal/record.ts";
import { Sessions } from "../../seal/seal.ts";
import { budget } from "../../workflow/review/window.ts";
import {
  agentNamed,
  budgetNotice,
  dispatchableNamed,
  Liaison,
} from "./agent.ts";

/** Why another agent may not use the review harness: the Liaison runs the whole review, so callers dispatch it. */
const LIAISON_ONLY =
  "Only directorate_liaison runs a Directorate review: it seals, reads, dispatches its own Auditors, Seats, and Compliance, and returns the Directive. Dispatch directorate_liaison with the target and focus, and relay its Directive verbatim. If you already dispatched one, send the follow-up to that session instead of starting another. To re-check after fixes, send that session a follow-up asking for a re-check, or dispatch a new Liaison with the seal id from the Directive's Containment line.";

/** True for a request of an agent outside The Directorate, whose tools then keep only those to configure and export. */
export const withholdHarness = Effect.fnUntraced(function* withholdHarness(
  event: SessionContext
) {
  if (agentNamed(event.agent)) {
    return false;
  }

  const catalog = yield* ToolCatalog;

  // Other agents can configure and export without getting the review harness.
  for (const name of Object.keys(event.tools ?? {})) {
    if (yield* catalog.harness(name)) {
      Reflect.deleteProperty(event.tools, name);
    }
  }

  return true;
});

/** Once the seal's budget is locked: the lockdown notice, and only the tools the agent keeps at lockdown. */
export const lockdown = Effect.fnUntraced(function* lockdown(
  event: SessionContext,
  seal: Seal
) {
  const b = yield* budget(seal.window);

  if (b.phase !== "locked") {
    return;
  }

  const catalog = yield* ToolCatalog;

  // Unknown agents read the Liaison's notice.
  event.system.push({
    text: budgetNotice(agentNamed(event.agent) ?? Liaison, b.phase),
    type: "text",
  });

  for (const name of Object.keys(event.tools ?? {})) {
    if (!(yield* catalog.keeps(event.agent, name))) {
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
  const catalog = yield* ToolCatalog;
  const { hook } = yield* adapter<Sessions>();

  yield* host.permission.hook(
    "evaluate",
    hook("evaluate", function* onEvaluate(event) {
      const target = String(event.resources?.[0] ?? "");

      const child =
        event.action === "subagent" ? dispatchableNamed(target) : undefined;

      const covered =
        event.action === "subagent"
          ? child !== undefined
          : yield* catalog.harness(event.action);

      // A request that names no agent is the session's agent's, as the host resolves it.
      const caller = covered
        ? (event.agent ?? (yield* sessions.agent(event.sessionID)))
        : undefined;

      const by = agentNamed(caller);

      if (
        caller !== undefined &&
        (child ? !by?.dispatches.includes(child.id) : !by)
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

      const b = yield* budget(seal.window);

      // Any other subagent launches only while the budget is normal, as Auditors and Seats do.
      const launchable = child
        ? Liaison.mayLaunch(child, b.phase)
        : b.phase === "normal";

      if (!launchable) {
        const stage = b.phase === "locked" ? "lockdown" : "evacuation";
        event.effect = "deny";
        event.message = `Directorate ${stage} (${b.phase}): <We/The Directorate> deny new ${target || "subagent"} dispatches. Verify what you hold and call directorate_report.`;
      }
    })
  );
});
