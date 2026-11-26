// Dispatch's host-event side: the one ordered session-event consumer, and what OpenCode's session records say about the
// runs a review dispatched.
import type { Plugin } from "@opencode/plugin/effect";
import type { SessionMessage } from "@opencode/schema/session-message";
import { DateTime, Effect, Match, Option, Schedule, Stream } from "effect";

import { ignore, recover } from "../../platform/error.ts";
import {
  activity,
  createdAt,
  Host,
  idleAt,
  isOrphaned,
  isRunning,
  isShutdown,
  isSucceeded,
  isUserInput,
  isUserStop,
  turns,
} from "../../platform/platform.ts";
import { Records } from "../../records/records.ts";
import type { Seal } from "../../seal/record.ts";
import { HostEvent, Sessions } from "../../seal/seal.ts";
import { halted } from "../../workflow/review/custody.ts";
import { dispatchableNamed } from "../agents/agent.ts";
import {
  claimed,
  Completed,
  enqueued,
  Failed,
  finished,
  followUpPrompt,
  followUpRecovered,
  inboxSettled,
  isOutstanding,
  outstandingDispatches,
  perSession,
  update,
} from "./lifecycle.ts";
import type { EndMarker } from "./lifecycle.ts";

/** A promoted follow-up belongs to the first terminal marker after that exact input. */
const recoverFollowUps = (
  seal: Seal,
  session: string,
  messages: readonly SessionMessage.Info[]
) =>
  update(seal, (child) => {
    if (child.session !== session || !child.followUp || !isOutstanding(child)) {
      return child;
    }

    const { inbox } = child.followUp;

    const input = messages.findIndex(
      (message) =>
        isUserInput(message) &&
        (inbox
          ? message.id === inbox
          : message.text === followUpPrompt(child) &&
            createdAt(message) >= DateTime.toEpochMillis(child.startedAt))
    );

    const delivered = messages[input];

    if (!delivered) {
      return child;
    }

    const [turn] = turns(messages.slice(input + 1));

    if (!turn && child.followUp.delivered) {
      return child;
    }

    return followUpRecovered(
      child,
      delivered.id,
      turn && {
        endedAt: turn.time.created,
        status: isSucceeded(turn.outcome) ? "completed" : "failed",
      }
    );
  });

/** Events missed across a reload leave a finished run recorded as running: settle it from the host's own record. */
export const settleChildren = Effect.fn("Directorate.settleChildren")(
  function* settleChildren(seal: Seal) {
    const host = yield* Host;
    const sessions = yield* Sessions;
    const outstanding = outstandingDispatches(seal);

    for (const { session } of perSession(outstanding)) {
      const info = session ? yield* sessions.info(session) : undefined;
      const act = info ? yield* activity(host, info) : undefined;

      // A run that never began has not been orphaned; one that began and will never end has failed.
      if (
        !session ||
        !info ||
        !act ||
        isRunning(act.state) ||
        (isOrphaned(act.state) && !act.session.time.busy)
      ) {
        continue;
      }

      const idle = idleAt(act);

      const completed = Option.isSome(idle) && isSucceeded(act.session.outcome);

      const endedAt = Option.isSome(idle)
        ? DateTime.makeUnsafe(idle.value)
        : yield* DateTime.now;

      const messages = outstanding.some(
        (run) => run.session === session && run.followUp
      )
        ? yield* host.session.context({ sessionID: act.session.id })
        : [];

      // The session's last outcome is not proof of how an exact follow-up ended.
      yield* sessions.mutate(seal.id, HostEvent.make({}), ({ seal: s }) => {
        const followed = recoverFollowUps(s, session, messages);

        return Effect.succeed({
          out: undefined,
          seal:
            finished(
              followed ?? s,
              session,
              completed ? Completed : Failed,
              endedAt,
              "record"
            ) ?? followed,
        });
      });
    }
  }
);

const subscribe = (host: Plugin.Context) =>
  host.event.subscribe({
    types: [
      "session.created",
      "session.deleted",
      "session.inbox.enqueued",
      "session.inbox.delivered",
      "session.inbox.cancelled",
      "session.idle",
      "session.moved",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
    ],
  });

/** One of the session events the consumer reads, in the order the host emits them. */
export type SessionEvent = Stream.Success<ReturnType<typeof subscribe>>;

/**
 * The one session-event consumer, in event order: a child's session.created is always handled before its terminal
 * events. `before` hears each event first (the ship loop's share), then the review's runs take theirs.
 */
