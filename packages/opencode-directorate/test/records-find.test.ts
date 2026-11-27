// Records lookups that never decode more than they must: a missing seal is none, a damaged one is none but logged, and
// a record's modification time is read without decoding it.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { test } from "node:test";

import { Effect, Layer, Logger } from "effect";

import { nodeLayer } from "../src/platform/platform.ts";
import { Records, StateRoot } from "../src/records/records.ts";
import { SealIdSchema } from "../src/seal/seal-id.ts";
import type { SealId } from "../src/seal/seal-id.ts";
import { bareSeal, emptyLedger } from "./fixtures.ts";

const { mkdirSync, mkdtempSync, utimesSync, writeFileSync } = fs;
const { join } = nodePath;

const GOOD = SealIdSchema.make("directorate-20260101000000-abcdef");
const DAMAGED = SealIdSchema.make("directorate-20260102000000-abcdef");

/** Records stored under a fresh temporary directory, and the warnings its runs log. */
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "directorate-find-"));
  const state = join(dir, "state");
  const warnings: string[] = [];

  const capture = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") {
      warnings.push(JSON.stringify(message));
    }
  });

  const layer = Records.layer.pipe(
    Layer.provide(Layer.succeed(StateRoot, state)),
    Layer.provideMerge(nodeLayer)
  );

  return {
    run: <A, E>(effect: Effect.Effect<A, E, Records>) =>
      Effect.runPromise(
        effect.pipe(Effect.provide(Layer.merge(layer, Logger.layer([capture]))))
      ),
    state,
    warnings,
  };
};

/** A stored seal under `id`, written through the repository. */
const saved = (state: string, id: SealId) => {
  mkdirSync(join(state, id), { recursive: true });

  return Records.use((st) =>
    st.saveBoth(bareSeal({ gen: 0, id, postImage: "worktree" }), emptyLedger)
  );
};

test("find reads a missing seal as none, without a warning", async () => {
  const { run, warnings } = fresh();

  const found = await run(Records.use((st) => st.find(GOOD)));

  assert.equal(found, undefined);
  assert.deepEqual(warnings, []);
});

test("find reads a damaged seal as none and warns; lists skip it", async () => {
  const { run, state, warnings } = fresh();

  const out = await run(
    Effect.gen(function* damaged() {
      yield* saved(state, GOOD);
      mkdirSync(join(state, DAMAGED));
      writeFileSync(join(state, DAMAGED, "seal.json"), "{ not json");

      const st = yield* Records;

      return {
        found: yield* st.find(DAMAGED),
        good: (yield* st.find(GOOD))?.id,
        list: (yield* st.list()).map((s) => s.id),
        without: (yield* st.listWithout(new Set())).map((s) => s.id),
      };
    })
  );

  assert.deepEqual(out, {
    found: undefined,
    good: GOOD,
    list: [GOOD],
    without: [GOOD],
  });
  assert.ok(
    warnings.some((w) => w.includes(DAMAGED) && w.includes("is damaged")),
    `expected a warning naming ${DAMAGED}: ${warnings.join("\n")}`
  );
});

test("modifiedAt is the newer of seal.json and commit.json, and none without either", async () => {
  const { run, state } = fresh();
  const review = join(state, GOOD);

  assert.equal(await run(Records.use((st) => st.modifiedAt(GOOD))), undefined);

  await run(saved(state, GOOD));
  const older = new Date(Date.UTC(2026, 0, 1));
  utimesSync(join(review, "seal.json"), older, older);
  assert.equal(
    await run(Records.use((st) => st.modifiedAt(GOOD))),
    older.getTime()
  );

  // An unfinished pair commit is newer than the seal it will replace.
  const newer = new Date(Date.UTC(2026, 0, 2));
  writeFileSync(join(review, "commit.json"), "{}");
  utimesSync(join(review, "commit.json"), newer, newer);
  assert.equal(
    await run(Records.use((st) => st.modifiedAt(GOOD))),
    newer.getTime()
  );
});
