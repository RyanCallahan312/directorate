// Directorate sessions: which seal each OpenCode session works on, the host operations on those sessions, and the door
// every write to a review (its seal and its ledger) goes through.
import {
  Context,
  Effect,
  HashMap,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
} from "effect";

import {
  Actor,
  budgetLine,
  dispatchableNamed,
  Liaison,
} from "../feature/agents/agent.ts";
import { outstandingDispatches } from "../feature/dispatch/lifecycle.ts";
import { Ledger } from "../feature/ledger/entry.ts";
import { ignore } from "../platform/error.ts";
import type { SessionId } from "../platform/host-id.ts";
import { Host, keyedLock, ToolCatalog } from "../platform/platform.ts";
import { ActiveSeal, Records } from "../records/records.ts";
import { budget, isLocked } from "../workflow/review/window.ts";
import { Seal } from "./record.ts";
import { SealIdSchema, sealIdIn } from "./seal-id.ts";
import type { SealId } from "./seal-id.ts";

const SEAL_ENTRY = "directorate-seal";

/** A reported seal accepts no changes. */
class SealReported extends Schema.TaggedError<
  SealReported,
  { readonly brand: unique symbol }
>()("SealReported", {
  autoReported: Schema.Boolean,
  seal: SealIdSchema,
}) {
  override get message() {
    return `${this.seal} was already reported${this.autoReported ? " (filed automatically)" : ""}; containment is closed and accepts no further changes. Open a new seal for new work.`;
  }
}

/** An owner-only tool called from a session other than the one that sealed. */
class NotOwner extends Schema.TaggedError<
  NotOwner,
  { readonly brand: unique symbol }
>()("NotOwner", {
  seal: SealIdSchema,
  tool: Schema.String,
}) {
  override get message() {
    return `Only the session that sealed ${this.seal} may call ${this.tool}. To take over an interrupted review, call directorate_seal with resume: "${this.seal}".`;
  }
}

/** Once the budget locks, a tool the caller's agent does not keep at lockdown no longer runs. */
class Lockdown extends Schema.TaggedError<
  Lockdown,
  { readonly brand: unique symbol }
>()("Lockdown", {
  agent: Schema.String,
  seal: SealIdSchema,
  tool: Schema.String,
}) {
  override get message() {
    return `Directorate lockdown: the budget for ${this.seal} is locked, so ${this.tool} no longer runs. ${Liaison.is(this.agent) ? "Call directorate_report now." : "Hand off what you hold now."}`;
  }
}

// ---------- writers ----------
// Who writes to a review decides which of the root's guards apply. Guards apply to an open seal. A reported seal accepts
// no change from any writer but the ship link; each meets it in its own way: refused, left alone silently, or shown
// read-only.

/** Who may make a tool call: any participant in the review, or only the session that sealed it. */
const CallersSchema = Schema.Literals(["participants", "owner"]);

const isOwnerOnly = Schema.is(CallersSchema.pick(["owner"]));

/** Whether a tool call is checked against the ToolCatalog once the budget locks, or exempt. */
const LockdownCheckSchema = Schema.Literals(["catalog", "exempt"]);

const isCatalogChecked = Schema.is(LockdownCheckSchema.pick(["catalog"]));

/** What a reported seal does to a tool call: refuses it, or shows the seal and saves nothing. */
const ReportedSchema = Schema.Literals(["refused", "shown"]);

const isShownReported = Schema.is(ReportedSchema.pick(["shown"]));

/**
 * A tool call by `actor`. On an open seal, owner-only tools (`callers: "owner"`) need the session that sealed it, and once
 * the budget locks only the tools the ToolCatalog says the caller's agent keeps still run (unless `lockdown: "exempt"`).
 * A reported seal refuses it (SealReported), or, for a tool that shows a reported seal (`reported: "shown"`), lets it read
 * the seal while saving nothing.
 */
export class ToolCall extends Schema.TaggedClass<
  ToolCall,
  { readonly brand: unique symbol }
>()("ToolCall", {
  actor: Actor,
  callers: CallersSchema.pipe(
    Schema.withConstructorDefault(
      Effect.succeed(CallersSchema.make("participants"))
    )
  ),
  lockdown: LockdownCheckSchema.pipe(
    Schema.withConstructorDefault(
      Effect.succeed(LockdownCheckSchema.make("catalog"))
    )
  ),
  reported: ReportedSchema.pipe(
    Schema.withConstructorDefault(
      Effect.succeed(ReportedSchema.make("refused"))
    )
  ),
  tool: Schema.String,
}) {
  /** Only the session that sealed may make it. */
  get ownerOnly() {
    return isOwnerOnly(this.callers);
  }

  /** Once the budget locks, it runs only if the ToolCatalog says the caller's agent keeps the tool. */
  get catalogChecked() {
    return isCatalogChecked(this.lockdown);
  }

  /** On a reported seal, it runs and saves nothing instead of being refused. */
  get showsReported() {
    return isShownReported(this.reported);
  }
}

