// Directorate sessions: which seal each OpenCode session works on, the host operations on those sessions, and the door
// every write to a review (its seal and its ledger) goes through.
import { Session } from "@opencode/schema/session";
import {
  Context,
  Effect,
  Function,
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
import { Host, ToolCatalog } from "../platform/platform.ts";
import { ActiveSeal, Records } from "../records/records.ts";
import { budget, isLocked } from "../workflow/review/window.ts";
import { Seal } from "./record.ts";

const SEAL_ENTRY = "directorate-seal";
const SEAL_IN_ENTRY = /\bdirectorate-\d{14}-[0-9a-f]{6}\b/u;

/** A reported seal accepts no changes. */
class SealReported extends Schema.TaggedError<
  SealReported,
  { readonly brand: unique symbol }
>()("SealReported", {
  autoReported: Schema.Boolean,
  seal: Schema.String,
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
  seal: Schema.String,
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
  seal: Schema.String,
  tool: Schema.String,
}) {
  override get message() {
    return `Directorate lockdown: the budget for ${this.seal} is locked, so ${this.tool} no longer runs. ${this.agent === Liaison.id ? "Call directorate_report now." : "Hand off what you hold now."}`;
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
    Schema.withConstructorDefault(Effect.succeed("participants" as const))
  ),
  lockdown: LockdownCheckSchema.pipe(
    Schema.withConstructorDefault(Effect.succeed("catalog" as const))
  ),
  reported: ReportedSchema.pipe(
    Schema.withConstructorDefault(Effect.succeed("refused" as const))
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

/** The watchdog's sweep, stamping a ship on an older seal: a reported seal is left alone, silently. */
export class Watchdog extends Schema.TaggedClass<
  Watchdog,
  { readonly brand: unique symbol }
>()("Watchdog", {}) {}

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
  Watchdog,
  RecoveryWake,
  ShipLink,
  AutoReport,
  Takeover,
]).pipe(Schema.toTaggedUnion("_tag"));

type Writer = typeof WriterSchema.Type;

/** Writers that leave a reported seal alone: the door returns nothing for them then. */
type Quiet = HostEvent | Watchdog | RecoveryWake | AutoReport;

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

/** The seal and Liaison session a subagent call was launched for. */
const LaunchSchema = Schema.Struct({
  parent: Schema.String,
  seal: Schema.String,
});

/** How a writer that leaves a reported seal alone is admitted. */
const quietly = (seal: Seal) =>
  Effect.succeed(seal.reportedAt ? ("skip" as const) : ("write" as const));

/** A host session id, or none for anything else (hook events are typed loosely). */
const asSessionID = Schema.decodeUnknownOption(Session.ID);

const participant = (s: Seal, sessionID: string) =>
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
  const bindings = yield* Ref.make(HashMap.empty<string, string>());

  const boundTo = (sessionID: string) =>
    Ref.get(bindings).pipe(
      Effect.map((m) => Option.getOrUndefined(HashMap.get(m, sessionID)))
    );

  const bind = (sessionID: string, sealId: string) =>
    Ref.update(bindings, HashMap.set(sessionID, sealId));

  /**
   * Subagent call -> the seal and Liaison session it was launched for, until the subagent tool returns. A report can
   * close the seal before the launch links to its child session; the late child is stopped, not left running unowned.
   */
  const launches = yield* Ref.make(
    HashMap.empty<string, typeof LaunchSchema.Type>()
  );

  const interrupt = (sessionID: string) =>
    host.session
      .interrupt({ resume: false, sessionID: Session.ID.make(sessionID) })
      .pipe(ignore(`could not interrupt ${sessionID}`));

  const info = Effect.fnUntraced(function* info(sessionID: string) {
    const id = Option.getOrUndefined(asSessionID(sessionID));

    return id
      ? Option.getOrUndefined(
          yield* host.session.get({ sessionID: id }).pipe(Effect.option)
        )
      : undefined;
  });

  /** The seal id in a session's `directorate-seal` instruction entry (written by `record`), if any. */
  const recordedSeal = Effect.fnUntraced(function* recordedSeal(
    sessionID: string
  ) {
    const id = Option.getOrUndefined(asSessionID(sessionID));

    if (!id) {
      return;
    }

    const entries = yield* host.session.instructions.entry
      .list({ sessionID: id })
      .pipe(Effect.orElseSucceed(() => []));

    const value = entries.find((e) => e.key === SEAL_ENTRY)?.value;

    return Predicate.isString(value)
      ? SEAL_IN_ENTRY.exec(value)?.[0]
      : undefined;
  });

  /** The unreported seal this session belongs to, recovered from persisted records after reload. */
  const active = Effect.fn("Sessions.active")(function* active(
    sessionID: string
  ) {
    const cached = yield* boundTo(sessionID);

    const loadActive = (id: string | undefined) =>
      id
        ? store.load(id).pipe(
            Effect.orElseSucceed(Function.constUndefined),
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
    sessionID: string,
    sealId: string
  ) {
    const seal = yield* store.load(sealId);

    if (participant(seal, sessionID) && !seal.reportedAt) {
      yield* bind(sessionID, seal.id);
    }

    return seal;
  });

  /** Records the Liaison's review on its session: the model reads it, and `active` finds the seal by it after a reload. */
  const record = (sessionID: string, seal: Seal) =>
    host.session.instructions.entry
      .put({
        key: SEAL_ENTRY,
        sessionID: Session.ID.make(sessionID),
        value: `Active Directorate containment seal ${seal.id} (${seal.mode}): ${seal.description}. Pass this seal id to every directorate_* tool and assignment.`,
      })
      .pipe(ignore("could not set seal instructions", "Warn"));

  const forget = (sessionID: string) =>
    host.session.instructions.entry
      .remove({ key: SEAL_ENTRY, sessionID: Session.ID.make(sessionID) })
      .pipe(ignore("could not clear seal instructions"));

  // ---------- the door ----------

  /** A tool call's guards: what a reported seal does to it, then owner-only, then lockdown. */
  const called = Effect.fnUntraced(function* called(
    seal: Seal,
    call: ToolCall
  ) {
    if (seal.reportedAt) {
      if (call.showsReported) {
        return "read" as const;
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

    return "write" as const;
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
      ShipLink: () => Effect.succeed("write" as const),
      Takeover: () =>
        Effect.succeed(
          seal.reportedAt ? ("read" as const) : ("write" as const)
        ),
      ToolCall: (call) => called(seal, call),
      Watchdog: () => quietly(seal),
    });

  /** Writes what a revision changed: the report with its seal, the ledger before the seal, or either alone. */
  const persist = (sealId: string, revision: Revision<unknown>) => {
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
  const loaded = (sealId: string, writer: Writer) =>
    WriterSchema.isAnyOf(["ToolCall"])(writer)
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
    sealId: string,
    writer: Quiet,
    transition: (review: Review) => Effect.Effect<T, E, R>
  ): Effect.Effect<T["out"] | undefined, DoorError | E, R>;
  function mutate<T extends Revision<unknown>, E, R>(
    sealId: string,
    writer: Writer,
    transition: (review: Review) => Effect.Effect<T, E, R>
  ): Effect.Effect<T["out"], DoorError | E, R>;
  function mutate<T extends Revision<unknown>, E, R>(
    sealId: string,
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
      WriterSchema.isAnyOf(["RecoveryWake"])(writer)
        ? Effect.uninterruptible(body)
        : body
    );
  }

  /** Runs `read` on the seal under its lock, after the guards `call` is subject to; it writes nothing. */
  const read = <A, E, R>(
    sealId: string,
    call: ToolCall,
    body: (seal: Seal) => Effect.Effect<A, E, R>
  ) =>
    store.withLock(
      sealId,
      Effect.gen(function* readLocked() {
        const seal = yield* sealFor(call.actor.session, sealId);
        yield* called(seal, call);

        return yield* body(seal);
      })
    );

  return {
    active,
    /** The session's agent, as the host falls back to when a permission request names none. */
    agent: (sessionID: string) =>
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
      yield* forget(seal.ownerSession);
    }),
    directory: (sessionID: string) =>
      info(sessionID).pipe(Effect.map((i) => i?.location.directory)),
    /** The host's record of a session, or none if it is gone or was never one. */
    info,
    interrupt,
    /** A subagent call the Liaison of `parent` made for `seal`, open until `launchSettled`. */
    launch: (call: string, seal: string, parent: string) =>
      Ref.update(launches, HashMap.set(call, { parent, seal })),
    launchSettled: (call: string) => Ref.update(launches, HashMap.remove(call)),
    /** The seal a subagent call was launched for, if it has not settled. */
    launchedFor: (call: string) =>
      Ref.get(launches).pipe(
        Effect.map((m) => Option.getOrUndefined(HashMap.get(m, call))?.seal)
      ),
    /** Seal ids of the unsettled subagent calls `parent` made. */
    launchesBy: (parent: string) =>
      Ref.get(launches).pipe(
        Effect.map(
          (m) =>
            new Set(
              [...HashMap.values(m)].flatMap((l) =>
                l.parent === parent ? [l.seal] : []
              )
            )
        )
      ),
    mutate,
    /** Tells the seal's owner session something without starting a turn. */
    notify: (seal: Seal, text: string) =>
      host.session
        .synthetic({
          resume: false,
          sessionID: Session.ID.make(seal.ownerSession),
          text,
        })
        .pipe(ignore(`could not notify the owner of ${seal.id}`, "Warn")),
    read,
    record,
    recordedSeal,
    sealFor,
    /** A resumed seal's new owner session takes it over from the previous one. */
    takeOver: Effect.fn("Sessions.takeOver")(function* takeOver(
      seal: Seal,
      previousOwner: string
    ) {
      yield* Ref.update(bindings, (m) =>
        HashMap.set(
          HashMap.remove(m, previousOwner),
          seal.ownerSession,
          seal.id
        )
      );

      if (previousOwner && previousOwner !== seal.ownerSession) {
        yield* forget(previousOwner);
      }

      yield* record(seal.ownerSession, seal);
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
  id: string,
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
