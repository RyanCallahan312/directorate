// What the host's records prove to Ship: which inputs are its own, the user's, or a subagent's notice, and what a session's history says about the ship's last input.
import type { SessionInbox } from "@opencode/schema/session-inbox";
import type { SessionMessage } from "@opencode/schema/session-message";
import { Option, Predicate, Result, Schema, Struct } from "effect";

import { SessionIdSchema } from "../../platform/host-id.ts";
import type { MessageId, SessionId } from "../../platform/host-id.ts";
import {
  createdAt,
  idleAt,
  isFailed,
  isRunning as isExecuting,
  isSucceeded,
  isSynthetic,
  isUserInput,
  turns,
} from "../../platform/platform.ts";
import type { Activity } from "../../platform/platform.ts";
import { ShipIdSchema } from "../review/ship-link.ts";
import type { ShipId } from "../review/ship-link.ts";
import type { Plan, ShipState } from "./state.ts";

/** How long a finished subagent's completion notice may stay undelivered before recovery stops waiting for it. */
const NOTICE_GRACE_MS = 30_000;

/** The mark on every input Ship sends: its source, and the ship that sent it. */
const ShipMarkSchema = Schema.Struct({
  shipID: ShipIdSchema,
  source: Schema.Literal("directorate-ship"),
});

/** Whether an input's metadata carries Ship's mark, from any ship. */
const isShipMarked = Schema.is(
  ShipMarkSchema.mapFields(Struct.pick(["source"]))
);

/** The mark for an input ship `id` sends. */
export const shipMark = (id: ShipId) =>
  ShipMarkSchema.make({ shipID: id, source: "directorate-ship" });

/** The host's mark on a finished subagent's completion notice: the child session it is from. */
const isSubagentNotice = Schema.is(
  Schema.Struct({
    childID: SessionIdSchema,
    source: Schema.Literal("subagent"),
  })
);

/** Background work that is a subagent running for the session. */
export const isSubagentWork = Schema.is(
  Schema.Struct({ kind: Schema.Literal("subagent") })
);

/** A request message the user's turn carries. */
export const isUserTurn = Schema.is(
  Schema.Struct({ role: Schema.Literal("user") })
);

/** What an input that is not a completion notice is to Ship: the user's, or anything else. */
const InputKindSchema = Schema.Literals(["user", "other"]);

export const isUserKind = Schema.is(InputKindSchema.pick(["user"]));

/** What an input is to Ship: the user's, a finished subagent's completion notice, or anything else. */
const InboxKindSchema = Schema.Union([
  InputKindSchema,
  Schema.Struct({ child: SessionIdSchema }),
]);

export type InboxKind = typeof InboxKindSchema.Type;

/** A user input is the user's unless Ship sent it. */
const userKind = (metadata: SessionMessage.Info["metadata"]) =>
  isShipMarked(metadata) ? "other" : "user";

/** A synthetic input is a completion notice when the host marked it as one. */
const syntheticKind = (metadata: SessionMessage.Info["metadata"]) =>
  isSubagentNotice(metadata) ? { child: metadata.childID } : "other";

/** What a queued input is to Ship, by its type and metadata. */
export const inboxKind = (item: SessionInbox.Item) => {
  if (isUserInput(item)) {
    return userKind(item.payload.metadata);
  }

  return isSynthetic(item) ? syntheticKind(item.payload.metadata) : "other";
};

/** What a delivered input is to Ship, by its type and metadata. */
export const messageKind = (message: SessionMessage.Info) => {
  if (isUserInput(message)) {
    return userKind(message.metadata);
  }

  return isSynthetic(message) ? syntheticKind(message.metadata) : "other";
};

export const handoff =
  "An ordinary user prompt was delivered. Ship yielded control; use /directorate-ship resume when ready.";

export const noProvenance =
  "Could not verify the continuation's originating Ship input. Use /directorate-ship resume when ready.";

export const compacted =
  "OpenCode installed a checkpoint that hides the continuation's context. Ship paused without sending further instructions. Use /directorate-ship resume to reassess from the saved Directive.";

/** A compaction the host completed: a checkpoint that hides what came before it. */
const isCheckpoint = Schema.is(
  Schema.Struct({
    status: Schema.Literal("completed"),
    type: Schema.Literal("compaction"),
  })
);

export const checkpointID = (messages: readonly SessionMessage.Info[]) =>
  messages.findLast(isCheckpoint)?.id;

/**
 * Why the ship's input no longer leads the session, if it does not: its origin from `ship` is missing, a user input
 * came after it, or its marker `markerID` was never promoted after it.
 */
