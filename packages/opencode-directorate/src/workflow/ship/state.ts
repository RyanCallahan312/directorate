// Ship state, stored in OpenCode plugin storage under ship:<sessionID> as one object whose `status` field names its state:
// waiting for its queued input to be delivered, active, paused, or complete. It decodes into the tagged union of those
// states, and each change between them is a named transition that builds the next state through its class.
import { Effect, Match, Option, Schema, SchemaGetter } from "effect";

import { MessageIdSchema, SessionIdSchema } from "../../platform/host-id.ts";
import type { MessageId, SessionId } from "../../platform/host-id.ts";
import { Count, invalid, sortedFields } from "../../platform/stored.ts";
import { asSealId, SealIdSchema } from "../../seal/seal-id.ts";
import type { SealId } from "../../seal/seal-id.ts";
import { ShipIdSchema } from "../review/ship-link.ts";

// ---------- the step the loop last took ----------
/** The initial review, before any seal. */
export class ReviewStep extends Schema.TaggedClass<
  ReviewStep,
  { readonly brand: unique symbol }
>()("Review", {}) {}

/** The re-check that finishes an incomplete review. */
export class FinishStep extends Schema.TaggedClass<
  FinishStep,
  { readonly brand: unique symbol }
>()("Finish", {}) {}

/** Asking the Liaison to finish and report `seal`. */
export class ResumeStep extends Schema.TaggedClass<
  ResumeStep,
  { readonly brand: unique symbol }
>()("Resume", { seal: SealIdSchema }) {}

/** Fixing the confirmed findings of `seal`. */
export class FixStep extends Schema.TaggedClass<
  FixStep,
  { readonly brand: unique symbol }
>()("Fix", { seal: SealIdSchema }) {}

/** Re-checking `seal` against the target at `fingerprint`. */
export class RecheckStep extends Schema.TaggedClass<
  RecheckStep,
  { readonly brand: unique symbol }
>()("Recheck", { fingerprint: Schema.String, seal: SealIdSchema }) {}

export const StepSchema = Schema.Union([
  ReviewStep,
  FinishStep,
  ResumeStep,
  FixStep,
  RecheckStep,
]).pipe(Schema.toTaggedUnion("_tag"));

export type Step = typeof StepSchema.Type;

/** A step as plugin storage spells it: `review`, `finish`, `resume:<seal>`, `fix:<seal>`, `recheck:<seal>:<fingerprint>`. */
const STEP_TEXT =
  /^(?:(?<review>review)|(?<finish>finish)|resume:(?<resume>.*)|fix:(?<fix>.*)|recheck:(?<recheck>[^:]*):(?<fingerprint>.*))$/su;

/** The step `text` spells, or none when it spells no step (including one whose seal is not a seal id). */
const stepOf = (text: string) => {
  const groups = STEP_TEXT.exec(text)?.groups ?? {};
  const { review, finish, resume, fix, recheck, fingerprint } = groups;

  if (review !== undefined) {
    return Option.some(ReviewStep.make({}));
  }

  if (finish !== undefined) {
    return Option.some(FinishStep.make({}));
  }

  if (resume !== undefined) {
    return Option.map(asSealId(resume), (seal) => ResumeStep.make({ seal }));
  }

  if (fix !== undefined) {
    return Option.map(asSealId(fix), (seal) => FixStep.make({ seal }));
  }

  return recheck !== undefined && fingerprint !== undefined
    ? Option.map(asSealId(recheck), (seal) =>
        RecheckStep.make({ fingerprint, seal })
      )
    : Option.none();
};

const textOf = (step: Step) =>
  StepSchema.match(step, {
    Finish: () => "finish",
    Fix: ({ seal }) => `fix:${seal}`,
    Recheck: ({ fingerprint, seal }) => `recheck:${seal}:${fingerprint}`,
    Resume: ({ seal }) => `resume:${seal}`,
    Review: () => "review",
  });

