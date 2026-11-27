import assert from "node:assert/strict";
import { test } from "node:test";

import { DateTime } from "effect";

import { Actor } from "../src/feature/agents/agent.ts";
import { Completed } from "../src/feature/dispatch/lifecycle.ts";
import {
  Carried,
  Entry,
  EntryIdSchema,
  Ledger,
  Note,
  Verdict,
} from "../src/feature/ledger/entry.ts";
import {
  entryRow,
  ledgerShown,
  sealHeader,
  sealIndex,
} from "../src/feature/ledger/show.ts";
import { CallIdSchema, SessionIdSchema } from "../src/platform/host-id.ts";
import { Anchor, Region } from "../src/seal/region.ts";
import { SealIdSchema } from "../src/seal/seal-id.ts";
import { bareSeal, emptyLedger } from "./fixtures.ts";

const T0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const T1 = DateTime.makeUnsafe("2026-01-02T00:00:00.000Z");
const T2 = DateTime.makeUnsafe("2026-01-03T00:00:00.000Z");

const seat = Actor.make({
  agent: "directorate_seat",
  session: SessionIdSchema.make("ses_seat"),
});

const compliance = Actor.make({
  agent: "directorate_compliance",
  session: SessionIdSchema.make("ses_c"),
});

const entry = Entry.make({
  anchor: Anchor.make({ endLine: 4, line: 2, path: "src/a.ts", side: "old" }),
  brief: "see callers",
  carried: Carried.make({ id: EntryIdSchema.make("F9"), status: "confirmed" }),
  consequence: "crash",
  createdAt: T0,
  evidence: ["src/a.ts:2", "src/b.ts:7"],
  fix: "guard it",
  history: [
    Verdict.make({
      at: T0,
      by: compliance,
      evidence: [],
      rationale: "",
      verdict: "refuted",
    }),
  ],
  id: EntryIdSchema.make("F1"),
  kind: "defect",
  lens: "correctness",
  quote: "return a / b",
  raisedBy: seat,
  severity: "minor",
  staleReason: "the code moved",
  status: "confirmed",
  title: "Division by zero",
  trigger: "b = 0",
  verdicts: [
    Verdict.make({
      at: T0,
      by: compliance,
      evidence: ["src/a.ts:2"],
      of: EntryIdSchema.make("F2"),
      rationale: "retraced",
      severity: "important",
      verdict: "confirmed",
    }),
  ],
});

// The seat's run names the entry's author by its model.
const seal = bareSeal({
  baseSha: "0123456789abcdef",
  children: [
    new Completed({
      agent: "directorate_seat",
      call: CallIdSchema.make("c1"),
      model: "openai/gpt",
      prompt: "review",
      session: SessionIdSchema.make("ses_seat"),
      startedAt: T0,
    }),
  ],
  headSha: "fedcba9876543210",
  recheckOf: SealIdSchema.make("directorate-20251231000000-000001"),
  regions: [
    Region.make({
      file: "src/a.ts",
      id: "R1",
      newEnd: 2,
      newStart: 1,
      ownerRead: true,
      patchEnd: 2,
      patchStart: 1,
      readBy: [],
    }),
  ],
});

test("entryRow: brief is one line; full shows the anchor, claim, verdicts, and earlier verdicts", () => {
  assert.equal(
    entryRow(seal, entry, true),
    "- F1 [confirmed] important · Division by zero — src/a.ts:2 · by gpt · carried: confirmed as F9 in directorate-20251231000000-000001"
  );

  assert.equal(
    entryRow(seal, entry, false),
    [
      "### F1 [confirmed] important defect · correctness · Division by zero",
      "anchor: src/a.ts:2-4 (old side) · raised by gpt · carried: confirmed as F9 in directorate-20251231000000-000001",
      "STALE: the code moved",
      "quote:\n```\nreturn a / b\n```",
      "trigger: b = 0",
      "consequence: crash",
      "evidence: src/a.ts:2, src/b.ts:7",
      "fix: guard it",
      "brief: see callers",
      "verdicts:\n- confirmed (important) of F2 by directorate_compliance: retraced [src/a.ts:2]",
      "earlier verdicts (before the code changed): refuted by directorate_compliance",
    ].join("\n")
  );
});

test("ledgerShown: the seal's header over the picked entries, or No entries.", () => {
  const ledger = Ledger.make({
    entries: [entry],
    notes: [Note.make({ at: T0, by: seat, kind: "limit", text: "n" })],
  });

  assert.equal(
    sealHeader(seal, ledger),
    `seal ${seal.id} · default · base 0123456789ab · head fedcba987654 · read 1/1 · notes 1`
  );

  assert.equal(
    ledgerShown(seal, emptyLedger, [], false),
    `${sealHeader(seal, emptyLedger)}\n\nNo entries.`
  );

  const two = ledgerShown(seal, ledger, [entry, entry], true).split("\n");
  assert.equal(two.length, 4);
  assert.equal(two[2], entryRow(seal, entry, true));

  assert.match(
    ledgerShown(seal, ledger, [entry, entry], false),
    /directorate_compliance\n\n### F1/u
  );

  assert.match(
    sealHeader(
      bareSeal({ postImage: "worktree", reportedAt: T1 }),
      emptyLedger
    ),
    /head working tree · read 0\/0 · notes 0 · REPORTED$/u
  );
});

/** The `n`th seal id of the index tests. */
const sealId = (n: number) =>
  SealIdSchema.make(
    `directorate-20260101000000-${n.toString(16).padStart(6, "0")}`
  );

const OLDER = sealId(0xa0);
const NEWER = sealId(0xb0);

test("sealIndex: names the latest reported seal on its own, then lists the ten most recent", () => {
  assert.equal(
    sealIndex([]),
    "No Directorate seals found for this repository."
  );

  const unreported = Array.from({ length: 11 }, (_, i) =>
    bareSeal({ createdAt: T0, id: sealId(i) })
  );

  const unreportedIndex = sealIndex(unreported).split("\n");
  assert.equal(unreportedIndex[0], "No reported seal for this repository.");
  assert.equal(unreportedIndex.length, 12);
  assert.equal(
    unreportedIndex[2],
    `- \`${sealId(0)}\` default · d · created 2026-01-01T00:00:00.000Z · unreported`
  );

  // The latest reported seal is found even beyond the ten listed.
  const reported = [
    ...unreported,
    bareSeal({
      autoReported: true,
      createdAt: T0,
      id: OLDER,
      reportedAt: T1,
    }),
    bareSeal({ createdAt: T0, id: NEWER, reportedAt: T2 }),
  ];

  assert.equal(
    sealIndex(reported).split("\n")[0],
    `Latest reported seal (re-check this one): \`${NEWER}\`, reported 2026-01-03T00:00:00.000Z.`
  );

  assert.match(
    sealIndex([reported[11], reported[12]].filter((s) => s !== undefined)),
    new RegExp(
      `- \`${OLDER}\` default · d · created [^\n]* · reported automatically\n- \`${NEWER}\` [^\n]* · reported$`,
      "u"
    )
  );
});
