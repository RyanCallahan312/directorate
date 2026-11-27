import assert from "node:assert/strict";
import { test } from "node:test";

import { DateTime } from "effect";

import { Actor } from "../src/feature/agents/agent.ts";
import { Running } from "../src/feature/dispatch/lifecycle.ts";
import { Entry, EntryIdSchema, Ledger } from "../src/feature/ledger/entry.ts";
import { Gates } from "../src/feature/report/directive.ts";
import {
  coverageGate,
  dossierGate,
  driftGate,
  heldAfterFreshness,
  heldBeforeFreshness,
  Hold,
  personnelGate,
  pushesBack,
  seatsGate,
} from "../src/feature/report/gates.ts";
import { CallIdSchema, SessionIdSchema } from "../src/platform/host-id.ts";
import { Anchor, Region } from "../src/seal/region.ts";
import { bareSeal, emptyLedger } from "./fixtures.ts";

const T0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

const region = (id: string, ownerRead?: boolean) =>
  Region.make({
    file: "src/a.ts",
    id,
    newEnd: 2,
    newStart: 1,
    ownerRead,
    patchEnd: 2,
    patchStart: 1,
    readBy: [],
  });

const running = new Running({
  agent: "directorate_auditor",
  call: CallIdSchema.make("call_1"),
  prompt: "question: is it safe?",
  session: SessionIdSchema.make("ses_scout"),
  startedAt: T0,
});

const openEntry = Entry.make({
  anchor: Anchor.make({ endLine: 1, line: 1, path: "src/a.ts", side: "new" }),
  consequence: "c",
  createdAt: T0,
  evidence: ["src/a.ts:1"],
  id: EntryIdSchema.make("F1"),
  kind: "defect",
  lens: "correctness",
  quote: "q",
  raisedBy: Actor.make({
    agent: "directorate_auditor",
    session: SessionIdSchema.make("ses_scout"),
  }),
  severity: "minor",
  status: "open",
  title: "t",
  trigger: "x",
  verdicts: [],
});

const openLedger = Ledger.make({ entries: [openEntry], notes: [] });

const coverageHold = Hold.make({ ids: ["R1"], key: "coverage", message: "m" });

test("pushesBack: locked never pushes back; only newly seen ids push", () => {
  const cases = [
    {
      expected: undefined,
      gates: Gates.make({}),
      name: "locked, with a new id",
      phase: "locked",
    },
    {
      expected: undefined,
      gates: Gates.make({ coverage: ["R1"] }),
      name: "every id seen",
      phase: "normal",
    },
    {
      expected: { coverage: ["R1"] },
      gates: Gates.make({}),
      name: "nothing seen yet",
      phase: "normal",
    },
    {
      expected: { coverage: ["R0", "R1"] },
      gates: Gates.make({ coverage: ["R0"] }),
      name: "a new id beside a seen one, in drain",
      phase: "drain",
    },
  ] as const;

  for (const { expected, gates, name, phase } of cases) {
    assert.deepEqual(
      pushesBack(bareSeal({ gates }), phase, coverageHold),
      expected,
      name
    );
  }
});

test("driftGate: holds only for a new fingerprint, before the one refresh, unless remembered or locked", () => {
  const cases = [
    { name: "all terms hold", phase: "normal", seal: bareSeal({}), want: true },
    {
      fingerprint: "f",
      name: "fingerprint unchanged",
      phase: "normal",
      seal: bareSeal({}),
      want: false,
    },
    {
      name: "already refreshed once",
      phase: "normal",
      seal: bareSeal({ refreshes: 1 }),
      want: false,
    },
    {
      name: "this fingerprint already pushed back",
      phase: "normal",
      seal: bareSeal({ gates: Gates.make({ freshness: "g" }) }),
      want: false,
    },
    { name: "locked", phase: "locked", seal: bareSeal({}), want: false },
  ] as const;

  for (const c of cases) {
    const fingerprint = "fingerprint" in c ? c.fingerprint : "g";
    const out = driftGate(c.seal, c.phase, fingerprint, "");

    assert.equal(out !== undefined, c.want, c.name);
  }

  assert.match(
    driftGate(bareSeal({}), "normal", "g", "head moved") ?? "",
    /^Protocol hold \(Containment Drift\): the artifact changed after sealing \(head moved\)\./u
  );
});

