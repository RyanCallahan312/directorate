// Dispatches: the Directorate Auditor, Seat, and Compliance runs a review sends out, stored in seal.json's children, as a
// region of the review's state chart: launching → running → completed | failed, and a completed run that works again is
// running again. Each transition returns the new seal, or undefined if nothing changed, so callers write only changes.
import { DateTime, Match, Schema, SchemaGetter } from "effect";

import { Time } from "../../platform/stored.ts";
import type { Seal } from "../../seal/record.ts";
import {
  Auditor,
  dispatchableNamed,
  Compliance,
  Seat as SeatAgent,
} from "../agents/agent.ts";
import type { Actor } from "../agents/agent.ts";
import type { Ledger } from "../ledger/entry.ts";

const opt = Schema.optional;

/** A follow-up's prompt as it moves through the child session's inbox: queued as `inbox`, then delivered. */
const FollowUpSchema = Schema.Struct({
  delivered: opt(Schema.Boolean),
  inbox: opt(Schema.String),
});

/**
 * What every run carries in every state. Seals hold whatever any version wrote, so a run keeps each field it was stored
 * with in any state: a run that never linked its session can still complete, and a follow-up keeps its inbox record.
 */
const dispatchFields = {
  /** The agent it runs, as stored: an Auditor, Seat, or Compliance id for every launch today (see `dispatchedAgent`). */
  agent: Schema.String,
  call: Schema.String,
  /** The human-readable part of the OpenCode child session's title. */
  description: opt(Schema.String),
  /**
   * When it ended. Every transition to completed or failed sets it, and none to launching or running keeps it, but seals
   * may hold either combination; it is carried as stored.
   */
  endedAt: opt(Schema.DateTimeUtc),
  /** A follow-up to an existing child session: a new run of it, or joined to its running one. */
  followUp: opt(FollowUpSchema),
  /** The model the launch named, which for a Directorate Seat is its seat. */
  model: opt(Schema.String),
  prompt: Schema.String,
  session: opt(Schema.String),
  startedAt: Schema.DateTimeUtc,
};

const DispatchFieldsSchema = Schema.Struct(dispatchFields);

type DispatchFields = typeof DispatchFieldsSchema.Type;

/** Registered by the subagent tool's hook, before OpenCode creates its session (a follow-up already has one). */
export class Launching extends Schema.TaggedClass<
  Launching,
  { readonly brand: unique symbol }
>()("Launching", dispatchFields) {}

/** Its session is working: linked at session.created, or a delivered follow-up, or a completed run working again. */
export class Running extends Schema.TaggedClass<
  Running,
  { readonly brand: unique symbol }
>()("Running", dispatchFields) {}

export class Completed extends Schema.TaggedClass<
  Completed,
  { readonly brand: unique symbol }
>()("Completed", dispatchFields) {}

export class Failed extends Schema.TaggedClass<
  Failed,
  { readonly brand: unique symbol }
>()("Failed", dispatchFields) {}

/** One run the Liaison sends out in this review. */
export const DispatchSchema = Schema.Union([
  Launching,
  Running,
  Completed,
  Failed,
]).pipe(Schema.toTaggedUnion("_tag"));

export type Dispatch = typeof DispatchSchema.Type;

const isOutstanding = DispatchSchema.isAnyOf(["Launching", "Running"]);
const isLaunching = DispatchSchema.isAnyOf(["Launching"]);
const isCompleted = DispatchSchema.isAnyOf(["Completed"]);
const isFailed = DispatchSchema.isAnyOf(["Failed"]);

/** A dispatch's state, as seal.json names it. */
const DispatchStatusSchema = Schema.Literals([
  "launching",
  "running",
  "completed",
  "failed",
]);

type DispatchStatus = typeof DispatchStatusSchema.Type;

/** A dispatch in seal.json's children: its state is a `status` field, not a tag. */
const StoredDispatch = Schema.Struct({
  agent: Schema.String,
  call: Schema.String,
  /** The human-readable part of the OpenCode child session's title. */
  description: opt(Schema.String),
  endedAt: opt(Time),
  followUp: opt(FollowUpSchema),
  /** The model the launch named, which for a Directorate Seat is its seat. */
  model: opt(Schema.String),
  prompt: Schema.String,
  session: opt(Schema.String),
  startedAt: Time,
  status: DispatchStatusSchema,
});

