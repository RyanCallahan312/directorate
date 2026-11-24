# tests

Ask: which plausible regression would the tests let through, and can their failures be trusted?

Scope: whether existing and changed tests would catch a realistic wrong implementation of the changed behavior, and whether they are deterministic and isolated. Wrong behavior today is a correctness defect, not a test gap.

## The core move: mutate in your head

For each behavior the change adds or alters, imagine the most plausible wrong implementation—invert/drop a guard, return early, skip a write or `await`, swap arguments, off-by-one a boundary, swallow an error, or revert the bug fix—and check whether any assertion fails. If every assertion still passes, name that mutation and the test (input + assertion) that would catch it.

## High-signal failure modes

- **Missing behavior:** untested new branches, error/auth paths, boundaries, bug fixes without a regression test, or untested integration seams (DB constraints, middleware, serialization, wiring).
- **Weak or unexecuted assertions:** tautologies (`is defined`, `length > 0`, `does not throw`, `was called` without args), error tests ignoring error type/status, unreviewed huge snapshots, assertions inside unawaited async work or never-invoked callbacks, fake clocks never advanced.
- **Mocks & fixtures:** mocks replacing the behavior under test, permissive stubs hiding bad args, mocks still encoding the old contract after a change ("green by mock").
- **Determinism, isolation & regressions:** real clock/network/randomness/map-order dependence, leaked shared globals/env/DB state, weakened/deleted assertions, added `.skip`/`.only`, or runner/CI not discovering new test files.

## Investigate

1. `directorate_grep` the changed symbols, routes, and error messages under the test directories, including integration and end-to-end suites; don't stop at unit tests.
2. Read the assertions themselves, and the fixtures and mocks they rely on.
3. Apply the mutations above to the changed behavior and check each against the assertions.
4. For changed tests, compare with `directorate_read` `side: "old"` to see what an assertion used to require.
5. Check that the runner discovers the tests (file patterns, CI workflow) when new test files are added.

## Calibration

- **blocking (rare):** a suite disabled or emptied so that a mandatory release check passes vacuously; a mock that hides a blocking defect the change ships.
- **important:** new authorization, money, data-write, or migration logic with no test that fails on a plausible mutation; a bug fix whose regression test passes with the fix reverted; a replay that would double-write and pass.
- **minor:** a weak assertion on low-impact behavior; a flaky ordering assumption in a non-critical test.
- **not a finding:** a trivial getter or wiring without a test; behavior already asserted by an integration test (cite it).

## Not a finding

- Coverage percentages or "add tests" without a named mutation.
- Tests for trivial pass-throughs or for what the compiler already enforces.
- A unit-test gap for behavior an integration or end-to-end test already asserts (cite it).
- "Use a real database" or another harness preference with no regression it would catch.
- A test gap on code that is wrong today; record the defect instead.

## Evidence this lens needs

The tests you read (`path:line`), the mutation they accept, and the input and assertion of the test that would reject it.

## By mode

- **code-quality:** duplicated setup, fixtures that hide the important input, harness code that duplicates the runner's features, tests coupled to implementation details.
- **full:** test strategy for the area: missing layers, slow or flaky suites that teams will skip.

## Seams

- A mock that encodes an old contract is also an impact signal: check the real consumer.
- When a defect has no test, record the defect; its fix carries the test.
