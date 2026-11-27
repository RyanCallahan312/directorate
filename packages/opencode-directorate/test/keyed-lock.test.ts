import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { Deferred, Effect, Exit, Fiber } from "effect";

import { keyedLock } from "../src/platform/keyed-lock.ts";
import { runPromise, verifyLogs } from "./logs.ts";

afterEach(verifyLogs);

const run = <A, E>(effect: Effect.Effect<A, E>) => runPromise(effect);

test("starts from many sessions, finished, failed, or interrupted, leave the lock table empty", () =>
  run(
    Effect.gen(function* manySessions() {
      const lock = yield* keyedLock;
      const sessions = Array.from({ length: 20 }, (_, i) => `ses_${i}`);

      // Two starts per session at once, one of each pair failing.
      const exits = yield* Effect.forEach(
        sessions.flatMap((session) => [
          lock.withLock(session, Effect.yieldNow.pipe(Effect.as(session))),
          lock.withLock(session, Effect.fail(`refused ${session}`)),
        ]),
        Effect.exit,
        { concurrency: "unbounded" }
      );

      assert.equal(exits.filter(Exit.isSuccess).length, sessions.length);
      assert.equal(yield* lock.size, 0);

      // A holder interrupted mid-start, and a waiter interrupted while queued behind it.
      const entered = yield* Deferred.make<boolean>();

      const holder = yield* Effect.forkChild(
        lock.withLock(
          "ses_0",
          Deferred.succeed(entered, true).pipe(Effect.andThen(Effect.never))
        )
      );

      yield* Deferred.await(entered);

      const waiter = yield* Effect.forkChild(
        lock.withLock("ses_0", Effect.void)
      );

      yield* Effect.yieldNow;

      assert.equal(yield* lock.size, 1);

      yield* Fiber.interrupt(waiter);
      yield* Fiber.interrupt(holder);

      assert.equal(yield* lock.size, 0);
    })
  ));

test("one start at a time per session; other sessions do not wait", () =>
  run(
    Effect.gen(function* oneAtATime() {
      const lock = yield* keyedLock;
      const release = yield* Deferred.make<boolean>();
      const order: string[] = [];

      const first = yield* Effect.forkChild(
        lock.withLock(
          "a",
          Effect.sync(() => order.push("a1")).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.sync(() => order.push("a1 done")))
          )
        )
      );

      yield* Effect.yieldNow;

      const second = yield* Effect.forkChild(
        lock.withLock(
          "a",
          Effect.sync(() => order.push("a2"))
        )
      );

      yield* lock.withLock(
        "b",
        Effect.sync(() => order.push("b"))
      );
      yield* Effect.yieldNow;

      assert.deepEqual(order, ["a1", "b"]);

      yield* Deferred.succeed(release, true);
      yield* Fiber.join(first);
      yield* Fiber.join(second);

      assert.deepEqual(order, ["a1", "b", "a1 done", "a2"]);
      assert.equal(yield* lock.size, 0);
    })
  ));
