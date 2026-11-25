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

/**
 * Whether the session is executing, settled, or was left mid-turn. The host's times are milliseconds, and a shutdown or
 * kill records no end: unless they show a turn that ended after it began, ask whether this process is executing it. A
 * start with no end and no execution here is a turn the restart orphaned.
 */
export const activity = Effect.fnUntraced(function* activity(
  host: Plugin.Context,
  { id, time }: Pick<Session.Info, "id" | "time">
) {
  const idle = time.idle ? DateTime.toEpochMillis(time.idle) : undefined;
  const busy = time.busy ? DateTime.toEpochMillis(time.busy) : undefined;

  if (idle !== undefined && (busy === undefined || busy < idle)) {
    return { at: idle, state: "idle" } as const;
  }

  // Returns at once unless an execution is running here.
  const quiet = yield* host.session
    .wait({ sessionID: id })
    .pipe(
      Effect.timeoutOption("250 millis"),
      Effect.orElseSucceed(Option.none)
    );

  if (Option.isNone(quiet)) {
    return { state: "running" } as const;
  }

  // A successor that began in the millisecond its predecessor settled would still be running.
  return idle !== undefined && busy === idle
    ? ({ at: idle, state: "idle" } as const)
    : ({ state: "orphaned" } as const);
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
