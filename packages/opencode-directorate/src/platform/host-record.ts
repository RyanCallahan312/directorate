// What recovery after a reload or restart reads from the host's own record, never from the model's reply.
import type { Plugin } from "@opencode/plugin/effect";
import type { Location } from "@opencode/schema/location";
import type { Session } from "@opencode/schema/session";
import type { SessionMessage } from "@opencode/schema/session-message";
import { DateTime, Effect, Match, Option, Schema } from "effect";

import { ProcessIdentity } from "./process-identity.ts";

export const locationKey = (ref: Location.Ref) =>
  JSON.stringify([ref.directory, ref.workspaceID ?? ""]);

const timeOf = (time: DateTime.Utc | undefined) =>
  time && DateTime.toEpochMillis(time);

/** What `activity` finds a session doing: settled, executing in this process, or left mid-turn by a restart. */
const ActivityStateSchema = Schema.Literals(["idle", "running", "orphaned"]);

// Each state on its own, so `activity`'s results keep `state` as their discriminant.
const [IdleState, RunningState, OrphanedState] = ActivityStateSchema.members;

/**
 * Whether the session is executing, settled, or was left mid-turn. The host's times are milliseconds, and a shutdown or
 * kill records no end: unless they show a turn that ended after it began, ask whether this process is executing it. A
 * start with no end and no execution here is a turn the restart orphaned.
 */
export const activity = Effect.fnUntraced(function* activity(
  host: Plugin.Context,
  session: Session.Info
) {
  const idle = timeOf(session.time.idle);
  const busy = timeOf(session.time.busy);

  if (idle !== undefined && (busy === undefined || busy < idle)) {
    return { at: idle, session, state: IdleState.make("idle") };
  }

  // Returns at once unless an execution is running here.
  const quiet = yield* host.session
    .wait({ sessionID: session.id })
    .pipe(
      Effect.timeoutOption("250 millis"),
      Effect.orElseSucceed(Option.none)
    );

  if (Option.isNone(quiet)) {
    return { session, state: RunningState.make("running") };
  }

  // The execution may have settled during the wait. Use its new outcome, not the pre-wait snapshot.
  const fresh = yield* host.session.get({ sessionID: session.id });
  const ended = timeOf(fresh.time.idle);
  const started = timeOf(fresh.time.busy);

  if (
    ended !== undefined &&
    (started === undefined ||
      started < ended ||
      (started === ended && started === busy))
  ) {
    return {
      at: ended,
      session: fresh,
      state: IdleState.make("idle"),
    };
  }

  return {
    session: fresh,
    state:
      started === busy
        ? OrphanedState.make("orphaned")
        : RunningState.make("running"),
  };
});

export type Activity = Effect.Success<ReturnType<typeof activity>>;

export const isIdle = Schema.is(ActivityStateSchema.pick(["idle"]));

export const isRunning = Schema.is(ActivityStateSchema.pick(["running"]));

export const isOrphaned = Schema.is(ActivityStateSchema.pick(["orphaned"]));

/** When a settled session went idle, in the host's milliseconds; none while it runs or once orphaned. */
export const idleAt = Match.type<Activity>().pipe(
  Match.when({ state: "idle" }, (act) => act.at),
  Match.option
);

/** The host's outcome of a session or turn that succeeded. */
export const isSucceeded = Schema.is(Schema.Literal("succeeded"));

/** The host's outcome of a turn that failed. */
export const isFailed = Schema.is(Schema.Literal("failed"));

/** The host's outcome of a session or turn that was interrupted. */
export const isInterrupted = Schema.is(Schema.Literal("interrupted"));

/** An interruption at shutdown: OpenCode restores the executions it suspended then. */
export const isShutdown = Schema.is(Schema.Literal("shutdown"));

/** An interruption by the user, who stopped the execution. */
export const isUserStop = Schema.is(Schema.Literal("user"));

/** A message or inbox item the user (or an inbox delivery) sent. */
export const isUserInput = Schema.is(
  Schema.Struct({ type: Schema.Literal("user") })
);

/** A message or inbox item the host or a plugin added on its own: a completion notice, a marker, a wake. */
export const isSynthetic = Schema.is(
  Schema.Struct({ type: Schema.Literal("synthetic") })
);

/**
 * Whether another live server process last drove this record. Servers can share one database, and each sees only its
 * own executions, so recovery leaves such a record to its process.
 */
export const foreign = Effect.fnUntraced(function* foreign(pid: number) {
  const identity = yield* ProcessIdentity;

  return pid !== identity.pid && (yield* identity.isAlive(pid));
});

/** The message, if it marks a turn's end. */
const settled = Match.type<SessionMessage.Info>().pipe(
  Match.when({ type: "idle" }, (message) => [message]),
  Match.orElse(() => [])
);

/** How each turn that settled in these messages ended, oldest first. A shutdown is not a turn's end. */
export const turns = (messages: readonly SessionMessage.Info[]) =>
  messages.flatMap(settled);

export const createdAt = (message: SessionMessage.Info) =>
  DateTime.toEpochMillis(message.time.created);
