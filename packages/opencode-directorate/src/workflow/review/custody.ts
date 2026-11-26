// Who holds a review: the Custody field group of seal.json, and its transitions: start, resume or take over, halt, abandon,
// and the recovery wake.
import { DateTime, Schema } from "effect";

import { Liaison } from "../../feature/agents/agent.ts";
import type { Actor } from "../../feature/agents/agent.ts";
import { Time } from "../../platform/stored.ts";
import type { Seal } from "../../seal/record.ts";

const list = Schema.Array;
const opt = Schema.optional;

/** Only the session that owns a review may abandon it. */
export class AbandonRefused extends Schema.TaggedError<
  AbandonRefused,
  { readonly brand: unique symbol }
>()("AbandonRefused", { seal: Schema.String }) {
  override get message() {
    return `Only the owner of ${this.seal} can abandon it.`;
  }
}

/** A recovery wake sent to the owner's session, and whether the host admitted it. */
export class Recovery extends Schema.Class<
  Recovery,
  { readonly brand: unique symbol }
>("directorate/Recovery")({
  admitted: opt(Schema.Boolean),
  admittedAt: opt(Time),
  id: Schema.String,
  ownerSession: Schema.String,
}) {
  /** The same wake, admitted by the host at `at`. */
  admittedAs(at: DateTime.Utc) {
    return Recovery.make({ ...this, admitted: true, admittedAt: at });
  }

  /** When the host admitted it, in epoch milliseconds; -Infinity before. */
  get admittedMillis() {
    return this.admittedAt
      ? DateTime.toEpochMillis(this.admittedAt)
      : -Infinity;
  }
}

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
  recovery: opt(Recovery),
  /** History before an explicit resume or takeover must not halt the resumed review. */
  resumedAt: opt(Time),
});

/** A new review's custody: the session that sealed it (the Liaison, unless named), this instance, and this process. */
export const started = (
  owner: Actor | undefined,
  host: string | undefined,
  pid: number
) =>
  Custody.make({
    host,
    owner: owner?.agent ?? Liaison.id,
    ownerSession: owner?.session ?? "",
    pid,
  });

/**
 * An explicit resume by `by`, in process `pid`: it continues a review the user had interrupted. From another session it
 * is a takeover, and the session it took over from is kept for full exports.
 */
export const resumedBy = (
  seal: Seal,
  by: Actor,
  pid: number,
  at: DateTime.Utc
) => {
  const resumed = seal.withCustody({
    halted: false,
    owner: by.agent,
    ownerSession: by.session,
    pid,
    resumedAt: at,
  });

  if (!seal.ownerSession || seal.ownerSession === by.session) {
    return resumed;
  }

  return resumed.withCustody({
    previousOwnerSessions: [
      ...new Set([...(seal.previousOwnerSessions ?? []), seal.ownerSession]),
    ],
  });
};

/** The user interrupted the Liaison: automatic recovery stays off until a resume or takeover. */
export const halted = (seal: Seal) => seal.withCustody({ halted: true });

/** Abandoned for a new review by its owner. */
export const abandoned = (seal: Seal) => seal.withCustody({ abandoned: true });

/** Process `pid` intends to wake the owner with `recovery`, saved before the wake is sent. */
export const waking = (seal: Seal, pid: number, recovery: Recovery) =>
  seal.withCustody({ pid, recovery });

/** The host admitted process `pid`'s wake at `at`. */
export const woken = (
  seal: Seal,
  pid: number,
  recovery: Recovery,
  at: DateTime.Utc
) => seal.withCustody({ pid, recovery: recovery.admittedAs(at) });
