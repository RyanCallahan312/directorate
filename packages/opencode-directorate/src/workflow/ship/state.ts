// Ship state, stored in OpenCode plugin storage under ship:<sessionID> as one object whose `status` field names its state:
// waiting for its queued input to be delivered, active, paused, or complete. It decodes into the tagged union of those
// states, and each change between them is a named transition that builds the next state through its class.
import { Match, Schema, SchemaGetter } from "effect";

import { Count, sortedFields } from "../../platform/stored.ts";

/** An automatic continuation's prompt, rendered in place of its inert marker once the host promotes the marker. */
const PlanSchema = Schema.Struct({
  checkpoint: Schema.optionalKey(Schema.String),
  id: Schema.String,
  origin: Schema.String,
  rendered: Schema.Boolean,
  text: Schema.String,
});

export type Plan = typeof PlanSchema.Type;

/** The ship's last input in the session's inbox: queued until the host delivers it. */
const InboxSchema = Schema.Struct({
  continuation: Schema.optionalKey(Schema.Boolean),
  deliveredAt: Schema.optionalKey(Schema.Finite),
  id: Schema.String,
});

/**
 * Every field a ship carries in every state. Ship records hold whatever any version wrote, so each state keeps each field
 * it was stored with: what the runner writes in each state is set by its transitions, and noted on each state below.
 */
const shipFields = {
  /** An automatic continuation whose admission was not confirmed: set only while waiting for it. */
  admitting: Schema.optionalKey(Schema.Boolean),
  /** Background subagents the settled turn left running, and when each was seen: their notices come before the next step. */
  awaiting: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
  boot: Schema.String,
  chain: Schema.Array(Schema.String),
  id: Schema.String,
  inbox: Schema.optionalKey(InboxSchema),
  lastHostFailure: Schema.optionalKey(Schema.String),
  location: Schema.optionalKey(Schema.String),
  needsAttachments: Schema.optionalKey(Schema.Boolean),
  /** Queued completion notices by inbox ID, and the subagent each is from. */
  notices: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  origin: Schema.optionalKey(Schema.String),
  /** The server process driving the loop: while it lives, no other process recovers this ship. */
  pid: Schema.optionalKey(Schema.Finite),
  plan: Schema.optionalKey(PlanSchema),
  reason: Schema.String,
  /** What a paused ship tells the user to do next, from the step policy. */
  recovery: Schema.optionalKey(Schema.String),
  request: Schema.String,
  reviewsAtResume: Count,
  rounds: Count,
  startedAt: Schema.Finite,
  /** The step the loop last took. Stored without the key when there is none. */
  step: Schema.optional(Schema.String),
  /** When an awaited subagent's notice was delivered: the turn it woke settles next. */
  wokeAt: Schema.optionalKey(Schema.Finite),
};

export const ShipFieldsSchema = Schema.Struct(shipFields);

export type ShipFields = typeof ShipFieldsSchema.Type;

/** Its next prompt is queued in the session's inbox (`inbox`), not yet delivered; an automatic one may still be `admitting`. */
export class Waiting extends Schema.TaggedClass<
  Waiting,
  { readonly brand: unique symbol }
>()("Waiting", shipFields) {}

/** Its prompt was delivered and its turn runs, or the turn settled and the loop waits on the subagents it is `awaiting`. */
export class Active extends Schema.TaggedClass<
  Active,
  { readonly brand: unique symbol }
>()("Active", shipFields) {}

/**
 * Stopped for `reason` until the user resumes it; `recovery` says what to do first. Pausing drops the turn in flight
 * (its plan, awaited subagents, notices, wake, and pending admission) but keeps a still-queued `inbox`.
 */
export class Paused extends Schema.TaggedClass<
  Paused,
  { readonly brand: unique symbol }
>()("Paused", shipFields) {}

/** The Directive is clean: the loop ended with nothing to fix. */
class Complete extends Schema.TaggedClass<
  Complete,
  { readonly brand: unique symbol }
>()("Complete", shipFields) {}

const ShipStateSchema = Schema.Union([Waiting, Active, Paused, Complete]).pipe(
  Schema.toTaggedUnion("_tag")
);

export type ShipState = typeof ShipStateSchema.Type;

/** A ship whose loop is still driving: an event may move it on. */
export const isRunning = ShipStateSchema.isAnyOf(["Waiting", "Active"]);

export const isWaiting = ShipStateSchema.isAnyOf(["Waiting"]);

export const isActive = ShipStateSchema.isAnyOf(["Active"]);

export const isPaused = ShipStateSchema.isAnyOf(["Paused"]);

export const isComplete = ShipStateSchema.isAnyOf(["Complete"]);

/** A ship's state, as plugin storage names it. */
const ShipStatusSchema = Schema.Literals([
  "waiting",
  "active",
  "paused",
  "complete",
]);

