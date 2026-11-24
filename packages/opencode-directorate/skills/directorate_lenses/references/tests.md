# tests

Contents: The core move · Where defects hide (Missing behavior · Weak assertions · Assertions that never run · Mocks & fixtures · Determinism & isolation · Changed tests) · Investigate · Calibration · Not a finding · Evidence · By mode · Seams

Ask: which plausible regression would the tests let through, and can their failures be trusted?

Scope: whether existing and changed tests would catch a realistic wrong implementation of the changed behavior, and whether they are deterministic and isolated. Wrong behavior today is a correctness defect, not a test gap.

## The core move: mutate in your head

For each behavior the change adds or alters, imagine the most plausible wrong implementation and ask whether any assertion fails:

- invert or drop the new condition or guard;
- return early, skip the write, or stop waiting for asynchronous work;
- swap two arguments, use the old default, or off-by-one the boundary;
- swallow the error, or return success on failure;
- revert the bug fix the change makes.

If every assertion still passes, that is the gap. Name the mutation and the test (input and assertion) that would catch it.

## Where defects hide

### Missing behavior

- New branches, error paths, authorization checks, and boundaries with no test that reaches them.
- A bug fix with no test that fails when the fix is reverted.
- Integration seams no test crosses: real database constraints, serialization, middleware, dependency wiring.

### Weak assertions

- Assertions that cannot tell right from a plausible wrong result: "is defined", "length > 0", "does not throw", "was called" without arguments.
- Error tests that check only that something failed, not which error, tag, or status.
- Snapshots so large that a regression inside them goes unread; snapshots updated in the same change without review.
- Tests that only execute code, with no assertion on its effect.

### Assertions that never run

- An assertion inside a callback, continuation, or error handler that never runs; a test that returns before its assertions.
- Asynchronous tests: work started but never awaited, so the test ends first; a fake clock that is never advanced, so timeouts never fire; a failure path never asserted because the test only inspects success.

### Mocks and fixtures

- A mock replacing the behavior under test.
- Permissive stubs that accept any arguments and return success, hiding invalid calls.
- Mocks or fixtures still encoding the old contract after the change, so the test passes while the real consumer breaks.
- Fixtures that hide the input that matters behind a large shared setup.

### Determinism and isolation

- Real time, randomness, ordering of maps or concurrent work, network, or environment in assertions.
- Shared global state, env vars, files, or database rows that leak between tests; missing teardown; order-dependent suites.

### Changed tests

- Assertions weakened, removed, or loosened to pass; tests deleted; skip or focus markers added (for example `.skip`, `.only`, `@Disabled`, `pytest.mark.skip`); a narrowed test pattern; CI no longer running a suite.

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
