# Runtime and Observability

Read this only for process entrypoints, framework interop, shutdown, or
telemetry. Effects run at boundaries, never from domain logic or services.

## Choose

- Use `BunRuntime.runMain(program)` (`@effect/platform-bun`) or
  `NodeRuntime.runMain(program)` (`@effect/platform-node`) for a process
  entrypoint—verify the matching platform package is installed first.
- Use `BunRuntime.runMain(Layer.launch(AppLive))` (or `NodeRuntime.runMain`)
  for a long-running Layer application whose scope should live for the process.
- Use one `ManagedRuntime.make(AppLive)` for repeated framework callbacks;
  execute requests through it and dispose it during framework shutdown.
- Use a matching runtime runner only at a small Promise, callback, test, script,
  or framework boundary. `runSync` is only valid for a guaranteed-synchronous
  Effect.

## Rules

- Build and provide Layers near the runtime boundary. Reuse one Layer value when
  its scoped resources must be shared; dispose the `ManagedRuntime` that owns
  them.
- Inside Effect operations use `Config`, `Clock` / `DateTime`, `Random`, the
  `SecureRandom` / `Digest` services from `effect/crypto`, and `HttpClient`, not environment, clock, timer,
  UUID, randomness, or fetch globals.
- Name useful Effect tracing boundaries with `Effect.fn("Domain.operation")`
  and stream tracing boundaries with `Stream.withSpan("Domain.stream")`.
  Prefer `Effect.fnUntraced` for library glue that should not add tracing.
- Annotate spans and logs with stable, bounded domain identifiers. Redact
  credentials, tokens, personal data, and unbounded request or response bodies.

## Do not

- Do not call a runtime runner from a service implementation, generator, or
  reusable domain operation.
- Do not create one `ManagedRuntime` per request or neglect its shutdown
  disposal.
- Do not impose application tracing or runtime ownership on library consumers.

Use `effect/observability` for built-in Otlp modules. Verify
`@effect/opentelemetry` is installed before using its exporter Layers, and check
existing application setup before introducing a second telemetry pipeline.

Pinned starting points:

- `node_modules/effect/src/ManagedRuntime.ts`
- `node_modules/effect/src/observability/`
