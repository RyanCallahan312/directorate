// Ship owns the persisted loop; the next action is decided from the review dossier, never the model's reply.
import type {
  CommandDefinition,
  CommandInvocation,
} from "@opencode/plugin/effect/command";
import type {
  SessionContext,
  SessionIdle,
} from "@opencode/plugin/effect/session";
import type { SessionInbox } from "@opencode/schema/session-inbox";
import { SessionMessage } from "@opencode/schema/session-message";
import {
  Cause,
  Clock,
  Effect,
  Function,
  Match,
  Option,
  Predicate,
  Record,
  Result,
} from "effect";
import { SecureRandom } from "effect/crypto";
import type { Digest } from "effect/crypto";

import { Liaison } from "../../feature/agents/agent.ts";
import type { SessionEvent } from "../../feature/dispatch/dispatch.ts";
import { recover } from "../../platform/error.ts";
import type { MessageId, SessionId } from "../../platform/host-id.ts";
import {
  activity,
  foreign,
  Git,
  Host,
  isIdle,
  isInterrupted,
  isRunning as isExecuting,
  isShutdown,
  isSynthetic,
  isUserStop,
  locationKey,
  keyedLockUnsafe,
  ProcessIdentity,
} from "../../platform/platform.ts";
import type { Worktree } from "../../platform/platform.ts";
import { Records } from "../../records/records.ts";
import type { Seal } from "../../seal/record.ts";
import { currentFingerprint, FreshnessUnchecked } from "../../seal/seal.ts";
import { parseRequest, reviewRequest } from "../review/request.ts";
import type { ReviewScope } from "../review/request.ts";
import { interruptedReview, shipStamp } from "../review/review.ts";
import { ShipIdSchema } from "../review/ship-link.ts";
import type { ShipId } from "../review/ship-link.ts";
import {
  assertAgent,
  cancelFirst,
  clears,
  describe,
  hasAttachments,
  isForget,
  isPause,
  isRecheck,
  isResume,
  isStatus,
  parseShipCommand,
  queued,
  refusesAttachments,
  restartAttached,
  ShipCommandRefused,
  ShipElsewhere,
  ShipStatus,
} from "./command.ts";
import type { ShipCommand } from "./command.ts";
import {
  BLOCKED,
  checkpointHidesPlan,
  checkpointID,
  compacted,
  gone,
  handoff,
  held,
  HoldSchema,
  inboxKind,
  isBusy,
  isSubagentWork,
  isUserKind,
  isUserTurn,
  messageKind,
  noProvenance,
  noticed,
  proven,
  shipMark,
  superseded,
} from "./evidence.ts";
import type { InboxKind } from "./evidence.ts";
import {
  admitted,
  admitting,
  attached,
  awaited,
  claimed,
  completed,
  consumed,
  delivered,
  enqueued,
  hostFailed,
  isActive,
  isComplete,
  isFinishStep,
  isPaused,
  isReviewStep,
  isRunning,
  isWaiting,
  noticeQueued,
  observed as observedChain,
  paused,
  planned,
  planRendered,
  proceeding,
  rechecks,
  resumed,
  ReviewStep,
  rewound,
  settled,
  started,
  stopped,
  traced,
  unplanned,
  woken,
} from "./state.ts";
import type { Plan, ShipState } from "./state.ts";
import { decideShip, ShipDecisionSchema, shipKickoff } from "./step.ts";
import { shipStorage } from "./storage.ts";

const isProceed = ShipDecisionSchema.isAnyOf(["Proceed"]);

const reached = (at: number, boundary: number | undefined) =>
  boundary !== undefined && at >= boundary;

const causeMessage = (cause: Cause.Cause<unknown>) =>
  Cause.prettyErrors(cause)[0]?.message ?? Cause.pretty(cause);

// Plugin instances share the host's storage, so they share this per-session lock too: it outlives any one instance.
const guards = keyedLockUnsafe();

const guarded = guards.withLock;

