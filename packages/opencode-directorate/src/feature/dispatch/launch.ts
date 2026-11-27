// Launching: the subagent tool's hooks. A launch is registered before the child runs, so a fast child is never missed,
// and the subagent's result settles it even if session.created was missed.
import type { ToolHooks } from "@opencode/plugin/effect/tool";
import {
  DateTime,
  Effect,
  HashMap,
  Match,
  Option,
  Predicate,
  Ref,
  Schema,
} from "effect";

import { ignore, orWarn } from "../../platform/error.ts";
import { SessionIdSchema } from "../../platform/host-id.ts";
import type { CallId, SessionId } from "../../platform/host-id.ts";
import { adapter, Host, isSubagentTool } from "../../platform/platform.ts";
import { Records } from "../../records/records.ts";
import { SealIdSchema } from "../../seal/seal-id.ts";
import type { SealId } from "../../seal/seal-id.ts";
import { HostEvent, Sessions } from "../../seal/seal.ts";
import {
  dispatchableNamed,
  DispatchableIdSchema,
  Seat as SeatAgent,
} from "../agents/agent.ts";
import {
  Completed,
  Failed,
  followUpPrompt,
  launchTitle,
  launched,
  Launching,
  isLaunching,
  openSeat,
  resumed,
  returned,
  Running,
  seatName,
  withdrawn,
} from "./lifecycle.ts";

/** An Auditor, Seat, or Compliance launch, as the subagent tool's input; with a sessionID it continues an existing child. */
const decodeAssignment = Schema.decodeUnknownOption(
  Schema.Struct({
    agent: DispatchableIdSchema,
    description: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    prompt: Schema.optional(Schema.String),
    sessionID: Schema.optional(SessionIdSchema),
  })
);

/** What the subagent tool reports about the child it ran. */
const decodeChildMeta = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionID: Schema.optional(SessionIdSchema),
    status: Schema.optional(Schema.String),
  })
);

/** How the subagent tool's metadata names its child's end. */
const ChildStatusSchema = Schema.Literals(["completed", "failed"]);

const reportsCompleted = Schema.is(ChildStatusSchema.pick(["completed"]));

const reportsFailed = Schema.is(ChildStatusSchema.pick(["failed"]));

/** The subagent call's result when it completed, and whether it errored instead. */
const callResult = Match.type<ToolHooks["execute.after"]>().pipe(
  Match.discriminatorsExhaustive("status")({
    completed: (ev) => ({ errored: false, result: ev.result }),
    error: () => ({ errored: true, result: undefined }),
  })
);

/** How the subagent tool says its child ended: an error, then a completion, then a failure; otherwise it still runs. */
const subagentOutcome = (
  errored: boolean,
  reported: string | undefined,
  text: string
) => {
  if (errored) {
    return Failed;
  }

  if (reportsCompleted(reported) || /state=\\?"completed/u.test(text)) {
    return Completed;
  }

  if (
    /state=\\?"(?:failed|error|interrupted)/u.test(text) ||
    reportsFailed(reported)
  ) {
    return Failed;
  }

  return Running;
};

/** The seal and Liaison session a subagent call was launched for. */
const LaunchSchema = Schema.Struct({
  parent: SessionIdSchema,
  seal: SealIdSchema,
});

/**
 * Subagent call -> the seal and Liaison session it was launched for, until the subagent tool returns. A report can
 * close the seal before the launch links to its child session; the late child is stopped, not left running unowned.
 */
export const launchRegistry = Effect.gen(function* launchRegistry() {
  const launches = yield* Ref.make(
    HashMap.empty<CallId, typeof LaunchSchema.Type>()
  );

  return {
    /** A subagent call the Liaison of `parent` made for `seal`, open until `settled`. */
    launch: (call: CallId, seal: SealId, parent: SessionId) =>
      Ref.update(launches, HashMap.set(call, { parent, seal })),
    /** The seal a subagent call was launched for, if it has not settled. */
    launchedFor: (call: CallId) =>
      Ref.get(launches).pipe(
        Effect.map((m) => Option.getOrUndefined(HashMap.get(m, call))?.seal)
      ),
    /** Seal ids of the unsettled subagent calls `parent` made. */
    launchesBy: (parent: SessionId) =>
      Ref.get(launches).pipe(
        Effect.map(
          (m) =>
            new Set(
              [...HashMap.values(m)].flatMap((l) =>
                l.parent === parent ? [l.seal] : []
              )
            )
        )
      ),
    settled: (call: CallId) => Ref.update(launches, HashMap.remove(call)),
  };
});

export type Launches = Effect.Success<typeof launchRegistry>;

