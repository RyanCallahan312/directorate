// Directorate sessions: which seal each OpenCode session works on, and the host operations on those sessions.
import type { Plugin } from "@opencode/plugin/effect";
import { Session } from "@opencode/schema/session";
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

import { childOutstanding } from "./children.ts";
import { ignore } from "./error.ts";
import type { Seal } from "./model.ts";
import { Store } from "./store.ts";

/** The OpenCode host, as it gave itself to the plugin. */
export class Host extends Context.Service<Host, Plugin.Context>()(
  "directorate/Host"
) {}

const SEAL_ENTRY = "directorate-seal";
const SEAL_IN_ENTRY = /\bdirectorate-\d{14}-[0-9a-f]{6}\b/;
/** A host session id, or none for anything else (hook events are typed loosely). */
const asSessionID = Schema.decodeUnknownOption(Session.ID);
const participant = (s: Seal, sessionID: string) =>
  s.ownerSession === sessionID ||
  s.children.some((ch) => ch.session === sessionID);

const make = Effect.gen(function* () {
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

  const info = Effect.fnUntraced(function* (sessionID: string) {
    const id = Option.getOrUndefined(asSessionID(sessionID));
    return id
      ? Option.getOrUndefined(
          yield* host.session.get({ sessionID: id }).pipe(Effect.option)
        )
      : undefined;
  });
  /** The seal id in a session's `directorate-seal` instruction entry (written by `record`), if any. */
  const recordedSeal = Effect.fnUntraced(function* (sessionID: string) {
    const id = Option.getOrUndefined(asSessionID(sessionID));
    if (!id) return undefined;
    const entries = yield* host.session.instructions.entry
      .list({ sessionID: id })
      .pipe(Effect.orElseSucceed(() => []));
    const value = entries.find((e) => e.key === SEAL_ENTRY)?.value;
    return Predicate.isString(value)
      ? SEAL_IN_ENTRY.exec(value)?.[0]
      : undefined;
  });
  /** The unreported seal this session belongs to: cached, else recorded on the session, else on its parent (a child). */
  const active = Effect.fn("Sessions.active")(function* (sessionID: string) {
    const cached = yield* boundTo(sessionID);
    const parent = Effect.fnUntraced(function* () {
      const parentID = (yield* info(sessionID))?.parentID;
      return parentID ? yield* recordedSeal(parentID) : undefined;
    });
    const id = cached ?? (yield* recordedSeal(sessionID)) ?? (yield* parent());
    if (!id) return undefined;
    const s = yield* store.load(id).pipe(Effect.orElseSucceed(() => undefined));
    if (s && !s.reportedAt && participant(s, sessionID)) {
      if (!cached) yield* bind(sessionID, s.id);
      return s;
    }
    // Unbind only if no other fiber rebound the session while the seal loaded.
    if (cached)
      yield* Ref.update(bindings, (m) =>
        Option.getOrUndefined(HashMap.get(m, sessionID)) === id
          ? HashMap.remove(m, sessionID)
          : m
      );
    return undefined;
  });
  /** The seal, with a participating session bound to it. */
  const sealFor = Effect.fn("Sessions.sealFor")(function* (
    sessionID: string,
    sealId: string
  ) {
    const seal = yield* store.load(sealId);
    if (participant(seal, sessionID) && !seal.reportedAt)
      yield* bind(sessionID, seal.id);
    return seal;
  });
  /** Records the Liaison's review on its session: the model reads it, and `active` finds the seal by it after a reload. */
  const record = (sessionID: string, seal: Seal) =>
    host.session.instructions.entry
      .put({
        sessionID: Session.ID.make(sessionID),
        key: SEAL_ENTRY,
        value: `Active Directorate containment seal ${seal.id} (${seal.mode}): ${seal.description}. Pass this seal id to every directorate_* tool and assignment.`,
      })
      .pipe(ignore("could not set seal instructions", "Warn"));
  const forget = (sessionID: string) =>
    host.session.instructions.entry
      .remove({ sessionID: Session.ID.make(sessionID), key: SEAL_ENTRY })
      .pipe(ignore("could not clear seal instructions"));

  return {
    boundTo,
    bind,
    active,
    sealFor,
    record,
    /** Seal ids some session is bound to. */
    boundSeals: Ref.get(bindings).pipe(
      Effect.map((m) => new Set(HashMap.values(m)))
    ),
    directory: (sessionID: string) =>
      info(sessionID).pipe(Effect.map((i) => i?.location.directory)),
    /** The session's agent, as the host falls back to when a permission request names none. */
    agent: (sessionID: string) =>
      info(sessionID).pipe(Effect.map((i) => i?.agent)),
    /** Runs body under the seal's cross-process lock, on a freshly loaded seal. */
    locked: <A, E, R>(
      sessionID: string,
      sealId: string,
      body: (seal: Seal) => Effect.Effect<A, E, R>
    ) =>
      store.withLock(sealId, Effect.flatMap(sealFor(sessionID, sealId), body)),
    /** Changes an open seal under its lock; `change` returns undefined when nothing changed, and only changes are written. */
    update: (id: string, change: (s: Seal) => Seal | undefined) =>
      store.withLock(
        id,
        Effect.gen(function* () {
          const s = yield* store.load(id);
          const next = s.reportedAt ? undefined : change(s);
          if (next) yield* store.save(next);
        })
      ),
    /** A resumed seal's new owner session takes it over from the previous one. */
    takeOver: Effect.fn("Sessions.takeOver")(function* (
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
      if (previousOwner && previousOwner !== seal.ownerSession)
        yield* forget(previousOwner);
      yield* record(seal.ownerSession, seal);
    }),
    /** Ends every session's work on a reported seal: running children stop, and its bindings and record go. */
    close: Effect.fn("Sessions.close")(function* (seal: Seal) {
      yield* Effect.forEach(
        childOutstanding(seal).flatMap((ch) =>
          ch.session ? [ch.session] : []
        ),
        (session) =>
          host.session
            .interrupt({ sessionID: Session.ID.make(session), resume: false })
            .pipe(ignore(`could not interrupt ${session}`)),
        { concurrency: "unbounded", discard: true }
      );
      yield* Ref.update(
        bindings,
        HashMap.filter((id) => id !== seal.id)
      );
      yield* forget(seal.ownerSession);
    }),
    /** Tells the seal's owner session something without starting a turn. */
    notify: (seal: Seal, text: string) =>
      host.session
        .synthetic({
          sessionID: Session.ID.make(seal.ownerSession),
          text,
          resume: false,
        })
        .pipe(ignore(`could not notify the owner of ${seal.id}`, "Warn")),
  };
});

export class Sessions extends Context.Service<
  Sessions,
  Effect.Success<typeof make>
>()("directorate/Sessions") {
  static readonly layer = Layer.effect(Sessions, make);
}
