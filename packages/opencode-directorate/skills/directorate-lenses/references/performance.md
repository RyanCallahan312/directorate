# performance

Ask: what work, data volume, or contention makes this fail or waste resources at the workload this code really sees?

Scope: latency, throughput, memory, connections, locks, and cost on realistic inputs. Every claim starts from a workload you can cite. A loop, a scan, or an allocation is not a finding by itself.

## Establish the workload first

Cite at least one before recording anything: data size/growth (migrations, seeds, retention, page/payload caps), call frequency (route hotness, cron/queue rate, retries), capacity (pool sizes, workers, memory limits, timeouts from config/deploy files), or caller fan-out. If none exists in the repo, record a `directorate_note` kind `unanswered` naming what you need—not an entry.

## High-signal failure modes

- **Data stores:** N+1 queries inside loops/fan-out, missing or misordered compound indexes against actual migrations, unbounded result sets or deep offset pagination, network/file I/O inside transactions, hot-row lock contention, table-locking migrations on large tables (non-concurrent index, column rewrite, single-step backfill).
- **Concurrency, queues & pools:** unbounded parallel fan-out exhausting pools or downstream rate limits, sequential I/O on a hot critical path, missing backpressure, batch jobs sharing request pools, inconsistent lock order; retries without backoff/jitter/DLQ, lease timeouts shorter than slow jobs, unsupervised background tasks, cancellation skipping cleanup, clients/pools rebuilt per call.
- **Memory, CPU & network:** materializing whole files/streams/result sets in memory, unbounded caches or leaked listeners/timers, quadratic loops or synchronous CPU-heavy/ReDoS work on request threads/event loops, outbound calls missing timeouts/cancellation, chatty calls where a batch endpoint exists.
- **Frontend:** first-render request waterfalls, unstable hook/subscription dependencies causing render loops, oversized entry-bundle imports, unvirtualized huge lists.

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
