// Tests run their effects through these runners, which log into memory instead of the console. A warning or error fails
// the test (through `afterEach(verifyLogs)`) unless the test declared it with `expectWarnings`.
import assert from "node:assert/strict";
import { inspect } from "node:util";

import { Cause, Effect, Logger, LogLevel, Predicate } from "effect";

const logged: { level: LogLevel.LogLevel; text: string }[] = [];
let expected: RegExp[] = [];

const memory = Logger.make(({ cause, logLevel, message }) => {
  const parts: unknown[] = Array.isArray(message) ? message : [message];

  logged.push({
    level: logLevel,
    text: [
      ...parts.map((part) =>
        Predicate.isString(part) ? part : inspect(part, { depth: 8 })
      ),
      ...(cause.reasons.length > 0 ? [Cause.pretty(cause)] : []),
    ].join(" "),
  });
});

const quiet = Logger.layer([memory]);

/** `Effect.runPromise`, logging into memory. */
export const runPromise = <A, E>(
  effect: Effect.Effect<A, E>,
  options?: Effect.RunOptions
) => Effect.runPromise(effect.pipe(Effect.provide(quiet)), options);

/** `Effect.runPromiseExit`, logging into memory. */
export const runPromiseExit = <A, E>(
  effect: Effect.Effect<A, E>,
  options?: Effect.RunOptions
) => Effect.runPromiseExit(effect.pipe(Effect.provide(quiet)), options);

/** The warnings this test causes on purpose: each pattern must match a logged warning or error. */
export const expectWarnings = (...patterns: RegExp[]) => {
  expected.push(...patterns);
};

/** Every warning or error the test logged was expected, and every expected one was logged. */
export const verifyLogs = () => {
  const warnings = logged
    .splice(0)
    .filter(({ level }) => LogLevel.isGreaterThanOrEqualTo(level, "Warn"))
    .map(({ text }) => text);

  const patterns = expected;

  expected = [];

  assert.deepEqual(
    {
      missing: patterns
        .filter((pattern) => !warnings.some((w) => pattern.test(w)))
        .map(String),
      unexpected: warnings.filter(
        (w) => !patterns.some((pattern) => pattern.test(w))
      ),
    },
    { missing: [], unexpected: [] },
    "the test logged a warning it did not expect, or not one it expected"
  );
};
