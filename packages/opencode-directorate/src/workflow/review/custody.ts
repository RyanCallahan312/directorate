// Who holds a review: the Custody field group of seal.json.
import { Schema } from "effect";

import { Time } from "../../platform/stored.ts";

const list = Schema.Array;
const opt = Schema.optional;

/** The Custody field group of seal.json. */
export const Custody = Schema.Struct({
  abandoned: opt(Schema.Boolean),
  /**
   * Whether the user interrupted the Liaison: true keeps automatic recovery off until a resume or takeover, which sets
   * false. A missed interruption is read from the session's history after the last resume.
   */
  halted: opt(Schema.Boolean),
  /** The directory of the OpenCode instance that sealed it, whose watchdog reports it if the Liaison does not. */
  host: opt(Schema.String),
  owner: Schema.String,
  ownerSession: Schema.String,
  /** The server process that sealed, took over, or recovered the review: while it lives, no other process recovers it. */
  pid: opt(Schema.Finite),
  /** Liaison sessions that owned this seal before a takeover, for full exports. */
  previousOwnerSessions: opt(list(Schema.String)),
  /** The last recovery wake. Until admitted, the same ID is submitted again. */
  recovery: opt(
    Schema.Struct({
      admitted: opt(Schema.Boolean),
      admittedAt: opt(Time),
      id: Schema.String,
      ownerSession: Schema.String,
    })
  ),
  /** History before an explicit resume or takeover must not halt the resumed review. */
  resumedAt: opt(Time),
});