const MARKER =
  "Directorate Ship continuation marker. It does not request any action on its own.";

const relocated =
  "The session moved to another OpenCode location. Start a new ship there.";

export const registerShip = Effect.fn("Ship.register")(
  function* registerShip() {
    const host = yield* Host;
    const git = yield* Git;
    const store = yield* Records;
    const stampShip = yield* shipStamp;
    const services = yield* Effect.context<Git | Worktree | Digest.Digest>();
    const random = yield* SecureRandom.SecureRandom;
    const uuid = random.uuidV4();
    const boot = yield* Effect.cached(uuid);
    const identity = yield* ProcessIdentity;
    const { pid } = identity;

    const foreignOwner = (owner: number) =>
      foreign(owner).pipe(Effect.provideService(ProcessIdentity, identity));

    const { drop, location, pause, read, scan, unqueue, write } = shipStorage(
      host,
      foreignOwner
    );

    // What each queued input is, by session and inbox ID, until it settles or its session is deleted. A reload forgets
    // these; the message itself is read then.
    const kinds = new Map<SessionId, Map<MessageId, InboxKind>>();

    /** The kind recorded for the session's input `id`, forgetting it. */
    const takeKind = (sessionID: SessionId, id: MessageId) => {
      const known = kinds.get(sessionID);
      const kind = known?.get(id);
      known?.delete(id);

      if (known?.size === 0) {
        kinds.delete(sessionID);
      }

      return kind;
    };

    const checkWorktree = Effect.fnUntraced(function* checkWorktree(
      sessionID: SessionId,
      seal: Seal
    ) {
      const parent = yield* host.session.get({ sessionID });
      yield* assertAgent(parent.agent);

      if ((yield* git.root(parent.location.directory)) !== seal.repo) {
        return yield* new ShipElsewhere({
          message: `Seal ${seal.id} is for a different Git worktree than this session.`,
        });
      }
    });

    /** Bind at creation. The kickoff's ship id distinguishes its review from other children of the same parent. */
    const sealed = Effect.fn("Ship.sealed")(function* sealed(
      seal: Seal,
      shipID?: ShipId,
      scope?: ReviewScope
    ) {
      if (
        !Liaison.is(seal.owner) ||
        !seal.ownerSession ||
        (!shipID && !seal.recheckOf)
      ) {
        return;
      }

      const { parentID } = yield* host.session.get({
        sessionID: seal.ownerSession,
      });

      if (!parentID) {
        return;
      }

      yield* guarded(
        parentID,
        Effect.gen(function* attach() {
          const state = yield* read(parentID);

          if (!state || isComplete(state)) {
            return;
          }

          const tip = state.chain.at(-1);

          if (shipID) {
            if (shipID !== state.id || tip || !isReviewStep(state.step)) {
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
            !(isFinishStep(state.step) || rechecks(state.step, tip))
          ) {
            return;
          }

          // The seal names its ship first, so the review stays the ship's even once this record is stopped or replaced.
          yield* stampShip(seal.id, state.id);
          yield* write(parentID, attached(state, seal.id));
        })
      );
    }, recover("could not associate seal with ship"));

    const observeChain = Effect.fn("Ship.observeChain")(function* observeChain(
      sessionID: SessionId,
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
          return yield* new FreshnessUnchecked({ message: unfetched });
        }

        return { fingerprint, ledger };
      },
      Effect.provideContext(services)
    );

    const history = (sessionID: SessionId) =>
      host.session.context({ sessionID }).pipe(Effect.orElseSucceed(() => []));

    // OpenCode promotes input before assembling each request. Never put actionable instructions in the inbox itself.
    const marker = (sessionID: SessionId, state: ShipState, id: MessageId) =>
      host.session.synthetic({
        description: `Directorate ship: ${state.reason}`,
        id,
        metadata: shipMark(state.id),
        sessionID,
        text: MARKER,
      });

    /** Persists `intent`, sends, then persists `submitted`. A failed send pauses the ship. */
    const commit = <E>(
      sessionID: SessionId,
      intent: ShipState,
      submitted: ShipState,
      send: Effect.Effect<unknown, E>
    ) =>
      write(sessionID, intent).pipe(
        Effect.andThen(send),
        Effect.andThen(write(sessionID, submitted)),
        Effect.onError((cause) => {
          // Typed admission failures precede host enqueue. A defect or interruption may have left an item queued.
          const stop =
            Cause.hasDies(cause) || Cause.hasInterrupts(cause)
              ? pause
              : unqueue;

          return stop(
            sessionID,
            submitted,
            `Could not send the ship prompt: ${causeMessage(cause)}`
          ).pipe(recover("could not persist ship pause after prompt failure"));
        })
      );

    const admit = Effect.fn("Ship.admit")(function* admit(
      sessionID: SessionId,
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

      const waiting = enqueued(
        state,
        { continuation: input === undefined, id },
        input ? hasAttachments(input.prompt) : false
      );

      /** The continuation's prompt, rendered once the host promotes its marker. */
      const planFor = (from: MessageId) => {
        const plan = { id, origin: from, rendered: false, text };

        return checkpoint ? { ...plan, checkpoint } : plan;
      };

      const submitted =
        !input && origin ? planned(waiting, planFor(origin)) : waiting;

      if (!input) {
        // A reload must not interrupt automatic admission between enqueue and its checkpoint; a crash there leaves the
        // intent so recovery can confirm delivery or pause without reissuing it.
        return yield* commit(
          sessionID,
          admitting(submitted),
          submitted,
          marker(sessionID, state, id)
        ).pipe(Effect.uninterruptible);
      }

      // The user is here to retry: do not leave an active loop behind if admission or its final storage write fails.
      yield* commit(
        sessionID,
        paused(submitted, "Could not send the ship prompt."),
        submitted,
        host.session.prompt({
          ...input.prompt,
          delivery: input.delivery,
          id,
          metadata: shipMark(state.id),
          sessionID,
          text,
        })
      );
    });

    /** The next step for this state, from the seal and the tree as they are now. */
    const decide = Effect.fnUntraced(function* decide(
      sessionID: SessionId,
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

      const current = observedChain(state, chain, manual);

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
      sessionID: SessionId,
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

      const next = ShipDecisionSchema.match(decision, {
        Conclude: ({ reason }) => completed(current, reason),
        Pause: ({ reason, text }) => stopped(current, reason, text),
        Proceed: ({ reason, step }) => proceeding(current, reason, step),
      });

      if (isActive(next)) {
        return yield* admit(sessionID, next, decision.text, input);
      }

      yield* write(sessionID, next);

      if (input) {
        return yield* new ShipStatus({
          message: `${describe(next)}\nNo continuation was sent.`,
        });
      }
    });

    /** Whether the step this plan was made for is still the step the seal and tree call for. */
    const stillPlanned = Effect.fnUntraced(function* stillPlanned(
      sessionID: SessionId,
      state: ShipState,
      plan: Plan
    ) {
      const { decision } = yield* decide(sessionID, rewound(state));

      return isProceed(decision) && decision.text === plan.text;
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
            !isRunning(state)
          ) {
            return;
          }

          const index = messages.findIndex((message) => message.id === plan.id);

          const stored = yield* history(sessionID);

          const promoted =
            index !== -1 ||
            state.inbox.deliveredAt !== undefined ||
            stored.some(
              (message) => message.id === plan.id && isSynthetic(message)
            );

          if (!promoted) {
            return;
          }

          // Completed checkpoints come from stored history, not the speculative compaction request.
          if (checkpointHidesPlan(stored, plan)) {
            yield* unqueue(sessionID, state, compacted);

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
            yield* write(sessionID, unplanned(state));

            return;
          }

          const entry = messages[index];

          if (isUserTurn(entry)) {
            if (!plan.rendered) {
              yield* write(sessionID, planRendered(state));
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
      if (!state || !isPaused(state)) {
        return yield* new ShipCommandRefused({
          message: "No paused Directorate ship to resume.",
        });
      }

      if (state.location !== location) {
        return yield* new ShipElsewhere({
          message:
            "This ship belongs to its original OpenCode location. Start a new ship here instead.",
        });
      }

      if (state.needsAttachments) {
        return yield* new ShipCommandRefused({ message: restartAttached });
      }

      return yield* advance(
        input.sessionID,
        resumed(state, { boot: yield* boot, location, pid }),
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
        return HoldSchema.make("interrupted");
      }

      const notified = new Set(
        after.map((message) => noticed(message, awaiting))
      );

      const now = yield* Clock.currentTimeMillis;

      for (const child of new Set([
        ...Record.keys(awaiting),
        ...(owner ? [owner] : []),
      ])) {
        const unnoticed = child in awaiting && !notified.has(child);

        const info = yield* host.session
          .get({ sessionID: child })
          .pipe(Effect.option);

        if (Option.isNone(info)) {
          const blocked = gone(child === owner, unnoticed);

          if (blocked) {
            return blocked;
          }

          continue;
        }

        const act = yield* activity(host, info.value);
        const blocked = held(act, now, unnoticed);

        if (
          child === owner &&
          seal &&
          !isExecuting(act.state) &&
          (isInterrupted(act.session.outcome) ||
            interruptedReview(
              seal,
              yield* host.session.context({ sessionID: act.session.id })
            ))
        ) {
          return HoldSchema.make("interrupted");
        }

        if (blocked) {
          return blocked;
        }
      }
    });

    /** Recover a proven delivery, but never reissue an input that may have been cancelled. */
    const confirmAdmission = Effect.fnUntraced(function* confirmAdmission(
      sessionID: SessionId,
      state: ShipState,
      messages: readonly SessionMessage.Info[]
    ) {
      const submitted = admitted(state);
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
        yield* unqueue(sessionID, submitted, reason);

        return;
      }

      yield* pause(
        sessionID,
        submitted,
        "Could not confirm whether the queued Directorate ship prompt was delivered or cancelled. Check the exact inbox ID before resuming."
      );
    });

    /**
     * A ship from before this plugin instance loaded, once its session is idle: decide from what the host recorded, not
     * from events this instance may never have seen. Anything unproven waits or pauses.
     */
    const reconcile = Effect.fn("Ship.reconcile")(function* reconcile(
      sessionID: SessionId,
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
        !isIdle((yield* activity(host, session)).state)
      ) {
        return;
      }

      const messages = yield* host.session.context({ sessionID });

      const state = stored.admitting
        ? yield* confirmAdmission(sessionID, stored, messages)
        : stored;

      const proof = state && proven(state, messages, failed);

      if (!state || !proof) {
        return;
      }

      const ours = claimed(settled(state), yield* boot, pid);

      if (Result.isFailure(proof)) {
        return yield* pause(sessionID, ours, proof.failure);
      }

      const found = proof.success;
      const known = traced(ours, found.origin);

      const blocked = found.reason
        ? undefined
        : yield* blocker(state, found.after);

      if (isBusy(blocked)) {
        return;
      }

      const reason = found.reason ?? (blocked && BLOCKED[blocked]);

      if (reason) {
        return yield* pause(sessionID, known, reason);
      }

      // Recompute the next step from the seal and current tree, not the old prompt text.
      yield* advance(
        sessionID,
        state.plan?.rendered === false ? unplanned(known) : known
      );
    });

    const recoverOne = (sessionID: SessionId, reason?: string) =>
      store.withShipLock(
        sessionID,
        Effect.gen(function* claim() {
          const state = yield* read(sessionID);

          if (state && isRunning(state) && state.boot !== (yield* boot)) {
            yield* reconcile(sessionID, state, reason);
          }
        })
      );

    const recoverShips = Effect.gen(function* recoverShips() {
      const current = yield* boot;
      let after: string | undefined;

      do {
        const page = yield* scan(after);

        for (const { sessionID, snapshot } of page.ships) {
          // Settled records, other locations', this instance's own, and another live server's need no lock; one that
          // changes is seen by the next sweep.
          if (
            !isRunning(snapshot) ||
            snapshot.location !== location ||
            snapshot.boot === current ||
            (yield* foreignOwner(snapshot.pid))
          ) {
            continue;
          }

          yield* guarded(sessionID, recoverOne(sessionID)).pipe(
            recover(`could not recover ship in ${sessionID}`)
          );
        }

        after = page.next;
      } while (after);
    });

    const clear = Effect.fnUntraced(function* clear(
      sessionID: SessionId,
      pending: string | undefined,
      command: ShipCommand
    ) {
      if (isForget(command)) {
        if (!pending || command.id !== pending) {
          return yield* new ShipCommandRefused({
            message: pending
              ? cancelFirst(pending)
              : "No undelivered ship input to forget.",
          });
        }
      } else if (pending) {
        return yield* new ShipCommandRefused({ message: cancelFirst(pending) });
      }

      yield* drop(sessionID);
    });

    // Only idle observes background work. Ordered parent inbox deliveries consume its completion notices.
    const idle = ({ sessionID, background }: SessionIdle) =>
      guarded(
        sessionID,
        Effect.gen(function* observeBackground() {
          const at = yield* Clock.currentTimeMillis;
          const state = yield* read(sessionID);

          const seen = background.flatMap((work) =>
            isSubagentWork(work) && work.sessionID === sessionID
              ? [[work.childSessionID, at] as const]
              : []
          );

          if (state && isRunning(state) && seen.length) {
            yield* write(sessionID, awaited(state, Object.fromEntries(seen)));
          }
        })
      ).pipe(recover("ship idle hook failed"));

    const assertWritable = Effect.fnUntraced(function* assertWritable(
      state: ShipState | undefined
    ) {
      if (state && isRunning(state) && (yield* foreignOwner(state.pid))) {
        return yield* new ShipElsewhere({
          message: "Another live OpenCode server is driving this ship.",
        });
      }
    });

    const execute = ({ sessionID, prompt, delivery }: CommandInvocation) =>
      guarded(
        sessionID,
        store.withShipLock(
          sessionID,
          Effect.gen(function* runCommand() {
            const raw = prompt.text;
            const command = parseShipCommand(raw);

            if (refusesAttachments(command) && hasAttachments(prompt)) {
              return yield* new ShipCommandRefused({
                message: `The ${raw.trim().toLowerCase()} command does not accept attachments. Run it without attachments.`,
              });
            }

            const state = yield* read(sessionID, true);

            if (isStatus(command)) {
              return yield* new ShipStatus({
                message: state
                  ? describe(state)
                  : "No Directorate ship in this session.",
              });
            }

            yield* assertWritable(state);

            const pending = state && queued(state);
            const session = yield* host.session.get({ sessionID });

            if (locationKey(session.location) !== location) {
              return yield* new ShipElsewhere({
                message:
                  "Run this command from the session's current OpenCode location.",
              });
            }

            if (clears(command)) {
              return yield* clear(sessionID, pending, command);
            }

            if (pending) {
              return yield* new ShipCommandRefused({
                message: cancelFirst(pending),
              });
            }

            if (isPause(command)) {
              if (!state || !isActive(state)) {
                return yield* new ShipCommandRefused({
                  message: "No active Directorate ship to pause.",
                });
              }

              yield* pause(sessionID, state, "Paused by the user.");

              return;
            }

            if (state && isActive(state)) {
              return yield* new ShipCommandRefused({
                message:
                  "A Directorate ship is already active in this session.",
              });
            }

            yield* assertAgent(session.agent);
            const input = { delivery, prompt, sessionID };

            if (isResume(command)) {
              return yield* resume(input, state);
            }

            if (isRecheck(command)) {
              return yield* new ShipCommandRefused({
                message:
                  "/directorate-ship starts a new review. Use /directorate-review --recheck to re-check an existing seal.",
              });
            }

            const id = ShipIdSchema.make(yield* uuid);

            const kickoff = shipKickoff(
              yield* reviewRequest(command.request, "defaults"),
              id
            );

            const now = yield* Clock.currentTimeMillis;

            const created = started({
              boot: yield* boot,
              id,
              location,
              pid,
              request: command.request,
              startedAt: now,
              step: ReviewStep.make({}),
            });

            return yield* admit(sessionID, created, kickoff, input);
          })
        )
      );

    const inboxEnqueued = (
      sessionID: SessionId,
      id: MessageId,
      item: SessionInbox.Item
    ) =>
      guarded(
        sessionID,
        Effect.gen(function* onEnqueue() {
          const state = yield* read(sessionID);

          if (!state || !isRunning(state)) {
            return;
          }

          const kind = inboxKind(item);
          kinds.set(
            sessionID,
            (kinds.get(sessionID) ?? new Map()).set(id, kind)
          );

          // A notice outlives a reload: its cancellation must still pause the ship that waits on it.
          if (Predicate.isObject(kind)) {
            yield* write(sessionID, noticeQueued(state, id, kind.child));
          }
        })
      ).pipe(recover("could not record ship inbox enqueue"));

    /** An item may have been queued before this instance existed. Inspect its exact ID only for its type, not its outcome. */
    const classify = Effect.fnUntraced(function* classify(
      sessionID: SessionId,
      id: MessageId
    ) {
      const message = (yield* history(sessionID)).find(
        (entry) => entry.id === id
      );

      return message && messageKind(message);
    });

    const recordDelivery = Effect.fnUntraced(function* recordDelivery(
      sessionID: SessionId,
      state: ShipState,
      id: MessageId,
      at: number
    ) {
      const { plan } = state;

      // The primary hook can run before the stream supplies proof of exact promotion.
      if (
        plan?.id === id &&
        checkpointHidesPlan(yield* history(sessionID), plan)
      ) {
        return yield* unqueue(sessionID, state, compacted);
      }

      yield* write(sessionID, delivered(state, id, at));
    });

    /** An input other than the ship's own settled: a user prompt hands control back, a subagent's notice is consumed. */
    const otherSettled = Effect.fnUntraced(function* otherSettled(
      sessionID: SessionId,
      state: ShipState,
      id: MessageId,
      isDelivered: boolean,
      at: number
    ) {
      const notice = state.notices?.[id];

      let kind =
        takeKind(sessionID, id) ?? (notice ? { child: notice } : undefined);

      if (
        isDelivered &&
        (isActive(state) || (isWaiting(state) && state.inbox?.continuation))
      ) {
        kind ??= yield* classify(sessionID, id);

        if (kind === undefined) {
          return yield* pause(
            sessionID,
            state,
            `Could not classify delivered input ${id}; Ship yielded control. Use /directorate-ship resume when ready.`
          );
        }

        if (isUserKind(kind)) {
          return yield* pause(sessionID, state, handoff);
        }
      }

      if (!Predicate.isObject(kind)) {
        return;
      }

      const observedAt = state.awaiting?.[kind.child];

      // An older notice may be consumed by this subscriber after the same child was relaunched.
      if (!reached(at, observedAt)) {
        return;
      }

      if (isDelivered) {
        yield* write(sessionID, woken(state, id, kind.child, at));
      } else if (!queued(state)) {
        yield* pause(
          sessionID,
          state,
          "The waiting subagent's completion message was cancelled."
        );
      }
    });

    const inboxSettled = (
      sessionID: SessionId,
      id: MessageId,
      isDelivered: boolean,
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
            return yield* otherSettled(sessionID, state, id, isDelivered, at);
          }

          takeKind(sessionID, id);

          if (state.inbox.deliveredAt !== undefined) {
            return;
          }

          if (isDelivered) {
            return yield* recordDelivery(sessionID, state, id, at);
          }

          yield* unqueue(
            sessionID,
            state,
            "The queued Directorate ship prompt was cancelled."
          );
        })
      ).pipe(recover("could not handle ship inbox delivery"));

    const executionSettled = (
      sessionID: SessionId,
      at: number,
      reason?: string
    ) =>
      guarded(
        sessionID,
        Effect.gen(function* onTerminal() {
          const state = yield* read(sessionID);

          if (!state || !isRunning(state)) {
            return;
          }

          // This instance did not see the whole turn: the host's record decides, including how the turn ended.
          if (state.boot !== (yield* boot)) {
            return yield* recoverOne(sessionID, reason);
          }

          if (isWaiting(state)) {
            // The host does not attribute a busy period to any one queued input.
            if (reason !== undefined) {
              yield* write(sessionID, hostFailed(state, reason));
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
          const used = consumed(state);

          if (Object.keys(used.awaiting ?? {}).length) {
            yield* write(sessionID, used);

            return;
          }

          yield* advance(sessionID, used).pipe(
            Effect.catchCauseIf(Cause.hasDies, (cause) =>
              read(sessionID).pipe(
                Effect.flatMap((current) =>
                  current && isActive(current)
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

    const remove = (sessionID: SessionId) =>
      guarded(
        sessionID,
        Effect.sync(() => kinds.delete(sessionID)).pipe(
          Effect.andThen(drop(sessionID))
        )
      ).pipe(recover("could not remove ship for deleted session"));

    const moved = (
      sessionID: SessionId,
      destination: Parameters<typeof locationKey>[0]
    ) =>
      guarded(
        sessionID,
        Effect.gen(function* onMove() {
          if (locationKey(destination) === location) {
            return;
          }

          const state = yield* read(sessionID);

          if (state && isRunning(state)) {
            yield* pause(sessionID, state, relocated);
          }
        })
      ).pipe(recover("could not pause ship after moving session"));

    /** The ship loop's share of each session event dispatch consumes, heard before the review's runs take theirs. */
    const sessionEvent = Match.type<SessionEvent>().pipe(
      Match.discriminatorsExhaustive("type")({
        "session.created": () => Effect.void,
        "session.deleted": ({ data }) => remove(data.sessionID),
        "session.execution.failed": ({ created, data }) =>
          executionSettled(
            data.sessionID,
            created,
            `The session failed: ${data.error.message}`
          ),
        "session.execution.interrupted": ({ created, data }) => {
          // OpenCode restores suspended executions and jobs after shutdown.
          if (isShutdown(data.reason)) {
            return Effect.void;
          }

          return executionSettled(
            data.sessionID,
            created,
            isUserStop(data.reason)
              ? "Interrupted by the user."
              : `The session was interrupted (${data.reason}).`
          );
        },
        "session.execution.succeeded": ({ created, data }) =>
          executionSettled(data.sessionID, created),
        "session.idle": () => Effect.void,
        "session.inbox.cancelled": ({ created, data }) =>
          inboxSettled(data.sessionID, data.inboxID, false, created),
        "session.inbox.delivered": ({ created, data }) =>
          inboxSettled(data.sessionID, data.inboxID, true, created),
        "session.inbox.enqueued": ({ data }) =>
          inboxEnqueued(data.sessionID, data.inboxID, data.item),
        "session.moved": ({ data }) => moved(data.sessionID, data.location),
      })
    );

    yield* host.session.hook("experimental.idle", idle);
    yield* host.session.hook("context", renderPlan);

    return {
      command: {
        description:
          "Review, fix, and re-check until the Directive is clean [request, --scope branch|local|repository] | status | pause | resume | stop | forget <pending-id>",
        execute,
        name: "directorate-ship",
      } satisfies CommandDefinition,
      recoverShips,
      sealed,
      sessionEvent,
    };
  }
);
