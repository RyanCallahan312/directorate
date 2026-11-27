import assert from "node:assert/strict";
import { test } from "node:test";

import {
  recheckFlag,
  startsWithRecheck,
} from "../src/workflow/review/request.ts";

const SEAL = "directorate-20261126120000-abc123";

test("recheckFlag reads a leading --recheck, with or without a seal", () => {
  assert.deepEqual(recheckFlag("--recheck"), { rest: "", seal: undefined });
  assert.deepEqual(recheckFlag(`--recheck ${SEAL}`), { rest: "", seal: SEAL });
  assert.deepEqual(recheckFlag(`--recheck=${SEAL}`), { rest: "", seal: SEAL });
  assert.deepEqual(recheckFlag(`  \n--recheck ${SEAL}`), {
    rest: "",
    seal: SEAL,
  });
  assert.deepEqual(recheckFlag(`--recheck ${SEAL}  focus on auth `), {
    rest: "focus on auth",
    seal: SEAL,
  });
  assert.deepEqual(recheckFlag("--recheck focus on auth"), {
    rest: "focus on auth",
    seal: undefined,
  });
});

test("recheckFlag leaves a bad --recheck= value in the rest, for the command to refuse", () => {
  assert.deepEqual(recheckFlag("--recheck=bad"), {
    rest: "=bad",
    seal: undefined,
  });
});

test("recheckFlag needs the flag itself, first and in lower case", () => {
  assert.equal(recheckFlag("--rechecks"), undefined);
  assert.equal(recheckFlag("review --recheck"), undefined);
  assert.equal(recheckFlag("--RECHECK"), undefined);
  assert.equal(recheckFlag(""), undefined);
});

test("startsWithRecheck matches a leading --recheck in any case", () => {
  assert.equal(startsWithRecheck("--recheck"), true);
  assert.equal(startsWithRecheck("  --ReCheck=x"), true);
  assert.equal(startsWithRecheck(`--recheck ${SEAL} more`), true);
  assert.equal(startsWithRecheck("--rechecks"), false);
  assert.equal(startsWithRecheck("please --recheck"), false);
});
