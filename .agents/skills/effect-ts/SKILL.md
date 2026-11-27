---
name: effect-ts
description: Write, refactor, and review Effect 4.1.2 TypeScript code—schemas, services, layers, domain modeling, module layout, streams, fibers, schedules, caching, config, platform I/O, HTTP, SQL, workflows, clusters, and tests—avoiding stale v3/beta APIs. Do not use for Effect v3 codebases, non-Effect TypeScript, or unrelated UI/build/linter configuration.
license: MIT
---

# Effect v4

Use installed Effect 4 patterns and the target repository's conventions.
Established package guidance still takes precedence unless the task changes it.

## Source Rule

Before guessing about an unfamiliar or unstable API, read in this order:

1. The nearest `AGENTS.md` and package-local guidance.
2. [Installed version and API changes](./references/installed-version.md).
3. `node_modules/effect/AGENTS.md` and its linked
   `ai-docs/src/` examples.
4. Source and declarations in that installed package (`src/` and `dist/`).

This skill targets `effect@4.1.2`. Check the target workspace's installed
version before changing version-sensitive code. Prefer installed source over
public docs or upstream main. Do not reuse v3/beta APIs (such as catchAll,
either, Layer.scoped, Context.Tag, TaggedErrorClass, Config.string,
Schedule.both/take, or unstable subpaths—see
[Installed Version](./references/installed-version.md)) or assume optional
`@effect/*` integrations are installed.

## Branch Chooser

Read only the references matching the task. Read every matching branch when a
change crosses concerns.

| Task | Reference |
|---|---|
| Version checks, beta-to-stable API names, package exports | [Installed Version](./references/installed-version.md) |
| Schemas, brands, variants, errors, codecs, recursion, evolution | [Schema](./references/schema-advanced.md) |
| Services, `make` factories, Layers, colocation, `Effect.fn`, scoped workers | [Services and Layers](./references/services-layers.md) |
| Second module for a capability, shared models across features/clients, multi-writer records, upward/sideways imports, package layout | [Architecture](./references/architecture.md) |
| Environment or runtime configuration, `ConfigProvider` | [Config](./references/config.md) |
| Retry, repeat, polling, backoff, jitter, timeout policy | [Scheduling](./references/scheduling.md) |
| TTL caches, memoization, concurrent dedupe, request batching | [Caching](./references/caching.md) |
| Scope, resources, fibers, synchronization, bounded concurrency | [Resources and Concurrency](./references/resources-concurrency.md) |
| Streams, event sources, pagination, backpressure, consumers | [Streams](./references/streams.md) |
| Promises, callbacks, events, async iterables, native streams | [Foreign APIs](./references/foreign-apis.md) |
| `FileSystem`, `Path`, child processes, encoding, platform Layers | [Platform I/O](./references/platform.md) |
| Effect tests, virtual time, service doubles, synchronization | [Testing](./references/testing.md) |
| Effect SQL, Postgres, or Effect-native Drizzle | [SQL](./references/sql.md) |
| Outgoing HTTP and provider adapters | [HTTP](./references/http.md) |
| Bun/Node entrypoints, `ManagedRuntime`, shutdown, telemetry | [Runtime and Observability](./references/runtime-observability.md) |
| Durable workflows and activities | [Workflows](./references/workflows.md) |
| Entities, sharding, cluster transport and storage | [Clustering](./references/clustering.md) |
| AI, CLI, GraphQL, RPC, HTTP API, OpenAPI, other specialized modules | [Specialized Modules](./references/specialized.md) |

## Implementation Order

1. **Model the domain with Effect Schema first.** Define branded `Schema.Class`
   values, tagged unions (`Schema.TaggedClass` +
   `Schema.toTaggedUnion("_tag")`), and `Schema.TaggedError` failures before
   writing behavior—even when no external parsing is needed yet. Derive types
   from schemas instead of maintaining parallel `interface` or union types.
2. **Build the service with a `make` factory next when owning I/O or state.**
   Introduce `Context.Service` for a real capability seam. Express its
   operations in those schema-backed types and typed errors, implement it in a
   `const make = Effect.gen(...)` factory that captures dependencies (`R = never`
   on methods), and expose `static readonly layer = Layer.effect(Self, make)`
   with `Effect.Success<typeof make>`. Keep pure domain logic on schema classes
   or exported functions rather than wrapping it in a service.
3. **Colocate by capability and grow in place.** Start a new capability in one
   domain-named module (owned schemas and errors -> pure functions -> `make`
   factory -> `Context.Service` + `layer`). Promote to a slice directory, then
   to ordered bands, only when a trigger in
   [Architecture](./references/architecture.md) fires in the code you are
   touching. An established repository layout wins.
4. **Decode at ingress; don't wait for ingress to model the domain.** Boundary
   decoding and domain modeling are separate decisions.

## Core Defaults

- Compose inline workflows with `Effect.gen`.
- Define reusable Effect operations with `Effect.fn("Domain.operation")` when
  tracing is useful. Use `Effect.fnUntraced` for library glue or hot paths that
  should not introduce a tracing boundary.
- Keep decisions over known values pure; use generators to obtain inputs and
  coordinate effects, and attach timeout, retry, tracing, provisioning, and
  interruption policy with combinators.
- Compose bottom-up: schema primitives -> concrete values and `make` factories
  -> pure policies and layers. Wire cross-slice dependencies only at the
  composition root.
- For reusable policy, prefer a canonical pipeable value; treat options objects
  as convenience syntax that normalizes to it rather than as the policy algebra.
- Introduce `Context.Service` for a real capability seam. Capture dependencies
  while building its implementation so public methods require `R = never`.
