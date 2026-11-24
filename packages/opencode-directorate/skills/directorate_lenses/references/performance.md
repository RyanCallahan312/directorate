# performance

Contents: Establish the workload · Where defects hide (Data stores · Concurrency & pools · Queues & background work · Memory · CPU & blocking · Network & I/O · Frontend) · Investigate · Calibration · Not a finding · Evidence · By mode · Seams

Ask: what work, data volume, or contention makes this fail or waste resources at the workload this code really sees?

Scope: latency, throughput, memory, connections, locks, and cost on realistic inputs. Every claim starts from a workload you can cite. A loop, a scan, or an allocation is not a finding by itself.

## Establish the workload first

Find at least one of these before recording anything:

- Data size: table or collection sizes, or their growth, from migrations, seeds, fixtures, docs, or retention settings; page size limits; payload size limits.
- Frequency: route hotness (a public or per-request path versus an admin page), scheduled job frequency, queue throughput, polling intervals, retries.
- Capacity: pool sizes, worker and replica counts, memory limits, timeouts, from configuration or deployment files.
- Callers: whether the function runs once, per request, per item in a loop, or per message.

If none can be found, the workload is unknown: record a `directorate_note` kind `unanswered` naming what you need, not an entry.

## Where defects hide

### Data stores

- N+1: a query per item inside a loop, map, or parallel fan-out, where one batched query fits.
- Missing or mismatched indexes: the filter and sort fields of a new query against the indexes the schema or migrations define, including the order of fields in a compound index and transformations that keep an index from being used.
- Unbounded results: no limit or pagination on a growing table or collection; fetching every field when large ones are not needed; offset pagination deep into large data sets.
- Filtering, sorting, or aggregating in application code what the database could do.
- Long transactions: network calls, file I/O, or user waits inside a transaction; lock order that invites deadlocks; hot-row contention.
- Migrations that rewrite or lock a large table or collection (for example, building an index without the store's online option, changing a field's type, or adding a required field with a backfill).

### Concurrency and pools

- Unbounded fan-out: launching one task, thread, or request per item of an input-sized collection with no concurrency limit, exhausting connection pools or downstream rate limits.
- Sequential I/O where independent calls could run together on a latency critical path (for example, awaiting each call in turn inside a loop).
- Missing backpressure: queues or buffers that grow without bound; producers faster than consumers.
- One workload starving another: a batch job sharing the request pool.
- Shared mutable state guarded by more than one mechanism, or locks taken in inconsistent order, so contention turns into deadlock.

### Queues and background work

Applies to threads, async tasks, coroutines, goroutines, actors, or fibers, whatever the runtime, and to any broker. Verify the runtime's and the broker's semantics against their documentation for the version in use. Whether a duplicate or lost message gives a wrong result is correctness; here, what it costs under load.

- Retries that never back off or never stop; poison messages retried forever instead of going to a dead-letter path with their context.
- Visibility timeouts or leases shorter than the longest job, so slow jobs are redelivered and run twice in parallel.
- Ordering assumptions stronger than the broker guarantees (per key, per partition, or none), forcing serial consumers or causing rework.
- Background work with no owner that starts, supervises, and stops it, so it piles up or outlives shutdown; a failure in it that nobody observes.
- Cancellation and timeouts that do not stop the work or skip its cleanup, so abandoned work keeps holding connections, memory, or locks.
- Shared services, clients, and pools rebuilt where one shared instance was intended, or request-specific values captured by an application-wide one.
- Tests that cannot show any of this: no control of time or scheduling (fake clocks, deterministic executors), and no assertion on failure or cancellation.

### Memory

- Materializing whole files, result sets, or responses where a stream fits (reading whole uploads into memory, collecting large streams or result sets into lists, parsing large bodies at once).
- Caches or maps without a bound or expiry; listeners, timers, or background tasks never removed; closures retaining large objects.
- Clients, pools, or containers built per request or per call instead of once, rebuilding connections and leaking them.

### CPU and blocking

- Quadratic work on input-sized collections (a linear search inside a loop over a large collection; repeated string concatenation in hot loops).
- Blocking or CPU-heavy work on a request thread or event loop: large serialization, synchronous crypto, compression, image work; regexes with catastrophic backtracking.
- Repeated computation that a single pass or a memo would avoid, on a hot path.

### Network and I/O

- Missing timeouts or cancellation on outbound calls; retries that multiply load during an outage (no backoff or jitter).
- Chatty protocols: many small round trips where a batch endpoint exists.
- Oversized payloads to clients; no compression where the framework provides it.

### Frontend

- Request waterfalls on first render; re-render loops from unstable dependencies of hooks, watchers, or subscriptions; large imports in the entry bundle; long lists without virtualization at the sizes the app shows.

## Investigate

1. Establish the workload (above) and cite it.
2. Find who calls the changed code and how often: `directorate_grep` its name and follow callers up to an entry point.
3. For queries, read the schema and indexes in the migrations, and the page or limit applied by callers.
4. Estimate the cost: items × queries, fan-out × pool size, rows × row size, frequency × duration. Write the arithmetic in `brief`.
5. Look for an existing bound: a page cap, a concurrency option, a timeout, a cache, a batch loader.

## Calibration

- **blocking:** a common request runs a query per row on a table of millions; ordinary bulk traffic exhausts the shared connection pool; a migration locks a hot table for minutes during deploy; memory grows without bound until the process is killed.
- **important:** a search route exceeds its latency budget at documented data sizes; unbounded parallel calls over user-supplied ids hit downstream rate limits; an outbound call with no timeout can hang workers.
- **minor:** avoidable sequential calls adding small latency on a frequent path; an unbounded but slow-growing cache with an obvious bound.
- **not a finding:** an N+1 over a list capped at 10; a full scan of a configuration-sized table.

## Not a finding

- Any loop, scan, or allocation without a cited workload.
- Micro-optimizations: a hash lookup instead of a linear search on a small collection, avoiding a copy, caching a cheap pure function.
- "Should cache" without frequency, hit rate, and an invalidation story.
- Big-O complaints where `n` is a constant or a small configured cap.
- Performance of one-off scripts, tests, or local developer tooling, unless it blocks their use.

## Evidence this lens needs

The workload and where it is stated, the cost arithmetic, the bound you looked for, and the resource that runs out or the budget that is missed.

## By mode

- **code-quality:** a custom cache, pool, retry loop, or scheduler that duplicates a facility the project already has.
- **full:** missing measurement on a new hot path, capacity planning, infrastructure cost, and performance budgets.

## Seams

- Attacker-controlled expensive work is security (abuse) with this lens's evidence.
- A migration that locks a table is also ops; record it once.
- Slow responses that leave users stuck are ux; record the cause here.
