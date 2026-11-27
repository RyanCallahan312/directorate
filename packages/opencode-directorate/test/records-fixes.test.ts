// Records persistence: settings saves reclaim an orphaned lock, export keeps to committed generations, a ledger and
// seal pair commits as one, and retention never removes a review another writer made current.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { afterEach, test } from "node:test";

import { ConfigProvider, Effect, FileSystem, Layer, Schema } from "effect";

import { LedgerJson } from "../src/feature/ledger/entry.ts";
import { SettingsStore } from "../src/feature/settings/settings.ts";
import { platformLayer } from "../src/index.ts";
import type { Platform } from "../src/index.ts";
import { SessionIdSchema } from "../src/platform/host-id.ts";
import { copyReview } from "../src/records/export.ts";
import { Records } from "../src/records/records.ts";
import { SealIdSchema } from "../src/seal/seal-id.ts";
import { bareSeal, emptyLedger } from "./fixtures.ts";
import { expectWarnings, runPromise, verifyLogs } from "./logs.ts";

afterEach(verifyLogs);

const { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync } = fs;
const { join } = nodePath;

/** A platform storing seals, and the global settings file, under a fresh temporary directory. */
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "directorate-records-"));
  const state = join(dir, "state");

  const layer = platformLayer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          DIRECTORATE_SETTINGS: join(dir, "directorate.json"),
          DIRECTORATE_STATE_DIR: state,
        })
      )
    )
  );

  return {
    dir,
    run: <A, E>(effect: Effect.Effect<A, E, Platform>) =>
      runPromise(effect.pipe(Effect.provide(layer))),
    state,
  };
};

const ID = SealIdSchema.make("directorate-20260101000000-abcdef");
const DEAD_PID = 2 ** 22 + 1;

/** A Records instance over `fs`, separate from the platform's own. */
const recordsWith = (files: FileSystem.FileSystem) =>
  Records.pipe(
    Effect.provide(Layer.fresh(Records.layer)),
    Effect.provideService(FileSystem.FileSystem, files)
  );

/** The platform's filesystem with `rename` failing for destinations whose name ends with `name`. */
const failingRename = (name: string) =>
  Effect.gen(function* renameFailing() {
    const real = yield* FileSystem.FileSystem;

    return FileSystem.FileSystem.of({
      ...real,
      rename: (from, to) =>
        to.endsWith(name)
          ? real.rename(from, join(from, "missing", "nowhere"))
          : real.rename(from, to),
    });
  });

/** A stored seal of generation 0 and an empty ledger, written directly. */
const sealed = (state: string) => {
  const seal = bareSeal({ gen: 0, id: ID, postImage: "worktree" });

  mkdirSync(join(state, ID), { recursive: true });

  return seal;
};

const fixtureLedger = Schema.decodeSync(LedgerJson)(
  readFileSync(new URL("stored/ledger.json", import.meta.url), "utf-8")
);

test("a settings save reclaims a lock whose holder is gone or that is long stale", async () => {
  const { dir, run } = fresh();
  const at = join(dir, "directorate.json");
  const lock = `${at}.lock`;

  const write = (mode: "full" | "code-quality") =>
    run(
      SettingsStore.use((s) => s.write("global", dir, { mode })).pipe(
        Effect.timeout("5 seconds")
      )
    );

  // A lock left by a process that has exited.
  mkdirSync(lock);
  fs.writeFileSync(
    join(lock, "holder"),
    JSON.stringify({ at: Date.now(), pid: DEAD_PID, token: "x" })
  );
  await write("full");
  assert.equal(existsSync(lock), false);
  assert.match(readFileSync(at, "utf-8"), /"full"/u);

  // A lock without a holder record, left long ago.
  mkdirSync(lock);
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(lock, old, old);
  await write("code-quality");
  assert.equal(existsSync(lock), false);
  assert.match(readFileSync(at, "utf-8"), /"code-quality"/u);
});