export const consumeSessionEvents = Effect.fnUntraced(
  function* consumeSessionEvents(
    before: (event: SessionEvent) => Effect.Effect<void>
  ) {
    const host = yield* Host;
    const sessions = yield* Sessions;
    const store = yield* Records;

    // Running: a child's session is created by the subagent tool before it runs; link it to its launch now, so every later
    // event for it finds the review.
    const claimChild = Effect.fn("Directorate.claimChild")(function* claimChild(
      sessionID: string,
      parentID: string,
      agent: string,
      title: string | undefined
    ) {
      if (!dispatchableNamed(agent)) {
        return;
      }

      const seal = yield* sessions.active(parentID);

      // Reported between launch and link, even if the Liaison has sealed another review since: stop the child, which no
      // review owns now.
      for (const id of yield* sessions.launchesBy(parentID)) {
        if (id === seal?.id) {
          continue;
        }

        const reported = yield* store
          .load(id)
          .pipe(Effect.orElseSucceed(() => null));

        if (
          reported?.reportedAt &&
          claimed(reported, sessionID, agent, title)
        ) {
          yield* sessions.interrupt(sessionID);

          return;
        }
      }

      if (!seal || seal.ownerSession !== parentID) {
        return;
      }

      let linked = false;
      yield* sessions
        .mutate(seal.id, HostEvent.make({}), ({ seal: s }) => {
          const next = claimed(s, sessionID, agent, title);
          linked =
            next !== undefined ||
            s.children.some((c) => c.session === sessionID);

          return Effect.succeed({ out: undefined, seal: next });
        })
        .pipe(
          ignore(`could not link ${agent} ${sessionID} to ${seal.id}`, "Warn")
        );

      if (linked) {
        yield* sessions.bind(sessionID, seal.id);
      }
    });

    const childEvent = Effect.fn("Directorate.childEvent")(function* childEvent(
      sessionID: string,
      change: (s: Seal) => Seal | undefined
    ) {
      const id =
        (yield* sessions.boundTo(sessionID)) ??
        (yield* sessions.active(sessionID))?.id;

      if (!id) {
        return;
      }

      yield* sessions
        .mutate(id, HostEvent.make({}), ({ seal }) =>
          Effect.succeed({ out: undefined, seal: change(seal) })
        )
        .pipe(ignore(`could not update ${sessionID} in ${id}`, "Warn"));
    });

    /** A session's execution ended as `ending`: settle its runs. The user stopping the Liaison itself halts the review. */
    const ended = (
      event: SessionEvent,
      ending: typeof Completed | typeof Failed,
      marker: EndMarker,
      stopped: boolean
    ) => {
      const { sessionID } = event.data;
      const at = DateTime.makeUnsafe(event.created);

      return childEvent(sessionID, (s) => {
        const next = finished(s, sessionID, ending, at, marker);

        // The user stopped the Liaison itself: a later successful turn must not read as the review's own.
        return stopped && s.ownerSession === sessionID && !s.halted
          ? halted(next ?? s)
          : next;
      });
    };

    /** The review's share of one event. */
    const forRuns = Match.type<SessionEvent>().pipe(
      Match.discriminatorsExhaustive("type")({
        "session.created": ({ data }) =>
          data.parentID
            ? claimChild(
                data.sessionID,
                data.parentID,
                String(data.agent ?? ""),
                data.title
              )
            : Effect.void,
        "session.deleted": () => Effect.void,
        "session.execution.failed": (event) =>
          ended(event, Failed, "execution", false),
        "session.execution.interrupted": (event) =>
          // OpenCode restores suspended executions and jobs after shutdown.
          isShutdown(event.data.reason)
            ? Effect.void
            : ended(event, Failed, "execution", isUserStop(event.data.reason)),
        "session.execution.succeeded": (event) =>
          ended(event, Completed, "execution", false),
        "session.idle": (event) => ended(event, Completed, "idle", false),
        "session.inbox.cancelled": ({
          created,
          data: { inboxID, sessionID },
        }) => {
          const at = DateTime.makeUnsafe(created);

          return childEvent(sessionID, (s) =>
            inboxSettled(s, sessionID, inboxID, false, at)
          );
        },
        "session.inbox.delivered": ({
          created,
          data: { inboxID, sessionID },
        }) => {
          const at = DateTime.makeUnsafe(created);

          return childEvent(sessionID, (s) =>
            inboxSettled(s, sessionID, inboxID, true, at)
          );
        },
        "session.inbox.enqueued": ({ data: { inboxID, item, sessionID } }) => {
          if (
            !isUserInput(item) ||
            !item.payload.text.includes("\n\n[Directorate follow-up: ")
          ) {
            return Effect.void;
          }

          const { text } = item.payload;

          return childEvent(sessionID, (s) =>
            enqueued(s, sessionID, inboxID, text)
          );
        },
        "session.moved": () => Effect.void,
      })
    );

    yield* Stream.suspend(() => subscribe(host)).pipe(
      Stream.runForEach((event) =>
        before(event).pipe(Effect.andThen(forRuns(event)))
      ),
      recover("event subscription failed"),
      Effect.repeat(Schedule.spaced("5 seconds")),
      Effect.forkScoped
    );
  }
);
