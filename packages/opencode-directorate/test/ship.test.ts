import assert from "node:assert/strict";
import { test } from "node:test";

import { DateTime } from "effect";

import { Seat } from "../src/feature/agents/agent.ts";
import { Completed } from "../src/feature/dispatch/lifecycle.ts";
import type { Entry } from "../src/feature/ledger/entry.ts";
import { Seal } from "../src/seal/record.ts";
import { Anchor, FileEntry, Region } from "../src/seal/region.ts";
import { Target } from "../src/seal/target.ts";
import { decideShip, shipKickoff } from "../src/workflow/ship/step.ts";

const state = {
  id: "8e651aab-1f61-43d4-8a2d-9890bdb86d2b",
  request: "",
  reviewsAtResume: 0,
  rounds: 0,
};

const at = DateTime.makeUnsafe(0);

const seal = Seal.make({
  baseSha: "base",
  budgetMinutes: 20,
  children: [],
  createdAt: at,
  deadline: DateTime.makeUnsafe(20 * 60_000),
  deleted: [],
  description: "working tree changes",
  directive: { reasons: [], status: "complete" },
  files: [
    FileEntry.make({
      added: 1,
      path: "src/file.ts",
      removed: 0,
      status: "modified",
    }),
  ],
  fingerprint: "original",
  gates: {},
  gen: 0,
  headSha: "head",
  id: "directorate-example",
  mode: "default",
  owner: "directorate_liaison",
  ownerSession: "ses_liaison",
  postImage: "worktree",
  refreshes: 0,
  regions: [
    Region.make({
      file: "src/file.ts",
      id: "R1",
      newEnd: 1,
      newStart: 1,
      patchEnd: 1,
      patchStart: 0,
      readBy: [],
    }),
  ],
  repo: "/repo",
  reportedAt: at,
  target: Target.make({ kind: "local" }),
});

const entry = (id: string, overrides: Partial<Entry> = {}): Entry => ({
  anchor: Anchor.make({
    endLine: 12,
    line: 12,
    path: "src/file.ts",
    side: "new",
  }),
  consequence: "The result is incorrect",
  createdAt: at,
  evidence: [],
  fix: `Suggestion for ${id}`,
  id,
  kind: "defect",
  lens: "correctness",
  quote: "return value",
  raisedBy: { agent: seal.owner, session: seal.ownerSession },
  severity: "minor",
  status: "confirmed",
  title: `Title for ${id}`,
  trigger: "The input is absent",
  verdicts: [],
  ...overrides,
});

const reported = {
  fingerprint: seal.fingerprint,
  ledger: { entries: [], notes: [] },
  reviews: 1,
  seal,
};

test("kickoff assigns only the first review turn; the no-seal retry preserves the ship ID and parsed scope", () => {
  const kickoff = shipKickoff("review instructions", state.id);
  assert.ok(kickoff.includes(`ship: "${state.id}"`));
  assert.match(
    kickoff,
    /initial seal only.*Do not pass ship when resuming or re-checking/u
  );
  assert.match(kickoff, /dispatch directorate_liaison.*Directive verbatim/u);
  assert.match(kickoff, /Do not fix or re-check yet/u);
  assert.match(kickoff, /wait for the plugin to direct the next step/u);
  assert.match(kickoff, /review instructions/u);

  const request = { ...state, request: "--scope=local focus on input parsing" };
  const start = decideShip(request, { reviews: 0 });
  assert.equal(start.status, "active");
  assert.equal(start.step, "review");
  assert.ok(start.text.includes(`ship: "${state.id}"`));
  assert.match(start.text, /<user_request>\nfocus on input parsing\n/u);
  assert.match(start.text, /scope: "local"/u);
  assert.doesNotMatch(start.text, /--scope=local/u);
  assert.equal(
    decideShip({ ...request, step: start.step }, { reviews: 0 }).status,
    "paused"
  );
});