/** The ordered session-event consumer, and runs settled after a reload: a reported seal is left alone, silently. */
export class HostEvent extends Schema.TaggedClass<
  HostEvent,
  { readonly brand: unique symbol }
>()("HostEvent", {}) {}

/**
 * The watchdog waking a stalled Liaison: a reported seal is left alone, silently, and once the seal is loaded nothing
 * interrupts the change, so a wake is never sent without its intent and acknowledgement around it.
 */
export class RecoveryWake extends Schema.TaggedClass<
  RecoveryWake,
  { readonly brand: unique symbol }
>()("RecoveryWake", {}) {}

/** Ship stamping its id on the seal it was handed at sealing: written whatever the seal's state. */
export class ShipLink extends Schema.TaggedClass<
  ShipLink,
  { readonly brand: unique symbol }
>()("ShipLink", {}) {}

/** Filing the Directive without the Liaison, for an abandoned or expired review: a reported seal is left alone, silently. */
export class AutoReport extends Schema.TaggedClass<
  AutoReport,
  { readonly brand: unique symbol }
>()("AutoReport", {}) {}

/** `actor` resuming or taking over a review: its transition refuses a reported seal itself, which saves nothing. */
export class Takeover extends Schema.TaggedClass<
  Takeover,
  { readonly brand: unique symbol }
>()("Takeover", { actor: Actor }) {}

const WriterSchema = Schema.Union([
  ToolCall,
  HostEvent,
  RecoveryWake,
  ShipLink,
  AutoReport,
  Takeover,
]).pipe(Schema.toTaggedUnion("_tag"));

type Writer = typeof WriterSchema.Type;

const isToolCall = WriterSchema.isAnyOf(["ToolCall"]);

const isRecoveryWake = WriterSchema.isAnyOf(["RecoveryWake"]);

/** Writers that leave a reported seal alone: the door returns nothing for them then. */
type Quiet = HostEvent | RecoveryWake | AutoReport;

/** What a transition changed: the seal and ledger it rebuilt (absent: unchanged, nothing written). */
const RevisedSchema = Schema.Struct({
  ledger: Schema.optional(Ledger),
  report: Schema.optional(Schema.Undefined),
  seal: Schema.optional(Seal),
});

/** Filing the Directive: the reported seal and its report, written together. It hands back no ledger. */
const FiledSchema = Schema.Struct({
  ledger: Schema.optional(Schema.Undefined),
  report: Schema.String,
  seal: Seal,
});

/** What a transition hands the door: what it changed or filed, and its output. */
type Revision<A> = (typeof RevisedSchema.Type | typeof FiledSchema.Type) & {
  readonly out: A;
};

/**
 * How the door admits a writer: "write" runs the transition and saves what it hands back, "read" runs it and saves
 * nothing, "skip" does not run it.
 */
const AdmissionSchema = Schema.Literals(["write", "read", "skip"]);

const writes = Schema.is(AdmissionSchema.pick(["write"]));

const skips = Schema.is(AdmissionSchema.pick(["skip"]));

/** How a writer that leaves a reported seal alone is admitted. */
const quietly = (seal: Seal) =>
  Effect.succeed(AdmissionSchema.make(seal.reportedAt ? "skip" : "write"));

const participant = (s: Seal, sessionID: SessionId) =>
  s.ownerSession === sessionID ||
  s.children.some((ch) => ch.session === sessionID);