test("export copies only generations up to the committed one", async () => {
  const { run, state } = fresh();
  const seal = sealed(state);
  const review = join(state, ID);

  // Generation 0 is committed; a rejected refresh left generation 1's diff and snapshot behind.
  fs.writeFileSync(join(review, "diff.patch"), "g0");
  mkdirSync(join(review, "snapshot"));
  fs.writeFileSync(join(review, "diff.g1.patch"), "g1");
  mkdirSync(join(review, "snapshot.g1"));

  const staging = mkdtempSync(join(tmpdir(), "directorate-export-"));

  const out = await run(
    Effect.gen(function* exported() {
      const st = yield* Records;
      yield* st.saveBoth(seal, emptyLedger);

      return yield* copyReview(ID, staging);
    })
  );

  assert.deepEqual(out.artifacts, [
    "seal/diff.patch",
    "seal/ledger.json",
    "seal/seal.json",
    "seal/snapshot",
  ]);
  assert.deepEqual(out.missingArtifacts, []);
  assert.equal(existsSync(join(staging, "seal", "diff.g1.patch")), false);
  assert.equal(existsSync(join(staging, "seal", "snapshot.g1")), false);
});

test("a ledger and seal pair whose seal.json replacement fails is saved, reads as the new pair, and the next lock finishes it", async () => {
  const { run, state } = fresh();
  const seal = sealed(state);
  const next = bareSeal({ gen: 1, id: ID, postImage: "worktree" });
  const review = join(state, ID);

  expectWarnings(/finishing the pair commit of \S+: [\s\S]*rename/u);

  const reopened = await run(
    Effect.gen(function* stopped() {
      yield* (yield* Records).saveBoth(seal, emptyLedger);

      // The ledger is replaced, then replacing seal.json fails: commit.json already holds the pair, so the save succeeds.
      const failing = yield* recordsWith(yield* failingRename("seal.json"));
      yield* failing.saveBoth(next, fixtureLedger);

      // A new Records, as after a restart.
      const st = yield* recordsWith(yield* FileSystem.FileSystem);

      return {
        entries: (yield* st.loadLedger(ID)).entries.length,
        gen: (yield* st.load(ID)).gen,
        list: (yield* st.list()).map((s) => s.gen),
      };
    })
  );

  assert.equal(existsSync(join(review, "commit.json")), true);
  assert.deepEqual(reopened, {
    entries: fixtureLedger.entries.length,
    gen: 1,
    list: [1],
  });

  // The next lock holder finishes the commit, leaving both files on the new pair.
  await run(Records.use((st) => st.withLock(ID, Effect.void)));
  assert.equal(existsSync(join(review, "commit.json")), false);
  assert.match(readFileSync(join(review, "seal.json"), "utf-8"), /"gen": 1/u);
  assert.equal(
    Schema.decodeSync(LedgerJson)(
      readFileSync(join(review, "ledger.json"), "utf-8")
    ).entries.length,
    fixtureLedger.entries.length
  );
});

test("a ledger and seal pair stopped before its commit point reads as the old pair", async () => {
  const { run, state } = fresh();
  const seal = sealed(state);
  const next = bareSeal({ gen: 1, id: ID, postImage: "worktree" });

  const reopened = await run(
    Effect.gen(function* stopped() {
      yield* (yield* Records).saveBoth(seal, emptyLedger);

      const failing = yield* recordsWith(yield* failingRename("commit.json"));
      yield* failing.saveBoth(next, fixtureLedger).pipe(Effect.flip);

      const st = yield* recordsWith(yield* FileSystem.FileSystem);

      return {
        entries: (yield* st.loadLedger(ID)).entries.length,
        gen: (yield* st.load(ID)).gen,
      };
    })
  );

  assert.deepEqual(reopened, { entries: 0, gen: 0 });
});

/** Ages a review: its record files and then its directory, last written long ago. */
const age = (state: string) => {
  const old = new Date(Date.now() - 40 * 86_400_000);
  const review = join(state, ID);

  for (const name of fs.readdirSync(review)) {
    utimesSync(join(review, name), old, old);
  }

  utimesSync(review, old, old);
};

test("retention removes an aged review", async () => {
  const { run, state } = fresh();
  const seal = sealed(state);

  await run(Records.use((st) => st.saveBoth(seal, emptyLedger)));
  age(state);
  await run(Records.use((st) => st.gc()));
  assert.equal(existsSync(join(state, ID)), false);
});