test("unfinished review resumes the Liaison and exact seal only once without progress", () => {
  const observation = {
    reviews: 1,
    seal: Seal.make({ ...seal, reportedAt: undefined }),
  };

  const decision = decideShip(state, observation);
  assert.equal(decision.status, "active");
  assert.equal(decision.step, `resume:${seal.id}`);
  assert.match(
    decision.text,
    /same directorate_liaison session \(ses_liaison\)/u
  );
  assert.match(decision.text, /resume: "directorate-example"/u);
  assert.ok(!decision.text.includes(state.id));
  assert.match(decision.text, /Do not start another review/u);
  assert.match(decision.text, /wait for the plugin to direct the next step/u);
  assert.equal(
    decideShip({ ...state, step: decision.step }, observation).status,
    "paused"
  );
});

test("empty initial targets and unreadable reported reviews never report completion", () => {
  for (const reportedAt of [at, undefined]) {
    const result = decideShip(state, {
      ...reported,
      seal: Seal.make({ ...seal, files: [], regions: [], reportedAt }),
    });

    assert.equal(result.status, "paused");
    assert.match(result.reason, /directorate-example.*nothing to review/u);
  }

  for (const [observation, cause] of [
    [{ ...reported, error: "git unavailable" }, /git unavailable/u],
    [{ ...reported, ledger: undefined }, /review ledger/u],
    [{ ...reported, fingerprint: undefined }, /target fingerprint/u],
  ] as const) {
    const result = decideShip(state, observation);
    assert.equal(result.status, "paused");
    assert.match(result.reason, /directorate-example/u);
    assert.match(result.text, cause);
  }
});

test("an empty recheck still decides carried findings and can complete after resolving them", () => {
  const recheck = Seal.make({
    ...seal,
    files: [],
    id: "directorate-next",
    recheckOf: seal.id,
    regions: [],
  });

  const unfinished = decideShip(state, {
    reviews: 2,
    seal: Seal.make({ ...recheck, reportedAt: undefined }),
  });

  assert.equal(unfinished.status, "active");
  assert.equal(unfinished.step, `resume:${recheck.id}`);
  assert.match(
    unfinished.text,
    /decide any carried items.*even if the re-check has no regions/u
  );
  assert.match(unfinished.text, /wait for the plugin to direct the next step/u);

  const resolved = entry("carried", {
    carried: { id: "F1", status: "confirmed" },
    status: "resolved",
  });

  const observation = { ...reported, reviews: 2, seal: recheck };
  assert.equal(decideShip(state, observation).status, "paused");
  assert.equal(
    decideShip(state, {
      ...observation,
      ledger: { entries: [resolved], notes: [] },
    }).status,
    "complete"
  );
  assert.equal(
    decideShip(state, {
      ...observation,
      ledger: { entries: [{ ...resolved, status: "open" }], notes: [] },
    }).step,
    "finish"
  );
});

test("changed target rechecks the exact seal before looking at its findings or old status", () => {
  const observation = {
    ...reported,
    fingerprint: "updated",
    ledger: { entries: [entry("F1")], notes: [] },
  };

  const changed = decideShip(state, observation);
  assert.equal(changed.status, "active");
  assert.equal(changed.step, `recheck:${seal.id}:updated`);
  assert.match(
    changed.text,
    /same directorate_liaison session \(ses_liaison\)/u
  );
  assert.match(changed.text, /recheck: "directorate-example"/u);
  assert.ok(!changed.text.includes(state.id));
  assert.match(
    changed.text,
    /new directorate_liaison with that same explicit recheck id/u
  );
  assert.match(changed.text, /wait for the plugin to direct the next step/u);
  assert.equal(
    decideShip({ ...state, step: changed.step }, observation).status,
    "paused"
  );
  assert.equal(
    decideShip(
      { ...state, step: changed.step },
      { ...observation, fingerprint: "newer" }
    ).step,
    `recheck:${seal.id}:newer`
  );
});

