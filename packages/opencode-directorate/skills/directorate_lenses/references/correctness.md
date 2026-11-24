# correctness

Contents: Where defects hide (Logic & boundaries · Language & runtime · Errors, cleanup & cancellation · State, concurrency & ordering · Persistence & queries · Messages, retries & workflows · Time & dates · Contracts) · Investigate · Calibration · Not a finding · Evidence · By mode · Seams

Ask: what inputs, states, orderings, or failures make the code break its contract?

Scope: wrong results, lost or duplicated effects, invalid states, and broken failure handling. Who may reach the code belongs to security; how much work it does belongs to performance; who else depends on its shape belongs to impact.

## Where defects hide

### Logic and boundaries

- Inverted or incomplete conditions, operator precedence in boolean expressions, De Morgan slips, early returns that skip a required step.
- Off-by-one: inclusive versus exclusive ranges, `<` versus `<=`, last page, last element, empty collection, a single element.
- Defaults applied to explicit values: a "use the default if missing" rule that also overrides a deliberate zero, empty, or false.
- Branch tables that miss a case: a new enum member or variant that an old conditional or match does not handle.

### Language and runtime semantics

Judge with the language's actual rules, not intuition; read the language or library documentation for the version in use when it decides the claim.

- Truthiness and defaults: zero, empty strings, and empty collections treated as missing; a "default if absent" operator that also replaces valid falsy values.
- Numbers: integer division and overflow, floating-point money, parsing that accepts partial input, precision lost in serialization (for example, large integer ids passed through JSON).
- Mutation and aliasing: in-place sorts and updates on shared data, shallow copies, defaults shared across calls (for example, Python's mutable default arguments), iterating a collection while changing it.
- Equality and ordering: reference versus value equality, default sort orders, unstable sorts, iteration order of maps and sets.
- Serialization: fields dropped, renamed, or defaulted by the encoder; types the encoder cannot represent.
- Asynchrony: work started but never awaited or joined; callbacks whose errors go nowhere; error handlers that do not cover the asynchronous call.
- Types versus runtime: casts or assertions on data from outside the process; a static type that promises a field the decoder never checks.

### Errors, cleanup, and cancellation

- A failure caught and turned into success, a default, or an empty result that the caller treats as real data.
- Misleading success: 200 or exit code 0 after a partial failure; a function that returns before its write completes.
- Cleanup missing on some exit path: early return, thrown error, interruption, timeout.
- Retries around non-idempotent work, retries that never stop, or retries of errors that cannot succeed.
- Concurrent and asynchronous work (threads, tasks, coroutines, goroutines, promises, fibers):
  - a background task whose failure nobody observes, or which outlives the resources it uses;
  - cancellation or timeout that skips cleanup, or that a catch-all handler turns into success;
  - a resource acquired outside the language's cleanup construct (for example `finally`, `with`, `defer`, or RAII), so an error or cancellation leaks it.

### State, concurrency, and ordering

- Check-then-act: read, decide, write without a lock, a conditional update, or a unique constraint.
- Lost updates: read-modify-write on shared state without an atomic update, a lock, or a version check (for example, a read query followed by an update, or get then set on a shared variable or cache).
- Invalid transitions: a state machine reachable in an order it does not allow; a step that can run twice or be skipped.
- Partial updates: two writes that must agree, with a failure possible between them.
- Event ordering: handlers that assume order where delivery does not guarantee it.

### Persistence and queries

Whatever the store (relational, document, key-value, files), check its documented semantics rather than assuming them.

- Missing-value semantics: how the query language treats null or absent fields in comparisons, joins, and counts (for example, in SQL, `NOT IN` against a list containing `NULL` matches nothing).
- Pagination without a total, deterministic order: ties make pages skip or repeat rows.
- Upserts and conflict handling keyed on the wrong field, or silently skipping a write the caller relies on.
- Transaction boundaries: two writes that must agree outside one transaction; network calls inside one; isolation or consistency guarantees assumed stronger than the store's configured level.
- Types and precision: time zones dropped on storage, numeric precision, silent truncation, collation and case sensitivity in uniqueness.

### Messages, retries, and workflows

- At-least-once delivery without an idempotency key or deduplication.
- Ack or commit order: acknowledging before the write commits loses work on a crash; writing before acking duplicates it unless the write is idempotent.
- Poison messages retried forever; a dead-letter path that drops context.
- Multi-step operations with no resume or compensation after an interruption; create without the matching delete; apply without the matching rollback.

### Time, dates, and scheduling

- Instants stored without a zone, or local times stored without theirs where the rule is local ("9am in the customer's zone").
- Daylight-saving transitions: local times that do not exist or occur twice; schedules that skip or run twice; durations computed across a transition.
- Calendar edges: month ends (January 31 plus one month), leap days, week starts, fiscal periods, ISO week numbers at year boundaries.
- Schedulers: no misfire policy after downtime; overlapping runs when a run outlasts its interval; runs that are not idempotent; more than one scheduler across replicas.
- Comparisons and expiry checks that mix clock sources; tests that depend on the real clock instead of controlling time.

### Contracts between modules and services

- Ignored return values, error results, or status codes.
- Changed defaults or units across a call (seconds versus milliseconds, cents versus dollars).
- Error and status mapping: "not found" treated as empty, a timeout treated as "not found", every error mapped to one code.
- Model and LLM API contracts: deprecated or rejected parameters for the pinned model (e.g., `temperature`/`top_p`, `budget_tokens`, assistant prefills), mid-session prefix edits that invalidate preserved reasoning state or KV cache, or unhandled refusals and `max_tokens` truncations beyond JSON Schema.

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