export const registerLaunches = Effect.fnUntraced(function* registerLaunches(
  launches: Launches
) {
  const host = yield* Host;
  const sessions = yield* Sessions;
  const store = yield* Records;
  const { hook } = yield* adapter<never>();

  // ---------- Auditors, Seats, and Compliance ----------
  // Launching: registered before the child runs, so a fast child is never missed. A completed child calling tools again
  // is running again; check before locking, since most calls change nothing.
  yield* host.tool.hook(
    "execute.before",
    hook("executeBefore", function* onExecuteBefore(ev) {
      if (!isSubagentTool(ev.tool)) {
        const id = yield* sessions.boundTo(ev.sessionID);

        if (!id || !dispatchableNamed(ev.agent)) {
          return;
        }

        const seal = yield* store.find(id);

        if (!seal || !resumed(seal, ev.sessionID)) {
          return;
        }

        yield* sessions
          .mutate(id, HostEvent.make({}), ({ seal: s }) =>
            Effect.succeed({ out: undefined, seal: resumed(s, ev.sessionID) })
          )
          .pipe(
            ignore(`could not mark ${ev.sessionID} running in ${id}`, "Warn")
          );

        return;
      }

      const assignment = Option.getOrUndefined(decodeAssignment(ev.input));

      if (!assignment) {
        return;
      }

      const seal = yield* sessions.active(ev.sessionID);

      if (!seal) {
        return;
      }

      const startedAt = yield* DateTime.now;

      // Assign seats under the seal lock so parallel launches take different models. Only a launch the seal saved is
      // registered and sent on.
      const launch = yield* sessions
        .mutate(seal.id, HostEvent.make({}), ({ seal: s }) => {
          // A follow-up continues a child session: a new run of it, keeping the seat it was launched for.
          const prior = assignment.sessionID
            ? s.children.findLast((c) => c.session === assignment.sessionID)
            : undefined;

          if (assignment.sessionID) {
            const followUp = new Launching({
              agent: assignment.agent,
              call: ev.id,
              description: assignment.description ?? prior?.description,
              followUp: {},
              model: assignment.model ?? prior?.model,
              prompt: assignment.prompt ?? "",
              session: assignment.sessionID,
              startedAt,
            });

            return Effect.succeed({
              out: followUp,
              seal: launched(s, followUp),
            });
          }

          const model =
            SeatAgent.is(assignment.agent) && !assignment.model
              ? openSeat(s)
              : undefined;

          const fresh = new Launching({
            agent: assignment.agent,
            call: ev.id,
            description: model
              ? `${assignment.description ?? SeatAgent.title} · ${seatName(model)}`
              : assignment.description,
            model: model ?? assignment.model,
            prompt: assignment.prompt ?? "",
            startedAt,
          });

          return Effect.succeed({ out: fresh, seal: launched(s, fresh) });
        })
        .pipe(orWarn(`could not register ${assignment.agent} in ${seal.id}`));

      if (launch) {
        yield* launches.launch(ev.id, seal.id, ev.sessionID);
      }

      if (launch && Predicate.isObject(ev.input)) {
        ev.input = launch.followUp
          ? { ...ev.input, prompt: followUpPrompt(launch) }
          : {
              ...ev.input,
              description: launchTitle(launch),
              ...(launch.model && { model: launch.model }),
            };
      }
    })
  );

  /** A launch of a seal reported before the launch ran: stop the child it started, which no review owns now. */
  const stopUnowned = Effect.fn("Directorate.stopUnowned")(
    function* stopUnowned(
      call: CallId,
      sealId: SealId | undefined,
      session: SessionId | undefined
    ) {
      const reported = sealId ? yield* store.find(sealId) : undefined;

      const launch = reported?.reportedAt
        ? reported.children.find((x) => x.call === call && isLaunching(x))
        : undefined;

      const child = session ?? launch?.session;

      if (launch && child) {
        yield* sessions.interrupt(child);
      }
    }
  );

  // The subagent result is authoritative even if session.created was missed (a plugin reload mid-launch).
  yield* host.tool.hook(
    "execute.after",
    hook("executeAfter", function* onExecuteAfter(ev) {
      if (!isSubagentTool(ev.tool)) {
        return;
      }

      const { errored, result } = callResult(ev);

      const meta = Option.getOrElse(
        decodeChildMeta(result?.metadata?.metadata ?? result?.metadata),
        () => ({ sessionID: undefined, status: undefined })
      );

      const launchedFor = yield* launches.launchedFor(ev.id);
      yield* launches.settled(ev.id);
      const seal = yield* sessions.active(ev.sessionID);

      // Launched for a review that is no longer this session's, even if the Liaison has sealed another since.
      if (!seal || (launchedFor && launchedFor !== seal.id)) {
        return yield* stopUnowned(ev.id, launchedFor, meta.sessionID);
      }

      const text = JSON.stringify(result?.content ?? "");

      const outcome = subagentOutcome(errored, meta.status, text);

      const endedAt = yield* DateTime.now;

      // The child session the saved result names, if any.
      const child = yield* sessions
        .mutate(seal.id, HostEvent.make({}), ({ seal: s }) =>
          Effect.sync(() => {
            const launch = s.children.find((x) => x.call === ev.id);

            // Not an Auditor, Seat, or Compliance of this review.
            if (!launch) {
              return { out: undefined };
            }

            // Rejected before it ran: the subagent tool checks permission (drain, lockdown, rules) after this launch
            // registered, so there is no child, and no failure to report.
            if (errored && isLaunching(launch)) {
              return { out: undefined, seal: withdrawn(s, launch) };
            }

            return {
              out: meta.sessionID ?? launch.session,
              seal: returned(s, ev.id, meta.sessionID, outcome, endedAt),
            };
          })
        )
        .pipe(orWarn(`could not record subagent result in ${seal.id}`));

      if (child) {
        yield* sessions.bind(child, seal.id);
      }
    })
  );
});