test("missing panel Seats require a new panel review even with drift or confirmed findings", () => {
  const model = "provider/seat";

  const panelSeal = Seal.make({
    ...seal,
    directive: { reasons: ["a Seat never launched"], status: "partial" },
    panel: [model],
  });

  for (const observation of [
    reported,
    { ...reported, fingerprint: "drifted" },
    { ...reported, ledger: { entries: [entry("F1")], notes: [] } },
    {
      ...reported,
      fingerprint: "drifted",
      ledger: { entries: [entry("F1")], notes: [] },
    },
  ]) {
    const paused = decideShip(state, { ...observation, seal: panelSeal });
    assert.equal(paused.status, "paused");
    assert.equal(paused.step, undefined);
    assert.match(
      paused.reason,
      /directorate-example.*panel review is incomplete.*provider\/seat/u
    );
    assert.match(
      paused.text,
      /re-check runs without a panel.*start a new.*same scope with the panel enabled/u
    );
  }

  const completed = Seal.make({
    ...panelSeal,
    children: [
      new Completed({
        agent: Seat.id,
        call: "call",
        model,
        prompt: "Review",
        session: "ses_seat",
        startedAt: at,
      }),
    ],
    directive: seal.directive,
    regions: seal.regions.map((r) =>
      Region.make({ ...r, readBy: ["ses_seat"] })
    ),
  });

  assert.equal(
    decideShip(state, { ...reported, seal: completed }).status,
    "complete"
  );
  assert.equal(
    decideShip(state, {
      ...reported,
      seal: Seal.make({ ...panelSeal, reportedAt: undefined }),
    }).step,
    `resume:${seal.id}`
  );
});

test("fix includes every severity and separates unverified leads from confirmed findings", () => {
  const observation = {
    ...reported,
    ledger: {
      entries: [
        entry("minor"),
        entry("important", { severity: "important" }),
        entry("blocking", { severity: "blocking" }),
        entry("lead", { fix: undefined, status: "open" }),
        entry("ignored", { status: "refuted" }),
      ],
      notes: [],
    },
    seal: Seal.make({
      ...seal,
      target: Target.make({ kind: "local", paths: ["src/"] }),
    }),
  };

  const request = "--scope local\nKeep public interfaces unchanged.";

  const fix = decideShip({ ...state, request }, observation);
  assert.equal(fix.status, "active");
  assert.equal(fix.step, `fix:${seal.id}`);
  assert.match(fix.text, /Fix all confirmed findings.*including minor/u);
  assert.match(fix.text, /Investigate every unverified lead/u);
  assert.match(fix.text, /Do not commit, push, approve, or merge/u);
  assert.match(
    fix.text,
    /If blocked, tell the user what decision or action is needed and stop/u
  );
  assert.match(fix.text, /Do not start the re-check yourself/u);
  assert.match(fix.text, /wait for the plugin to direct the next step/u);
  assert.match(
    fix.text,
    /Sealed repository: \/repo\nSealed target: working tree changes\nRepository-relative paths: src/u
  );
  assert.match(
    fix.text,
    /If a fix needs to widen that scope, ask the user and stop/u
  );
  assert.ok(fix.text.includes(`<user_request>\n${request}\n</user_request>`));
  const [verified, leads] = fix.text.split("### Unverified leads");
  assert.ok(verified && leads);

  for (const severity of ["blocking", "important", "minor"]) {
    assert.ok(
      verified.includes(
        `[${severity}] Title for ${severity} — \`src/file.ts:12\`. Suggested fix: Suggestion for ${severity}`
      )
    );
  }

  assert.match(
    leads,
    /\[minor\] Title for lead.*src\/file\.ts:12.*none recorded/u
  );
  assert.doesNotMatch(fix.text, /Title for ignored/u);
  assert.doesNotMatch(verified, /Title for lead/u);
  assert.equal(
    decideShip({ ...state, step: fix.step }, observation).status,
    "paused"
  );
});