/** The state class a dispatch is in. */
const stateOf = (d: Dispatch) =>
  DispatchSchema.match(d, {
    Completed: () => Completed,
    Failed: () => Failed,
    Launching: () => Launching,
    Running: () => Running,
  });

/** A dispatch's state as seal.json and readers name it. */
export const statusOf = (d: Dispatch) =>
  DispatchSchema.match(d, {
    Completed: () => "completed" as const,
    Failed: () => "failed" as const,
    Launching: () => "launching" as const,
    Running: () => "running" as const,
  });

const stateFor = (status: DispatchStatus) =>
  Match.value(status).pipe(
    Match.when("launching", () => Launching),
    Match.when("running", () => Running),
    Match.when("completed", () => Completed),
    Match.when("failed", () => Failed),
    Match.exhaustive
  );

/** A dispatch's fields without its state: what carries over when it changes state. */
const fieldsOf = (d: Dispatch) => DispatchFieldsSchema.make(d);

/** The same state with some fields changed. */
const rebuilt = (d: Dispatch, change: Partial<DispatchFields>) =>
  new (stateOf(d))({ ...fieldsOf(d), ...change });

/** A dispatch as seal.json stores it, every field it was stored with kept. */
export const DispatchFromStored = StoredDispatch.pipe(
  Schema.decodeTo(Schema.toType(DispatchSchema), {
    decode: SchemaGetter.transform(
      (stored) =>
        new (stateFor(stored.status))(DispatchFieldsSchema.make(stored))
    ),
    encode: SchemaGetter.transform((d) => ({
      ...fieldsOf(d),
      status: statusOf(d),
    })),
  })
);

/** The agent a dispatch runs, or undefined for a name no Directorate version dispatches today. */
const dispatchedAgent = (d: Pick<Dispatch, "agent">) =>
  dispatchableNamed(d.agent);

export const outstandingDispatches = (seal: Seal) =>
  seal.children.filter(isOutstanding);

/** One per child session (its latest run), since a follow-up joined to a running child shares its session. */
export const perSession = (runs: readonly Dispatch[]) => [
  ...new Map(runs.map((x) => [x.session ?? x.call, x])).values(),
];

export const dispatchQuestion = (c: Pick<Dispatch, "prompt">) =>
  c.prompt
    .split("\n")
    .find((l) => /^(?:question|entries):/iu.test(l.trim()))
    ?.trim()
    .replace(/^(?:question|entries):\s*/iu, "") ?? c.prompt.slice(0, 160);

/** A panel seat as readers see it: the model without its provider. */
export const seatName = (model: string) => model.slice(model.indexOf("/") + 1);

/** A dispatch as readers see it: a Seat by its model, anyone else by role. */
export const dispatchName = (c: Pick<Dispatch, "agent" | "model">) =>
  dispatchedAgent(c) === SeatAgent && c.model ? seatName(c.model) : c.agent;

/** Whoever raised or decided something, named as `dispatchName` names them. */
export const actorName = (seal: Seal, a: Actor) => {
  const c = seal.children.find((x) => x.session === a.session);

  return c ? dispatchName(c) : a.agent;
};

/** A panel seat's status as the report shows it: a dispatch's, partial, or not launched. */
export const SeatStatusSchema = Schema.Literals([
  ...DispatchStatusSchema.literals,
  "partial",
  "not launched",
]);

type SeatStatus = typeof SeatStatusSchema.Type;

/** A seat's status as the report shows it: completed, partial (a run completed but did not read everything), or its latest run's. */
const seatStatus = (
  done: boolean,
  partial: boolean,
  latest: Dispatch | undefined
): SeatStatus => {
  if (done) {
    return "completed";
  }

  if (partial) {
    return "partial";
  }

  return latest ? statusOf(latest) : "not launched";
};

/**
 * A seat completes only if one of its finished sessions read the entire current generation. It is missing (the next
 * launch may take it) unless it completed or its latest run is still going.
 */
