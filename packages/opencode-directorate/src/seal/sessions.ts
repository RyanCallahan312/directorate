// Directorate sessions: which seal each OpenCode session works on, the host operations on those sessions, and the door
// every tool change to an open seal goes through.
import { Session } from "@opencode/schema/session";
import type { Tool } from "@opencode/schema/tool";
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

import { childOutstanding } from "../children.ts";
import {
  budgetLine,
  CHILD_ROLE_SET,
  LOCKED_TOOLS,
  REVIEWER,
} from "../feature/agents/agent.ts";
import { failure, ignore } from "../platform/error.ts";
import { Host } from "../platform/platform.ts";
import type { Body } from "../platform/platform.ts";
import { ActiveSeal, Store } from "../records/records.ts";
import { budget } from "../workflow/review/window.ts";
import type { Seal } from "./record.ts";

const SEAL_ENTRY = "directorate-seal";
const SEAL_IN_ENTRY = /\bdirectorate-\d{14}-[0-9a-f]{6}\b/u;

/** A host session id, or none for anything else (hook events are typed loosely). */
const asSessionID = Schema.decodeUnknownOption(Session.ID);

const participant = (s: Seal, sessionID: string) =>
  s.ownerSession === sessionID ||
  s.children.some((ch) => ch.session === sessionID);

const make = Effect.gen(function* make() {
  const host = yield* Host;
  const store = yield* Store;
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
    HashMap.empty<string, { parent: string; seal: string }>()
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
        if (!seal && CHILD_ROLE_SET.has(String(child.agent))) {
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
        childOutstanding(seal).flatMap((ch) =>
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
    /** Runs body under the seal's cross-process lock, on a freshly loaded seal. */
    locked: <A, E, R>(
      sessionID: string,
      sealId: string,
      body: (seal: Seal) => Effect.Effect<A, E, R>
    ) =>
      store.withLock(sealId, Effect.flatMap(sealFor(sessionID, sealId), body)),
    /** Tells the seal's owner session something without starting a turn. */
    notify: (seal: Seal, text: string) =>
      host.session
        .synthetic({
          resume: false,
          sessionID: Session.ID.make(seal.ownerSession),
          text,
        })
        .pipe(ignore(`could not notify the owner of ${seal.id}`, "Warn")),
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
    /** Changes an open seal under its lock; `change` returns undefined when nothing changed, and only changes are written. */
    update: (id: string, change: (s: Seal) => Seal | undefined) =>
      store.withLock(
        id,
        Effect.gen(function* update() {
          const s = yield* store.load(id);
          const next = s.reportedAt ? undefined : change(s);

          if (next) {
            yield* store.save(next);
          }
        })
      ),
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

/** A tool result; while the seal is open, it ends with the caller's budget line. */
export const done = Effect.fnUntraced(function* done(
  seal: Seal,
  text: string,
  agent?: string
) {
  return {
    content: seal.reportedAt
      ? text
      : `${text}\n\n${yield* budgetLine(seal, agent)}`,
  };
});

/** A reported seal accepts no changes; an owner-only tool also needs the session that sealed it. */
export const writable = (
  seal: Seal,
  c: Tool.Context,
  name: string,
  ownerOnly = false
) => {
  if (seal.reportedAt) {
    return failure(
      `${seal.id} was already reported${seal.autoReported ? " (filed automatically)" : ""}; containment is closed and accepts no further changes. Open a new seal for new work.`
    );
  }

  return ownerOnly && seal.ownerSession !== c.sessionID
    ? failure(
        `Only the session that sealed ${seal.id} may call ${name}. To take over an interrupted review, call directorate_seal with resume: "${seal.id}".`
      )
    : Effect.void;
};

/** Runs body under the seal's lock, on a freshly loaded seal. */
export const locked = <A, R>(
  c: Tool.Context,
  sealId: string,
  body: Body<[seal: Seal], A, R>
) =>
  Effect.flatMap(Effect.service(Sessions), (sessions) =>
    sessions.locked(c.sessionID, sealId, (seal) => Effect.gen(() => body(seal)))
  );

/**
 * Once an open seal's budget locks, only the caller's locked tools run: a model step that began before the deadline still
 * sees the tools stripped at lockdown, and the lock may have been held past it. Check under the seal's lock.
 */
export const unlocked = Effect.fnUntraced(function* unlocked(
  seal: Seal,
  c: Tool.Context,
  name: string
) {
  if (
    !seal.reportedAt &&
    !LOCKED_TOOLS.get(c.agent)?.has(name) &&
    (yield* budget(seal)).phase === "locked"
  ) {
    return yield* failure(
      `Directorate lockdown: the budget for ${seal.id} is locked, so ${name} no longer runs. ${c.agent === REVIEWER ? "Call directorate_report now." : "Hand off what you hold now."}`
    );
  }
});

/** A change to an open seal, under its lock; once the budget locks, only the caller's locked tools run. */
export const mutate = <A, R>(
  c: Tool.Context,
  sealId: string,
  name: string,
  body: Body<[seal: Seal], A, R>,
  ownerOnly = false
) =>
  locked(c, sealId, function* mutateSeal(seal) {
    yield* writable(seal, c, name, ownerOnly);
    yield* unlocked(seal, c, name);

    return yield* body(seal);
  });
