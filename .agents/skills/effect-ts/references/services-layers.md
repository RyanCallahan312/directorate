# Services, Layers, and Modules

Contents: Colocate a Capability · Pure Models and Ports · Build and Compose Layers

Use this for capability seams, `make` factories, service tags, layer
implementations, runtime wiring, and reusable Effect operations. Target
installed Effect 4.1.2; verify unfamiliar APIs in the installed Context and
Layer sources.

## Colocate a Capability

Start a new stateful or effectful capability in one domain-named module (for
example `draft-slot.ts`). Define its owned schemas and typed errors first,
implement the capability in a `const make = Effect.gen(...)` factory that
captures dependencies so public methods expose `R = never`, and derive the
`Context.Service` shape from `Effect.Success<typeof make>` with
`static readonly layer = Layer.effect(Self, make)`.

```ts
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"

export class Draft extends Schema.Class<
  Draft,
  { readonly brand: unique symbol }
>("app/Draft")({
  title: Schema.NonEmptyString
}) {}

export class NoDraft extends Schema.TaggedError<
  NoDraft,
  { readonly brand: unique symbol }
>()("NoDraft", {}) {}

const make = Effect.gen(function* () {
  const current = yield* Ref.make(Option.none<Draft>())

  return {
    save: (draft: Draft) => Ref.set(current, Option.some(draft)),
    read: Effect.fn("DraftSlot.read")(function* () {
      const draft = yield* Ref.get(current)
      return yield* Effect.fromOption(draft, () => NoDraft.make({}))
    })
  }
})

export class DraftSlot extends Context.Service<
  DraftSlot,
  Effect.Success<typeof make>
>()("app/DraftSlot") {
  static readonly layer = Layer.effect(DraftSlot, make)
}
```

`Draft` owns invariants and validated construction (`Draft.make(...)`) even
before any external parsing exists. `DraftSlot` owns mutable state, accepts
already-validated domain values, and derives its service contract from `make`
without a duplicate handwritten interface. Yield dependency services inside
`make` (`const db = yield* Database`) so callers still see `R = never` on every
method.

## Pure Models and Ports

Introduce `Context.Service` only for a real capability seam (I/O, state, or a
swappable runtime boundary). Keep pure domain models and functions as schema
classes or exported functions—do not wrap pure logic in a service.

When callers across features or light client bundles need pure models without
importing a service or layer, keep the pure schemas and functions in a sibling
primitive module inside the same slice (importing only `effect` and other pure
primitives). For graduating a module into a vertical slice, dependency bands,
guarded multi-writer records, and ports pointing up, see
[Architecture](./architecture.md).

```ts
import { Schema } from "effect"

export const PhaseSchema = Schema.Literals(["normal", "drain", "locked"])
export type Phase = typeof PhaseSchema.Type

export class Budget extends Schema.Class<
  Budget,
  { readonly brand: unique symbol }
>("app/Budget")({
  minutes: Schema.Finite.check(Schema.isGreaterThan(0)),
  phase: PhaseSchema
}) {}

export const isLocked = Schema.is(PhaseSchema.pick(["locked"]))

export const openBudget = (minutes: number) =>
  Budget.make({ minutes, phase: "normal" })
```

When a capability is an abstract port with multiple implementations and no
single `make` (for example a host adapter or swappable transport), declare the
method bag on `Context.Service<Self, { ... }>()` and construct implementations
with `Self.of(...)` in each adapter's `Layer`.

Name service classes after the domain capability and give them package-qualified
identifiers. Follow the package's relative `.ts` imports rather than
self-referential module namespaces or incidental barrel imports. Do not add
`export * as Domain from "./domain.ts"`, TypeScript `namespace` declarations, or
a barrel that re-imports its own leaf; use direct, intentional named exports
instead.

Use named `Effect.fn` values with hierarchical names such as `"DraftSlot.read"`
for useful tracing boundaries; use `Effect.fnUntraced` for library glue without
a tracing boundary. Put the operation's meaning in its generator; attach retry,
timeout, logging, tracing, and provisioning policy to a specific invocation
unless it is intrinsic to every call.

## Build and Compose Layers

Choose the constructor that matches acquisition:

| Need | Layer API |
|---|---|
| `make` factory, effectful, or scoped construction | `Layer.effect` |
| Existing implementation or test double | `Layer.succeed` |
| Lazy synchronous construction | `Layer.sync` |
| Lifecycle work with no service | `Layer.effectDiscard` |
| Config or discovery selects a layer | `Layer.unwrap` |

Use `Layer.provide` to satisfy and hide dependencies, `Layer.provideMerge` only
when they must remain available, and `Layer.mergeAll` for independent peers.
Compose a named, topologically ordered runtime layer near the entrypoint and
provide it once. Reuse the same layer value when its scoped resource must be
shared.

Fork long-lived streams, listeners, workers, and loops into layer scope with
`Effect.forkScoped`; layer acquisition must complete. Use
`Effect.acquireRelease` inside `make` for a reusable scoped resource and
`Effect.acquireUseRelease` for one local bracket.

```ts
import { Context, Effect, Layer, Schema } from "effect"

export class QueryFailed extends Schema.TaggedError<
  QueryFailed,
  { readonly brand: unique symbol }
>()("QueryFailed", {
  message: Schema.String
}) {}

declare const openConnection: Effect.Effect<{
  readonly query: (
    sql: string
  ) => Effect.Effect<ReadonlyArray<unknown>, QueryFailed>
}>
declare const closeConnection: (
  conn: Effect.Success<typeof openConnection>
) => Effect.Effect<void>

const make = Effect.gen(function* () {
  const conn = yield* Effect.acquireRelease(openConnection, closeConnection)

  return {
    query: Effect.fn("Database.query")(function* (sql: string) {
      return yield* conn.query(sql)
    })
  }
})

export class Database extends Context.Service<
  Database,
  Effect.Success<typeof make>
>()("app/Database") {
  static readonly layer = Layer.effect(Database, make)
}
```

`Layer.effect` supplies the Scope required by `acquireRelease`. The connection
stays open for that Layer instance and closes on normal shutdown, failure, or
interruption. Do not wrap this acquisition in `Effect.scoped` before returning
the Layer, which would close the resource before consumers can use it.

Keep the runtime at the application boundary; reusable library code should not
construct application services or Layers on the caller's behalf.