const make = Effect.gen(function* make() {
  const host = yield* Host;
  const store = yield* Records;
  const catalog = yield* ToolCatalog;
  /**
   * session -> seal id, for the Liaison and the Auditors/Seats/Compliance it dispatched. A cache: the Liaison's
   * `directorate-seal` instruction entry is the durable record, and a child reaches it through its parent session.
   */
  const bindings = yield* Ref.make(HashMap.empty<SessionId, SealId>());
  /** Per session: writing, comparing, and removing its `directorate-seal` entry happen one at a time. */
  const markers = yield* keyedLock;

  const boundTo = (sessionID: SessionId) =>
    Ref.get(bindings).pipe(
      Effect.map((m) => Option.getOrUndefined(HashMap.get(m, sessionID)))
    );

  const bind = (sessionID: SessionId, sealId: SealId) =>
    Ref.update(bindings, HashMap.set(sessionID, sealId));

  const interrupt = (sessionID: SessionId) =>
    host.session
      .interrupt({ resume: false, sessionID })
      .pipe(ignore(`could not interrupt ${sessionID}`));

  const info = Effect.fnUntraced(function* info(sessionID: SessionId) {
    return Option.getOrUndefined(
      yield* host.session.get({ sessionID }).pipe(Effect.option)
    );
  });

  /** The seal id in a session's `directorate-seal` instruction entry (written by `record`), if any. */
  const recordedSeal = Effect.fnUntraced(function* recordedSeal(
    sessionID: SessionId
  ) {
    const entries = yield* host.session.instructions.entry
      .list({ sessionID })
      .pipe(Effect.orElseSucceed(() => []));

    const value = entries.find((e) => e.key === SEAL_ENTRY)?.value;

    return Predicate.isString(value) ? sealIdIn(value) : undefined;
  });

  /** The unreported seal this session belongs to, recovered from persisted records after reload. */
  const active = Effect.fn("Sessions.active")(function* active(
    sessionID: SessionId
  ) {
    const cached = yield* boundTo(sessionID);

    const loadActive = (id: SealId | undefined) =>
      id
        ? store
            .find(id)
            .pipe(
              Effect.map((s) =>
                s && !s.reportedAt && participant(s, sessionID) ? s : undefined
              )
            )
        : Effect.undefined;

    const bound = yield* loadActive(cached);

    if (bound) {
      return bound;
    }

    // Unbind only if no other fiber rebound the session while the seal loaded.
    if (cached) {
      yield* Ref.update(bindings, (m) =>
        Option.getOrUndefined(HashMap.get(m, sessionID)) === cached
          ? HashMap.remove(m, sessionID)
          : m
      );
    }

    let seal = yield* loadActive(yield* recordedSeal(sessionID));

    if (!seal) {
      const child = yield* info(sessionID);

      if (child?.parentID) {
        seal = yield* loadActive(yield* recordedSeal(child.parentID));

        // After takeover the host's parent link is unchanged, but the former Liaison no longer records this seal.
        if (!seal && dispatchableNamed(child.agent)) {
          seal = (yield* store.list()).find(
            (s) =>
              !s.reportedAt && s.children.some((ch) => ch.session === sessionID)
          );
        }
      }
    }

    if (seal) {
      yield* bind(sessionID, seal.id);
    }

    return seal;
  });

  /** The seal, with a participating session bound to it. */
  const sealFor = Effect.fn("Sessions.sealFor")(function* sealFor(
    sessionID: SessionId,
    sealId: SealId
  ) {
    const seal = yield* store.load(sealId);

    if (participant(seal, sessionID) && !seal.reportedAt) {
      yield* bind(sessionID, seal.id);
    }

    return seal;
  });

  /** Records the Liaison's review on its session: the model reads it, and `active` finds the seal by it after a reload. */
  const record = (sessionID: SessionId, seal: Seal) =>
    markers.withLock(
      sessionID,
      host.session.instructions.entry
        .put({
          key: SEAL_ENTRY,
          sessionID,
          value: `Active Directorate containment seal ${seal.id} (${seal.mode}): ${seal.description}. Pass this seal id to every directorate_* tool and assignment.`,
        })
        .pipe(ignore("could not set seal instructions", "Warn"))
    );

  /** Removes a session's entry if it still records `sealId`: a review recorded since then keeps its entry. */
  const forget = (sessionID: SessionId, sealId: SealId) =>
    markers.withLock(
      sessionID,
      Effect.gen(function* forgetLocked() {
        if ((yield* recordedSeal(sessionID)) !== sealId) {
          return;
        }

        yield* host.session.instructions.entry
          .remove({ key: SEAL_ENTRY, sessionID })
          .pipe(ignore("could not clear seal instructions"));
      })
    );

  // ---------- the door ----------

  /** A tool call's guards: what a reported seal does to it, then owner-only, then lockdown. */
  const called = Effect.fnUntraced(function* called(
    seal: Seal,
    call: ToolCall
  ) {
    if (seal.reportedAt) {
      if (call.showsReported) {
        return AdmissionSchema.make("read");
      }

      return yield* new SealReported({
        autoReported: seal.autoReported === true,
        seal: seal.id,
      });
    }

    if (call.ownerOnly && seal.ownerSession !== call.actor.session) {
      return yield* new NotOwner({ seal: seal.id, tool: call.tool });
    }

    // A model step that began before the deadline still sees the tools stripped at lockdown, and the lock may have been
    // held past it: check under the seal's lock.
    if (
      call.catalogChecked &&
      !(yield* catalog.keeps(call.actor.agent, call.tool)) &&
      isLocked((yield* budget(seal.window)).phase)
    ) {
      return yield* new Lockdown({
        agent: call.actor.agent,
        seal: seal.id,
        tool: call.tool,
      });
    }

    return AdmissionSchema.make("write");
  });

  /**
   * Whether `writer` may change `seal`: "write" runs the transition and saves what it hands back, "read" runs it on a
   * reported seal and saves nothing, "skip" leaves a reported seal alone without running it.
   */
  const admit = (seal: Seal, writer: Writer) =>
    WriterSchema.match(writer, {
      AutoReport: () => quietly(seal),
      HostEvent: () => quietly(seal),
      RecoveryWake: () => quietly(seal),
      ShipLink: () => Effect.succeed(AdmissionSchema.make("write")),
      Takeover: () =>
        Effect.succeed(
          AdmissionSchema.make(seal.reportedAt ? "read" : "write")
        ),
      ToolCall: (call) => called(seal, call),
    });

  /** Writes what a revision changed: the report with its seal, the ledger before the seal, or either alone. */
  const persist = (sealId: SealId, revision: Revision<unknown>) => {
    if (revision.report !== undefined) {
      return store.publish(revision.seal, revision.report);
    }

    if (revision.seal && revision.ledger) {
      return store.saveBoth(revision.seal, revision.ledger);
    }

    if (revision.ledger) {
      return store.saveLedger(sealId, revision.ledger);
    }

    return revision.seal ? store.save(revision.seal) : Effect.void;
  };

  /** The seal under its lock: a tool caller that participates in it is bound to it on the way. */
  const loaded = (sealId: SealId, writer: Writer) =>
    isToolCall(writer)
      ? sealFor(writer.actor.session, sealId)
      : store.load(sealId);

  /** What the door itself may fail with, besides the transition's own failures. */
  type DoorError =
    | Effect.Error<ReturnType<typeof store.withLock<never, never, never>>>
    | Effect.Error<ReturnType<typeof loaded>>
    | Effect.Error<ReturnType<typeof admit>>
    | Effect.Error<ReturnType<typeof persist>>;

  /** The review a transition reads: the seal as loaded, its ledger when asked for, and a write-ahead save. */
  const reviewOf = (
    seal: Seal,
    save: (
      revision: Revision<undefined>
    ) => Effect.Effect<void, Effect.Error<ReturnType<typeof persist>>>
  ) => ({
    /** Saves `next` now, before an outside effect the transition goes on to cause; the door still saves the result. */
    checkpoint: (next: Seal) => save({ out: undefined, seal: next }),
    ledger: store.loadLedger(seal.id),
    seal,
  });

  type Review = ReturnType<typeof reviewOf>;

  /**
   * The one door: under the seal's cross-process lock it loads the review, applies the guards `writer` is subject to,
   * runs `transition`, saves what it changed, and returns its output. Writers that leave a reported seal alone get
   * nothing back from one.
   */
  function mutate<T extends Revision<unknown>, E, R>(
    sealId: SealId,
    writer: Quiet,
    transition: (review: Review) => Effect.Effect<T, E, R>
  ): Effect.Effect<T["out"] | undefined, DoorError | E, R>;
  function mutate<T extends Revision<unknown>, E, R>(
    sealId: SealId,
    writer: Writer,
    transition: (review: Review) => Effect.Effect<T, E, R>
  ): Effect.Effect<T["out"], DoorError | E, R>;
  function mutate<T extends Revision<unknown>, E, R>(
    sealId: SealId,
    writer: Writer,
    transition: (review: Review) => Effect.Effect<T, E, R>
  ) {
    const body = Effect.gen(function* review() {
      const seal = yield* loaded(sealId, writer);
      const admitted = yield* admit(seal, writer);

      if (skips(admitted)) {
        return;
      }

      const save = (revision: Revision<unknown>) =>
        writes(admitted) ? persist(sealId, revision) : Effect.void;

      const revision = yield* transition(reviewOf(seal, save));
      yield* save(revision);

      return revision.out;
    });

    return store.withLock(
      sealId,
      isRecoveryWake(writer) ? Effect.uninterruptible(body) : body
    );
  }

  /** Runs `body` on the seal through the door, after the guards `call` is subject to; it hands back no change, so nothing is written. */
  const read = <A, E, R>(
    sealId: SealId,
    call: ToolCall,
    body: (seal: Seal) => Effect.Effect<A, E, R>
  ) =>
    mutate(sealId, call, ({ seal }) =>
      Effect.map(body(seal), (out) => ({ out }))
    );

  return {
    active,
    /** The session's agent, as the host falls back to when a permission request names none. */
    agent: (sessionID: SessionId) =>
      info(sessionID).pipe(Effect.map((i) => i?.agent)),
    bind,
    /** Seal ids some session is bound to. */
    boundSeals: Ref.get(bindings).pipe(
      Effect.map((m) => new Set(HashMap.values(m)))
    ),
    boundTo,
    /** Ends every session's work on a reported seal: running children stop, and its bindings and record go. */
    close: Effect.fn("Sessions.close")(function* close(seal: Seal) {
      yield* Effect.forEach(
        outstandingDispatches(seal).flatMap((ch) =>
          ch.session ? [ch.session] : []
        ),
        interrupt,
        { concurrency: "unbounded", discard: true }
      );
      yield* Ref.update(
        bindings,
        HashMap.filter((id) => id !== seal.id)
      );

      if (seal.ownerSession) {
        yield* forget(seal.ownerSession, seal.id);
      }
    }),
    directory: (sessionID: SessionId) =>
      info(sessionID).pipe(Effect.map((i) => i?.location.directory)),
    /** The host's record of a session, or none if it is gone or was never one. */
    info,
    interrupt,
    mutate,
    /** Tells the seal's owner session something without starting a turn. */
    notify: (seal: Seal, text: string) =>
      seal.ownerSession
        ? host.session
            .synthetic({ resume: false, sessionID: seal.ownerSession, text })
            .pipe(ignore(`could not notify the owner of ${seal.id}`, "Warn"))
        : Effect.void,
    read,
    record,
    recordedSeal,
    sealFor,
    /** A resumed seal's new owner session takes it over from the previous one. */
    takeOver: Effect.fn("Sessions.takeOver")(function* takeOver(
      seal: Seal,
      previousOwner: SessionId | undefined
    ) {
      const owner = seal.ownerSession;

      if (!owner) {
        return;
      }

      yield* Ref.update(bindings, (m) =>
        HashMap.set(
          previousOwner ? HashMap.remove(m, previousOwner) : m,
          owner,
          seal.id
        )
      );

      if (previousOwner && previousOwner !== owner) {
        yield* forget(previousOwner, seal.id);
      }

      yield* record(owner, seal);
    }),
  };
});

