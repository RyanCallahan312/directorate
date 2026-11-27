import assert from "node:assert/strict";
import { test } from "node:test";

import type { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { DateTime, Result } from "effect";

import { MessageIdSchema } from "../src/platform/host-id.ts";
import type { Activity } from "../src/platform/platform.ts";
import { SealIdSchema } from "../src/seal/seal-id.ts";
import { ShipIdSchema } from "../src/workflow/review/ship-link.ts";
import { describe } from "../src/workflow/ship/command.ts";
import {
  checkpointHidesPlan,
  compacted,
  gone,
  handoff,
  held,
  noProvenance,
  noticed,
  proven,
  shipMark,
  superseded,
} from "../src/workflow/ship/evidence.ts";
import {
  Active,
  FixStep,
  paused,
  Waiting,
} from "../src/workflow/ship/state.ts";

const SHIP = ShipIdSchema.make("8e651aab-1f61-43d4-8a2d-9890bdb86d2b");

const ID = SessionMessage.ID.make;

const time = (at = 0) => ({ created: DateTime.makeUnsafe(at) });

/** A user input: the user's own, or Ship's when it carries a ship's mark. */
const user = (id: string, metadata?: SessionMessage.Info["metadata"], at = 0) =>
  SessionMessage.User.make({
    id: ID(id),
    text: id,
    time: time(at),
    type: "user",
    ...(metadata && { metadata }),
  });

/** A synthetic input: Ship's marker, or a finished subagent's completion notice. */
const synthetic = (
  id: string,
  metadata?: SessionMessage.Info["metadata"],
  at = 0
) =>
  SessionMessage.Synthetic.make({
    id: ID(id),
    text: id,
    time: time(at),
    type: "synthetic",
    ...(metadata && { metadata }),
  });

const notice = (id: string, child: string, at: number) =>
  synthetic(id, { childID: child, source: "subagent" }, at);

/** A turn that settled with `outcome`. */
const idle = (
  outcome: "succeeded" | "failed" | "interrupted",
  message?: string
) =>
  SessionMessage.Idle.make({
    id: SessionMessage.ID.create(),
    outcome,
    time: time(),
    type: "idle",
    ...(message && { error: { message, type: "APIError" } }),
  });

const checkpoint = (id: string) =>
  SessionMessage.CompactionCompleted.make({
    id: ID(id),
    reason: "auto",
    status: "completed",
    summary: "Summary.",
    time: time(),
    type: "compaction",
  });

const origin = user("msg_origin", shipMark(SHIP));
const marker = synthetic("msg_marker", shipMark(SHIP));

const plan = {
  id: ID("msg_marker"),
  origin: ID("msg_origin"),
  rendered: true,
  text: "Fix the findings.",
};

const fields = {
  boot: "boot-1",
  chain: [SealIdSchema.make("directorate-20260101000000-aaaaaa")],
  id: SHIP,
  location: "/test",
  pid: process.pid,
  reason: "Fixing round 1.",
  request: "--scope branch",
  reviewsAtResume: 0,
  rounds: 1,
  startedAt: 1,
  step: FixStep.make({
    seal: SealIdSchema.make("directorate-20260101000000-aaaaaa"),
  }),
};

test("superseded: the origin must be this ship's, with no user input after it and its marker promoted", () => {
  assert.equal(superseded([], SHIP, ID("msg_origin")), noProvenance);
  assert.equal(superseded([origin], SHIP), noProvenance);
  assert.equal(
    superseded(
      [
        user(
          "msg_origin",
          shipMark(ShipIdSchema.make("0b6c3c1e-7c4a-4b8e-9a51-2f0d6f1e9c11"))
        ),
      ],
      SHIP,
      ID("msg_origin")
    ),
    noProvenance
  );
  assert.equal(
    superseded([origin, user("msg_user")], SHIP, ID("msg_origin")),
    handoff
  );
  assert.equal(
    superseded([origin], SHIP, ID("msg_origin"), ID("msg_marker")),
    noProvenance
  );
  assert.equal(
    superseded(
      [origin, user("msg_marker", shipMark(SHIP))],
      SHIP,
      ID("msg_origin"),
      ID("msg_marker")
    ),
    noProvenance,
    "the marker must be synthetic"
  );
  assert.equal(superseded([origin], SHIP, ID("msg_origin")), undefined);
  assert.equal(
    superseded([origin, marker], SHIP, ID("msg_origin"), ID("msg_marker")),
    undefined
  );
  assert.equal(
    superseded(
      [origin, notice("msg_notice", "ses_child", 1), marker],
      SHIP,
      ID("msg_origin"),
      ID("msg_marker")
    ),
    undefined,
    "a completion notice is not the user's"
  );
});

test("checkpointHidesPlan: only a newer checkpoint that hides the marker or its origin", () => {
  assert.equal(checkpointHidesPlan([origin, marker], plan), false);
  assert.equal(
    checkpointHidesPlan([checkpoint("msg_cp"), origin, marker], plan),
    false
  );
  assert.equal(checkpointHidesPlan([checkpoint("msg_cp"), marker], plan), true);
  assert.equal(checkpointHidesPlan([checkpoint("msg_cp"), origin], plan), true);
  assert.equal(
    checkpointHidesPlan([checkpoint("msg_cp"), marker], {
      ...plan,
      checkpoint: MessageIdSchema.make("msg_cp"),
    }),
    false,
    "the plan was made after this checkpoint"
  );
});

test("proven: a missing input waits while undelivered and fails once delivered", () => {
  const queued = Waiting.make({
    ...fields,
    inbox: { continuation: true, id: MessageIdSchema.make("msg_marker") },
    plan,
  });

  assert.equal(proven(queued, [origin]), undefined);

  const delivered = Active.make({
    ...fields,
    inbox: {
      continuation: true,
      deliveredAt: 5,
      id: MessageIdSchema.make("msg_marker"),
    },
    plan,
  });

  assert.deepEqual(proven(delivered, [origin]), Result.fail(noProvenance));
  assert.deepEqual(
    proven(delivered, [checkpoint("msg_cp")]),
    Result.fail(compacted)
  );
});

test("proven: no settled turn since the input proves nothing yet", () => {
  const state = Active.make({
    ...fields,
    inbox: { deliveredAt: 5, id: MessageIdSchema.make("msg_origin") },
    origin: MessageIdSchema.make("msg_origin"),
  });

  assert.equal(proven(state, [origin]), undefined);
});

test("proven: a failed turn among later successes is reported", () => {
  const state = Active.make({
    ...fields,
    inbox: { deliveredAt: 5, id: MessageIdSchema.make("msg_origin") },
    origin: MessageIdSchema.make("msg_origin"),
  });

  const clean = proven(state, [origin, idle("succeeded")]);

  assert.ok(clean && Result.isSuccess(clean));
  assert.equal(clean.success.origin, "msg_origin");
  assert.equal(clean.success.reason, undefined);
  assert.equal(clean.success.after.length, 1);

  const messages = [
    origin,
    idle("succeeded"),
    idle("failed", "overloaded"),
    idle("succeeded"),
  ];

  const failed = proven(state, messages);

  assert.ok(failed && Result.isSuccess(failed));
  assert.equal(failed.success.reason, "The session failed: overloaded.");

  const interrupted = proven(state, [
    origin,
    idle("interrupted"),
    idle("succeeded"),
  ]);

  assert.ok(interrupted && Result.isSuccess(interrupted));
  assert.equal(interrupted.success.reason, "The session was interrupted.");

  const told = proven(state, messages, "The session failed: from the event.");

  assert.ok(told && Result.isSuccess(told));
  assert.equal(told.success.reason, "The session failed: from the event.");

  const handedOff = proven(state, [
    origin,
    user("msg_user"),
    idle("failed", "overloaded"),
  ]);

  assert.ok(handedOff && Result.isSuccess(handedOff));
  assert.equal(handedOff.success.reason, handoff, "provenance comes first");
});

// SAFETY: held reads only an activity's state and idle time, never its session.
const session = Object.create(null) as Session.Info;

const running = { session, state: "running" } satisfies Activity;

const idleSince = (at: number) =>
  ({ at, session, state: "idle" }) satisfies Activity;

test("held: a running subagent is busy; an idle one's notice gets a 30 s grace", () => {
  assert.equal(held(running, 100_000, false), "busy");
  assert.equal(held(running, 100_000, true), "busy");
  assert.equal(held(idleSince(100_000), 130_000, true), "busy");
  assert.equal(held(idleSince(100_000), 130_001, true), "unnoticed");
  assert.equal(held(idleSince(100_000), 200_000, false), undefined);
  assert.equal(
    held({ session, state: "orphaned" }, 200_000, true),
    undefined,
    "an orphaned subagent neither runs nor has settled"
  );
});

test("gone: a missing Liaison blocks; another missing subagent only while unnoticed", () => {
  assert.equal(gone(true, false), "missing");
  assert.equal(gone(true, true), "missing");
  assert.equal(gone(false, true), "unnoticed");
  assert.equal(gone(false, false), undefined);
});

test("noticed: a completion notice counts only after its subagent was seen running", () => {
  const awaiting = { ses_child: 10 };

  assert.equal(
    noticed(notice("msg_n1", "ses_child", 10), awaiting),
    "ses_child"
  );
  assert.equal(noticed(notice("msg_n2", "ses_child", 9), awaiting), undefined);
  assert.equal(noticed(notice("msg_n3", "ses_other", 50), awaiting), undefined);
  assert.equal(noticed(user("msg_u1", undefined, 50), awaiting), undefined);
  assert.equal(
    noticed(synthetic("msg_s1", undefined, 50), awaiting),
    undefined
  );
});

test("describe: a paused ship says how to recover; a queued one says to cancel its input first", () => {
  const stopped = paused(Active.make(fields), "Paused by the user.");

  assert.equal(
    describe(stopped),
    [
      "Directorate ship paused.",
      "Request: --scope branch",
      "Rounds this run: 1",
      "Seals: directorate-20260101000000-aaaaaa",
      "Reason: Paused by the user.",
      "Resolve the blocker, then use /directorate-ship resume, or use /directorate-ship stop to clear it.",
    ].join("\n")
  );

  const queued = Waiting.make({
    ...fields,
    chain: [],
    inbox: { id: MessageIdSchema.make("msg_queued") },
    lastHostFailure: "The session failed: overloaded.",
    request: " ",
  });

  const text = describe(queued).split("\n");

  assert.equal(
    text[0],
    "Directorate ship waiting (queued input can still execute)."
  );
  assert.equal(text[1], "Request: (configured defaults)");
  assert.equal(text[3], "Seals: none");
  assert.equal(
    text[5],
    "Latest host outcome before delivery (not attributed to this ship): The session failed: overloaded."
  );
  assert.match(
    text[6] ?? "",
    /^Cancel the exact queued ship input msg_queued in OpenCode/u
  );
  assert.equal(text.length, 7);
});
