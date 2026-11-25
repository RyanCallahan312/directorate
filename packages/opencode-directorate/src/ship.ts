// Ship owns the persisted loop; the next action is decided from the review dossier, never the model's reply.
import type { CommandInvocation } from "@opencode/plugin/effect/command";
import type {
  SessionContext,
  SessionIdle,
} from "@opencode/plugin/effect/session";
import { Session } from "@opencode/schema/session";
import type { SessionInbox } from "@opencode/schema/session-inbox";
import { SessionMessage } from "@opencode/schema/session-message";
import {
  Cause,
  Clock,
  Crypto,
  Effect,
  Function,
  Option,
  Predicate,
  Result,
  Schema,
  Semaphore,
} from "effect";

import { failure, recover } from "./error.ts";
import { Git } from "./git.ts";
import { Host } from "./host.ts";
import { REVIEWER, ROLE_SET } from "./model.ts";
import type { ReviewScope, Seal } from "./model.ts";
import type { Platform } from "./platform.ts";
import { ProcessIdentity } from "./process-identity.ts";
import {
  activity,
  createdAt,
  foreign,
  locationKey,
  turns,
} from "./recovery.ts";
import type { Activity } from "./recovery.ts";
import { parseRequest, reviewRequest } from "./request.ts";
import { decideShip, shipKickoff } from "./ship-step.ts";
import { Store } from "./store.ts";
import { currentFingerprint } from "./target.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** How long a finished subagent's completion notice may stay undelivered before recovery stops waiting for it. */
const NOTICE_GRACE_MS = 30_000;

const Plan = Schema.Struct({
  checkpoint: Schema.optionalKey(Schema.String),
  id: Schema.String,
  origin: Schema.String,
  rendered: Schema.Boolean,
  text: Schema.String,
});

const ShipStateSchema = Schema.Struct({
  /** An automatic continuation whose admission was not confirmed; recovery submits it again under the same ID. */
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

type ShipState = typeof ShipStateSchema.Type;

type SessionID = Session.ID;

type InboxKind = "user" | "other" | { readonly child: string };

/** What an input is to Ship, by its type and metadata, whether still queued or already a message. */
const kindOf = (
  type: string,
  metadata: SessionMessage.Info["metadata"]
): InboxKind => {
  if (type === "user" && metadata?.source !== "directorate-ship") {
    return "user";
  }

  if (
    type === "synthetic" &&
    metadata?.source === "subagent" &&
    Predicate.isString(metadata.childID)
  ) {
    return { child: metadata.childID };
  }

  return "other";
};

const inboxKind = (item: SessionInbox.Item): InboxKind =>
  item.type === "user" || item.type === "synthetic"
    ? kindOf(item.type, item.payload.metadata)
    : "other";

const asSessionID = Schema.decodeUnknownOption(Session.ID);
const decode = Schema.decodeUnknownEffect(ShipStateSchema);
const decodeSnapshot = Schema.decodeUnknownOption(ShipStateSchema);
const prefix = "ship:";
const storageKey = (id: string) => `${prefix}${id}`;

const running = (state: ShipState) =>
  state.status === "active" || state.status === "waiting";

const restartAttached =
  "Start a new /directorate-ship with the request and attachments; their delivery could not be confirmed.";

const queued = (state: ShipState) =>
  state.inbox?.deliveredAt === undefined ? state.inbox?.id : undefined;

const reached = (at: number, boundary: number | undefined) =>
  boundary !== undefined && at >= boundary;

const cancelFirst = (id: string) =>
  `Cancel the exact queued ship input ${id} in OpenCode or let it be delivered. If OpenCode confirms it is no longer queued and Ship missed the event, run /directorate-ship forget ${id}. Forget only discards automation; it does not cancel input.`;

const hasAttachments = ({
  files,
  agents,
  skills,
}: CommandInvocation["prompt"]) =>
  Boolean(files?.length || agents?.length || skills?.length);

const causeMessage = (cause: Cause.Cause<unknown>) =>
  Cause.prettyErrors(cause)[0]?.message ?? Cause.pretty(cause);

// Plugin instances share the host's storage. A lock lasts until its last waiter leaves, even on cancellation.
const guards = new Map<
  string,
  { permit: Semaphore.Semaphore; users: number }
>();

const guarded = <A, E, R>(id: string, body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const entry = guards.get(id) ?? {
        permit: Semaphore.makeUnsafe(1),
        users: 0,
      };

      entry.users += 1;
      guards.set(id, entry);

      return entry;
    }),
    ({ permit }) => permit.withPermit(body),
    (entry) =>
      Effect.sync(() => {
        entry.users -= 1;

        if (entry.users === 0) {
          guards.delete(id);
        }
      })
  );

const metadata = (id: string) => ({ shipID: id, source: "directorate-ship" });

const handoff =
  "An ordinary user prompt was delivered. Ship yielded control; use /directorate-ship resume when ready.";

const noProvenance =
  "Could not verify the continuation's originating Ship input. Use /directorate-ship resume when ready.";

