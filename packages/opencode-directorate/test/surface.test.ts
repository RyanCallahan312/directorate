// The host-facing surface: what the plugin registers at load (tools with their input JSON Schema, commands, agents,
// skills, RPC, hooks, event subscriptions) is what OpenCode and the model see, so it must match test/stored/surface.json
// exactly. A change here is a change for every user's prompt prefix, not a refactor.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { Schema } from "effect";

import { verifyLogs } from "./logs.ts";
import { captureSurface } from "./surface.ts";

afterEach(verifyLogs);

const Entries = Schema.Array(Schema.Json);

const Surface = Schema.Struct({
  agents: Entries,
  commands: Entries,
  hooks: Entries,
  rpcs: Entries,
  skills: Entries,
  subscriptions: Entries,
  tools: Entries,
});

const decodeSurface = Schema.decodeUnknownSync(Surface);

const stored = decodeSurface(
  JSON.parse(
    readFileSync(new URL("stored/surface.json", import.meta.url), "utf-8")
  )
);

const isNamed = Schema.is(Schema.Struct({ name: Schema.String }));

/**
 * Each entry that differs, with its own diff, so one changed tool reads as one small diff. Categories without names
 * (hooks, subscriptions, RPC) are short lists and compare whole.
 */
const differences = (
  category: string,
  expected: readonly Schema.Json[],
  actual: readonly Schema.Json[]
) => {
  const found: string[] = [];

  const check = (title: string, left: Schema.Json, right: Schema.Json) => {
    try {
      assert.deepEqual(left, right);
    } catch (error) {
      found.push(`${title}\n${String(error)}`);
    }
  };

  if (!expected.every(isNamed) || !actual.every(isNamed)) {
    check(category, [...actual], [...expected]);

    return found;
  }

  check(
    `${category}: names in order`,
    actual.map(({ name }) => name),
    expected.map(({ name }) => name)
  );

  for (const entry of expected) {
    const match = actual.find(({ name }) => name === entry.name);

    if (match !== undefined) {
      check(`${category} ${entry.name}`, match, entry);
    }
  }

  return found;
};

test("the host-facing surface matches test/stored/surface.json", async () => {
  const actual = decodeSurface(await captureSurface());

  const found = [
    ...differences("tools", stored.tools, actual.tools),
    ...differences("commands", stored.commands, actual.commands),
    ...differences("agents", stored.agents, actual.agents),
    ...differences("skills", stored.skills, actual.skills),
    ...differences("rpcs", stored.rpcs, actual.rpcs),
    ...differences("hooks", stored.hooks, actual.hooks),
    ...differences("subscriptions", stored.subscriptions, actual.subscriptions),
  ];

  if (found.length > 0) {
    assert.fail(`\n${found.join("\n\n")}`);
  }
});
