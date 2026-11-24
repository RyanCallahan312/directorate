// Directorate Auditors, Seats, and Compliance, as a region of the review's state chart: launching → running → completed | failed, and a
// completed child that works again is running again. Each transition returns the new seal, or undefined if nothing
// changed, so callers write only changes.
import type { DateTime } from "effect";

import { type Actor, type Child, PANELIST, type Seal } from "./model.ts";

export const childOutstanding = (seal: Seal) =>
  seal.children.filter(
    (c) => c.status === "running" || c.status === "launching"
  );
export const childQuestion = (c: Pick<Child, "prompt">) =>
  c.prompt
    .split("\n")
    .find((l) => /^(question|entries):/i.test(l.trim()))
    ?.trim()
    .replace(/^(question|entries):\s*/i, "") ?? c.prompt.slice(0, 160);
/** A panel seat as readers see it: the model without its provider. */
export const seatName = (model: string) => model.slice(model.indexOf("/") + 1);
/** A child as readers see it: a panelist by its seat, anyone else by role. */
export const childName = (c: Pick<Child, "agent" | "model">) =>
  c.agent === PANELIST && c.model ? seatName(c.model) : c.agent;
/** Whoever raised or decided something, named as `childName` names them. */
export const actorName = (seal: Seal, a: Actor) => {
  const c = seal.children.find((x) => x.session === a.session);
  return c ? childName(c) : a.agent;
};
/** Each panel seat and how its review went: completed if any run of it completed, else the latest run's status. */
export const panelSeats = (seal: Seal) =>
  (seal.panel ?? []).map((model) => {
    const runs = seal.children.filter(
      (c) => c.agent === PANELIST && c.model === model
    );
    const status = runs.some((c) => c.status === "completed")
      ? "completed"
      : (runs.at(-1)?.status ?? "not launched");
    return {
      model,
      status,
      runs,
      sessions: new Set(runs.flatMap((c) => (c.session ? [c.session] : []))),
    };
  });
/** The next seat a panelist launch takes: the first with no run that is launching, running, or completed. */
export const openSeat = (seal: Seal) =>
  panelSeats(seal).find(
    (s) => s.status === "failed" || s.status === "not launched"
  )?.model;
/** Failed children whose question no later run of the same agent (and model) completed. */
export function childFailures(seal: Seal) {
  const key = (c: Child) => `${c.agent}\0${c.model ?? ""}\0${childQuestion(c)}`;
  const done = new Set(
    seal.children.filter((c) => c.status === "completed").map(key)
  );
  return seal.children.filter(
    (c) => c.status === "failed" && !done.has(key(c))
  );
}

const update = (seal: Seal, step: (c: Child) => Child): Seal | undefined => {
  const children = seal.children.map(step);
  return children.some((c, i) => c !== seal.children[i])
    ? { ...seal, children }
    : undefined;
};

/** The lead launched a scout or refuter. */
export const launched = (seal: Seal, child: Child): Seal => ({
  ...seal,
  children: [...seal.children, child],
});
/** A child's session was created: it takes the open launch of its agent with its title, else the oldest one. */
export function claimed(
  seal: Seal,
  session: string,
  agent: string,
  title: string | undefined
): Seal | undefined {
  if (seal.children.some((c) => c.session === session)) return undefined;
  const open = seal.children.filter(
    (c) => !c.session && c.agent === agent && c.status === "launching"
  );
  const claim =
    open.find((c) => c.description !== undefined && c.description === title) ??
    open[0];
  return (
    claim &&
    update(seal, (c) =>
      c === claim ? { ...c, session, status: "running" } : c
    )
  );
}
/** A session's latest run: a follow-up to a child session is a new run, and session events belong to it, not earlier ones. */
const latest = (seal: Seal, session: string) =>
  seal.children.findLast((c) => c.session === session);
/** A follow-up launch continuing a child session: earlier runs keep their outcome. */
export const followedUp = (seal: Seal, child: Child): Seal | undefined =>
  seal.children.some(
    (c) =>
      c.session === child.session &&
      (c.status === "running" || c.status === "launching")
  )
    ? undefined // Joins the run already going, which stays the one tracked.
    : launched(seal, child);
/** A child's session went idle (completed) or failed; a failure stands over any other outcome of its latest run. */
export function finished(
  seal: Seal,
  session: string,
  status: "completed" | "failed",
  endedAt: DateTime.Utc
) {
  const run = latest(seal, session);
  return update(seal, (c) =>
    c === run &&
    (status === "failed"
      ? c.status !== "failed"
      : c.status === "running" || c.status === "launching")
      ? { ...c, status, endedAt }
      : c
  );
}
/** A completed child doing more work without a new launch is running again. */
export function resumed(seal: Seal, session: string) {
  const run = latest(seal, session);
  return update(seal, (c) =>
    c === run && c.status === "completed"
      ? { ...c, status: "running", endedAt: undefined }
      : c
  );
}
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
    if (c.call !== call) return c;
    const status =
      c.status === "failed" || outcome === "failed"
        ? "failed"
        : c.status === "completed"
          ? "completed"
          : outcome;
    const linked = c.session ?? session;
    return c.session === linked && c.status === status
      ? c
      : {
          ...c,
          session: linked,
          status,
          endedAt: status === "running" ? undefined : (c.endedAt ?? endedAt),
        };
  });
