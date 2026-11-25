// What recovery after a reload or restart reads from the host's own record, never from the model's reply.
import type { Plugin } from "@opencode/plugin/effect";
import type { Session } from "@opencode/schema/session";
import type { SessionMessage } from "@opencode/schema/session-message";
import { DateTime, Effect, Option } from "effect";

import { ProcessIdentity } from "./process-identity.ts";

export const locationKey = (ref: {
  readonly directory: string;
  readonly workspaceID?: string | undefined;
}) => JSON.stringify([ref.directory, ref.workspaceID ?? ""]);

const timeOf = (time: DateTime.Utc | undefined) =>
  time && DateTime.toEpochMillis(time);

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
    return { at: idle, session, state: "idle" } as const;
  }

  // Returns at once unless an execution is running here.
  const quiet = yield* host.session
    .wait({ sessionID: session.id })
    .pipe(
      Effect.timeoutOption("250 millis"),
      Effect.orElseSucceed(Option.none)
    );

  if (Option.isNone(quiet)) {
    return { session, state: "running" } as const;
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
    return { at: ended, session: fresh, state: "idle" } as const;
  }

  return {
    session: fresh,
    state: started === busy ? "orphaned" : "running",
  } as const;
});

export type Activity = Effect.Success<ReturnType<typeof activity>>;

/**
 * Whether another live server process last drove this record. Servers can share one database, and each sees only its
 * own executions, so recovery leaves such a record to its process.
 */
export const foreign = Effect.fnUntraced(function* foreign(
  pid: number | undefined
) {
  const identity = yield* ProcessIdentity;

  return (
    pid !== undefined && pid !== identity.pid && (yield* identity.isAlive(pid))
  );
});

/** How each turn that settled in these messages ended, oldest first. A shutdown is not a turn's end. */
export const turns = (messages: readonly SessionMessage.Info[]) =>
  messages.flatMap((message) => (message.type === "idle" ? [message] : []));

export const createdAt = (message: SessionMessage.Info) =>
  DateTime.toEpochMillis(message.time.created);

/** On resume, ignore old interruptions, not later ones. Older manually resumed seals lack the resume time. */
export const interruptedReview = (
  seal: {
    readonly createdAt: DateTime.Utc;
    readonly halted?: boolean | undefined;
    readonly resumedAt?: DateTime.Utc | undefined;
  },
  messages: readonly SessionMessage.Info[]
) => {
  if (seal.halted || (!seal.resumedAt && seal.halted === false)) {
    return seal.halted === true;
  }

  const since = DateTime.toEpochMillis(seal.resumedAt ?? seal.createdAt);

  return turns(messages).some(
    (turn) =>
      turn.outcome === "interrupted" &&
      (seal.resumedAt ? createdAt(turn) > since : createdAt(turn) >= since)
  );
};