export const panelSeats = (seal: Seal) =>
  (seal.panel ?? []).map((model) => {
    const runs = seal.children.filter(
      (c) => dispatchedAgent(c) === SeatAgent && c.model === model
    );

    const completed = runs.filter(isCompleted);

    const unread = Math.min(
      seal.regions.length,
      ...completed.map(
        (c) =>
          seal.regions.filter(
            (r) => !c.session || !r.readBy.includes(c.session)
          ).length
      )
    );

    const latest = runs.at(-1);
    const going = latest !== undefined && isOutstanding(latest);
    const done = completed.length > 0 && unread === 0;

    const status = seatStatus(done, completed.length > 0 && !going, latest);

    return {
      missing: !done && !going,
      model,
      runs,
      sessions: new Set(runs.flatMap((c) => (c.session ? [c.session] : []))),
      status,
      unread,
    };
  });

/**
 * The next seat a Directorate Seat launch takes: the first with no run that is launching, running, or completed. With
 * no regions there is nothing to review, so no seat is missing.
 */
export const missingSeats = (seal: Seal) =>
  seal.regions.length ? panelSeats(seal).filter((s) => s.missing) : [];

export const openSeat = (seal: Seal) => missingSeats(seal)[0]?.model;

const dispatchKey = (c: Dispatch) =>
  `${c.agent}\0${c.model ?? ""}\0${dispatchQuestion(c)}`;

/** A Compliance run is answered once every entry on its entries line is decided, whichever run decided it. */
const decided = (c: Dispatch, ledger: Ledger) => {
  if (dispatchedAgent(c) !== Compliance || !/^entries:/imu.test(c.prompt)) {
    return false;
  }

  const ids = dispatchQuestion(c).match(/\bF\d+\b/gu) ?? [];

  return (
    ids.length > 0 &&
    ids.every((id) =>
      ledger.entries.some((e) => e.id === id && e.status !== "open")
    )
  );
};

/** An Auditor question as an `answered` note names it: the `question:` line, with or without its label. */
export const questionText = (text: string) =>
  text.trim().replace(/^question:\s*/iu, "");

/** An Auditor run whose question the Liaison recorded as answered itself. */
const answered = (c: Dispatch, ledger: Ledger) =>
  dispatchedAgent(c) === Auditor &&
  ledger.notes.some(
    (n) => n.kind === "answered" && questionText(n.text) === dispatchQuestion(c)
  );

/**
 * Failed dispatches whose question no later run of the same agent (and model) completed or the Liaison answered, or
 * whose entries stay open.
 */
export const failedDispatches = (seal: Seal, ledger: Ledger) => {
  const done = new Set<string>();

  return seal.children
    .toReversed()
    .filter((c) => {
      if (isCompleted(c)) {
        done.add(dispatchKey(c));
      }

      return (
        isFailed(c) &&
        !done.has(dispatchKey(c)) &&
        !decided(c, ledger) &&
        !answered(c, ledger)
      );
    })
    .toReversed();
};

/** Auditor questions a review left unanswered: still running when it closed, or failed and never answered. */
export const unansweredQuestions = (seal: Seal, ledger: Ledger) => [
  ...new Set(
    [...outstandingDispatches(seal), ...failedDispatches(seal, ledger)].flatMap(
      (c) => (dispatchedAgent(c) === Auditor ? [dispatchQuestion(c)] : [])
    )
  ),
];

export const update = (seal: Seal, step: (c: Dispatch) => Dispatch) => {
  const children = seal.children.map(step);

  return children.some((c, i) => c !== seal.children[i])
    ? seal.withDispatches(children)
    : undefined;
};

/** The Liaison launched an Auditor, Seat, or Compliance run. */
export const launched = (seal: Seal, launch: Launching) =>
  seal.withDispatches([...seal.children, launch]);

/** A launch the subagent tool rejected before it ran: there is no child, and no failure to report. */
export const withdrawn = (seal: Seal, launch: Dispatch) =>
  seal.withDispatches(seal.children.filter((c) => c !== launch));

export const launchTitle = (
  launch: Pick<Dispatch, "description" | "agent" | "call">
) => `${launch.description ?? launch.agent} · ${launch.call}`;

/** Claim only the launch whose correlation suffix was sent to OpenCode. */
export const claimed = (
  seal: Seal,
  session: string,
  agent: string,
  title: string | undefined
) => {
  if (seal.children.some((c) => c.session === session)) {
    return;
  }

  const claim = seal.children.find(
    (c) =>
      !c.session &&
      c.agent === agent &&
      isLaunching(c) &&
      launchTitle(c) === title
  );

  return (
    claim &&
    update(seal, (c) =>
      c === claim ? new Running({ ...fieldsOf(c), session }) : c
    )
  );
};