- Build and provide Layers near the runtime boundary; run Effects only at
  application, framework, script, or test edges.
- Decode unknown input once at ingress and pass validated values inward.
- Never inspect, compare, switch on, destructure, or index `_tag` at runtime.
  Use generated union matchers/predicates (`Union.match`, `Union.isAnyOf`,
  `Match.tag` + `Match.exhaustive`) or Effect's domain helpers.
- Keep expected failures in `E`. Preserve defects and interruption unless a
  named supervision boundary has a truthful policy for them.
- Make resource, Scope, and fiber ownership explicit.

## Quick Selection

| Need | Default |
|---|---|
| Named domain concept | Branded `Schema.Class` (`Schema.Class<Self, { readonly brand: unique symbol }>("id")(fields)`) |
| Anonymous shape, tool input, or fragment | `Schema.Struct` |
| Scalar identity | Checked schema, then `Schema.brand` |
| Nominal plain object (no methods) | `Schema.Opaque` |
| Domain variant | Branded `Schema.TaggedClass` in `Schema.Union([...]).pipe(Schema.toTaggedUnion("_tag"))` |
| Tagged-union membership | `Union.isAnyOf` (decoded) / `Union.guards.Tag` (unknown) |
| Tagged-union branching | `Union.match`, or `Match.tag` with `Match.exhaustive` |
| Expected failure | Branded `Schema.TaggedError` |
| Unknown payload | `Schema.decodeUnknownEffect` |
| Trusted construction | `schema.make` |
| Fallible Effect construction | `schema.makeEffect` |
| Promise API | `Effect.tryPromise` with immediate error normalization |
| One callback result | `Effect.callback` |
| Runtime settings | `Config`, installed with `ConfigProvider` at a boundary |
| Keyed TTL lookup dedupe | `Cache` |
| One memoized Effect | `Effect.cached` / `cachedWithTTL` |

## Repository Rules

- Follow the package's existing relative `.ts` imports and intentional public
  exports. Do not introduce `#` aliases or incidental barrels.
- Add definition-site `Stream.withSpan` when the stream is a useful tracing boundary.
- Inside Effect operations, use services instead of ambient globals:
  `Config` instead of `process.env`, `HttpClient` instead of global `fetch`,
  `Clock` / `DateTime` instead of global time, and Effect sleep/delay instead of
  global timers.
- Use `Random` only for non-security-sensitive randomness. Use the
  `SecureRandom` service from `effect/crypto` for secure bytes, UUIDs, and
  tokens; use its `Digest` service for digests.
- Prefer adapting foreign Promises with
  `Effect.tryPromise`, including its `AbortSignal` when supported.
- Yield Effect-native Drizzle builders directly. Do not wrap them in Promise
  adapters.
- Use result types and typed errors for expected control flow. Do not throw from
  Effect-native domain code.

## Boundary Rules

- Keep HTTP/framework handlers thin: decode, read context, call a service, and
  translate typed outcomes.
- Keep network/provider calls outside authoritative database transactions.
- Retry only classified transient failures and only with proven idempotency.
- Keep exhausted failures visible unless the current boundary has a real
  fallback.
- Treat persisted and remote schemas as compatibility contracts.
- Do not claim exactly-once external effects from workflow, activity, cluster,
  queue, or persistence semantics; design idempotency and reconciliation.

## Do Not

- Do not silence Effect typing with `as any`, non-null assertions, or unchecked
  casts.
- Do not write parallel handwritten `interface`s or plain object types for
  domain concepts that should be Effect Schemas.
- Do not split capabilities into horizontal kind folders (`schemas/`,
  `services/`, `layers/`, `types.ts`, `utils.ts`) or put pattern words
  (`*Aggregate`, `*ValueObject`, `*Specification`) in domain names.
- Do not expose open write paths (`update(id, patch: Partial<X>)` or a public
  `save(entity)`) on shared records; expose domain verbs or a guarded
  transition door.
- Do not bypass class validation with plain object spreads (`{ ...entity, x }`);
  construct a new instance (`new Entity({ ...entity, x })` or `Entity.make(...)`).
- Do not use cause-level recovery when typed-error recovery is sufficient.
- Do not convert interruption into an ordinary success or failure.
- Do not use `Layer.mergeAll` or `provideMerge` as blind compile fixes.
- Do not hide required credentials, persistence, transport, or authority behind
  defaulted references.
- Do not add sleeps to tests when `Deferred`, `Queue`, `Latch`, `Ref`, or
  `TestClock` can synchronize deterministically.
- Do not hand-roll TTL/in-flight caches when `Cache` fits.

## Error Recovery

| Failure | Fix |
|---|---|
| Missing or renamed Effect API (v3/beta name) | Read [Installed Version](./references/installed-version.md) and check `node_modules/effect/src/` before retrying. |
| `Schema.make` type/runtime mismatch | Module-level `Schema.make` builds a schema from an AST; construct values with `MyClass.make(...)`, `new MyClass(...)`, or `.makeEffect(...)`. |
| Scoped resource closes before service use | Remove inner `Effect.scoped` inside `Layer.effect`; the layer already owns the `Scope`. |
| `TestClock` test hangs on sleep or retry | Fork the waiting effect (`Effect.forkChild`) before calling `TestClock.adjust`. |
| Effect language-service suggestion (`schemaNumber`, `schemaClassMissingBrand`, `floatingEffect`, unstable API) | Read `tsc --noEmit` output (suggestions exit `0`), use `Schema.Finite` / brand / yield the effect, or allowlist intentional unstable subpaths in `tsconfig.json`. |
