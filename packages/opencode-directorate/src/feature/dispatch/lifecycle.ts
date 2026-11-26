// The subagent runs a review dispatches, as stored in seal.json's children.
import { Schema } from "effect";

import { Time } from "../../platform/stored.ts";

const opt = Schema.optional;

const ChildStatus = Schema.Literals([
  "launching",
  "running",
  "completed",
  "failed",
]);

export const ChildSchema = Schema.Struct({
  agent: Schema.String,
  call: Schema.String,
  /** The human-readable part of the OpenCode child session's title. */
  description: opt(Schema.String),
  endedAt: opt(Time),
  followUp: opt(
    Schema.Struct({
      delivered: opt(Schema.Boolean),
      inbox: opt(Schema.String),
    })
  ),
  /** The model the launch named, which for a Directorate SeatSchema is its seat. */
  model: opt(Schema.String),
  prompt: Schema.String,
  session: opt(Schema.String),
  startedAt: Time,
  status: ChildStatus,
});

export type Child = typeof ChildSchema.Type;