export const superseded = (
  messages: readonly SessionMessage.Info[],
  ship: ShipId,
  origin?: MessageId,
  markerID?: MessageId
) => {
  const start = messages.findIndex(
    (message) =>
      message.id === origin &&
      isShipMarked(message.metadata) &&
      message.metadata.shipID === ship
  );

  if (start === -1) {
    return noProvenance;
  }

  const newer = messages.slice(start + 1);

  if (newer.some((message) => isUserKind(messageKind(message)))) {
    return handoff;
  }

  return markerID &&
    !newer.some((message) => message.id === markerID && isSynthetic(message))
    ? noProvenance
    : undefined;
};

/** Whether a checkpoint newer than the plan's hides its marker or its origin. */
export const checkpointHidesPlan = (
  messages: readonly SessionMessage.Info[],
  plan: Plan
) => {
  const checkpoint = checkpointID(messages);

  return (
    checkpoint !== undefined &&
    checkpoint !== plan.checkpoint &&
    (!messages.some((message) => message.id === plan.id) ||
      !messages.some((message) => message.id === plan.origin))
  );
};

/** Why a subagent the next step depends on holds recovery back: busy waits, and the rest stop it. */
export const HoldSchema = Schema.Literals([
  "busy",
  "interrupted",
  "missing",
  "unnoticed",
]);

/** Still working, or its notice may yet arrive: recovery waits for it. */
export const isBusy = Schema.is(HoldSchema.pick(["busy"]));

/** Why recovery stops for a subagent the next step depends on. */
export const BLOCKED = Schema.Record(
  HoldSchema.pick(["interrupted", "missing", "unnoticed"]),
  Schema.String
).make({
  interrupted: "The Liaison was interrupted before reporting.",
  missing:
    "The review's Liaison session is no longer available. Resuming dispatches a replacement, which may restart part of the review's time budget.",
  unnoticed:
    "A waiting subagent finished, but its completion message was not delivered.",
});

const turnFailure = (turn: SessionMessage.Idle) =>
  isFailed(turn.outcome)
    ? `The session failed${turn.error ? `: ${turn.error.message}` : ""}.`
    : "The session was interrupted.";

/**
 * What the session's history proves about the ship's last input: nothing yet (undefined), that it cannot be traced (a
 * failure, with why), or the messages since it with any reason they give to stop.
 */
export const proven = (
  state: ShipState,
  messages: readonly SessionMessage.Info[],
  failed?: string
) => {
  const { inbox, plan } = state;
  const id = inbox?.id ?? state.origin;

  const input = messages.find(
    (message) =>
      message.id === id && (isUserInput(message) || isSynthetic(message))
  );

  if (!input) {
    // Missing delivery evidence is not evidence that an inbox item was cancelled; a known delivery was compacted away.
    return inbox && inbox.deliveredAt === undefined
      ? undefined
      : Result.fail(checkpointID(messages) ? compacted : noProvenance);
  }

  const after = messages.slice(messages.indexOf(input) + 1);
  const ended = turns(after);

  // The host's times say idle, yet no turn has settled since the input: do not guess.
  if (!ended.length) {
    return;
  }

  // Every turn since the input, not only the last: a later success must not hide an interruption.
  const turn = ended.find(({ outcome }) => !isSucceeded(outcome));

  const reason =
    plan && checkpointHidesPlan(messages, plan)
      ? compacted
      : superseded(messages, state.id, plan?.origin ?? input.id, plan?.id);

  return Result.succeed({
    after,
    origin: input.id,
    reason: reason ?? (turn && (failed ?? turnFailure(turn))),
  });
};

/** Why a subagent holds the next step back, if it does. An orphaned one neither runs nor sends a notice. */
export const held = (act: Activity, now: number, unnoticed: boolean) => {
  if (isExecuting(act.state)) {
    return HoldSchema.make("busy");
  }

  const idle = idleAt(act);

  if (Option.isNone(idle) || !unnoticed) {
    return;
  }

  // The notice follows the subagent's settling; give the host a moment to deliver it.
  return now - idle.value <= NOTICE_GRACE_MS
    ? HoldSchema.make("busy")
    : HoldSchema.make("unnoticed");
};

/** The same for a subagent whose session no longer exists: a Liaison cannot report, and no notice will come. */
export const gone = (owner: boolean, unnoticed: boolean) => {
  if (owner) {
    return HoldSchema.make("missing");
  }

  return unnoticed ? HoldSchema.make("unnoticed") : undefined;
};

/** The awaited subagent whose completion notice this message is, if it arrived after the subagent was seen running. */
export const noticed = (
  message: SessionMessage.Info,
  awaiting: Readonly<Record<SessionId, number>>
) => {
  const kind = messageKind(message);

  return Predicate.isObject(kind) &&
    createdAt(message) >= (awaiting[kind.child] ?? Infinity)
    ? kind.child
    : undefined;
};
