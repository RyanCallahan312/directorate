// What /directorate-ship asks for, the errors it answers with, and how a ship reads back to the user.
import type { CommandInvocation } from "@opencode/plugin/effect/command";
import { Effect, Match, Schema } from "effect";

import { agentNamed } from "../../feature/agents/agent.ts";
import { startsWithRecheck } from "../review/request.ts";
import { isPaused, statusOf } from "./state.ts";
import type { ShipFields, ShipState } from "./state.ts";

export const restartAttached =
  "Start a new /directorate-ship with the request and attachments; their delivery could not be confirmed.";

/** The ship's input, while it is still queued. */
export const queued = (state: ShipFields) =>
  state.inbox?.deliveredAt === undefined ? state.inbox?.id : undefined;

export const cancelFirst = (id: string) =>
  `Cancel the exact queued ship input ${id} in OpenCode or let it be delivered. If OpenCode confirms it is no longer queued and Ship missed the event, run /directorate-ship forget ${id}. Forget only discards automation; it does not cancel input.`;

export const hasAttachments = ({
  files,
  agents,
  skills,
}: CommandInvocation["prompt"]) =>
  Boolean(files?.length || agents?.length || skills?.length);

/** The ship as `/directorate-ship status` shows it. */
export const describe = (state: ShipState) => {
  const pending = queued(state);

  return [
    `Directorate ship ${statusOf(state)}${pending ? " (queued input can still execute)" : ""}.`,
    `Request: ${state.request.trim() || "(configured defaults)"}`,
    `Rounds this run: ${state.rounds}`,
    `Seals: ${state.chain.join(" → ") || "none"}`,
    `Reason: ${state.reason}`,
    state.lastHostFailure &&
      `Latest host outcome before delivery (not attributed to this ship): ${state.lastHostFailure}`,
    pending && cancelFirst(pending),
    !pending &&
      isPaused(state) &&
      (state.needsAttachments
        ? restartAttached
        : (state.recovery ??
          "Resolve the blocker, then use /directorate-ship resume, or use /directorate-ship stop to clear it.")),
  ]
    .filter(Boolean)
    .join("\n");
};

/** A ship command run from the wrong place: a Directorate agent, another worktree or location, or another server. */
export class ShipElsewhere extends Schema.TaggedError<
  ShipElsewhere,
  { readonly brand: unique symbol }
>()("ShipElsewhere", { message: Schema.String }) {}

/** A ship command the ship's state or the command's input does not allow. */
export class ShipCommandRefused extends Schema.TaggedError<
  ShipCommandRefused,
  { readonly brand: unique symbol }
>()("ShipCommandRefused", { message: Schema.String }) {}

/** The ship's status, shown instead of acting: for status, or when a ship ends without a continuation. */
export class ShipStatus extends Schema.TaggedError<
  ShipStatus,
  { readonly brand: unique symbol }
>()("ShipStatus", { message: Schema.String }) {}

/** What /directorate-ship does instead of starting a ship; `forget` takes the pending input's id after it. */
const ShipVerbSchema = Schema.Literals([
  "status",
  "pause",
  "resume",
  "stop",
  "forget",
]);

const isShipVerb = Schema.is(ShipVerbSchema);

const FORGET = /^forget(?:\s|$)/u;

const FORGET_ID = /^forget\s+(?<id>\S+)$/iu;

/** The verb a command's trimmed, lowercased text names, if it names one. */
const verbOf = (action: string) => {
  if (isShipVerb(action)) {
    return action;
  }

  return FORGET.test(action) ? ShipVerbSchema.make("forget") : undefined;
};

/** `/directorate-ship status`: show the ship instead of acting. */
class StatusCommand extends Schema.TaggedClass<
  StatusCommand,
  { readonly brand: unique symbol }
>()("Status", {}) {}

/** `/directorate-ship pause`: stop the active ship until the user resumes it. */
class PauseCommand extends Schema.TaggedClass<
  PauseCommand,
  { readonly brand: unique symbol }
>()("Pause", {}) {}

/** `/directorate-ship resume`: continue the paused ship. */
class ResumeCommand extends Schema.TaggedClass<
  ResumeCommand,
  { readonly brand: unique symbol }
>()("Resume", {}) {}

/** `/directorate-ship stop`: clear the ship's record. */
class StopCommand extends Schema.TaggedClass<
  StopCommand,
  { readonly brand: unique symbol }
>()("Stop", {}) {}

/** `/directorate-ship forget <id>`: clear the record of a ship whose input `id` is no longer queued; `id` is absent unless exactly one follows. */
class ForgetCommand extends Schema.TaggedClass<
  ForgetCommand,
  { readonly brand: unique symbol }
>()("Forget", { id: Schema.optionalKey(Schema.String) }) {}

/** A request that asks for `--recheck`: refused, as a ship starts a new review. */
class RecheckCommand extends Schema.TaggedClass<
  RecheckCommand,
  { readonly brand: unique symbol }
>()("Recheck", {}) {}

/** Anything else starts a new ship for `request`, as typed. */
class StartCommand extends Schema.TaggedClass<
  StartCommand,
  { readonly brand: unique symbol }
>()("Start", { request: Schema.String }) {}

const ShipCommandSchema = Schema.Union([
  StatusCommand,
  PauseCommand,
  ResumeCommand,
  StopCommand,
  ForgetCommand,
  RecheckCommand,
  StartCommand,
]).pipe(Schema.toTaggedUnion("_tag"));

export type ShipCommand = typeof ShipCommandSchema.Type;

const forgetCommand = (raw: string) => {
  const id = FORGET_ID.exec(raw.trim())?.groups?.id;

  return ForgetCommand.make(id === undefined ? {} : { id });
};

/** What a /directorate-ship command's text asks for: a verb (case-insensitive), a refused `--recheck`, or a new ship. */
export const parseShipCommand = (raw: string) => {
  const verb = verbOf(raw.trim().toLowerCase());

  if (verb === undefined) {
    return startsWithRecheck(raw)
      ? RecheckCommand.make({})
      : StartCommand.make({ request: raw });
  }

  return Match.value(verb).pipe(
    Match.when("status", () => StatusCommand.make({})),
    Match.when("pause", () => PauseCommand.make({})),
    Match.when("resume", () => ResumeCommand.make({})),
    Match.when("stop", () => StopCommand.make({})),
    Match.when("forget", () => forgetCommand(raw)),
    Match.exhaustive
  );
};

/** The commands that act on the ship as it is, so take no attachments. */
export const refusesAttachments = ShipCommandSchema.isAnyOf([
  "Pause",
  "Status",
  "Stop",
  "Forget",
]);

export const isStatus = ShipCommandSchema.isAnyOf(["Status"]);

export const isPause = ShipCommandSchema.isAnyOf(["Pause"]);

export const isResume = ShipCommandSchema.isAnyOf(["Resume"]);

export const isRecheck = ShipCommandSchema.isAnyOf(["Recheck"]);

export const isForget = ShipCommandSchema.isAnyOf(["Forget"]);

/** The commands that clear the ship's record. */
export const clears = ShipCommandSchema.isAnyOf(["Stop", "Forget"]);

export const assertAgent = (agent: string | undefined) =>
  agentNamed(agent)
    ? Effect.fail(
        new ShipElsewhere({
          message:
            "Use /directorate-ship from the calling session, not from a Directorate agent.",
        })
      )
    : Effect.void;
