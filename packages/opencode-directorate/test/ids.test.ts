// Identifiers are branded schemas: each accepts its own format, rejects another, and is not interchangeable with any other
// id at compile time. The host's ids are mirrored, so their types are the host's own.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Session } from "@opencode/schema/session";
import type { SessionMessage } from "@opencode/schema/session-message";
import type { Tool } from "@opencode/schema/tool";
import { Option } from "effect";

import {
  asEntryId,
  EntryIdSchema,
  entryIdsIn,
  isEntryId,
  nthEntryId,
} from "../src/feature/ledger/entry.ts";
import type { EntryId } from "../src/feature/ledger/entry.ts";
import {
  asSessionId,
  CallIdSchema,
  MessageIdSchema,
  SessionIdSchema,
} from "../src/platform/host-id.ts";
import type { CallId, MessageId, SessionId } from "../src/platform/host-id.ts";
import { asSealId, SealIdSchema } from "../src/seal/seal-id.ts";
import type { SealId } from "../src/seal/seal-id.ts";
import { asShipId, ShipIdSchema } from "../src/workflow/review/ship-link.ts";
import type { ShipId } from "../src/workflow/review/ship-link.ts";

const SESSION = "ses_2f0c1d";
const MESSAGE = "msg_9a8b7c";
const SEAL = "directorate-20260101000000-abcdef";
const SHIP = "8e651aab-1f61-43d4-8a2d-9890bdb86d2b";

/** Compiles only when `A` and `B` are the same type. */
const sameType = <A, B>(
  ..._proof: [A] extends [B] ? ([B] extends [A] ? [] : [never]) : [never]
) => true;

const takesSeal = (id: SealId) => id;

const takesSession = (id: SessionId) => id;

const takesShip = (id: ShipId) => id;

const takesCall = (id: CallId) => id;

const takesMessage = (id: MessageId) => id;

const takesEntry = (id: EntryId) => id;

test("a session id starts with ses, as the host's does", () => {
  assert.equal(SessionIdSchema.make(SESSION), SESSION);
  assert.ok(Option.isSome(asSessionId(SESSION)));
  assert.ok(Option.isNone(asSessionId(MESSAGE)));
  assert.throws(() => SessionIdSchema.make("lead"));
});

test("a message id starts with msg_, as the host's does", () => {
  assert.equal(MessageIdSchema.make(MESSAGE), MESSAGE);
  assert.throws(() => MessageIdSchema.make(SESSION));
});

test("a call id is any string the host names a tool call with", () => {
  assert.equal(CallIdSchema.make("call_1"), "call_1");
});

test("a ship id is a UUID", () => {
  assert.equal(ShipIdSchema.make(SHIP), SHIP);
  assert.ok(Option.isSome(asShipId(SHIP)));
  assert.ok(Option.isNone(asShipId("ship-1")));
  assert.throws(() => ShipIdSchema.make(SEAL));
});

test("an entry id is F and its 1-based filing number", () => {
  assert.equal(EntryIdSchema.make("F1"), "F1");
  assert.equal(nthEntryId(12), "F12");
  assert.ok(Option.isSome(asEntryId("F203")));

  for (const other of ["F0", "F01", "f1", "F", "E1", " F1", "F1a", SEAL]) {
    assert.ok(!isEntryId(other), other);
  }

  assert.throws(() => nthEntryId(0));
});

test("entry ids are found word by word in text", () => {
  assert.deepEqual(entryIdsIn("seal: x\nentries: F1, F12"), ["F1", "F12"]);
  assert.deepEqual(entryIdsIn("entries: [F2] F0 FF3 F4x"), ["F2"]);
});

test("a seal id is not a session, message, or ship id, nor the other way round", () => {
  assert.ok(Option.isSome(asSealId(SEAL)));

  for (const other of [SESSION, MESSAGE, SHIP]) {
    assert.ok(Option.isNone(asSealId(other)), other);
  }
});

test("the mirrored ids are the host's types", () => {
  assert.ok(sameType<SessionId, Session.ID>());
  assert.ok(sameType<MessageId, SessionMessage.ID>());
  assert.ok(sameType<CallId, Tool.CallID>());
});

test("no id passes for another at compile time", () => {
  const session = SessionIdSchema.make(SESSION);
  const message = MessageIdSchema.make(MESSAGE);
  const call = CallIdSchema.make("call_1");
  const seal = SealIdSchema.make(SEAL);
  const ship = ShipIdSchema.make(SHIP);
  const entry = EntryIdSchema.make("F1");

  // @ts-expect-error: a session id is not a seal id
  takesSeal(session);
  // @ts-expect-error: a seal id is not a session id
  takesSession(seal);
  // @ts-expect-error: a seal id is not a ship id
  takesShip(seal);
  // @ts-expect-error: a session id is not a call id
  takesCall(session);
  // @ts-expect-error: a call id is not a message id
  takesMessage(call);
  // @ts-expect-error: a message id is not a session id
  takesSession(message);
  // @ts-expect-error: a plain string is not a session id
  takesSession(SESSION);
  // @ts-expect-error: a seal id is not an entry id
  takesEntry(seal);
  // @ts-expect-error: an entry id is not a seal id
  takesSeal(entry);

  assert.equal(takesSeal(seal), SEAL);
  assert.equal(takesSession(session), SESSION);
  assert.equal(takesShip(ship), SHIP);
  assert.equal(takesCall(call), "call_1");
  assert.equal(takesMessage(message), MESSAGE);
  assert.equal(takesEntry(entry), "F1");
});
