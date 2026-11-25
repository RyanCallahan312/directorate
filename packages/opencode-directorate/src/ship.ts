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
import { parseRequest, reviewRequest } from "./request.ts";
import { decideShip, shipKickoff } from "./ship-step.ts";
import { Store } from "./store.ts";
import { currentFingerprint } from "./target.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const ShipStateSchema = Schema.Struct({
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
  origin: Schema.optionalKey(Schema.String),
  reason: Schema.String,
  recovery: Schema.optionalKey(Schema.String),
  request: Schema.String,
  reviewsAtResume: Count,
  rounds: Count,
  startedAt: Schema.Finite,
  status: Schema.Literals(["waiting", "active", "paused", "complete"]),
  step: Schema.optional(Schema.String),
});

type ShipState = typeof ShipStateSchema.Type;

type SessionID = Session.ID;

type InboxKind = "user" | "other" | { readonly child: string };

const inboxKind = (item: SessionInbox.Item): InboxKind => {
  if (
    item.type === "user" &&
    item.payload.metadata?.source !== "directorate-ship"
  ) {
    return "user";
  }

  if (
    item.type === "synthetic" &&
    item.payload.metadata?.source === "subagent" &&
    Predicate.isString(item.payload.metadata.childID)
  ) {
    return { child: item.payload.metadata.childID };
  }

  return "other";
};

const locationKey = (ref: {
  readonly directory: string;
  readonly workspaceID?: string | undefined;
}) => JSON.stringify([ref.directory, ref.workspaceID ?? ""]);

const decode = Schema.decodeUnknownEffect(ShipStateSchema);
const storageKey = (id: string) => `ship:${id}`;

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

interface Plan {
  checkpoint?: string | undefined;
  id: string;
  origin: string;
  rendered: boolean;
  text: string;
}

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

