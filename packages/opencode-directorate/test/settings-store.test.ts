// SettingsStore against real files: no global config directory, an unreadable file's cause, and removing a file that is
// not there.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { afterEach, test } from "node:test";

import { ConfigProvider, Effect, Layer } from "effect";

import { SettingsStore } from "../src/feature/settings/settings.ts";
import { platformLayer } from "../src/index.ts";
import type { Platform } from "../src/index.ts";
import { runPromise, verifyLogs } from "./logs.ts";

afterEach(verifyLogs);

const { join } = nodePath;

/** A platform under a fresh temporary directory, configured by `env` alone. */
const fresh = (env: (dir: string) => Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "directorate-settings-"));

  const layer = platformLayer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          DIRECTORATE_STATE_DIR: join(dir, "state"),
          ...env(dir),
        })
      )
    )
  );

  return {
    dir,
    run: <A, E>(effect: Effect.Effect<A, E, Platform>) =>
      runPromise(effect.pipe(Effect.provide(layer))),
  };
};

test("without a global config directory there is no global file, not a placeholder path", async () => {
  const { dir, run } = fresh(() => ({}));
  const project = join(dir, "repo");
  mkdirSync(project);

  const loaded = await run(SettingsStore.use((s) => s.load(project)));

  assert.deepEqual(loaded.files, {
    project: join(project, ".opencode", "directorate.json"),
  });
  assert.deepEqual(loaded.global, {});

  const error = await run(
    Effect.flip(SettingsStore.use((s) => s.write("global", project, {})))
  );

  assert.match(error.message, /^No global settings file/u);
});

test("a git failure other than 'not a repository' is unavailable, not a project file in the directory itself", async () => {
  const { dir, run } = fresh(() => ({}));
  // git cannot enter a directory that does not exist: a failure, not "outside any repository".
  const missing = join(dir, "missing");

  const error = await run(
    Effect.flip(SettingsStore.use((s) => s.load(missing)))
  );

  assert.match(
    error.message,
    /^Cannot find the repository of .+missing: git rev-parse failed/u
  );
  assert.ok(error.cause instanceof Error, "the git failure is kept");
});

test("an invalid settings file is unavailable, keeping the decode failure as its cause", async () => {
  const { dir, run } = fresh((d) => ({
    DIRECTORATE_SETTINGS: join(d, "directorate.json"),
  }));

  writeFileSync(join(dir, "directorate.json"), '{ "mode": "fast" }');
  mkdirSync(join(dir, "repo"));

  const error = await run(
    Effect.flip(SettingsStore.use((s) => s.load(join(dir, "repo"))))
  );

  assert.match(
    error.message,
    /directorate\.json is not valid Directorate settings: .+\. Fix it, or delete it/su
  );
  assert.ok(error.cause instanceof Error, "the decode failure is kept");
});

test("removing a settings file that is not there creates no directory and takes no lock", async () => {
  const { dir, run } = fresh((d) => ({
    DIRECTORATE_SETTINGS: join(d, "directorate.json"),
  }));

  const project = join(dir, "repo");
  mkdirSync(project);

  const out = await run(
    SettingsStore.use((s) => s.write("project", project, {}))
  );

  assert.equal(out.removed, true);
  assert.equal(out.path, join(project, ".opencode", "directorate.json"));
  assert.equal(existsSync(join(project, ".opencode")), false);
});
