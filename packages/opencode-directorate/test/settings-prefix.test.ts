// The Liaison's `[directorate settings]` line: frozen per seal once read, but a failed read is not frozen.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { Plugin } from "@opencode/plugin/effect";
import type { SessionContext } from "@opencode/plugin/effect/session";
import { Effect } from "effect";

import { Liaison } from "../src/feature/agents/agent.ts";
import type { Settings } from "../src/feature/settings/file.ts";
import { settingsLines } from "../src/feature/settings/prefix.ts";
import { SettingsStore } from "../src/feature/settings/settings.ts";
import { settingsUnavailable } from "../src/feature/settings/store.ts";
import { Host } from "../src/platform/platform.ts";
import { SealIdSchema } from "../src/seal/seal-id.ts";
import { Sessions } from "../src/seal/seal.ts";
import { bareSeal } from "./fixtures.ts";
import { runPromise, verifyLogs } from "./logs.ts";

afterEach(verifyLogs);

test("an unreadable settings file is shown for one request, not frozen for the seal", async () => {
  const reads: (Settings | Error)[] = [
    new Error("busy disk"),
    { mode: "full" },
    { mode: "code-quality" },
  ];

  const store = SettingsStore.of({
    // SAFETY: settingsLines uses only load.
    ...(Object.create(null) as SettingsStore["Service"]),
    load: () =>
      Effect.suspend(() => {
        const next = reads.shift() ?? assert.fail("read too often");

        return next instanceof Error
          ? Effect.fail(settingsUnavailable("Cannot read", next))
          : Effect.succeed({
              effective: next,
              files: {},
              global: next,
              project: {},
            });
      }),
  });

  // SAFETY: with a seal, the directory is the seal's repository: the host is never asked.
  const host = Object.create(null) as Plugin.Context;
  // SAFETY: with a seal, the directory is the seal's repository: sessions are never asked.
  const sessions = Object.create(null) as Sessions["Service"];

  const lines = await runPromise(
    settingsLines().pipe(
      Effect.provideService(SettingsStore, store),
      Effect.provideService(Host, host),
      Effect.provideService(Sessions, sessions)
    )
  );

  const seal = bareSeal({
    id: SealIdSchema.make("directorate-20260101000000-f02e17"),
  });

  const push = async () => {
    const system: { text: string; type: string }[] = [];

    // SAFETY: push reads only the agent and the system prompt it appends to.
    const event = Object.assign(Object.create(null) as SessionContext, {
      agent: Liaison.id,
      system,
    });

    await runPromise(lines.push(event, seal));

    return system.map((s) => s.text);
  };

  assert.deepEqual(await push(), [
    "[directorate settings] unreadable: Cannot read: busy disk",
  ]);
  assert.deepEqual(await push(), ["[directorate settings] mode full"]);
  assert.deepEqual(
    await push(),
    ["[directorate settings] mode full"],
    "a line that was read stays frozen for the seal"
  );
  assert.equal(reads.length, 1);
});