/** A ship as plugin storage holds it: its state is a `status` field, not a tag, and keys are in alphabetical order. */
const StoredShipState = Schema.Struct(
  sortedFields({ ...shipFields, status: ShipStatusSchema })
);

/** A ship's state as plugin storage and its status line name it. */
export const statusOf = (state: ShipState) =>
  ShipStateSchema.match(state, {
    Active: () => "active" as const,
    Complete: () => "complete" as const,
    Paused: () => "paused" as const,
    Waiting: () => "waiting" as const,
  });

const stateFor = (status: typeof ShipStatusSchema.Type) =>
  Match.value(status).pipe(
    Match.when("waiting", () => Waiting),
    Match.when("active", () => Active),
    Match.when("paused", () => Paused),
    Match.when("complete", () => Complete),
    Match.exhaustive
  );

/** The state class a ship is in. */
const classOf = (state: ShipState) =>
  ShipStateSchema.match(state, {
    Active: () => Active,
    Complete: () => Complete,
    Paused: () => Paused,
    Waiting: () => Waiting,
  });

/** A ship's fields without its state: what carries over when it changes state. */
export const fieldsOf = (ship: ShipFields) => ShipFieldsSchema.make(ship);

/** The ship as plugin storage holds it, every field it carries kept. */
export const toStored = (state: ShipState) =>
  StoredShipState.make({ ...fieldsOf(state), status: statusOf(state) });

/** A ship as plugin storage holds it, decoded into its state; unknown keys are dropped. */
export const ShipStateFromStored = StoredShipState.pipe(
  Schema.decodeTo(Schema.toType(ShipStateSchema), {
    decode: SchemaGetter.transform(
      (stored) => new (stateFor(stored.status))(fieldsOf(stored))
    ),
    encode: SchemaGetter.transform(toStored),
  })
);

// ---------- within a state ----------
/** The same state with exactly these fields. */
export const rebuilt = (state: ShipState, fields: ShipFields) =>
  new (classOf(state))(fields);

/** The same state with some fields changed. */
export const changed = (state: ShipState, change: Partial<ShipFields>) =>
  rebuilt(state, { ...fieldsOf(state), ...change });

/** What one turn leaves for the next, in the same state: nothing queued, planned, or awaited. */
export const settled = (state: ShipState) => {
  const {
    admitting: _admitting,
    awaiting: _awaiting,
    inbox: _inbox,
    lastHostFailure: _lastHostFailure,
    notices: _notices,
    plan: _plan,
    wokeAt: _wokeAt,
    ...rest
  } = fieldsOf(state);

  return rebuilt(state, rest);
};

// ---------- between states ----------
/** A ship stopped for `reason`, from any state: the turn in flight is dropped, a queued input is not. */
export const paused = (ship: ShipFields, reason: string) => {
  const {
    admitting: _admitting,
    awaiting: _awaiting,
    notices: _notices,
    plan: _plan,
    wokeAt: _wokeAt,
    ...rest
  } = fieldsOf(ship);

  return Paused.make({ ...rest, reason });
};

/** Its next prompt submitted to the session's inbox as `inbox`: what the last turn left is settled first. */
export const enqueued = (
  state: ShipState,
  inbox: typeof InboxSchema.Type,
  needsAttachments: boolean
) => Waiting.make({ ...fieldsOf(settled(state)), inbox, needsAttachments });

/** The host delivered input `id` at `at`, which is now the ship's origin: a waiting ship is active again. */
export const delivered = (state: ShipState, id: string, at: number) => {
  const { lastHostFailure: _lastHostFailure, ...rest } = fieldsOf(state);

  const fields = {
    ...rest,
    inbox: InboxSchema.make({ deliveredAt: at, id }),
    needsAttachments: false,
    origin: id,
  };

  return isWaiting(state) ? Active.make(fields) : rebuilt(state, fields);
};

/** A paused ship resumed by this process: a new run, with no step taken and its review allowance counted from now. */
export const resumed = (
  ship: Paused,
  run: { boot: string; location: string; pid: number }
) => {
  const { recovery: _recovery, ...rest } = fieldsOf(ship);

  return Active.make({
    ...rest,
    ...run,
    needsAttachments: false,
    reviewsAtResume: ship.chain.length,
    rounds: 0,
    step: undefined,
  });
};

/** The step policy chose `step` for `reason`: one more round, active until its prompt is submitted. */
export const proceeding = (ship: ShipFields, reason: string, step: string) =>
  Active.make({ ...fieldsOf(ship), reason, rounds: ship.rounds + 1, step });

/** The step policy stopped the loop for `reason`; `recovery` tells the user what to do. Nothing else is dropped. */
export const stopped = (ship: ShipFields, reason: string, recovery: string) =>
  Paused.make({ ...fieldsOf(ship), reason, recovery, step: undefined });

/** The step policy found the Directive clean. */
export const completed = (ship: ShipFields, reason: string) =>
  Complete.make({ ...fieldsOf(ship), reason, step: undefined });
