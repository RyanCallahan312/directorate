// The subagent runs a review dispatches, as stored in seal.json's children, and Directorate Auditors, Seats, and Compliance
// as a region of the review's state chart: launching → running → completed | failed, and a completed child that works
// again is running again. Each transition returns the new seal, or undefined if nothing changed, so callers write only
// changes.
import { DateTime, Schema } from "effect";

import { Time } from "../../platform/stored.ts";
import type { Seal } from "../../seal/record.ts";
import { Auditor, Compliance, Seat } from "../agents/agent.ts";
import type { Actor } from "../agents/agent.ts";
import type { Ledger } from "../ledger/entry.ts";

const opt = Schema.optional;

const ChildStatus = Schema.Literals([
  "launching",
  "running",
  "completed",
  "failed",
]);

export const ChildSchema = Schema.Struct({
  agent: Schema.String,
  call: Schema.String,
  /** The human-readable part of the OpenCode child session's title. */
  description: opt(Schema.String),
  endedAt: opt(Time),
  followUp: opt(
    Schema.Struct({
      delivered: opt(Schema.Boolean),
      inbox: opt(Schema.String),
    })
  ),
  /** The model the launch named, which for a Directorate SeatSchema is its seat. */
  model: opt(Schema.String),
  prompt: Schema.String,
  session: opt(Schema.String),
  startedAt: Time,
  status: ChildStatus,
});

export type Child = typeof ChildSchema.Type;

export const childOutstanding = (seal: Seal) =>
  seal.children.filter(
    (c) => c.status === "running" || c.status === "launching"
  );

/** One per child session (its latest run), since a follow-up joined to a running child shares its session. */
export const perSession = (runs: readonly Child[]) => [
  ...new Map(runs.map((x) => [x.session ?? x.call, x])).values(),
];

export const childQuestion = (c: Pick<Child, "prompt">) =>
  c.prompt
    .split("\n")
    .find((l) => /^(?:question|entries):/iu.test(l.trim()))
    ?.trim()
    .replace(/^(?:question|entries):\s*/iu, "") ?? c.prompt.slice(0, 160);

/** A panel seat as readers see it: the model without its provider. */
export const seatName = (model: string) => model.slice(model.indexOf("/") + 1);

/** A child as readers see it: a Seat by its model, anyone else by role. */
export const childName = (c: Pick<Child, "agent" | "model">) =>
  c.agent === Seat.id && c.model ? seatName(c.model) : c.agent;

/** Whoever raised or decided something, named as `childName` names them. */
export const actorName = (seal: Seal, a: Actor) => {
  const c = seal.children.find((x) => x.session === a.session);

  return c ? childName(c) : a.agent;
};

