import assert from "node:assert/strict";
import { test } from "node:test";

import { parseShipCommand } from "../src/workflow/ship/command.ts";

/** A parsed command as plain data: its form and fields. */
const parsed = (raw: string) => {
  const { _tag: form, ...fields } = parseShipCommand(raw);

  return { form, ...fields };
};

test("each verb parses to its command, in any case and with surrounding space", () => {
  for (const [raw, tag] of [
    ["status", "Status"],
    ["pause", "Pause"],
    ["resume", "Resume"],
    ["stop", "Stop"],
    ["  STATUS\n", "Status"],
    ["Pause", "Pause"],
    ["ReSuMe ", "Resume"],
    ["STOP", "Stop"],
  ] as const) {
    assert.deepEqual(parsed(raw), { form: tag }, raw);
  }
});

test("forget takes exactly one pending id after it, keeping its case", () => {
  assert.deepEqual(parsed("forget msg_AbC"), { form: "Forget", id: "msg_AbC" });
  assert.deepEqual(parsed("  FORGET\tmsg_1  "), {
    form: "Forget",
    id: "msg_1",
  });
  assert.deepEqual(parsed("forget"), { form: "Forget" });
  assert.deepEqual(parsed("Forget "), { form: "Forget" });
  assert.deepEqual(parsed("forget msg_1 msg_2"), { form: "Forget" });
});

test("--recheck at the start is refused in any case; elsewhere it is part of the request", () => {
  for (const raw of [
    "--recheck",
    "  --RECHECK directorate-a",
    "--recheck=directorate-a",
  ]) {
    assert.deepEqual(parsed(raw), { form: "Recheck" }, raw);
  }

  assert.deepEqual(parsed("--rechecked"), {
    form: "Start",
    request: "--rechecked",
  });
  assert.deepEqual(parsed("focus --recheck"), {
    form: "Start",
    request: "focus --recheck",
  });
});

test("anything else starts a ship for the request exactly as typed", () => {
  for (const raw of [
    "",
    "--scope branch focus on parsing",
    " status of the parser ",
    "forgetful",
    "stopping",
  ]) {
    assert.deepEqual(parsed(raw), { form: "Start", request: raw }, raw);
  }
});
