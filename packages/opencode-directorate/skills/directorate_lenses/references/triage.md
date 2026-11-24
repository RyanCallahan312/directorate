# Triage: from the change to the questions that matter

For directorate_liaison, and for directorate_seat (which answers its questions itself instead of sending scouts). Triage turns the sealed change into the few falsifiable questions that could change the verdict, and picks the lens that answers each. A holistic review covers every seam the change touches; it does not run every lens.

## 1. Map the change

Answer these from the file table and the first regions before choosing anything:

- **Intent:** what behavior the change produces, and for whom.
- **Entry points:** every route, handler, resolver, CLI command, job, consumer, export, or UI action that reaches the changed code. `directorate_grep` the changed symbols; a handler usually has siblings (batch, export, admin, webhook, worker).
- **Data:** what it reads, writes, persists, caches, or sends, and whether any stored or wire format changed.
- **Trust:** which actors reach it, and whether a trust boundary is crossed.
- **Deploy:** migrations, configuration, flags, and rollout order.
- **Tests:** which tests changed or were deleted, and which should have changed.

## 2. Signals, lenses, and questions

| Signal in the change | Lenses | Question to ask |
| --- | --- | --- |
| Route, handler, middleware, resolver, RPC | security, impact | Can actor B reach X through a sibling path without check Y? Does any client depend on the old response? |
| Auth, roles, tokens, sessions, tenant ids | security | Is the identity verified and the scope taken from it, not from input, on every path? |
| Query, ORM call, repository, cache | correctness, performance, security | Is the result scoped and bounded? Does the cache key carry every scoping input? |
| Migration, schema, persisted or wire format, serialized enum or type discriminator | impact, ops | Can old and new code run against old and new data through rollout and rollback? |
| Exported signature, config key, env var, CLI flag, event name, route path | impact, docs | Which consumers still use the old form? |
| Retry, queue, job, cron, webhook, worker | correctness, performance, ops | What happens on duplicate delivery, a crash between commit and ack, or overlapping runs? |
| Threads, async tasks, background work, locks, shared mutable state | correctness, performance | Which interleaving or interruption breaks the invariant or leaks the resource? |
| Loop over I/O, parallel fan-out, streaming, large payloads | performance | At the workload in configuration or docs, does it exhaust a pool, memory, or a timeout? |
| Money, quantities, units, dates, schedules | correctness | Rounding, units, time zones, DST, and month ends? |
| Forms, components, client state, CLI output | ux, correctness | If the request fails or fires twice, can the user recover? Do scripts that parse the output still work? |
| Bug fix | tests, correctness, architecture | Would a test fail with the fix reverted? Do sibling paths share the cause? Is it fixed where the cause lives? |
| Deleted code, tests, or configuration | impact, tests | What depended on it? Which behavior lost its only test? |
| Tests only | tests | Were assertions weakened, skipped, or made unable to fail? |
| New dependency or version bump | security, impact, quality | Is the risky API reachable? Does a breaking change in its changelog hit our calls? Does an existing primitive already do this? |
| New helper, abstraction, or refactor (code-quality, full) | quality, architecture | Does existing code already do this? Did ownership or dependency direction move? |
| Docs, README, examples, help text | docs | Do the commands and examples still run against the code? |
| Prompts, skills (`SKILL.md`), agent definitions, `.mcp.json`, tool permissions | security, correctness | Can untrusted content steer a tool with more authority than its author, or does the change break pinned model/API contracts? |

## 3. Seams that fall between lenses

Check these yourself or send a question for them; no single lens owns them:

- **Fix one caller:** the change fixes one entry point while sibling, batch, export, admin, or worker paths keep the bug.
- **Rolling deploy:** old code against new data, new code against old data, messages queued by the old version, and rollback after the migration.
- **Scope through async work:** a cache key, background job, or log line drops the tenant or actor that the request had.
- **Retry plus side effect:** a new retry or timeout repeats a charge, email, or insert.
- **Green by mock:** the contract changed, and a mock still encodes the old one, so the tests pass and the real consumer breaks.
- **Error paths:** what the user sees, what is logged, what is retried, and the exit code or response status.
- **Files outside the source tree:** deploy manifests, CI workflows, env examples, generated clients, and scripts that name changed things.

## 4. Choosing what to send

- Trace yourself first: the main path, one failure path, and the rollout seam. Send a scout only for a question you cannot settle in a few reads and whose answer could change the verdict.
- One question and one lens per scout. Make it answerable with yes or no, and name the suspected guard or sink at `path:line`.
  - Good: "Can a non-owner reach `updateInvoice` through `POST /invoices/batch` without the owner check at `invoices.ts:88`?"
  - Bad: "Check the security of the invoice changes."
- Typical counts: default, 0 to 2 scouts. In code-quality, add a quality question when the change adds machinery. In full, add architecture, ops, docs, and ux questions where the change touches them.
- A lens you did not choose is not a gap. A seam you did not check is: if it could change the verdict and you cannot check it, record a `directorate_note` kind `limit`.
- When a scout's handoff names an adjacent question, send another scout only if its answer could change the verdict; otherwise note it.

## 5. Deciding minor entries yourself

Before you confirm a minor scout entry, read the entry's lens file and check its "Not a finding" list and calibration. Retrace the trigger, path, and consequence on the sealed code. Two scouts agreeing is not proof.