test("retention keeps an aged review that a writer made current after retention first saw it", async () => {
  const { run, state } = fresh();
  const seal = sealed(state);
  const review = join(state, ID);

  await run(Records.use((st) => st.saveBoth(seal, emptyLedger)));
  age(state);

  const resumed = bareSeal({
    gen: 0,
    id: ID,
    ownerSession: SessionIdSchema.make("ses_takeover"),
    postImage: "worktree",
  });

  await run(
    Effect.gen(function* raced() {
      const writer = yield* Records;
      const real = yield* FileSystem.FileSystem;
      let paused = false;

      // Retention observes the aged directory; before it continues, another session resumes the review.
      const pausing = FileSystem.FileSystem.of({
        ...real,
        stat: (path) =>
          real.stat(path).pipe(
            Effect.tap(() =>
              path === review && !paused
                ? Effect.sync(() => {
                    paused = true;
                  }).pipe(
                    Effect.andThen(writer.withLock(ID, writer.save(resumed))),
                    Effect.orDie
                  )
                : Effect.void
            )
          ),
      });

      yield* (yield* recordsWith(pausing)).gc();
      assert.ok(paused);
    })
  );

  assert.equal(existsSync(review), true);
  const kept = await run(Records.use((st) => st.load(ID)));
  assert.equal(kept.ownerSession, "ses_takeover");
});

test("an unreadable ledger is damage naming its seal, not an empty dossier", async () => {
  const { run, state } = fresh();
  const seal = sealed(state);

  const error = await run(
    Effect.gen(function* unreadable() {
      const st = yield* Records;
      yield* st.saveBoth(seal, emptyLedger);
      fs.rmSync(join(state, ID, "ledger.json"));
      mkdirSync(join(state, ID, "ledger.json"));

      return yield* st.loadLedger(ID).pipe(Effect.flip);
    })
  );

  assert.equal(error._tag, "RecordDamaged");
  assert.match(error.message, new RegExp(`Cannot read ledger for ${ID}`, "u"));
});

test("records and settings files are replaced whole, with the settings newline, leaving no temporary files", async () => {
  const { dir, run, state } = fresh();
  const seal = sealed(state);
  const at = join(dir, "directorate.json");

  await run(
    Effect.gen(function* saved() {
      yield* (yield* Records).saveBoth(seal, emptyLedger);
      yield* SettingsStore.use((s) => s.write("global", dir, { mode: "full" }));
    })
  );

  const review = join(state, ID);
  assert.deepEqual(fs.readdirSync(review).toSorted(), [
    "ledger.json",
    "seal.json",
  ]);
  assert.equal(readFileSync(at, "utf-8"), '{\n  "mode": "full"\n}\n');
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.startsWith(".directorate-")),
    []
  );
});

test("export reads numbered generations by the names the repository writes", async () => {
  const { run, state } = fresh();
  const seal = bareSeal({ gen: 1, id: ID, postImage: "worktree" });
  const review = join(state, ID);
  mkdirSync(review, { recursive: true });

  fs.writeFileSync(join(review, "diff.patch"), "g0");
  mkdirSync(join(review, "snapshot"));
  // Generation 1 is committed without its snapshot; generation 2 was never committed.
  fs.writeFileSync(join(review, "diff.g1.patch"), "g1");
  fs.writeFileSync(join(review, "diff.g2.patch"), "g2");
  mkdirSync(join(review, "snapshot.g2"));

  const staging = mkdtempSync(join(tmpdir(), "directorate-export-"));

  const out = await run(
    Effect.gen(function* exported() {
      const st = yield* Records;
      yield* st.saveBoth(seal, emptyLedger);
      assert.equal(st.diffFile(seal), join(review, "diff.g1.patch"));

      return yield* copyReview(ID, staging);
    })
  );

  assert.deepEqual(out.artifacts, [
    "seal/diff.g1.patch",
    "seal/diff.patch",
    "seal/ledger.json",
    "seal/seal.json",
    "seal/snapshot",
  ]);
  assert.deepEqual(out.missingArtifacts, ["snapshot.g1"]);
});