/** A step as plugin storage holds it: one string, decoded into its form; a string no form reads fails to decode. */
export const StepFromStored = Schema.String.pipe(
  Schema.decodeTo(Schema.toType(StepSchema), {
    decode: SchemaGetter.transformEffect<Step, string>((text, options) => {
      const step = Option.getOrUndefined<Step>(stepOf(text));

      return step
        ? Effect.succeed(step)
        : invalid(text, options, "not a ship step");
    }),
    encode: SchemaGetter.transform(textOf),
  })
);

const isReview = StepSchema.isAnyOf(["Review"]);

const isFinish = StepSchema.isAnyOf(["Finish"]);

const isRecheck = StepSchema.isAnyOf(["Recheck"]);

/** Whether `step` is the initial review. */
export const isReviewStep = (step: Step | undefined) =>
  step !== undefined && isReview(step);

/** Whether `step` is the re-check that finishes an incomplete review. */
export const isFinishStep = (step: Step | undefined) =>
  step !== undefined && isFinish(step);

/** Whether `step` re-checks seal `seal`, at any fingerprint. */
export const rechecks = (step: Step | undefined, seal: SealId) =>
  step !== undefined && isRecheck(step) && step.seal === seal;

/** An automatic continuation's prompt, rendered in place of its inert marker once the host promotes the marker. */
const PlanSchema = Schema.Struct({
  checkpoint: Schema.optionalKey(MessageIdSchema),
  id: MessageIdSchema,
  origin: MessageIdSchema,
  rendered: Schema.Boolean,
  text: Schema.String,
});

export type Plan = typeof PlanSchema.Type;

/** The ship's last input in the session's inbox: queued until the host delivers it. */
const InboxSchema = Schema.Struct({
  continuation: Schema.optionalKey(Schema.Boolean),
  deliveredAt: Schema.optionalKey(Schema.Finite),
  id: MessageIdSchema,
});

/**
 * Every field a ship carries in every state, so a stored ship round-trips whatever state it is in: what the runner writes
 * in each state is set by its transitions, and noted on each state below.
 */
