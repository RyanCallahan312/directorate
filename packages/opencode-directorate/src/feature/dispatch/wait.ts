// Waiting: the Liaison stays in its turn while its subagents work. Ending the turn instead would hand a calling agent
// an unfinished review, and leave that agent to finish it. Their handoffs arrive as messages at the next step.
import { DateTime, Effect, Schedule, Schema } from "effect";
import type { FileSystem, Path } from "effect";

import { actor, str } from "../../platform/platform.ts";
import type { DefineTool } from "../../platform/platform.ts";
import { Store } from "../../records/records.ts";
import type { Seal } from "../../seal/record.ts";
import { done, Sessions, ToolCall } from "../../seal/seal.ts";
import { budget } from "../../workflow/review/window.ts";
import {
  dispatchName,
  outstandingDispatches,
  perSession,
  statusOf,
} from "./lifecycle.ts";
import type { Dispatch } from "./lifecycle.ts";

export const waitTool = (
  tool: DefineTool<Sessions | Store | FileSystem.FileSystem | Path.Path>
) => {
  tool({
    description:
      "Wait, without ending your turn, until one of this review's Auditor, Seat, or Compliance runs finishes or the budget phase changes. Returns who finished, the entries and verdicts each recorded, and who is still running; their handoffs follow as subagent messages. Call it whenever you would otherwise end your turn while they run.",
    *execute(input, c) {
      const store = yield* Store;

      const start = yield* (yield* Sessions).read(
        input.seal,
        ToolCall.make({
          actor: actor(c),
          callers: "owner",
          lockdown: "exempt",
          tool: "directorate_wait",
        }),
        Effect.succeed
      );

      const { phase } = yield* budget(start.window);
      const waiting = outstandingDispatches(start);

      if (!waiting.length) {
        return yield* done(
          start,
          "No Auditor, Seat, or Compliance runs are running. Decide or route the open entries, then call directorate_report."
        );
      }

      if (phase === "locked") {
        return yield* done(
          start,
          "The budget is locked: call directorate_report now; it stops the runs still going."
        );
      }

      const ended = (seal: Seal) => {
        const still = new Set(outstandingDispatches(seal).map((x) => x.call));

        return seal.children.filter(
          (x) => waiting.some((w) => w.call === x.call) && !still.has(x.call)
        );
      };

      // The session events and the deadline watchdog write the seal; poll it until something the Liaison acts on changed.
      const { seal, phaseNow } = yield* Effect.gen(function* poll() {
        const current = yield* store.load(start.id);
        const next = yield* budget(current.window);

        return { phaseNow: next.phase, seal: current };
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (state) =>
            state.seal.reportedAt !== undefined ||
            state.phaseNow !== phase ||
            ended(state.seal).length > 0,
        })
      );

      if (seal.reportedAt) {
        return {
          content: `The deadline passed and The Directorate filed the Directive. Output it verbatim:\n\n${yield* store.readReport(seal.id)}`,
        };
      }

      const ledger = yield* store.loadLedger(seal.id);

      /** What this run recorded: a follow-up reports its own round, not the session's earlier ones. */
      const recorded = (x: Dispatch) => {
        const since = (at: DateTime.Utc) =>
          DateTime.toEpochMillis(at) >= DateTime.toEpochMillis(x.startedAt);

        const raised = ledger.entries
          .filter((e) => e.raisedBy.session === x.session && since(e.createdAt))
          .map((e) => e.id);

        const decided = ledger.entries.flatMap((e) =>
          [...(e.history ?? []), ...e.verdicts]
            .values()
            .filter((v) => v.by.session === x.session && since(v.at))
            .map((v) => `${e.id} ${v.verdict}`)
            .toArray()
        );

        return (
          [
            raised.length ? `raised ${raised.join(", ")}` : "",
            decided.length ? `decided ${[...new Set(decided)].join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; ") || "recorded nothing"
        );
      };

      const still = perSession(outstandingDispatches(seal));

      const lines = perSession(ended(seal)).map(
        (x) =>
          `- ${dispatchName(x)} ${statusOf(x)}${x.session ? ` (${x.session})` : ""}: ${recorded(x)}`
      );

      if (phaseNow === "locked") {
        lines.push(
          "The budget is locked: call directorate_report now; it stops the runs still going."
        );
      } else {
        if (phaseNow !== phase) {
          lines.push(
            `The budget moved to ${phaseNow}; follow the budget line below.`
          );
        }

        lines.push(
          still.length
            ? `Still running (${still.length}): ${still.map((x) => `${dispatchName(x)}${x.session ? ` (${x.session})` : ""}`).join(", ")}. Decide or route what finished, then call directorate_wait again; do not end your turn while any run.`
            : "Nothing else is running. Decide or route the new entries, then call directorate_report."
        );
      }

      return yield* done(seal, lines.join("\n"));
    },
    input: Schema.Struct({ seal: str }),
    name: "directorate_wait",
  });
};
