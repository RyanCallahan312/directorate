// Dispatch's host-event side: the one ordered session-event consumer, and what OpenCode's session records say about the
// runs a review dispatched.
import type { Plugin } from "@opencode/plugin/effect";
import type { SessionMessage } from "@opencode/schema/session-message";
import { DateTime, Effect, Schedule, Stream } from "effect";

import { ignore, recover } from "../../platform/error.ts";
import { activity, createdAt, Host } from "../../platform/platform.ts";
import { Records } from "../../records/records.ts";
import type { Seal } from "../../seal/record.ts";
import { HostEvent, Sessions } from "../../seal/seal.ts";
import { halted } from "../../workflow/review/custody.ts";
import { dispatchableNamed } from "../agents/agent.ts";
import {
  claimed,
  Completed,
  DispatchSchema,
  enqueued,
  Failed,
  finished,
  followUpPrompt,
  followUpRecovered,
  inboxSettled,
  outstandingDispatches,
  perSession,
  update,
} from "./lifecycle.ts";

/** A promoted follow-up belongs to the first terminal marker after that exact input. */
const recoverFollowUps = (
  seal: Seal,
  session: string,
  messages: readonly SessionMessage.Info[]
) =>
  update(seal, (child) => {
    if (
      child.session !== session ||
      !child.followUp ||
      !DispatchSchema.isAnyOf(["Launching", "Running"])(child)
    ) {
      return child;
    }

    const { inbox } = child.followUp;

    const input = messages.findIndex(
      (message) =>
        message.type === "user" &&
        (inbox
          ? message.id === inbox
          : message.text === followUpPrompt(child) &&
            createdAt(message) >= DateTime.toEpochMillis(child.startedAt))
    );

    const delivered = messages[input];

    if (!delivered) {
      return child;
    }

    const turn = messages
      .slice(input + 1)
      .find((message) => message.type === "idle");

    if (!turn && child.followUp.delivered) {
      return child;
    }

    return followUpRecovered(
      child,
      delivered.id,
      turn && {
        endedAt: turn.time.created,
        ending: turn.outcome === "succeeded" ? Completed : Failed,
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
        act.state === "running" ||
        (act.state === "orphaned" && !act.session.time.busy)
      ) {
        continue;
      }

      const completed =
        act.state === "idle" && act.session.outcome === "succeeded";

      const endedAt =
        act.state === "idle"
          ? DateTime.makeUnsafe(act.at)
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
              "initial"
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

    /** The review's share of one event. */
    const forRuns = (event: SessionEvent) => {
      const { sessionID } = event.data;

      if (event.type === "session.created") {
        return event.data.parentID
          ? claimChild(
              event.data.sessionID,
              event.data.parentID,
              String(event.data.agent ?? ""),
              event.data.title
            )
          : Effect.void;
      }

      if (event.type === "session.deleted" || event.type === "session.moved") {
        return Effect.void;
      }

      // OpenCode restores suspended executions and jobs after shutdown.
      if (
        event.type === "session.execution.interrupted" &&
        event.data.reason === "shutdown"
      ) {
        return Effect.void;
      }

      if (event.type === "session.inbox.enqueued") {
        const { inboxID, item } = event.data;

        return item.type === "user" &&
          item.payload.text.includes("\n\n[Directorate follow-up: ")
          ? childEvent(sessionID, (s) =>
              enqueued(s, sessionID, inboxID, item.payload.text)
            )
          : Effect.void;
      }

      const at = DateTime.makeUnsafe(event.created);

      if (
        event.type === "session.inbox.delivered" ||
        event.type === "session.inbox.cancelled"
      ) {
        const { inboxID } = event.data;
        const delivered = event.type === "session.inbox.delivered";

        return childEvent(sessionID, (s) =>
          inboxSettled(s, sessionID, inboxID, delivered, at)
        );
      }

      const stopped =
        event.type === "session.execution.interrupted" &&
        event.data.reason === "user";

      return childEvent(sessionID, (s) => {
        const next = finished(
          s,
          sessionID,
          /failed|interrupted/u.test(event.type) ? Failed : Completed,
          at,
          event.type !== "session.idle"
        );

        // The user stopped the Liaison itself: a later successful turn must not read as the review's own.
        return stopped && s.ownerSession === sessionID && !s.halted
          ? halted(next ?? s)
          : next;
      });
    };

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
