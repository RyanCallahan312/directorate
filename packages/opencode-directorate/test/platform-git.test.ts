// Git.rootOption: none only when git says the directory is outside any repository; other failures still fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { afterEach, test } from "node:test";

import { Effect, Layer, Option } from "effect";

import { Git, nodeLayer } from "../src/platform/platform.ts";
import { runPromise, verifyLogs } from "./logs.ts";

afterEach(verifyLogs);

const { join } = nodePath;

const run = <A, E>(effect: Effect.Effect<A, E, Git>) =>
  runPromise(
    effect.pipe(Effect.provide(Git.layer.pipe(Layer.provide(nodeLayer))))
  );

test("rootOption is none outside a repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "directorate-norepo-"));

  assert.ok(Option.isNone(await run(Git.use((git) => git.rootOption(dir)))));
});

test("rootOption is the work tree's top from inside it", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "directorate-repo-")));
  execFileSync("git", ["init", "-q", dir]);
  const sub = join(dir, "sub");
  mkdirSync(sub);

  assert.deepEqual(
    await run(Git.use((git) => git.rootOption(sub))),
    Option.some(dir)
  );
});

test("rootOption fails for anything but a missing repository", async () => {
  const missing = join(tmpdir(), "directorate-missing-dir", "nowhere");

  const error = await run(
    Git.use((git) => git.rootOption(missing)).pipe(Effect.flip)
  );

  assert.equal(error._tag, "GitFailed");
});
