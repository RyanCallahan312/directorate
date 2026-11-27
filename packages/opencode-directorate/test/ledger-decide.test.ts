import assert from "node:assert/strict";
import { test } from "node:test";

import { DateTime } from "effect";

import { Actor } from "../src/feature/agents/agent.ts";
import { resolvedTarget, unresolved } from "../src/feature/ledger/decide.ts";
import {
  Entry,
  EntryIdSchema,
  Ledger,
  Verdict,
} from "../src/feature/ledger/entry.ts";
import { SessionIdSchema } from "../src/platform/host-id.ts";
import { Anchor } from "../src/seal/region.ts";

const T0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

const compliance = Actor.make({
  agent: "directorate_compliance",
  session: SessionIdSchema.make("ses_c"),
});

const entry = (id: string, of?: string) =>
  Entry.make({
    anchor: Anchor.make({ endLine: 1, line: 1, path: "src/a.ts", side: "new" }),
    consequence: "c",
    createdAt: T0,
    evidence: ["src/a.ts:1"],
    id: EntryIdSchema.make(id),
    kind: "defect",
    lens: "correctness",
    quote: "q",
    raisedBy: Actor.make({
      agent: "directorate_auditor",
      session: SessionIdSchema.make("ses_a"),
    }),
    severity: "minor",
    status: of === undefined ? "confirmed" : "duplicate",
    title: id,
    trigger: "x",
    verdicts:
      of === undefined
        ? []
        : [
            Verdict.make({
              at: T0,
              by: compliance,
              evidence: ["src/a.ts:1"],
              of: EntryIdSchema.make(of),
              rationale: "same",
              verdict: "duplicate",
            }),
          ],
  });

test("resolvedTarget: follows a chain to its root, and is undefined for a cycle or a missing target", () => {
  const ledger = Ledger.make({
    entries: [
      entry("F1"),
      entry("F2", "F1"),
      entry("F3", "F2"),
      entry("F4", "F5"),
      entry("F5", "F4"),
      entry("F6", "F9"),
      entry("F7", "F6"),
    ],
    notes: [],
  });

  const cases = [
    ["F1", "F1", "a non-duplicate is its own root"],
    ["F2", "F1", "a direct duplicate"],
    ["F3", "F1", "a chain"],
    ["F4", undefined, "a two-entry cycle"],
    ["F5", undefined, "the cycle's other end"],
    ["F6", undefined, "a target that does not exist"],
    ["F7", undefined, "a chain ending at a missing target"],
  ] as const;

  for (const [id, root, name] of cases) {
    const e = ledger.entryById(EntryIdSchema.make(id));
    assert.ok(e);
    assert.equal(resolvedTarget(ledger, e)?.id, root, name);
  }

  // Duplicates with no confirmed root stay unresolved.
  assert.deepEqual(
    unresolved(ledger).map((e) => e.id),
    ["F4", "F5", "F6", "F7"]
  );
});