const shipFields = {
  /** An automatic continuation whose admission was not confirmed: set only while waiting for it. */
  admitting: Schema.optionalKey(Schema.Boolean),
  /** Background subagents the settled turn left running, and when each was seen: their notices come before the next step. */
  awaiting: Schema.optionalKey(Schema.Record(SessionIdSchema, Schema.Finite)),
  boot: Schema.String,
  chain: Schema.Array(SealIdSchema),
  id: ShipIdSchema,
  inbox: Schema.optionalKey(InboxSchema),
  lastHostFailure: Schema.optionalKey(Schema.String),
  location: Schema.String,
  needsAttachments: Schema.optionalKey(Schema.Boolean),
  /** Queued completion notices by inbox ID, and the subagent each is from. */
  notices: Schema.optionalKey(Schema.Record(MessageIdSchema, SessionIdSchema)),
  origin: Schema.optionalKey(MessageIdSchema),
  /** The server process driving the loop: while it lives, no other process recovers this ship. */
  pid: Schema.Finite,
  plan: Schema.optionalKey(PlanSchema),
  reason: Schema.String,
  /** What a paused ship tells the user to do next, from the step policy. */
  recovery: Schema.optionalKey(Schema.String),
  request: Schema.String,
  reviewsAtResume: Count,
  rounds: Count,
  startedAt: Schema.Finite,
  /** The step the loop last took. Stored without the key when there is none. */
  step: Schema.optional(StepFromStored),
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
const fieldsOf = (ship: ShipFields) => ShipFieldsSchema.make(ship);

/** A ship as plugin storage holds it, decoded into its state; unknown keys are dropped. */
export const ShipStateFromStored = StoredShipState.pipe(
  Schema.decodeTo(Schema.toType(ShipStateSchema), {
    decode: SchemaGetter.transform(
      (stored) => new (stateFor(stored.status))(fieldsOf(stored))
    ),
    encode: SchemaGetter.transform((state) =>
      StoredShipState.make({ ...fieldsOf(state), status: statusOf(state) })
    ),
  })
);

const encodeStored = Schema.encodeSync(ShipStateFromStored);

/** The ship as the runner writes it to plugin storage, every field it carries kept; with no step, without the key. */
export const toStored = (state: ShipState) => {
  const { step, ...rest } = encodeStored(state);

  return step === undefined ? rest : { ...rest, step };
};

// ---------- within a state ----------
/** The same state with exactly these fields. */
const rebuilt = (state: ShipState, fields: ShipFields) =>
  new (classOf(state))(fields);

/** The new seal `seal` joined the ship's chain: the review it was sealed for is the ship's. */
export const attached = (state: ShipState, seal: SealId) =>
  rebuilt(state, { ...fieldsOf(state), chain: [...state.chain, seal] });

/** The chain as observed now; a manual command counts its review allowance from here. */
export const observed = (
  state: ShipState,
  chain: readonly SealId[],
  manual: boolean
) =>
  rebuilt(state, {
    ...fieldsOf(state),
    chain,
    reviewsAtResume: manual ? chain.length : state.reviewsAtResume,
  });

/** The ship as it stood before the round that made its plan: one round back, with no step taken. */
export const rewound = (state: ShipState) =>
  rebuilt(state, {
    ...fieldsOf(state),
    rounds: Math.max(0, state.rounds - 1),
    step: undefined,
  });

/** Its queued automatic continuation will be rendered as `plan` once the host promotes its marker. */
export const planned = (state: ShipState, plan: Plan) =>
  rebuilt(state, { ...fieldsOf(state), plan });

/** The plan's prompt was rendered in place of its marker. */
export const planRendered = (state: ShipState) =>
  state.plan
    ? rebuilt(state, {
        ...fieldsOf(state),
        plan: { ...state.plan, rendered: true },
      })
    : state;

/** An automatic continuation is about to be submitted: until its admission is confirmed, it is `admitting`. */
export const admitting = (state: ShipState) =>
  rebuilt(state, { ...fieldsOf(state), admitting: true });

/** The server process `pid`, in plugin instance `boot`, claimed the ship's run. */
export const claimed = (state: ShipState, boot: string, pid: number) =>
  rebuilt(state, { ...fieldsOf(state), boot, pid });

/** The session's history holds the ship's exact input `origin`, so its attachments were delivered with it. */
export const traced = (state: ShipState, origin: MessageId) =>
  rebuilt(state, { ...fieldsOf(state), needsAttachments: false, origin });

/** Background subagents seen running, each with when it was seen: the ship awaits their notices too. */
export const awaited = (
  state: ShipState,
  seen: Readonly<Record<SessionId, number>>
) =>
  rebuilt(state, {
    ...fieldsOf(state),
    awaiting: { ...state.awaiting, ...seen },
  });

/** Subagent `child`'s completion notice was queued as inbox item `id`. */
export const noticeQueued = (
  state: ShipState,
  id: MessageId,
  child: SessionId
) =>
  rebuilt(state, {
    ...fieldsOf(state),
    notices: { ...state.notices, [id]: child },
  });

/** Subagent `child`'s notice, inbox item `id`, was delivered at `at`: no longer awaited, it woke the session. */
export const woken = (
  state: ShipState,
  id: MessageId,
  child: SessionId,
  at: number
) => {
  const { [id]: _notice, ...notices } = state.notices ?? {};
  const { [child]: _seen, ...awaiting } = state.awaiting ?? {};

  return rebuilt(state, { ...fieldsOf(state), awaiting, notices, wokeAt: at });
};

/** The host reported `reason` while the ship's input was queued; it is not attributed to that input. */
export const hostFailed = (state: ShipState, reason: string) =>
  rebuilt(state, { ...fieldsOf(state), lastHostFailure: reason });

/** An automatic continuation's admission resolved, whichever way: it is no longer `admitting`. */
export const admitted = (state: ShipState) => {
  const { admitting: _admitting, ...rest } = fieldsOf(state);

  return rebuilt(state, rest);
};

/** A plan made before a reload or restart that no longer matches the tree, or was never rendered: dropped, and its step forgotten. */
export const unplanned = (state: ShipState) => {
  const { plan: _plan, ...rest } = fieldsOf(state);

  return rebuilt(state, { ...rest, step: undefined });
};

/** The input's turn succeeded and is used up: its inbox entry, plan, and wake are dropped; awaited subagents stay. */
export const consumed = (state: ShipState) => {
  const {
    inbox: _inbox,
    plan: _plan,
    wokeAt: _wokeAt,
    ...rest
  } = fieldsOf(state);

  return rebuilt(state, rest);
};

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

/**
 * The ship's input is no longer queued (cancelled, refused by the host, or promoted under a checkpoint that hides its
 * plan), so it stops for `reason`. The host outcome seen while it was queued goes with it, as delivery drops it too.
 */
export const unqueued = (ship: ShipFields, reason: string) => {
  const {
    inbox: _inbox,
    lastHostFailure: _lastHostFailure,
    ...rest
  } = fieldsOf(ship);

  return paused(rest, reason);
};

/** Its next prompt submitted to the session's inbox as `inbox`: what the last turn left is settled first. */
export const enqueued = (
  state: ShipState,
  inbox: typeof InboxSchema.Type,
  needsAttachments: boolean
) => Waiting.make({ ...fieldsOf(settled(state)), inbox, needsAttachments });

/** The host delivered input `id` at `at`, which is now the ship's origin: a waiting ship is active again. */
export const delivered = (state: ShipState, id: MessageId, at: number) => {
  const { lastHostFailure: _lastHostFailure, ...rest } = fieldsOf(state);

  const fields = {
    ...rest,
    inbox: InboxSchema.make({ deliveredAt: at, id }),
    needsAttachments: false,
    origin: id,
  };

  return isWaiting(state) ? Active.make(fields) : rebuilt(state, fields);
};

/** What drives a ship's run: the plugin instance's boot, its OpenCode location, and the server process. */
const RunSchema = Schema.Struct({
  boot: Schema.String,
  location: Schema.String,
  pid: Schema.Finite,
});

/** What a new ship starts from: its run, its id and request, when it started, and its first step. */
const StartSchema = Schema.Struct({
  ...RunSchema.fields,
  id: ShipIdSchema,
  request: Schema.String,
  startedAt: Schema.Finite,
  step: StepSchema,
});

/** A new ship, active until its first prompt is submitted: no seals yet, and no rounds or reviews counted. */
export const started = (start: typeof StartSchema.Type) =>
  Active.make({
    ...start,
    chain: [],
    reason: "Waiting for the initial Directorate review.",
    reviewsAtResume: 0,
    rounds: 0,
  });

/** A paused ship resumed by this process: a new run, with no step taken and its review allowance counted from now. */
export const resumed = (ship: Paused, run: typeof RunSchema.Type) => {
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
export const proceeding = (ship: ShipFields, reason: string, step: Step) =>
  Active.make({ ...fieldsOf(ship), reason, rounds: ship.rounds + 1, step });

/** The step policy stopped the loop for `reason`; `recovery` tells the user what to do. Nothing else is dropped. */
export const stopped = (ship: ShipFields, reason: string, recovery: string) =>
  Paused.make({ ...fieldsOf(ship), reason, recovery, step: undefined });

/** The step policy found the Directive clean. */
export const completed = (ship: ShipFields, reason: string) =>
  Complete.make({ ...fieldsOf(ship), reason, step: undefined });