export const registerShip = Effect.fn("Ship.register")(
  function* registerShip() {
    const host = yield* Host;
    const git = yield* Git;
    const store = yield* Store;
    const services = yield* Effect.context<Platform>();
    const crypto = yield* Crypto.Crypto;
    const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);
    const boot = yield* Effect.cached(uuid);

    const plans = new Map<SessionID, Plan>();

    // Only idle observes background work. Ordered parent inbox deliveries consume its completion notices.
    const waiting = new Map<
      SessionID,
      {
        ship: string;
        children: Map<string, number>;
        inboxKinds: Map<string, InboxKind>;
        wokeAt?: number | undefined;
      }
    >();

    const backgroundFor = (id: SessionID, ship: string) => {
      const current = waiting.get(id);

      if (current?.ship === ship) {
        return current;
      }

      const fresh = {
        children: new Map<string, number>(),
        inboxKinds: new Map<string, InboxKind>(),
        ship,
      };

      waiting.set(id, fresh);

      return fresh;
    };

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
      const paused: ShipState = { ...state, reason, status: "paused" };
      yield* write(sessionID, paused);
      plans.delete(sessionID);
      waiting.delete(sessionID);

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

      // The host shares storage and events across locations; only the owner may disarm on reload.
      if (
        state.location !== location &&
        (!command || state.location !== undefined)
      ) {
        return command ? state : undefined;
      }

      return (state.status === "active" || state.status === "waiting") &&
        (state.location !== location || state.boot !== (yield* boot))
        ? yield* pause(
            sessionID,
            state,
            "OpenCode reloaded or restarted before the ship finished."
          )
        : state;
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
      const { lastHostFailure: _lastHostFailure, ...next } = state;

      const submitted: ShipState = {
        ...next,
        inbox: { continuation: input === undefined, id },
        needsAttachments: input ? hasAttachments(input.prompt) : false,
        status: "waiting",
      };

      // Do not leave an active loop behind if admission or its final storage write fails.
      const pending = {
        ...submitted,
        reason: "Could not send the ship prompt.",
        status: "paused" as const,
      };

      yield* write(sessionID, pending);

      const message = { id, metadata: metadata(state.id), sessionID, text };

      if (!input && origin) {
        plans.set(sessionID, {
          checkpoint: checkpointID(messages),
          id,
          origin,
          rendered: false,
          text,
        });
      }

      const delivery = input
        ? host.session
            .prompt({ ...input.prompt, ...message, delivery: input.delivery })
            .pipe(Effect.asVoid)
        : host.session
            .synthetic({
              ...message,
              description: `Directorate ship: ${state.reason}`,
              text: "Directorate Ship continuation marker. It does not request any action on its own.",
            })
            .pipe(Effect.asVoid);

      yield* delivery.pipe(
        Effect.onError((cause) => {
          // Typed admission failures precede host enqueue. A defect or interruption may have left an item queued.
          const { inbox: _inbox, ...rejected } = pending;

          const retained =
            Cause.hasDies(cause) || Cause.hasInterrupts(cause)
              ? pending
              : rejected;

          return pause(
            sessionID,
            retained,
            `Could not send the ship prompt: ${causeMessage(cause)}`
          ).pipe(recover("could not persist ship pause after prompt failure"));
        })
      );
      yield* write(sessionID, submitted);
    });

    // OpenCode promotes input before assembling each request. Never put actionable instructions in the inbox itself.
    const renderPlan = ({ sessionID, messages }: SessionContext) =>
      Effect.suspend(() => {
        const plan = plans.get(sessionID);

        if (!plan) {
          return Effect.void;
        }

        // The synthetic admission only wakes the runner; it does not wait for a model request.
        return guarded(
          sessionID,
          Effect.gen(function* gateContinuation() {
            const state = yield* read(sessionID);

            if (
              plans.get(sessionID) !== plan ||
              state?.inbox?.id !== plan.id ||
              (state.status !== "active" && state.status !== "waiting")
            ) {
              return;
            }

            const marker = messages.findIndex(
              (message) => message.id === plan.id
            );

            const stored = yield* history(sessionID);

            const promoted =
              marker !== -1 ||
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

            if (marker === -1) {
              return;
            }

            const reason = messages
              .slice(0, marker)
              .some((message) => message.id === plan.origin)
              ? superseded(stored, state.id, plan.origin, plan.id)
              : noProvenance;

            if (reason) {
              yield* pause(sessionID, state, reason);

              return;
            }

            const entry = messages[marker];

            if (entry?.role === "user") {
              messages[marker] = {
                ...entry,
                content: [{ text: plan.text, type: "text" }],
              };
              plan.rendered = true;
            }
          })
        );
      }).pipe(recover("could not render ship continuation"));

    const advance = Effect.fn("Ship.advance")(function* advance(
      sessionID: SessionID,
      state: ShipState,
      input?: CommandInvocation
    ) {
      if (
        locationKey((yield* host.session.get({ sessionID })).location) !==
        location
      ) {
        yield* pause(
          sessionID,
          state,
          "The session moved to another OpenCode location. Start a new ship there."
        );

        return;
      }

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
        reviewsAtResume: input ? chain.length : state.reviewsAtResume,
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
          reviewsAtResume: state.chain.length,
          rounds: 0,
          status: "active",
          step: undefined,
        },
        input
      );
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

      plans.delete(sessionID);
      waiting.delete(sessionID);
      yield* host.storage.remove(storageKey(sessionID));
    });

    const idle = ({ sessionID, background }: SessionIdle) =>
      guarded(
        sessionID,
        Effect.gen(function* observeBackground() {
          const at = yield* Clock.currentTimeMillis;
          const state = yield* read(sessionID);

          if (state?.status !== "active" && state?.status !== "waiting") {
            return;
          }

          const entry = backgroundFor(sessionID, state.id);

          for (const work of background) {
            if (work.kind === "subagent" && work.sessionID === sessionID) {
              entry.children.set(work.childSessionID, at);
            }
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

          if (state?.status === "active" || state?.status === "waiting") {
            backgroundFor(sessionID, state.id).inboxKinds.set(
              id,
              inboxKind(item)
            );
          }
        })
      ).pipe(recover("could not record ship inbox enqueue"));

    const handoffReason = Effect.fnUntraced(function* handoffReason(
      sessionID: SessionID,
      id: string,
      kind: InboxKind | undefined
    ) {
      let classified = kind;

      // An item may have been queued before Ship existed. Inspect its exact ID only for its type, not its outcome.
      if (kind === undefined) {
        const messages = yield* host.session
          .context({ sessionID })
          .pipe(Effect.orElseSucceed(() => []));

        const message = messages.find((entry) => entry.id === id);

        if (!message) {
          return `Could not classify delivered input ${id}; Ship yielded control. Use /directorate-ship resume when ready.`;
        }

        classified =
          message.type === "user" &&
          message.metadata?.source !== "directorate-ship"
            ? "user"
            : "other";
      }

      return classified === "user" ? handoff : undefined;
    });

    const recordDelivery = Effect.fnUntraced(function* recordDelivery(
      sessionID: SessionID,
      state: ShipState,
      id: string,
      at: number
    ) {
      const { lastHostFailure: _lastHostFailure, ...deliveredState } = state;
      const plan = plans.get(sessionID);

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

          const background = waiting.get(sessionID);
          const kind = background?.inboxKinds.get(id);
          background?.inboxKinds.delete(id);

          if (state.inbox?.id !== id) {
            if (
              delivered &&
              (state.status === "active" ||
                (state.status === "waiting" && state.inbox?.continuation))
            ) {
              const reason = yield* handoffReason(sessionID, id, kind);

              if (reason) {
                return yield* pause(sessionID, state, reason);
              }
            }

            if (background && Predicate.isObject(kind)) {
              const { child } = kind;

              const observedAt = background.children.get(child);

              // An older notice may be consumed by this subscriber after the same child was relaunched.
              if (reached(at, observedAt)) {
                if (delivered) {
                  background.children.delete(child);
                  background.wokeAt = at;
                } else if (!queued(state)) {
                  return yield* pause(
                    sessionID,
                    state,
                    "The waiting subagent's completion message was cancelled."
                  );
                }
              }
            }

            return;
          }

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

    const unrenderedPlan = (sessionID: SessionID, id: string | undefined) => {
      const plan = plans.get(sessionID);

      return plan && plan.id === id && !plan.rendered;
    };

    const executionSettled = (
      sessionID: SessionID,
      at: number,
      reason?: string
    ) =>
      guarded(
        sessionID,
        Effect.gen(function* onTerminal() {
          const state = yield* read(sessionID);

          if (state?.status === "waiting") {
            // The host does not attribute a busy period to any one queued input.
            if (reason !== undefined) {
              yield* write(sessionID, { ...state, lastHostFailure: reason });
            }

            return;
          }

          if (state?.status !== "active") {
            return;
          }

          const deliveredAt = state.inbox?.deliveredAt;
          const background = waiting.get(sessionID);
          const related = reached(at, deliveredAt);
          const wokeForChild = !state.inbox && reached(at, background?.wokeAt);

          if (reason !== undefined) {
            if (related || wokeForChild) {
              yield* pause(sessionID, state, reason);
            }

            return;
          }

          if (!related && !wokeForChild) {
            return;
          }

          if (unrenderedPlan(sessionID, state.inbox?.id)) {
            yield* pause(sessionID, state, noProvenance);

            return;
          }

          plans.delete(sessionID);

          // Consume this input's successful execution before deciding or waiting for a child result.
          const { inbox: _inbox, ...settled } = state;
          yield* write(sessionID, settled);

          if (background) {
            background.wokeAt = undefined;
          }

          if (background?.children.size) {
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
      guarded(
        sessionID,
        Effect.suspend(() => {
          plans.delete(Session.ID.make(sessionID));
          waiting.delete(Session.ID.make(sessionID));

          return host.storage.remove(storageKey(sessionID));
        })
      ).pipe(recover("could not remove ship for deleted session"));

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
            yield* pause(
              sessionID,
              state,
              "The session moved to another OpenCode location. Start a new ship there."
            );
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
      remove,
      sealed,
    };
  }
);