test("fixed commits cannot show fixes; PR fixes need a fetched PR head", () => {
  const observation = {
    ...reported,
    ledger: { entries: [entry("F1")], notes: [] },
  };

  const commit = decideShip(state, {
    ...observation,
    seal: Seal.make({
      ...seal,
      postImage: "commit",
      target: Target.make({ commit: "head", kind: "commit" }),
    }),
  });

  assert.equal(commit.status, "paused");
  assert.match(commit.text, /fixed commit.*working tree or a moving ref/u);

  const pr = decideShip(state, {
    ...observation,
    seal: Seal.make({
      ...seal,
      postImage: "commit",
      target: Target.make({ kind: "pr", pr: "123" }),
    }),
  });

  assert.equal(pr.step, `fix:${seal.id}`);
  assert.match(pr.text, /Only committed changes.*fetched PR head/u);
  assert.match(pr.text, /Do not commit, push, approve, or merge/u);
});

test("incomplete reviews get one finish recheck, carrying reasons and outstanding leads", () => {
  const duplicate = entry("unsettled-duplicate", {
    status: "duplicate",
    verdicts: [
      {
        at,
        by: entry("lead").raisedBy,
        evidence: [],
        of: "lead",
        rationale: "same issue",
        verdict: "duplicate",
      },
    ],
  });

  const ledger = {
    entries: [entry("lead", { status: "open" }), duplicate],
    notes: [],
  };

  for (const directive of [
    { reasons: ["2 regions unread"], status: "partial" },
    { reasons: ["freshness uncertain"], status: "stale" },
    undefined,
    seal.directive,
  ] as const) {
    const observation = {
      ...reported,
      ledger,
      seal: Seal.make({ ...seal, directive }),
    };

    const finish = decideShip(state, observation);
    assert.equal(finish.status, "active");
    assert.equal(finish.step, "finish");
    assert.match(finish.text, /recheck: "directorate-example"/u);
    assert.match(finish.text, /wait for the plugin to direct the next step/u);
    assert.match(finish.text, /Title for lead/u);
    assert.match(finish.text, /Title for unsettled-duplicate/u);

    for (const reason of directive?.reasons ?? []) {
      assert.ok(finish.text.includes(reason));
    }

    const another = {
      ...observation,
      seal: Seal.make({
        ...observation.seal,
        id: "directorate-next",
        recheckOf: seal.id,
      }),
    };

    const paused = decideShip({ ...state, step: finish.step }, another);
    assert.equal(paused.status, "paused");
    assert.match(paused.reason, /directorate-next/u);
  }
});

test("only complete and fresh reports without confirmed findings or unresolved leads complete", () => {
  const decision = decideShip(state, {
    ...reported,
    ledger: { entries: [entry("old", { status: "resolved" })], notes: [] },
  });

  assert.equal(decision.status, "complete");
  assert.equal(decision.step, undefined);
  assert.match(decision.reason, /directorate-example.*complete and current/u);

  for (const status of ["stale", "partial"] as const) {
    const incomplete = decideShip(state, {
      ...reported,
      seal: Seal.make({ ...seal, directive: { reasons: [], status } }),
    });

    assert.equal(incomplete.step, "finish");
  }
});

test("review cap only stops new reviews; round cap stops any next action", () => {
  const almost = { ...state, reviewsAtResume: 10, rounds: 29 };
  const drift = { ...reported, fingerprint: "different" };
  assert.equal(decideShip(almost, { ...drift, reviews: 15 }).status, "active");
  const reviewLimit = decideShip(almost, { ...drift, reviews: 16 });
  assert.equal(reviewLimit.status, "paused");
  assert.match(reviewLimit.reason, /6 reviews/u);

  const fix = {
    ...reported,
    ledger: { entries: [entry("F1")], notes: [] },
    reviews: 16,
  };

  assert.equal(decideShip(almost, fix).step, `fix:${seal.id}`);
  assert.equal(
    decideShip(almost, {
      ...fix,
      seal: Seal.make({ ...seal, reportedAt: undefined }),
    }).step,
    `resume:${seal.id}`
  );
  const capped = { ...almost, rounds: 30 };
  const roundLimit = decideShip(capped, fix);
  assert.equal(roundLimit.status, "paused");
  assert.match(roundLimit.reason, /30-round limit/u);
  assert.equal(decideShip(capped, reported).status, "complete");
});