export class Sessions extends Context.Service<
  Sessions,
  Effect.Success<typeof make>
>()("directorate/Sessions") {
  static readonly layer = Layer.effect(Sessions, make);
}

/** Sessions, answering records' ActiveSeal port. */
export const sealLayer = Layer.effect(
  ActiveSeal,
  Effect.map(Effect.service(Sessions), (sessions) =>
    ActiveSeal.of({ active: sessions.active, directory: sessions.directory })
  )
).pipe(Layer.provideMerge(Sessions.layer));

/** A tool result; while the seal is open, it ends with the caller's budget line (the Liaison's for unknown callers). */
export const done = Effect.fnUntraced(function* done(
  seal: Seal,
  text: string,
  by?: Actor
) {
  return {
    content: seal.reportedAt
      ? text
      : `${text}\n\n${yield* budgetLine(by?.role ?? Liaison, seal.window)}`,
  };
});

/** A new review's first seal and ledger. */
const OpenedSchema = Schema.Struct({ ledger: Ledger, seal: Seal });

/**
 * Opens review `id`, the door's sibling for a review that does not exist yet: `attempt` captures into the new seal's
 * directory and hands back the first seal and ledger, written together. If it fails before they are, the directory goes.
 * It needs no host session, so a review opens wherever capture runs.
 */
export const openReview = <A, E, R>(
  id: SealId,
  attempt: Effect.Effect<typeof OpenedSchema.Type & { readonly out: A }, E, R>
) =>
  Effect.flatMap(Effect.service(Records), (store) =>
    store.create(
      id,
      attempt.pipe(
        Effect.flatMap((opened) =>
          store.saveBoth(opened.seal, opened.ledger).pipe(Effect.as(opened.out))
        )
      )
    )
  );