const compacted =
  "OpenCode installed a checkpoint that hides the continuation's context. Ship paused without sending further instructions. Use /directorate-ship resume to reassess from the saved Directive.";

const checkpointID = (messages: readonly SessionMessage.Info[]) =>
  messages.findLast(
    (message) => message.type === "compaction" && message.status === "completed"
  )?.id;

const superseded = (
  messages: readonly SessionMessage.Info[],
  ship: string,
  origin?: string,
  markerID?: string
) => {
  const start = messages.findIndex(
    (message) =>
      message.id === origin &&
      message.metadata?.source === "directorate-ship" &&
      message.metadata.shipID === ship
  );

  if (start === -1) {
    return noProvenance;
  }

  const newer = messages.slice(start + 1);

  if (
    newer.some(
      (message) =>
        message.type === "user" &&
        message.metadata?.source !== "directorate-ship"
    )
  ) {
    return handoff;
  }

  return markerID &&
    !newer.some(
      (message) => message.id === markerID && message.type === "synthetic"
    )
    ? noProvenance
    : undefined;
};

const checkpointHidesPlan = (
  messages: readonly SessionMessage.Info[],
  plan: typeof Plan.Type
) => {
  const checkpoint = checkpointID(messages);

  return (
    checkpoint !== undefined &&
    checkpoint !== plan.checkpoint &&
    (!messages.some((message) => message.id === plan.id) ||
      !messages.some((message) => message.id === plan.origin))
  );
};

const describe = (state: ShipState) => {
  const pending = queued(state);

  return [
    `Directorate ship ${state.status}${pending ? " (queued input can still execute)" : ""}.`,
    `Request: ${state.request.trim() || "(configured defaults)"}`,
    `Rounds this run: ${state.rounds}`,
    `Seals: ${state.chain.join(" → ") || "none"}`,
    `Reason: ${state.reason}`,
    state.lastHostFailure &&
      `Latest host outcome before delivery (not attributed to this ship): ${state.lastHostFailure}`,
    pending && cancelFirst(pending),
    !pending &&
      state.status === "paused" &&
      (state.needsAttachments
        ? restartAttached
        : (state.recovery ??
          "Resolve the blocker, then use /directorate-ship resume, or use /directorate-ship stop to clear it.")),
  ]
    .filter(Boolean)
    .join("\n");
};

const assertAgent = (agent: string | undefined) =>
  agent && ROLE_SET.has(agent)
    ? failure(
        "Use /directorate-ship from the calling session, not from a Directorate agent."
      )
    : Effect.void;

const MARKER =
  "Directorate Ship continuation marker. It does not request any action on its own.";

const relocated =
  "The session moved to another OpenCode location. Start a new ship there.";

/** Why recovery stops for a subagent the next step depends on. */
const BLOCKED = {
  interrupted: "The Liaison was interrupted before reporting.",
  missing:
    "The review's Liaison session is no longer available. Resuming dispatches a replacement, which may restart part of the review's time budget.",
  unnoticed:
    "A waiting subagent finished, but its completion message was not delivered.",
};

/** What one turn leaves for the next: nothing queued, planned, or awaited. */
const settle = ({
  admitting: _admitting,
  awaiting: _awaiting,
  inbox: _inbox,
  lastHostFailure: _lastHostFailure,
  notices: _notices,
  plan: _plan,
  wokeAt: _wokeAt,
  ...settled
}: ShipState) => settled;

const turnFailure = (turn: SessionMessage.Idle) =>
  turn.outcome === "failed"
    ? `The session failed${turn.error ? `: ${turn.error.message}` : ""}.`
    : "The session was interrupted.";

/**
 * What the session's history proves about the ship's last input: nothing yet (undefined), that it cannot be traced, or
 * the messages since it with any reason they give to stop.
 */
const proven = (
  state: ShipState,
  messages: readonly SessionMessage.Info[],
  failed: string | undefined
):
  | { readonly lost: string }
  | {
      readonly after: readonly SessionMessage.Info[];
      readonly origin: string;
      readonly reason: string | undefined;
    }
  | undefined => {
  const { inbox, plan } = state;
  const id = inbox?.id ?? state.origin;

  const input = messages.find(
    (message) =>
      message.id === id &&
      (message.type === "user" || message.type === "synthetic")
  );

  if (!input) {
    // Missing delivery evidence is not evidence that an inbox item was cancelled; a known delivery was compacted away.
    return inbox && inbox.deliveredAt === undefined
      ? undefined
      : { lost: checkpointID(messages) ? compacted : noProvenance };
  }

  const after = messages.slice(messages.indexOf(input) + 1);
  const ended = turns(after);

  // The host's times say idle, yet no turn has settled since the input: do not guess.
  if (!ended.length) {
    return;
  }

  // Every turn since the input, not only the last: a later success must not hide an interruption.
  const turn = ended.find(({ outcome }) => outcome !== "succeeded");

  const reason =
    plan && checkpointHidesPlan(messages, plan)
      ? compacted
      : superseded(messages, state.id, plan?.origin ?? input.id, plan?.id);

  return {
    after,
    origin: input.id,
    reason: reason ?? (turn && (failed ?? turnFailure(turn))),
  };
};

