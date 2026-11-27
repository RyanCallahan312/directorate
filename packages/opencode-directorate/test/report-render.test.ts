import assert from "node:assert/strict";
import { test } from "node:test";

import { DateTime } from "effect";

import { Actor } from "../src/feature/agents/agent.ts";
import {
  Carried,
  Entry,
  EntryIdSchema,
  Ledger,
  Note,
  Verdict,
} from "../src/feature/ledger/entry.ts";
import type { VerdictKind } from "../src/feature/ledger/entry.ts";
import { renderReport } from "../src/feature/report/render.ts";
import { SessionIdSchema } from "../src/platform/host-id.ts";
import { Anchor } from "../src/seal/region.ts";
import { SealIdSchema } from "../src/seal/seal-id.ts";
import { bareSeal } from "./fixtures.ts";

const T0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

const lead = Actor.make({
  agent: "directorate_liaison",
  session: SessionIdSchema.make("ses_lead"),
});

const scout = Actor.make({
  agent: "directorate_auditor",
  session: SessionIdSchema.make("ses_scout"),
});

const compliance = Actor.make({
  agent: "directorate_compliance",
  session: SessionIdSchema.make("ses_c"),
});

const decided = (
  id: string,
  verdict: VerdictKind,
  o: { carried?: Carried; evidence?: string[]; severity?: "important" } = {}
) =>
  Entry.make({
    anchor: Anchor.make({ endLine: 2, line: 2, path: "src/a.ts", side: "new" }),
    carried: o.carried,
    consequence: "crash",
    createdAt: T0,
    evidence: ["src/a.ts:2"],
    id: EntryIdSchema.make(id),
    kind: "defect",
    lens: "correctness",
    quote: "q",
    raisedBy: scout,
    severity: o.severity ?? "minor",
    status: verdict,
    title: `title ${id}`,
    trigger: "x",
    verdicts: [
      Verdict.make({
        at: T0,
        by: compliance,
        evidence: o.evidence ?? ["src/a.ts:1"],
        rationale: "because",
        verdict,
      }),
    ],
  });

test("render: carried findings previously unverified, recorded assumptions, and unverified freshness", () => {
  const ledger = Ledger.make({
    entries: [
      decided("F1", "confirmed", {
        carried: Carried.make({
          id: EntryIdSchema.make("F7"),
          status: "unverified",
        }),
      }),
      decided("F2", "resolved", {
        carried: Carried.make({
          id: EntryIdSchema.make("F8"),
          status: "unverified",
        }),
      }),
      decided("F3", "resolved", {
        carried: Carried.make({
          id: EntryIdSchema.make("F9"),
          status: "confirmed",
        }),
        evidence: [],
      }),
      decided("F4", "refuted", { severity: "important" }),
    ],
    notes: [
      Note.make({
        at: T0,
        by: lead,
        kind: "assumption",
        text: "inputs are trusted",
      }),
      Note.make({ at: T0, by: lead, kind: "limit", text: "no tests read" }),
    ],
  });

  const md = renderReport({
    ledger,
    reasons: [],
    seal: bareSeal({
      freshnessUnverified: "git timed out",
      recheckOf: SealIdSchema.make("directorate-20251231000000-000001"),
    }),
    status: "partial",
  });

  assert.match(
    md,
    /^1\. \*\*\[Minor\] title F1\*\* — `src\/a\.ts:2` · defect · correctness · previously unverified \(F7 in `directorate-20251231000000-000001`\)$/mu
  );

  assert.match(
    md,
    /^- title F2 — was `src\/a\.ts:2` \(minor, F8, previously unverified\); resolved by directorate_compliance: because `src\/a\.ts:1`$/mu
  );

  // No evidence: the line ends at the rationale, with no trailing space.
  assert.match(
    md,
    /^- title F3 — was `src\/a\.ts:2` \(minor, F9\); resolved by directorate_compliance: because$/mu
  );

  assert.match(
    md,
    /^- title F4 — `src\/a\.ts:2` \(important, raised by directorate_auditor; refuted by directorate_compliance: because `src\/a\.ts:1`\)$/mu
  );

  assert.match(md, /^- Limit: no tests read$/mu);
  assert.match(md, /^- Freshness not verified: git timed out$/mu);
  // Only assumptions are listed under Recorded Assumptions; limits stay under Outside Containment.
  assert.match(
    md,
    /\n### Recorded Assumptions\n- inputs are trusted\n\nExport this review/u
  );
});