test("each gap gate reads its own protocol hold, and holds nothing when there is no gap", () => {
  const cases = [
    {
      empty: coverageGate(bareSeal({})),
      held: coverageGate(bareSeal({ regions: [region("R1")] })),
      ids: ["R1"],
      key: "coverage",
      message:
        /^Protocol hold \(Coverage\): 1 of 1 regions unread: R1 src\/a\.ts:1-2\./u,
    },
    {
      empty: seatsGate(bareSeal({ regions: [region("R1", true)] }), "normal"),
      held: seatsGate(
        bareSeal({ panel: ["openai/gpt"], regions: [region("R1", true)] }),
        "normal"
      ),
      ids: ["openai/gpt:0"],
      key: "panel",
      message:
        /^Protocol hold \(Seats\): 1 of 1 Directorate Seats returned no review: gpt \(not launched\)\./u,
    },
    {
      empty: personnelGate(bareSeal({})),
      held: personnelGate(bareSeal({ children: [running] })),
      ids: ["call_1"],
      key: "children",
      message:
        /^Protocol hold \(Active Personnel\): Still running: directorate_auditor \(ses_scout\)\./u,
    },
    {
      empty: dossierGate(emptyLedger),
      held: dossierGate(openLedger),
      ids: ["F1:open:0:0"],
      key: "open",
      message:
        /^Protocol hold \(Unverified Dossier\): 1 entries are unresolved: F1 \(minor, by directorate_auditor\)\./u,
    },
  ] as const;

  for (const { empty, held, ids, key, message } of cases) {
    assert.equal(empty, undefined, `${key}: no gap`);
    assert.ok(held, `${key}: a gap`);
    assert.equal(held.key, key);
    assert.deepEqual(held.ids, ids);
    assert.match(held.message, message);
  }

  assert.match(
    seatsGate(
      bareSeal({ panel: ["openai/gpt"], regions: [region("R1", true)] }),
      "drain"
    )?.message ?? "",
    /Seats can no longer be launched or continued during drain\./u
  );
});

test("gate order: Coverage, Seats, Active Personnel before the fingerprint check; Containment Drift, then the Dossier, after it", () => {
  const everything = bareSeal({
    children: [running],
    panel: ["openai/gpt"],
    regions: [region("R1")],
  });

  const order: string[] = [];
  let seal = everything;

  for (;;) {
    const held = heldBeforeFreshness(seal, "normal");

    if (!held) {
      break;
    }

    order.push(held.message.slice(0, held.message.indexOf(")") + 1));
    seal = bareSeal({
      ...seal,
      gates: seal.gates.remembering(held.remembered),
    });
  }

  assert.deepEqual(order, [
    "Protocol hold (Coverage)",
    "Protocol hold (Seats)",
    "Protocol hold (Active Personnel)",
  ]);

  const drift = heldAfterFreshness(seal, openLedger, "normal", {
    fingerprint: "g",
  });

  assert.match(drift?.message ?? "", /^Protocol hold \(Containment Drift\)/u);
  assert.deepEqual(drift?.remembered, { freshness: "g" });

  // The freshness check could not tell the fingerprint, or Containment Drift already pushed back: the Dossier is next.
  for (const current of [undefined, { fingerprint: "f" }]) {
    const held = heldAfterFreshness(seal, openLedger, "normal", current);

    assert.match(held?.message ?? "", /^Protocol hold \(Unverified Dossier\)/u);
    assert.deepEqual(held?.remembered, { open: ["F1:open:0:0"] });
  }

  assert.equal(
    heldAfterFreshness(seal, emptyLedger, "normal", { fingerprint: "f" }),
    undefined
  );

  // Locked budgets pass every gate.
  assert.equal(heldBeforeFreshness(everything, "locked"), undefined);
  assert.equal(
    heldAfterFreshness(everything, openLedger, "locked", { fingerprint: "g" }),
    undefined
  );
});
