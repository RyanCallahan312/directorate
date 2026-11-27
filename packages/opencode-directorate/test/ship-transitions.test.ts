import assert from "node:assert/strict";
import { test } from "node:test";

import { Equal } from "effect";

import { MessageIdSchema, SessionIdSchema } from "../src/platform/host-id.ts";
import { SealIdSchema } from "../src/seal/seal-id.ts";
import { ShipIdSchema } from "../src/workflow/review/ship-link.ts";
import {
  Active,
  admitted,
  admitting,
  attached,
  awaited,
  claimed,
  consumed,
  FixStep,
  hostFailed,
  isActive,
  isPaused,
  isWaiting,
  noticeQueued,
  observed,
  planned,
  planRendered,
  ReviewStep,
  rewound,
  started,
  toStored,
  traced,
  unplanned,
  unqueued,
  Waiting,
  woken,
} from "../src/workflow/ship/state.ts";

const SEAL = SealIdSchema.make("directorate-20260101000000-aaaaaa");

const CHILD = SessionIdSchema.make("ses_child");

const MARKER = MessageIdSchema.make("msg_marker");

const fields = {
  admitting: true,
  awaiting: { [CHILD]: 5 },
  boot: "boot-1",
  chain: [SEAL],
  id: ShipIdSchema.make("8e651aab-1f61-43d4-8a2d-9890bdb86d2b"),
  inbox: { continuation: true, id: MARKER },
  lastHostFailure: "The session failed: overloaded.",
  location: "/repo",
  notices: { [MessageIdSchema.make("msg_notice")]: CHILD },
  pid: 42,
  plan: {
    id: MARKER,
    origin: MessageIdSchema.make("msg_origin"),
    rendered: false,
    text: "Fix the findings.",
  },
  reason: "Fixing round 1.",
  request: "--scope branch",
  reviewsAtResume: 0,
  rounds: 1,
  startedAt: 1,
  step: FixStep.make({ seal: SEAL }),
  wokeAt: 9,
};

const waiting = Waiting.make(fields);

test("a ship whose input is no longer queued pauses the same way from every handler", () => {
  // The context hook sees the ship waiting or active; a cancelled or rejected input finds it waiting.
  const fromWaiting = unqueued(waiting, "Compacted.");
  const fromActive = unqueued(Active.make(fields), "Compacted.");

  assert.ok(isPaused(fromWaiting));
  assert.deepEqual(toStored(fromActive), toStored(fromWaiting));

  const {
    admitting: _admitting,
    awaiting: _awaiting,
    inbox: _inbox,
    lastHostFailure: _lastHostFailure,
    notices: _notices,
    plan: _plan,
    wokeAt: _wokeAt,
    ...kept
  } = fields;

  assert.deepEqual(toStored(fromWaiting), {
    ...kept,
    reason: "Compacted.",
    status: "paused",
    step: "fix:directorate-20260101000000-aaaaaa",
  });
});

test("a consumed turn drops its input, plan, and wake but keeps what it awaits", () => {
  const used = consumed(Active.make(fields));

  assert.ok(isActive(used));
  assert.equal(used.inbox, undefined);
  assert.equal(used.plan, undefined);
  assert.equal(used.wokeAt, undefined);
  assert.deepEqual(used.awaiting, fields.awaiting);
  assert.equal(used.lastHostFailure, fields.lastHostFailure);
});

test("a stale plan is dropped with its step; a resolved admission only clears admitting", () => {
  const stale = unplanned(waiting);

  assert.ok(isWaiting(stale));
  assert.equal(stale.plan, undefined);
  assert.equal(stale.step, undefined);
  assert.deepEqual(stale.inbox, fields.inbox);

  const confirmed = admitted(waiting);

  assert.ok(isWaiting(confirmed));
  assert.equal(confirmed.admitting, undefined);
  assert.deepEqual(confirmed.plan, fields.plan);
});

test("a new ship is active with no seals, rounds, or reviews counted", () => {
  const ship = started({
    boot: "boot-1",
    id: fields.id,
    location: "/repo",
    pid: 42,
    request: "",
    startedAt: 7,
    step: ReviewStep.make({}),
  });

  assert.ok(isActive(ship));

  assert.deepEqual(toStored(ship), {
    boot: "boot-1",
    chain: [],
    id: fields.id,
    location: "/repo",
    pid: 42,
    reason: "Waiting for the initial Directorate review.",
    request: "",
    reviewsAtResume: 0,
    rounds: 0,
    startedAt: 7,
    status: "active",
    step: "review",
  });
});