/** A seat completes only if one of its finished sessions read the entire current generation. */
export const panelSeats = (seal: Seal) =>
  (seal.panel ?? []).map((model) => {
    const runs = seal.children.filter(
      (c) => c.agent === Seat.id && c.model === model
    );

    const completed = runs.filter((c) => c.status === "completed");

    const unread = Math.min(
      seal.regions.length,
      ...completed.map(
        (c) =>
          seal.regions.filter(
            (r) => !c.session || !r.readBy.includes(c.session)
          ).length
      )
    );

    const latest = runs.at(-1)?.status;

    let status: Child["status"] | "partial" | "not launched" =
      latest ?? "not launched";

    if (completed.length && unread === 0) {
      status = "completed";
    } else if (
      completed.length &&
      latest !== "running" &&
      latest !== "launching"
    ) {
      status = "partial";
    }

    return {
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
  seal.regions.length
    ? panelSeats(seal).filter(
        (s) =>
          s.status === "failed" ||
          s.status === "not launched" ||
          s.status === "partial"
      )
    : [];

export const openSeat = (seal: Seal) => missingSeats(seal)[0]?.model;

const childKey = (c: Child) =>
  `${c.agent}\0${c.model ?? ""}\0${childQuestion(c)}`;

/** A Compliance run is answered once every entry on its entries line is decided, whichever run decided it. */
const decided = (c: Child, ledger: Ledger) => {
  if (c.agent !== Compliance.id || !/^entries:/imu.test(c.prompt)) {
    return false;
  }

  const ids = childQuestion(c).match(/\bF\d+\b/gu) ?? [];

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
const answered = (c: Child, ledger: Ledger) =>
  c.agent === Auditor.id &&
  ledger.notes.some(
    (n) => n.kind === "answered" && questionText(n.text) === childQuestion(c)
  );

/**
 * Failed children whose question no later run of the same agent (and model) completed or the Liaison answered, or whose
 * entries stay open.
 */
export const childFailures = (seal: Seal, ledger: Ledger) => {
  const done = new Set<string>();

  return seal.children
    .toReversed()
    .filter((c) => {
      if (c.status === "completed") {
        done.add(childKey(c));
      }

      return (
        c.status === "failed" &&
        !done.has(childKey(c)) &&
        !decided(c, ledger) &&
        !answered(c, ledger)
      );
    })
    .toReversed();
};

/** Auditor questions a review left unanswered: still running when it closed, or failed and never answered. */
export const unansweredQuestions = (seal: Seal, ledger: Ledger) => [
  ...new Set(
    [...childOutstanding(seal), ...childFailures(seal, ledger)].flatMap((c) =>
      c.agent === Auditor.id ? [childQuestion(c)] : []
    )
  ),
];

export const update = (
  seal: Seal,
  step: (c: Child) => Child
): Seal | undefined => {
  const children = seal.children.map(step);

  return children.some((c, i) => c !== seal.children[i])
    ? { ...seal, children }
    : undefined;
};

/** The Liaison launched an Auditor, Seat, or Compliance run. */
export const launched = (seal: Seal, child: Child): Seal => ({
  ...seal,
  children: [...seal.children, child],
});

export const launchTitle = (
  child: Pick<Child, "description" | "agent" | "call">
) => `${child.description ?? child.agent} · ${child.call}`;

/** Claim only the launch whose correlation suffix was sent to OpenCode. */
export const claimed = (
  seal: Seal,
  session: string,
  agent: string,
  title: string | undefined
): Seal | undefined => {
  if (seal.children.some((c) => c.session === session)) {
    return undefined;
  }

  const claim = seal.children.find(
    (c) =>
      !c.session &&
      c.agent === agent &&
      c.status === "launching" &&
      launchTitle(c) === title
  );

  return (
    claim &&
    update(seal, (c) =>
      c === claim ? { ...c, session, status: "running" } : c
    )
  );
};

/** A session's latest run; follow-ups can register before older events are consumed. */
const latest = (seal: Seal, session: string) =>
  seal.children.findLast((c) => c.session === session);

/** OpenCode's subagent tool forwards the prompt text, but not the parent tool call ID. */
export const followUpPrompt = (c: Pick<Child, "call" | "prompt">) =>
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
      ? { ...c, followUp: { inbox } }
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
      (c.status !== "launching" && c.status !== "running")
    ) {
      return c;
    }

    return delivered
      ? { ...c, followUp: { delivered: true, inbox }, status: "running" }
      : { ...c, endedAt: at, status: "failed" };
  });

/** An execution can drain several delivered prompts, but never settles one still in the inbox. */
export const finished = (
  seal: Seal,
  session: string,
  status: "completed" | "failed",
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
    (c.status === "running" ||
      c.status === "launching" ||
      (durable !== "initial" &&
        status === "failed" &&
        c === latestRun &&
        !c.followUp &&
        c.status === "completed"))
      ? { ...c, endedAt, status }
      : c
  );
};

/** A completed child doing more work without a new launch is running again. */
export const resumed = (seal: Seal, session: string) => {
  const run = latest(seal, session);

  return update(seal, (c) =>
    c === run && c.status === "completed"
      ? { ...c, endedAt: undefined, status: "running" }
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
  outcome: Child["status"],
  endedAt: DateTime.Utc
) =>
  update(seal, (c) => {
    if (c.call !== call) {
      return c;
    }

    const linked = session ?? c.session;
    const sameSession = linked === c.session;

    const settled =
      sameSession && (c.status === "failed" || c.status === "completed");

    const status = outcome === "failed" || !settled ? outcome : c.status;

    return c.session === linked && c.status === status
      ? c
      : {
          ...c,
          endedAt:
            status === "running"
              ? undefined
              : ((sameSession ? c.endedAt : undefined) ?? endedAt),
          session: linked,
          status,
        };
  });
