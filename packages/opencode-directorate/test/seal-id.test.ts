// Seal ids: one pattern decides what is an id, what the generator makes, what a session's instruction entry names, and
// which tool inputs reach the records at all.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { DateTime, Effect } from "effect";
import { SecureRandom } from "effect/crypto";

import { sealIdOf } from "../src/records/records.ts";
import { isSealId, SealIdSchema, sealIdIn } from "../src/seal/seal-id.ts";
import { sealId } from "../src/workflow/review/lifecycle.ts";
import { runPromise, verifyLogs } from "./logs.ts";

afterEach(verifyLogs);

const VALID = "directorate-20260101000000-abcdef";

test("a seal id is directorate-, fourteen digits, and six lowercase hex digits", () => {
  assert.ok(isSealId(VALID));
  assert.equal(SealIdSchema.make(VALID), VALID);
});

test("ids of the wrong length, with uppercase hex, or without the prefix are not seal ids", () => {
  for (const id of [
    "directorate-2026010100000-abcdef",
    "directorate-202601010000000-abcdef",
    "directorate-20260101000000-abcde",
    "directorate-20260101000000-abcdef0",
    "directorate-20260101000000-ABCDEF",
    "20260101000000-abcdef",
    "review-20260101000000-abcdef",
    ` ${VALID}`,
    `${VALID}\n`,
  ]) {
    assert.equal(isSealId(id), false, id);
    assert.throws(() => SealIdSchema.make(id), id);
  }
});

test("the generator names a new seal by its creation time and three random bytes", async () => {
  const id = await runPromise(
    sealId(DateTime.makeUnsafe("2026-11-26T12:34:56.789Z")).pipe(
      Effect.provideService(
        SecureRandom.SecureRandom,
        SecureRandom.make(() => new Uint8Array([0x0a, 0xbc, 0xde]))
      )
    )
  );

  assert.equal(id, "directorate-20261126123456-0abcde");
  assert.ok(isSealId(id));
});

test("a session's instruction entry names its seal; text without a whole id names none", () => {
  assert.equal(
    sealIdIn(
      `Active Directorate containment seal ${VALID} (default): fix the cache. Pass this seal id to every directorate_* tool and assignment.`
    ),
    VALID
  );
  assert.equal(sealIdIn("No seal here."), undefined);
  assert.equal(sealIdIn(`seal ${VALID}0 is longer`), undefined);
  assert.equal(sealIdIn("seal directorate-20260101000000-ABCDEF"), undefined);
});

/** What a tool that hands `directorate-bogus` to `use` answers. */
const unknownSeal = (use: Parameters<typeof sealIdOf>[1]) =>
  runPromise(
    sealIdOf("directorate-bogus", use).pipe(
      Effect.flip,
      Effect.map((e) => e.message)
    )
  );

test("a malformed seal id from a tool is not found, with the hint for what the tool does", async () => {
  assert.equal(
    await unknownSeal("door"),
    'Unknown seal id "directorate-bogus". Call directorate_seal first.'
  );
  assert.equal(
    await unknownSeal("lookup"),
    'Unknown seal id "directorate-bogus". Call directorate_seal first, or directorate_ledger_list with no seal to list recent seals.'
  );
  assert.equal(await runPromise(sealIdOf(VALID, "door")), VALID);
});