/** Why a subagent holds the next step back, if it does. An orphaned one neither runs nor sends a notice. */
const held = (
  act: Activity,
  input: { interrupted: boolean; now: number; unnoticed: boolean }
) => {
  if (act.state === "running") {
    return "busy" as const;
  }

  if (act.state !== "idle") {
    return;
  }

  // The notice follows the subagent's settling; give the host a moment to deliver it.
  if (input.unnoticed) {
    return input.now - act.at <= NOTICE_GRACE_MS
      ? ("busy" as const)
      : ("unnoticed" as const);
  }

  return input.interrupted ? ("interrupted" as const) : undefined;
};

/** The same for a subagent whose session no longer exists: a Liaison cannot report, and no notice will come. */
const gone = (owner: boolean, unnoticed: boolean) => {
  if (owner) {
    return "missing" as const;
  }

  return unnoticed ? ("unnoticed" as const) : undefined;
};

/** The awaited subagent whose completion notice this message is, if it arrived after the subagent was seen running. */
const noticed = (
  message: SessionMessage.Info,
  awaiting: Readonly<Record<string, number>>
) => {
  const kind = kindOf(message.type, message.metadata);

  return Predicate.isObject(kind) &&
    createdAt(message) >= (awaiting[kind.child] ?? Infinity)
    ? kind.child
    : undefined;
};