test("a ship with no step is stored without the key", () => {
  assert.ok(!Object.hasOwn(toStored(unplanned(waiting)), "step"));
});

test("an attached seal joins the chain", () => {
  const next = attached(
    waiting,
    SealIdSchema.make("directorate-20260102000000-bbbbbb")
  );

  assert.ok(isWaiting(next));
  assert.deepEqual(next.chain, [
    ...fields.chain,
    "directorate-20260102000000-bbbbbb",
  ]);
});

test("an observed chain replaces the chain; only a manual command recounts the review allowance", () => {
  const chain = [
    "directorate-20260101000000-aaaaaa",
    "directorate-20260102000000-bbbbbb",
    "directorate-20260103000000-cccccc",
  ].map((id) => SealIdSchema.make(id));

  const automatic = observed(waiting, chain, false);
  const manual = observed(waiting, chain, true);

  assert.ok(isWaiting(automatic));
  assert.deepEqual(automatic.chain, chain);
  assert.equal(automatic.reviewsAtResume, fields.reviewsAtResume);
  assert.equal(manual.reviewsAtResume, 3);
});

test("a rewound ship is one round back, never below zero, with no step", () => {
  const back = rewound(waiting);

  assert.ok(isWaiting(back));
  assert.equal(back.rounds, 0);
  assert.equal(back.step, undefined);
  assert.equal(rewound(back).rounds, 0);
});

test("a plan is set, then marked rendered; a ship without one is unchanged", () => {
  const plan = {
    id: MessageIdSchema.make("msg_next"),
    origin: MessageIdSchema.make("msg_o"),
    rendered: false,
    text: "Go.",
  };

  const next = planned(unplanned(waiting), plan);

  assert.ok(isWaiting(next));
  assert.deepEqual(next.plan, plan);
  assert.deepEqual(planRendered(next).plan, { ...plan, rendered: true });

  const bare = unplanned(waiting);
  assert.equal(planRendered(bare), bare);
});

test("an admitting ship is marked until its admission resolves", () => {
  const next = admitting(admitted(waiting));

  assert.ok(isWaiting(next));
  assert.equal(next.admitting, true);
});

test("a claimed ship names its new boot and process; a traced one its origin, attachments delivered", () => {
  const ours = claimed(waiting, "boot-2", 7);

  assert.equal(ours.boot, "boot-2");
  assert.equal(ours.pid, 7);

  const known = traced(
    Active.make({ ...fields, needsAttachments: true }),
    MessageIdSchema.make("msg_x")
  );

  assert.ok(isActive(known));
  assert.equal(known.origin, "msg_x");
  assert.equal(known.needsAttachments, false);
});

test("subagents seen running are awaited alongside those already awaited", () => {
  const next = awaited(waiting, { [SessionIdSchema.make("ses_other")]: 6 });

  assert.deepEqual(next.awaiting, { ses_child: 5, ses_other: 6 });
});

test("a queued notice is recorded by inbox ID; its delivery drops it and its subagent and wakes the ship", () => {
  const queued = noticeQueued(
    waiting,
    MessageIdSchema.make("msg_notice2"),
    SessionIdSchema.make("ses_child")
  );

  assert.deepEqual(queued.notices, {
    msg_notice: "ses_child",
    msg_notice2: "ses_child",
  });

  const woke = woken(
    queued,
    MessageIdSchema.make("msg_notice2"),
    SessionIdSchema.make("ses_child"),
    11
  );

  assert.ok(isWaiting(woke));
  assert.deepEqual(woke.notices, { msg_notice: "ses_child" });
  assert.deepEqual(woke.awaiting, {});
  assert.equal(woke.wokeAt, 11);
  const { awaiting: _awaiting, notices: _notices, ...bare } = fields;

  assert.deepEqual(
    woken(
      Waiting.make(bare),
      MessageIdSchema.make("msg_9"),
      SessionIdSchema.make("ses_x"),
      3
    ).notices,
    {}
  );
});

test("a host failure while queued is recorded", () => {
  assert.equal(hostFailed(waiting, "boom").lastHostFailure, "boom");
});

test("a step equals another of the same form and fields", () => {
  assert.ok(
    Equal.equals(FixStep.make({ seal: SEAL }), FixStep.make({ seal: SEAL }))
  );
  assert.ok(
    !Equal.equals(
      FixStep.make({ seal: SEAL }),
      FixStep.make({
        seal: SealIdSchema.make("directorate-20260102000000-bbbbbb"),
      })
    )
  );
});
