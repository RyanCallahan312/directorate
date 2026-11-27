import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { Exit } from "effect";

import { refusesCaller } from "../src/feature/agents/access.ts";
import {
  AgentIdSchema,
  agentOf,
  Auditor,
  Compliance,
  Liaison,
  Seat,
} from "../src/feature/agents/agent.ts";
import {
  BundledFileInvalid,
  parseMarkdown,
} from "../src/feature/agents/registration.ts";
import { runPromise, runPromiseExit, verifyLogs } from "./logs.ts";

afterEach(verifyLogs);

test("Agent.is: true only for the agent's own id; false for another agent's, an unknown name, or none", () => {
  for (const id of AgentIdSchema.literals) {
    for (const agent of [Liaison, Auditor, Seat, Compliance]) {
      assert.equal(agent.is(id), agentOf(id) === agent, `${agent.id} is ${id}`);
    }
  }

  for (const name of [undefined, "", "build", "Directorate_Liaison"]) {
    assert.equal(Liaison.is(name), false, String(name));
  }
});

test("refusesCaller: unnamed, unknown, and non-dispatching callers are refused", () => {
  const cases = [
    [undefined, undefined, true, "unnamed caller, harness tool"],
    [undefined, Auditor, true, "unnamed caller, dispatch"],
    ["", undefined, true, "empty name, harness tool"],
    ["Directorate_Liaison", Compliance, true, "a near-miss name, dispatch"],
    ["build", undefined, true, "another agent, harness tool"],
    ["build", Compliance, true, "another agent, dispatch"],
    [Auditor.id, undefined, false, "a Directorate agent, harness tool"],
    [Auditor.id, Compliance, true, "an Auditor dispatching"],
    [Liaison.id, Compliance, false, "the Liaison dispatching"],
  ] as const;

  for (const [caller, child, refused, name] of cases) {
    assert.equal(refusesCaller(caller, child), refused, name);
  }
});

/** The message parseMarkdown fails with for a bundled agent file holding `text`. */
const fails = async (text: string) => {
  const exit = await runPromiseExit(
    parseMarkdown("/plugin/agents/directorate_seat.md", text)
  );

  assert.ok(Exit.isFailure(exit));
  const [error] = exit.cause.reasons;

  assert.ok(
    error && "error" in error && error.error instanceof BundledFileInvalid
  );

  return error.error.message;
};

test("parseMarkdown: a bundled file without or with broken frontmatter fails naming the file", async () => {
  assert.equal(
    await fails("no frontmatter here\n"),
    "Invalid bundled file /plugin/agents/directorate_seat.md: missing YAML frontmatter"
  );

  assert.match(
    await fails("---\ndescription: [unclosed\n---\nbody\n"),
    /^Invalid bundled file \/plugin\/agents\/directorate_seat\.md: \S/u
  );

  const ok = await runPromise(
    parseMarkdown("/p.md", "---\ndescription: d\n---\n\n body \n")
  );

  assert.deepEqual(ok, {
    content: "body",
    data: { description: "d" },
    path: "/p.md",
  });
});