/** A session's latest run; follow-ups can register before older events are consumed. */
const latest = (seal: Seal, session: string) =>
  seal.children.findLast((c) => c.session === session);

/** OpenCode's subagent tool forwards the prompt text, but not the parent tool call ID. */
export const followUpPrompt = (c: Pick<Dispatch, "call" | "prompt">) =>
  `${c.prompt}\n\n[Directorate follow-up: ${c.call}]`;

export const enqueued = (
  seal: Seal,
  session: string,
  inbox: string,
  text: string
) =>
  update(seal, (c) =>
    c.session === session &&
    c.followUp &&
    !c.followUp.inbox &&
    followUpPrompt(c) === text
      ? rebuilt(c, { followUp: { inbox } })
      : c
  );

export const inboxSettled = (
  seal: Seal,
  session: string,
  inbox: string,
  delivered: boolean,
  at: DateTime.Utc
) =>
  update(seal, (c) => {
    if (
      c.session !== session ||
      c.followUp?.inbox !== inbox ||
      c.followUp.delivered ||
      !isOutstanding(c)
    ) {
      return c;
    }

    return delivered
      ? new Running({ ...fieldsOf(c), followUp: { delivered: true, inbox } })
      : new Failed({ ...fieldsOf(c), endedAt: at });
  });

/**
 * A promoted follow-up delivered as `inbox`: still running, or ended as `ending` at `endedAt` with the first terminal
 * marker after it.
 */
export const followUpRecovered = (
  c: Dispatch,
  inbox: string,
  ended?: { ending: typeof Completed | typeof Failed; endedAt: DateTime.Utc }
) => {
  const fields = { ...fieldsOf(c), followUp: { delivered: true, inbox } };

  return ended
    ? new ended.ending({ ...fields, endedAt: ended.endedAt })
    : new Running(fields);
};

/** An execution can drain several delivered prompts, but never settles one still in the inbox. */
export const finished = (
  seal: Seal,
  session: string,
  ending: typeof Completed | typeof Failed,
  endedAt: DateTime.Utc,
  durable: boolean | "initial"
) => {
  const runs = seal.children.filter(
    (c) =>
      c.session === session &&
      (c.followUp
        ? durable && c.followUp.delivered
        : DateTime.toEpochMillis(c.startedAt) <=
          DateTime.toEpochMillis(endedAt))
  );

  const latestRun = runs.at(-1);

  return update(seal, (c) =>
    runs.includes(c) &&
    (durable !== "initial" || !c.followUp) &&
    (isOutstanding(c) ||
      (durable !== "initial" &&
        ending === Failed &&
        c === latestRun &&
        !c.followUp &&
        isCompleted(c)))
      ? new ending({ ...fieldsOf(c), endedAt })
      : c
  );
};

/** A completed run doing more work without a new launch is running again. */
export const resumed = (seal: Seal, session: string) => {
  const run = latest(seal, session);

  return update(seal, (c) =>
    c === run && isCompleted(c)
      ? new Running({ ...fieldsOf(c), endedAt: undefined })
      : c
  );
};

/**
 * The subagent tool returned for launch `call`, naming the child's session and how it ended. Failure wins; an outcome
 * the session events already recorded is never undone by a background "running".
 */
export const returned = (
  seal: Seal,
  call: string,
  session: string | undefined,
  outcome: typeof Running | typeof Completed | typeof Failed,
  endedAt: DateTime.Utc
) =>
  update(seal, (c) => {
    if (c.call !== call) {
      return c;
    }

    const linked = session ?? c.session;
    const sameSession = linked === c.session;
    const settled = sameSession && (isFailed(c) || isCompleted(c));
    const state = outcome === Failed || !settled ? outcome : stateOf(c);

    if (sameSession && stateOf(c) === state) {
      return c;
    }

    return new state({
      ...fieldsOf(c),
      endedAt:
        state === Running
          ? undefined
          : ((sameSession ? c.endedAt : undefined) ?? endedAt),
      session: linked,
    });
  });
