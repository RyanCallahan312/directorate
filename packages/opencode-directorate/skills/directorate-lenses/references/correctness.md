# correctness

Ask: what inputs, states, orderings, or failures make the code break its contract?

Scope: wrong results, lost or duplicated effects, invalid states, and broken failure handling. Who may reach the code belongs to security; how much work it does belongs to performance; who else depends on its shape belongs to impact.

## High-signal failure modes

- **Logic & boundaries:** inverted conditions, off-by-one/empty/single-item edges, missing enum/variant branches, defaults overriding explicit falsy values (`0`, `""`, `false`), static casts on untrusted runtime data.
- **Errors, cleanup & cancellation:** swallowed failures turned into empty/default success (200 / exit 0 after partial failure), leaked resources on early exit/timeout/cancellation, unobserved background failures, retries around non-idempotent work.
- **State, concurrency & ordering:** check-then-act or lost read-modify-write updates across concurrent actors without a lock/version/constraint, partial two-write updates without atomicity, handlers assuming delivery order.
- **Persistence & queries:** store-specific null semantics (e.g., SQL `NOT IN` with `NULL`), non-deterministic pagination order on ties, wrong upsert conflict keys, network calls inside transactions, dropped time zones or silent truncation.
- **Messages, retries & workflows:** at-least-once delivery without idempotency, ack-before-commit (data loss) or commit-before-ack without idempotency (duplicates), unbounded poison retries, multi-step writes with no resume/compensation.
- **Time & scheduling:** local wall-clock rules stored as bare instants, DST gaps/repeats, month-end/leap arithmetic, missing misfire policy or overlapping cron runs across replicas, mixed clock sources.
- **Contracts & LLM APIs:** ignored error/status codes, unit/default drift (s vs ms, cents vs dollars), `"not found"` conflated with timeout/empty; deprecated or rejected parameters for the pinned model (`temperature`/`top_p`, `budget_tokens`, assistant prefills), mid-session prefix edits breaking preserved reasoning/KV cache, unhandled refusals or `max_tokens` truncations beyond JSON Schema.

Judge language, runtime, and store semantics against the installed version or its docs—never intuition.

## Investigate

1. State the contract: read the changed function's callers, its type or schema, and its tests to learn what it must do. Use `directorate_read` with `side: "old"` to compare it with the previous behavior.
2. Enumerate the inputs that matter: empty, one, many, boundary, invalid, duplicate, concurrent, and interrupted.
3. Walk each exit path (return, throw, failure channel, interruption) and check what each leaves behind: writes, locks, open resources, messages.
4. For shared state, name the two actors that can interleave and the exact window between their reads and writes.
5. Look for the guard before you record: the decoder or schema, a database constraint (`directorate_grep` the migrations), the transaction wrapper, the caller's check, and the test that covers the case.
6. For library behavior (sort order, concurrency primitives, driver semantics), read the installed source or the documentation for the version in use.

## Calibration

- **blocking:** every invoice total is wrong; a consumer acks before commit, so a normal restart loses orders; a migration backfill writes the wrong column for all rows.
- **important:** a retry duplicates a row only when the first attempt times out after committing; pagination skips rows when two records share a timestamp; a `null` field clears stored data on a supported partial update.
- **minor:** a wrong error message on a rare invalid input with a correct status; an edge case in a CLI flag with an easy workaround.
- **not a finding:** "could be null" where the decoder rejects it; a race between writers when only one process ever writes.

## Not a finding

- Null checks for values that the type, schema, or every caller already excludes (cite it).
- "Could throw" where the caller handles the failure.
- A race with no second writer: a single process, a serialized queue, or a lock already held.
- Defensive coding wishes: "validate this too" without an input that breaks.
- Floating-point imprecision where the values are not money and the error is invisible at the precision used.

## Evidence this lens needs

The concrete input or interleaving, the line where behavior diverges from the contract, and the contract's source. For races, both actors and the window.

## By mode

- **code-quality:** an invariant duplicated in two places that must change together; a rule enforced away from the boundary that owns it; hidden side effects in a function named like a query.
- **full:** representations that make invalid states easy to build where a type or schema could exclude them.

## Seams

- An access check missing on one path is security, even when found here.
- A changed return shape that breaks callers is impact.
- A defect with no failing test also suggests a tests question for the lead; the fix's validation scenario covers it.
