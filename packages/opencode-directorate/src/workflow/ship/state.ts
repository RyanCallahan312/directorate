// Ship state as stored in OpenCode plugin storage under ship:<sessionID>.
import { Schema } from "effect";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const Plan = Schema.Struct({
  checkpoint: Schema.optionalKey(Schema.String),
  id: Schema.String,
  origin: Schema.String,
  rendered: Schema.Boolean,
  text: Schema.String,
});

export const ShipStateSchema = Schema.Struct({
  /** An automatic continuation whose admission was not confirmed. */
  admitting: Schema.optionalKey(Schema.Boolean),
  /** Background subagents the settled turn left running, and when each was seen: their notices come before the next step. */
  awaiting: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
  boot: Schema.String,
  chain: Schema.Array(Schema.String),
  id: Schema.String,
  inbox: Schema.optionalKey(
    Schema.Struct({
      continuation: Schema.optionalKey(Schema.Boolean),
      deliveredAt: Schema.optionalKey(Schema.Finite),
      id: Schema.String,
    })
  ),
  lastHostFailure: Schema.optionalKey(Schema.String),
  location: Schema.optionalKey(Schema.String),
  needsAttachments: Schema.optionalKey(Schema.Boolean),
  /** Queued completion notices by inbox ID, and the subagent each is from. */
  notices: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  origin: Schema.optionalKey(Schema.String),
  /** The server process driving the loop: while it lives, no other process recovers this ship. */
  pid: Schema.optionalKey(Schema.Finite),
  plan: Schema.optionalKey(Plan),
  reason: Schema.String,
  recovery: Schema.optionalKey(Schema.String),
  request: Schema.String,
  reviewsAtResume: Count,
  rounds: Count,
  startedAt: Schema.Finite,
  status: Schema.Literals(["waiting", "active", "paused", "complete"]),
  step: Schema.optional(Schema.String),
  /** When an awaited subagent's notice was delivered: the turn it woke settles next. */
  wokeAt: Schema.optionalKey(Schema.Finite),
});

export type ShipState = typeof ShipStateSchema.Type;
