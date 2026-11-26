# Architecture and Domain Design

Contents: Graduation Ladder · Slice Anatomy · Primitives, Factories, and Composition · Guarded Records and Owned Field Groups · Ports Point Up and the Thin Root · Placement and Anti-Patterns · Pattern Glossary

Use this when adding a second module to a capability, sharing models across
features or client bundles, coordinating multiple writers on one record,
inverting an upward or lateral import, or laying out a multi-feature package.
Skip this for small scripts, single-file edits, or repositories that already
define their own layout—an established package architecture always takes
precedence.

## Graduation Ladder

Stop at the lowest rung that fits the code you are touching:

| Rung | Shape | Move up only when |
|---|---|---|
| 0 | One file: schemas, pure functions, run at the edge | The capability owns state or I/O that other code calls |
| 1 | One domain-named module: schemas, errors, `make`, `Context.Service`, `layer` | Another feature or `effect`-only client bundle needs the models without pulling in services/host code, or the capability grows past one cohesive file |
| 2 | Vertical slice directory: primitives, selective `<slice>/<slice>.ts` entry, internal modules | Two slices need each other, workflows compose multiple features, or one stored record has multiple writers |
| 3 | Ordered dependency bands + thin composition root (`index.ts`) | — |

Not yet:

- A directory with one file is a file.
- A record with one writer needs no guarded door.
- A dependency that already points down needs no port.
- Fewer than three slices need no dependency bands.

## Slice Anatomy

A slice is a directory named for one capability. Its files have three roles
(roles, not three mandatory files):

- **Primitives**: schemas, tagged errors, value objects, named transitions,
  pure predicates, defaults, and copy. Import **only `effect` and other
  primitives**; require **no `Layer`** and never import host/framework packages.
  Importable from anywhere, including light client/UI bundles.
- **Entry (`<slice>/<slice>.ts`)**: selective named re-exports of the slice's
  `Context.Service`, `Layer`, registrations, and public workflows. Never use
  `export *` or namespace re-exports. Imported only by higher bands and the
  composition root.
- **Internal modules**: implementation details imported only from inside their
  own slice.

```text
src/
├── index.ts              # thin composition root: builds Layers, wires ports
├── platform/             # lower seam: host/process adapters
└── feature/
    └── billing/          # vertical slice
        ├── billing.ts    # entry: selective named exports (service, layer)
        ├── plan.ts       # primitive: effect-only schemas & pure predicates
        └── webhooks.ts   # internal: private to billing/
```

Treat the directory tree as an illustrative shape, not a mandatory folder
taxonomy; preserve whatever band names an existing repository uses.

## Primitives, Factories, and Composition

Build bottom-up: small schema primitives → concrete values and `.make(...)`
factories → pure predicates and transitions → services only where state or I/O
lives.

To separate reference data from per-run state, ask: **"Is this true of every X
of this kind, or only this specific X in this run?"** Keep kind-level rules and
copy on concrete `Schema.Class` instances inside one total
`Schema.Record(IdSchema, Class).make(...)` registry instead of scattering
`switch (kind)` blocks or parallel lookup maps. Keep pure eligibility rules as
exported predicates beside the schemas they inspect—testable with no `Layer`.

```ts
import { Schema } from "effect"

export const PlanIdSchema = Schema.Literals(["free", "team"])
export type PlanId = typeof PlanIdSchema.Type

export class Plan extends Schema.Class<
  Plan,
  { readonly brand: unique symbol }
>("app/Plan")({
  id: PlanIdSchema,
  seats: Schema.Int.check(Schema.isGreaterThan(0)),
  exports: Schema.Boolean
}) {}

export const Free = Plan.make({ id: "free", seats: 3, exports: false })
export const Team = Plan.make({ id: "team", seats: 50, exports: true })

const Plans = Schema.Record(PlanIdSchema, Plan).make({
  free: Free,
  team: Team
})

export const planOf = (id: PlanId) => Plans[id]

export const hasSeat = (plan: Plan, members: number) => members < plan.seats
export const mayExport = (plan: Plan, members: number) =>
  plan.exports && hasSeat(plan, members)
```

## Guarded Records and Owned Field Groups

When multiple concerns write to one consistency boundary, route every write
through **one guarded door** that owns locking, admission, and persistence.
Callers pass a domain verb or named transition—never an open `patch(Partial<T>)`
or public `save(record)`.

Default to **nested schema field groups** so each group keeps its own
refinements intact, and let only the owning slice's transitions rebuild that
group. Inside one consistency boundary, compose transitions synchronously under
one lock instead of introducing an internal `PubSub` or event bus; events cross
*between* boundaries.

In the example below, `// --- path (role) ---` banners mark the intended file
split inside one self-contained snippet:

```ts
import { Context, Effect, Layer, Schema, Semaphore } from "effect"

// --- seating/seats.ts (primitive): seating owns this field group ---
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export class Seats extends Schema.Class<
  Seats,
  { readonly brand: unique symbol }
>("app/Seats")({
  available: Count,
  reserved: Count
}) {}

export const reserveOne = (seats: Seats) =>
  seats.available === 0
    ? undefined
    : Seats.make({
        available: seats.available - 1,
        reserved: seats.reserved + 1
      })

// --- show/show.ts (primitive): root composes nested owner groups ---
export class Show extends Schema.Class<
  Show,
  { readonly brand: unique symbol }
>("app/Show")({
  id: Schema.NonEmptyString,
  closed: Schema.Boolean,
  seats: Seats
}) {
  withSeats(seats: Seats) {
    return new Show({ ...this, seats })
  }
}

// --- seating/seats.ts: owner transition rebuilds only its own group ---
export const seatReserved = (show: Show) => {
  const next = reserveOne(show.seats)
  return next === undefined ? undefined : show.withSeats(next)
}

// --- show/shows.ts (entry): single guarded write door ---
export class ShowClosed extends Schema.TaggedError<
  ShowClosed,
  { readonly brand: unique symbol }
>()("ShowClosed", { id: Schema.String }) {}

export class ShowStore extends Context.Service<
  ShowStore,
  {
    readonly load: (id: string) => Effect.Effect<Show>
    readonly save: (show: Show) => Effect.Effect<void>
  }
>()("app/ShowStore") {}

const make = Effect.gen(function* () {
  const store = yield* ShowStore
  const lock = yield* Semaphore.make(1)

  return {
    mutate: Effect.fn("Shows.mutate")(function* (
      id: string,
      transition: (show: Show) => Show | undefined
    ) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const show = yield* store.load(id)
          if (show.closed) {
            return yield* new ShowClosed({ id })
          }
          const next = transition(show)
          if (next === undefined) {
            return show
          }
          yield* store.save(next)
          return next
        })
      )
    })
  }
})

export class Shows extends Context.Service<
  Shows,
  Effect.Success<typeof make>
>()("app/Shows") {
  static readonly layer = Layer.effect(Shows, make)
}
```

When an existing flat persisted schema forces spreading `...Group.fields` onto
the root instead of nesting, re-apply any dropped outer `.check(...)`
refinements on the root and import the root via `import type` in owner
transition modules so value-import cycles cannot break module initialization.

## Ports Point Up and the Thin Root

In banded applications, imports point strictly down and sibling features never
import each other's entries—workflows compose features. When a lower slice needs
something from a higher slice or a sibling, **the call may go up; the import
does not**: declare a `Context.Service` port in the consumer slice, provide it
from the owning slice via `Layer.effect`, and wire both in a thin composition
root that holds no business conditionals.

For a single registration seam that needs no `Layer` provisioning, a plain typed
callback parameter wired at the root is enough; do not wrap every function call
in a service port.

```ts
import { Context, Effect, Layer, Ref } from "effect"

// --- storage/retention.ts (lower slice): declares the port it needs ---
export class InUse extends Context.Service<
  InUse,
  { readonly isActive: (id: string) => Effect.Effect<boolean> }
>()("app/storage/InUse") {}

const makeRetention = Effect.gen(function* () {
  const inUse = yield* InUse
  return {
    mayEvict: Effect.fn("Retention.mayEvict")(function* (id: string) {
      return !(yield* inUse.isActive(id))
    })
  }
})

export class Retention extends Context.Service<
  Retention,
  Effect.Success<typeof makeRetention>
>()("app/storage/Retention") {
  static readonly layer = Layer.effect(Retention, makeRetention)
}

// --- sessions/sessions.ts (higher slice): owns the fact, supplies the port ---
const makeSessions = Effect.gen(function* () {
  const open = yield* Ref.make<ReadonlyArray<string>>([])
  return {
    opened: (id: string) => Ref.update(open, (ids) => [...ids, id]),
    isOpen: (id: string) =>
      Ref.get(open).pipe(Effect.map((ids) => ids.includes(id)))
  }
})

export class Sessions extends Context.Service<
  Sessions,
  Effect.Success<typeof makeSessions>
>()("app/Sessions") {
  static readonly layer = Layer.effect(Sessions, makeSessions)
  static readonly inUse = Layer.effect(
    InUse,
    Effect.gen(function* () {
      const sessions = yield* Sessions
      return InUse.of({ isActive: sessions.isOpen })
    })
  )
}

// --- index.ts (composition root): wiring only ---
export const AppLayer = Retention.layer.pipe(
  Layer.provide(Sessions.inUse),
  Layer.provide(Sessions.layer)
)
```

## Placement and Anti-Patterns

| Adding | Place it in |
|---|---|
| Pure rule over domain values | Exported predicate beside the schema that owns the values |
| Change to a domain record | Named transition beside the owning schema returning a new instance |
| Per-kind policy or copy | Fields on concrete `Schema.Class` instances + one `Schema.Record(...).make` registry |
| Stateful or effectful capability | `make` factory + `Context.Service` + `layer` in the owning slice |
| Fact a lower slice needs from a higher one | Port declared low, `Layer` provided high, wired in the composition root |

Avoid:

- Horizontal kind buckets (`types.ts`, `utils.ts`, `constants.ts`, `schemas/`,
  `services/`, `layers/`, or fresh `domain/`/`application/`/`infra/` trees).
- Pattern words in identifiers or paths (`*Aggregate`, `*Entity`,
  `*ValueObject`, `*Specification`); use domain nouns.
- Rebuilding another slice's fields by spread instead of calling its transition.
- Mixing structural file moves with behavior changes in the same diff.
- Relying on prose alone once a repo adopts bands: add a lightweight automated
  test in the repository to verify primitive purity, import direction, and
  absence of value-import cycles.

## Pattern Glossary

| DDD term | Effect shape in this guide |
|---|---|
| Bounded context | Vertical slice directory (primitives + entry + internals) |
| Value object | Immutable branded `Schema.Class`, rebuilt on change |
| Entity / lifecycle | Branded `Schema.Class` (same shape) or `Schema.TaggedClass` union (`toTaggedUnion`) with named transitions |
| Specification | Pure exported predicate/function over primitives (no `Layer`) |
| Aggregate & consistency boundary | Root schema composing owned field groups behind one guarded `mutate` service |
| Port & composition root | Consumer-owned `Context.Service` (or callback) wired in a thin entrypoint `Layer` |