export const registerShip = Effect.fn("Ship.register")(
  function* registerShip() {
    const host = yield* Host;
    const git = yield* Git;
    const store = yield* Store;
    const services = yield* Effect.context<Platform>();
    const crypto = yield* Crypto.Crypto;
    const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);
    const boot = yield* Effect.cached(uuid);
    const { pid } = yield* ProcessIdentity;

    // What each queued input is, by inbox ID, until it settles. A reload forgets these; the message itself is read then.
    const kinds = new Map<string, InboxKind>();

    const location = locationKey(host.location);

    const write = (sessionID: string, { step, ...state }: ShipState) =>
      host.storage.set(
        storageKey(sessionID),
        step === undefined ? state : { ...state, step }
      );

    const pause = Effect.fnUntraced(function* pause(
      sessionID: SessionID,
      state: ShipState,
      reason: string
    ) {
      const {
        admitting: _admitting,
        awaiting: _awaiting,
        notices: _notices,
        plan: _plan,
        wokeAt: _wokeAt,
        ...rest
      } = state;

      const paused: ShipState = { ...rest, reason, status: "paused" };
      yield* write(sessionID, paused);

      return paused;
    });

    const read = Effect.fn("Ship.read")(function* read(
      sessionID: SessionID,
      command = false
    ) {
      const raw = yield* host.storage.get(storageKey(sessionID));

      if (raw === undefined) {
        return;
      }

      const state = yield* decode(raw);

      // The host shares storage and events across locations.
      if (
        state.location !== location &&
        (!command || state.location !== undefined)
      ) {
        return command ? state : undefined;
      }

      return state;
    });

    const checkWorktree = Effect.fnUntraced(function* checkWorktree(
      sessionID: SessionID,
      seal: Seal
    ) {
      const parent = yield* host.session.get({ sessionID });
      yield* assertAgent(parent.agent);

      if ((yield* git.root(parent.location.directory)) !== seal.repo) {
        return yield* failure(
          `Seal ${seal.id} is for a different Git worktree than this session.`
        );
      }
    });

    /** Bind at creation. The kickoff's ship id distinguishes its review from other children of the same parent. */
    const sealed = Effect.fn("Ship.sealed")(function* sealed(
      seal: Seal,
      shipID?: string,
      scope?: ReviewScope
    ) {
      if (seal.owner !== REVIEWER || (!shipID && !seal.recheckOf)) {
        return;
      }

      const { parentID } = yield* host.session.get({
        sessionID: Session.ID.make(seal.ownerSession),
      });

      if (!parentID) {
        return;
      }

      yield* guarded(
        parentID,
        Effect.gen(function* attach() {
          const state = yield* read(parentID);

          if (!state || state.status === "complete") {
            return;
          }

          const tip = state.chain.at(-1);

          if (shipID) {
            if (shipID !== state.id || tip || state.step !== "review") {
              return;
            }

            const request = parseRequest(state.request);

            if (
              Result.isFailure(request) ||
              (request.success.scope && scope !== request.success.scope)
            ) {
              yield* pause(
                parentID,
                state,
                "The initial ship seal did not use its requested --scope."
              );

              return;
            }
          } else if (
            !tip ||
            seal.recheckOf !== tip ||
            !(
              state.step === "finish" ||
              state.step?.startsWith(`recheck:${tip}:`)
            )
          ) {
            return;
          }

          // The seal names its ship first, so the review stays the ship's even once this record is stopped or replaced.
          yield* store.withLock(
            seal.id,
            Effect.gen(function* own() {
              yield* store.save({
                ...(yield* store.load(seal.id)),
                ship: state.id,
              });
            })
          );
          yield* write(parentID, {
            ...state,
            chain: [...state.chain, seal.id],
          });
        })
      );
    }, recover("could not associate seal with ship"));

    const observeChain = Effect.fn("Ship.observeChain")(function* observeChain(
      sessionID: SessionID,
      state: ShipState
    ) {
      const tip = state.chain.at(-1);
      const seal = tip ? yield* store.load(tip) : undefined;

      if (seal) {
        yield* checkWorktree(sessionID, seal);
      }

      return { chain: state.chain, seal };
    });

    const observeReview = Effect.fn("Ship.observeReview")(
      function* observeReview(seal: Seal) {
        const ledger = yield* store.loadLedger(seal.id, { required: true });
        const { fingerprint, unfetched } = yield* currentFingerprint(seal);

        if (unfetched) {
          return yield* failure(unfetched);
        }

        return { fingerprint, ledger };
      },
      Effect.provideContext(services)
    );

    const history = (sessionID: SessionID) =>
      host.session.context({ sessionID }).pipe(Effect.orElseSucceed(() => []));

    // OpenCode promotes input before assembling each request. Never put actionable instructions in the inbox itself.
    const marker = (sessionID: SessionID, state: ShipState, id: string) =>
      host.session.synthetic({
        description: `Directorate ship: ${state.reason}`,
        id: SessionMessage.ID.make(id),
        metadata: metadata(state.id),
        sessionID,
        text: MARKER,
      });

    /** Persists `intent`, sends, then persists `submitted`. A failed send pauses the ship. */
    const commit = <E>(
      sessionID: SessionID,
      intent: ShipState,
      submitted: ShipState,
      send: Effect.Effect<unknown, E>
    ) =>
      write(sessionID, intent).pipe(
        Effect.andThen(send),
        Effect.andThen(write(sessionID, submitted)),
        Effect.onError((cause) => {
          // Typed admission failures precede host enqueue. A defect or interruption may have left an item queued.
          const { inbox: _inbox, ...rejected } = submitted;

          const retained =
            Cause.hasDies(cause) || Cause.hasInterrupts(cause)
              ? submitted
              : rejected;

          return pause(
            sessionID,
            retained,
            `Could not send the ship prompt: ${causeMessage(cause)}`
          ).pipe(recover("could not persist ship pause after prompt failure"));
        })
      );

    const admit = Effect.fn("Ship.admit")(function* admit(
      sessionID: SessionID,
      state: ShipState,
      text: string,
      input?: CommandInvocation
    ) {
      const { origin } = state;
      const messages = input ? [] : yield* history(sessionID);

      if (!input) {
        const reason = superseded(messages, state.id, origin);

        if (reason) {
          yield* pause(sessionID, state, reason);

          return;
        }
      }

      const id = SessionMessage.ID.create();
      const checkpoint = checkpointID(messages);

      let submitted: ShipState = {
        ...settle(state),
        inbox: { continuation: input === undefined, id },
        needsAttachments: input ? hasAttachments(input.prompt) : false,
        status: "waiting",
      };

      if (!input && origin) {
        const plan = { id, origin, rendered: false, text };
        submitted = {
          ...submitted,
          plan: checkpoint ? { ...plan, checkpoint } : plan,
        };
      }

      if (!input) {
        // A reload must not interrupt automatic admission between enqueue and its checkpoint; a crash there leaves the
        // intent, not a pause, for recovery to submit again.
        return yield* commit(
          sessionID,
          { ...submitted, admitting: true },
          submitted,
          marker(sessionID, state, id)
        ).pipe(Effect.uninterruptible);
      }

      // The user is here to retry: do not leave an active loop behind if admission or its final storage write fails.
      yield* commit(
        sessionID,
        {
          ...submitted,
          reason: "Could not send the ship prompt.",
          status: "paused",
        },
        submitted,
        host.session.prompt({
          ...input.prompt,
          delivery: input.delivery,
          id,
          metadata: metadata(state.id),
          sessionID,
          text,
        })
      );
    });

    /** The next step for this state, from the seal and the tree as they are now. */
    const decide = Effect.fnUntraced(function* decide(
      sessionID: SessionID,
      state: ShipState,
      manual = false
    ) {
      const observed = yield* observeChain(sessionID, state).pipe(
        Effect.map(({ chain, seal }) => ({ chain, error: undefined, seal })),
        Effect.catch((error) =>
          Effect.succeed({
            chain: state.chain,
            error: causeMessage(Cause.fail(error)),
            seal: undefined,
          })
        )
      );

      const { chain, seal } = observed;

      const current = {
        ...state,
        chain,
        reviewsAtResume: manual ? chain.length : state.reviewsAtResume,
      };

      const review = seal?.reportedAt
        ? yield* observeReview(seal).pipe(
            Effect.catch((error) =>
              Effect.succeed({ error: causeMessage(Cause.fail(error)) })
            )
          )
        : {};

      const decision = decideShip(current, {
        error: observed.error,
        ...review,
        reviews: chain.length,
        seal,
      });

      return { current, decision };
    });

    const advance = Effect.fn("Ship.advance")(function* advance(
      sessionID: SessionID,
      state: ShipState,
      input?: CommandInvocation
    ) {
      if (
        locationKey((yield* host.session.get({ sessionID })).location) !==
        location
      ) {
        yield* pause(sessionID, state, relocated);

        return;
      }

      const { current, decision } = yield* decide(
        sessionID,
        state,
        input !== undefined
      );

      const next = {
        ...current,
        reason: decision.reason,
        rounds: current.rounds + (decision.status === "active" ? 1 : 0),
        status: decision.status,
        step: decision.step,
      };

      if (decision.status === "active") {
        return yield* admit(sessionID, next, decision.text, input);
      }

      const ended =
        decision.status === "paused"
          ? { ...next, recovery: decision.text }
          : next;

      yield* write(sessionID, ended);

      if (input) {
        return yield* failure(`${describe(ended)}\nNo continuation was sent.`);
      }
    });

    /** Whether the step this plan was made for is still the step the seal and tree call for. */
    const stillPlanned = Effect.fnUntraced(function* stillPlanned(
      sessionID: SessionID,
      state: ShipState,
      plan: typeof Plan.Type
    ) {
      const { decision } = yield* decide(sessionID, {
        ...state,
        rounds: Math.max(0, state.rounds - 1),
        step: undefined,
      });

      return decision.status === "active" && decision.text === plan.text;
    });

    // The synthetic admission only wakes the runner; it does not wait for a model request.
    const renderPlan = ({ sessionID, messages }: SessionContext) =>
      guarded(
        sessionID,
        Effect.gen(function* gateContinuation() {
          const state = yield* read(sessionID);
          const plan = state?.plan;

          if (
            !state ||
            !plan ||
            state.inbox?.id !== plan.id ||
            !running(state)
          ) {
            return;
          }

          const index = messages.findIndex((message) => message.id === plan.id);

          const stored = yield* history(sessionID);

          const promoted =
            index !== -1 ||
            state.inbox.deliveredAt !== undefined ||
            stored.some(
              (message) =>
                message.id === plan.id && message.type === "synthetic"
            );

          if (!promoted) {
            return;
          }

          // Completed checkpoints come from stored history, not the speculative compaction request.
          if (checkpointHidesPlan(stored, plan)) {
            const { inbox: _inbox, ...delivered } = state;
            yield* pause(sessionID, delivered, compacted);

            return;
          }

          if (index === -1) {
            return;
          }

          const reason = messages
            .slice(0, index)
            .some((message) => message.id === plan.origin)
            ? superseded(stored, state.id, plan.origin, plan.id)
            : noProvenance;

          if (reason) {
            yield* pause(sessionID, state, reason);

            return;
          }

          // A plan that waited out a reload or restart may be for a tree that has since moved: leave its marker inert,
          // and the settled turn is reassessed.
          if (
            !plan.rendered &&
            state.boot !== (yield* boot) &&
            !(yield* stillPlanned(sessionID, state, plan))
          ) {
            const { plan: _plan, ...stale } = state;
            yield* write(sessionID, { ...stale, step: undefined });

            return;
          }

          const entry = messages[index];

          if (entry?.role === "user") {
            if (!plan.rendered) {
              yield* write(sessionID, {
                ...state,
                plan: { ...plan, rendered: true },
              });
            }

            messages[index] = {
              ...entry,
              content: [{ text: plan.text, type: "text" }],
            };
          }
        })
      ).pipe(recover("could not render ship continuation"));

    const resume = Effect.fn("Ship.resume")(function* resume(
      input: CommandInvocation,
      state: ShipState | undefined
    ) {
      if (state?.status !== "paused") {
        return yield* failure("No paused Directorate ship to resume.");
      }

      if (state.location !== undefined && state.location !== location) {
        return yield* failure(
          "This ship belongs to its original OpenCode location. Start a new ship here instead."
        );
      }

      if (state.needsAttachments) {
        return yield* failure(restartAttached);
      }

      const { recovery: _recovery, ...resumable } = state;

      return yield* advance(
        input.sessionID,
        {
          ...resumable,
          boot: yield* boot,
          location,
          needsAttachments: false,
          pid,
          reviewsAtResume: state.chain.length,
          rounds: 0,
          status: "active",
          step: undefined,
        },
        input
      );
    });

    /** What the next step still waits on: an awaited subagent's notice, or the unreported review's Liaison. */
    const blocker = Effect.fnUntraced(function* blocker(
      state: ShipState,
      after: readonly SessionMessage.Info[]
    ) {
      const awaiting = state.awaiting ?? {};
      const tip = state.chain.at(-1);

      // A pruned or damaged seal is the next decision's error to report.
      const seal = tip
        ? yield* store
            .load(tip)
            .pipe(Effect.orElseSucceed(Function.constUndefined))
        : undefined;

      const owner = seal && !seal.reportedAt ? seal.ownerSession : undefined;

      if (owner && seal?.halted) {
        return "interrupted" as const;
      }

      const delivered = new Set(
        after.map((message) => noticed(message, awaiting))
      );

      const now = yield* Clock.currentTimeMillis;

      for (const child of new Set([
        ...Object.keys(awaiting),
        ...(owner ? [owner] : []),
      ])) {
        const unnoticed = child in awaiting && !delivered.has(child);

        const info = yield* Option.match(asSessionID(child), {
          onNone: () => Effect.succeedNone,
          onSome: (sessionID) =>
            host.session.get({ sessionID }).pipe(Effect.option),
        });

        const blocked = Option.isSome(info)
          ? held(yield* activity(host, info.value), {
              interrupted:
                child === owner && info.value.outcome === "interrupted",
              now,
              unnoticed,
            })
          : gone(child === owner, unnoticed);

        if (blocked) {
          return blocked;
        }
      }
    });

    /** An automatic continuation whose admission was cut short. Returns the state to settle, if the host already holds it. */
    const readmit = Effect.fnUntraced(function* readmit(
      sessionID: SessionID,
      state: ShipState,
      messages: readonly SessionMessage.Info[]
    ) {
      const { admitting: _admitting, ...submitted } = state;
      const { inbox, plan } = submitted;

      if (!inbox || !plan) {
        yield* pause(sessionID, submitted, noProvenance);

        return;
      }

      if (messages.some((message) => message.id === inbox.id)) {
        yield* write(sessionID, submitted);

        return submitted;
      }

      const reason = superseded(messages, state.id, plan.origin);

      if (reason) {
        const { inbox: _inbox, ...rejected } = submitted;
        yield* pause(sessionID, rejected, reason);

        return;
      }

      // First admission wins for an ID the host already queued, so this never adds a second continuation.
      yield* commit(
        sessionID,
        state,
        submitted,
        marker(sessionID, state, inbox.id)
      ).pipe(Effect.uninterruptible);
    });

    /**
     * A ship from before this plugin instance loaded, once its session is idle: decide from what the host recorded, not
     * from events this instance may never have seen. Anything unproven waits or pauses.
     */
    const reconcile = Effect.fn("Ship.reconcile")(function* reconcile(
      sessionID: SessionID,
      stored: ShipState,
      failed?: string
    ) {
      const session = yield* host.session.get({ sessionID });

      if (locationKey(session.location) !== location) {
        return yield* pause(sessionID, stored, relocated);
      }

      // A turn the restart orphaned is the host's to resume.
      if (
        session.time.archived ||
        session.revert ||
        (yield* activity(host, session)).state !== "idle"
      ) {
        return;
      }

      const messages = yield* host.session.context({ sessionID });

      const state = stored.admitting
        ? yield* readmit(sessionID, stored, messages)
        : stored;

      const found = state && proven(state, messages, failed);

      if (!state || !found) {
        return;
      }

      const settled = { ...settle(state), boot: yield* boot, pid };

      if ("lost" in found) {
        return yield* pause(sessionID, settled, found.lost);
      }

      // The exact input is in the history, so its attachments were delivered with it.
      const delivered = {
        ...settled,
        needsAttachments: false,
        origin: found.origin,
      };

      const blocked = found.reason
        ? undefined
        : yield* blocker(state, found.after);

      if (blocked === "busy") {
        return;
      }

      const reason = found.reason ?? (blocked && BLOCKED[blocked]);

      if (reason) {
        return yield* pause(sessionID, delivered, reason);
      }

      // Recompute the next step from the seal and current tree, not the old prompt text.
      yield* advance(sessionID, {
        ...delivered,
        step: state.plan?.rendered === false ? undefined : delivered.step,
      });
    });

    const recoverShips = Effect.gen(function* recoverShips() {
      const current = yield* boot;
      let after: string | undefined;

      do {
        const page = yield* host.storage.scan(
          after ? { after, prefix } : { prefix }
        );

        for (const { key, value } of page.entries) {
          const snapshot = Option.getOrUndefined(decodeSnapshot(value));

          // Settled records, other locations', this instance's own, and another live server's need no lock; one that
          // changes is seen by the next sweep.
          if (
            !snapshot ||
            !running(snapshot) ||
            snapshot.location !== location ||
            snapshot.boot === current ||
            (yield* foreign(snapshot.pid))
          ) {
            continue;
          }

          const sessionID = Session.ID.make(key.slice(prefix.length));
          yield* guarded(
            sessionID,
            Effect.gen(function* recoverOne() {
              const state = yield* read(sessionID);

              if (state && running(state) && state.boot !== current) {
                yield* reconcile(sessionID, state);
              }
            })
          ).pipe(recover(`could not recover ship in ${sessionID}`));
        }

        after = page.next;
      } while (after);
    });

    const clear = Effect.fnUntraced(function* clear(
      sessionID: SessionID,
      pending: string | undefined,
      raw: string,
      forgetting: boolean
    ) {
      if (forgetting) {
        const confirmed = /^forget\s+(?<id>\S+)$/iu.exec(raw.trim())?.groups
          ?.id;

        if (!pending || confirmed !== pending) {
          return yield* failure(
            pending
              ? cancelFirst(pending)
              : "No undelivered ship input to forget."
          );
        }
      } else if (pending) {
        return yield* failure(cancelFirst(pending));
      }

      yield* host.storage.remove(storageKey(sessionID));
    });

    // Only idle observes background work. Ordered parent inbox deliveries consume its completion notices.
    const idle = ({ sessionID, background }: SessionIdle) =>
      guarded(
        sessionID,
        Effect.gen(function* observeBackground() {
          const at = yield* Clock.currentTimeMillis;
          const state = yield* read(sessionID);

          const seen = background.flatMap((work) =>
            work.kind === "subagent" && work.sessionID === sessionID
              ? [[work.childSessionID, at] as const]
              : []
          );

          if (state && running(state) && seen.length) {
            yield* write(sessionID, {
              ...state,
              awaiting: { ...state.awaiting, ...Object.fromEntries(seen) },
            });
          }
        })
      ).pipe(recover("ship idle hook failed"));

    const execute = ({ sessionID, prompt, delivery }: CommandInvocation) =>
      guarded(
        sessionID,
        Effect.gen(function* runCommand() {
          const raw = prompt.text;
          const action = raw.trim().toLowerCase();
          const forgetting = /^forget(?:\s|$)/u.test(action);

          if (
            (["pause", "status", "stop"].includes(action) || forgetting) &&
            hasAttachments(prompt)
          ) {
            return yield* failure(
              `The ${action} command does not accept attachments. Run it without attachments.`
            );
          }

          const state = yield* read(sessionID, true);

          if (action === "status") {
            return yield* failure(
              state ? describe(state) : "No Directorate ship in this session."
            );
          }

          const pending = state && queued(state);
          const session = yield* host.session.get({ sessionID });

          if (locationKey(session.location) !== location) {
            return yield* failure(
              "Run this command from the session's current OpenCode location."
            );
          }

          if (action === "stop" || forgetting) {
            return yield* clear(sessionID, pending, raw, forgetting);
          }

          if (pending) {
            return yield* failure(cancelFirst(pending));
          }

          if (action === "pause") {
            if (state?.status !== "active") {
              return yield* failure("No active Directorate ship to pause.");
            }

            yield* pause(sessionID, state, "Paused by the user.");

            return;
          }

          if (state?.status === "active") {
            return yield* failure(
              "A Directorate ship is already active in this session."
            );
          }

          yield* assertAgent(session.agent);
          const input = { delivery, prompt, sessionID };

          if (action === "resume") {
            return yield* resume(input, state);
          }

          if (/^\s*--recheck(?=\s|=|$)/iu.test(raw)) {
            return yield* failure(
              "/directorate-ship starts a new review. Use /directorate-review --recheck to re-check an existing seal."
            );
          }

          const id = yield* uuid;

          const kickoff = shipKickoff(
            yield* reviewRequest(raw, "defaults"),
            id
          );

          const now = yield* Clock.currentTimeMillis;

          const created: ShipState = {
            boot: yield* boot,
            chain: [],
            id,
            location,
            pid,
            reason: "Waiting for the initial Directorate review.",
            request: raw,
            reviewsAtResume: 0,
            rounds: 0,
            startedAt: now,
            status: "active",
            step: "review",
          };

          return yield* admit(sessionID, created, kickoff, input);
        })
      );

    const inboxEnqueued = (
      sessionID: SessionID,
      id: string,
      item: SessionInbox.Item
    ) =>
      guarded(
        sessionID,
        Effect.gen(function* onEnqueue() {
          const state = yield* read(sessionID);

          if (!state || !running(state)) {
            return;
          }

          const kind = inboxKind(item);
          kinds.set(id, kind);

          // A notice outlives a reload: its cancellation must still pause the ship that waits on it.
          if (Predicate.isObject(kind)) {
            yield* write(sessionID, {
              ...state,
              notices: { ...state.notices, [id]: kind.child },
            });
          }
        })
      ).pipe(recover("could not record ship inbox enqueue"));

    /** An item may have been queued before this instance existed. Inspect its exact ID only for its type, not its outcome. */
    const classify = Effect.fnUntraced(function* classify(
      sessionID: SessionID,
      id: string
    ) {
      const message = (yield* history(sessionID)).find(
        (entry) => entry.id === id
      );

      return message && kindOf(message.type, message.metadata);
    });

    const recordDelivery = Effect.fnUntraced(function* recordDelivery(
      sessionID: SessionID,
      state: ShipState,
      id: string,
      at: number
    ) {
      const { lastHostFailure: _lastHostFailure, ...deliveredState } = state;
      const { plan } = state;

      // The primary hook can run before the stream supplies proof of exact promotion.
      if (
        plan?.id === id &&
        checkpointHidesPlan(yield* history(sessionID), plan)
      ) {
        const { inbox: _inbox, ...promoted } = deliveredState;

        return yield* pause(sessionID, promoted, compacted);
      }

      yield* write(sessionID, {
        ...deliveredState,
        inbox: { deliveredAt: at, id },
        needsAttachments: false,
        origin: id,
        status: state.status === "waiting" ? "active" : state.status,
      });
    });

    /** An input other than the ship's own settled: a user prompt hands control back, a subagent's notice is consumed. */
    const otherSettled = Effect.fnUntraced(function* otherSettled(
      sessionID: SessionID,
      state: ShipState,
      id: string,
      delivered: boolean,
      at: number
    ) {
      const { [id]: notice, ...notices } = state.notices ?? {};
      let kind = kinds.get(id) ?? (notice ? { child: notice } : undefined);
      kinds.delete(id);

      if (
        delivered &&
        (state.status === "active" ||
          (state.status === "waiting" && state.inbox?.continuation))
      ) {
        kind ??= yield* classify(sessionID, id);

        if (kind === undefined) {
          return yield* pause(
            sessionID,
            state,
            `Could not classify delivered input ${id}; Ship yielded control. Use /directorate-ship resume when ready.`
          );
        }

        if (kind === "user") {
          return yield* pause(sessionID, state, handoff);
        }
      }

      if (!Predicate.isObject(kind)) {
        return;
      }

      const { [kind.child]: observedAt, ...awaiting } = state.awaiting ?? {};

      // An older notice may be consumed by this subscriber after the same child was relaunched.
      if (!reached(at, observedAt)) {
        return;
      }

      if (delivered) {
        yield* write(sessionID, { ...state, awaiting, notices, wokeAt: at });
      } else if (!queued(state)) {
        yield* pause(
          sessionID,
          state,
          "The waiting subagent's completion message was cancelled."
        );
      }
    });

    const inboxSettled = (
      sessionID: SessionID,
      id: string,
      delivered: boolean,
      at: number
    ) =>
      guarded(
        sessionID,
        Effect.gen(function* onInboxSettled() {
          const state = yield* read(sessionID);

          if (!state) {
            return;
          }

          if (state.inbox?.id !== id) {
            return yield* otherSettled(sessionID, state, id, delivered, at);
          }

          kinds.delete(id);

          if (state.inbox.deliveredAt !== undefined) {
            return;
          }

          if (delivered) {
            return yield* recordDelivery(sessionID, state, id, at);
          }

          const { inbox: _inbox, ...cleared } = state;
          yield* pause(
            sessionID,
            cleared,
            "The queued Directorate ship prompt was cancelled."
          );
        })
      ).pipe(recover("could not handle ship inbox delivery"));

    const executionSettled = (
      sessionID: SessionID,
      at: number,
      reason?: string
    ) =>
      guarded(
        sessionID,
        Effect.gen(function* onTerminal() {
          const state = yield* read(sessionID);

          if (!state || !running(state)) {
            return;
          }

          // This instance did not see the whole turn: the host's record decides, including how the turn ended.
          if (state.boot !== (yield* boot)) {
            return yield* reconcile(sessionID, state, reason);
          }

          if (state.status === "waiting") {
            // The host does not attribute a busy period to any one queued input.
            if (reason !== undefined) {
              yield* write(sessionID, { ...state, lastHostFailure: reason });
            }

            return;
          }

          const related = reached(at, state.inbox?.deliveredAt);
          const wokeForChild = !state.inbox && reached(at, state.wokeAt);

          if (!related && !wokeForChild) {
            return;
          }

          if (reason !== undefined) {
            return yield* pause(sessionID, state, reason);
          }

          if (state.plan && !state.plan.rendered) {
            yield* pause(sessionID, state, noProvenance);

            return;
          }

          // Consume this input's successful execution before deciding or waiting for a child result.
          const {
            inbox: _inbox,
            plan: _plan,
            wokeAt: _wokeAt,
            ...settled
          } = state;

          if (Object.keys(settled.awaiting ?? {}).length) {
            yield* write(sessionID, settled);

            return;
          }

          yield* advance(sessionID, settled).pipe(
            Effect.catchCauseIf(Cause.hasDies, (cause) =>
              read(sessionID).pipe(
                Effect.flatMap((current) =>
                  current?.status === "active"
                    ? pause(sessionID, current, causeMessage(cause)).pipe(
                        Effect.asVoid
                      )
                    : Effect.void
                )
              )
            )
          );
        })
      ).pipe(recover("could not settle ship session execution"));

    const remove = (sessionID: string) =>
      guarded(sessionID, host.storage.remove(storageKey(sessionID))).pipe(
        recover("could not remove ship for deleted session")
      );

    const moved = (
      sessionID: SessionID,
      destination: Parameters<typeof locationKey>[0]
    ) =>
      guarded(
        sessionID,
        Effect.gen(function* onMove() {
          if (locationKey(destination) === location) {
            return;
          }

          const state = yield* read(sessionID);

          if (state?.status === "active" || state?.status === "waiting") {
            yield* pause(sessionID, state, relocated);
          }
        })
      ).pipe(recover("could not pause ship after moving session"));

    yield* host.session.hook("experimental.idle", idle);
    yield* host.session.hook("context", renderPlan);

    return {
      execute,
      executionSettled,
      inboxEnqueued,
      inboxSettled,
      moved,
      recoverShips,
      remove,
      sealed,
    };
  }
);
