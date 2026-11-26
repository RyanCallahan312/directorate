# Directorate `src/`: Modeling & Architecture

Rules for everything under `packages/opencode-directorate/src/`. Read the root `AGENTS.md` and the [`effect-ts` skill](../../../.agents/skills/effect-ts/SKILL.md) for general Effect 4 mechanics; this file sets Directorate's domain modeling, slice boundaries, and ownership map.

Some `src/` code predates these rules. See [Migrating](#migrating).

## 1. Schema First

Every domain concept starts as an Effect Schema: values, identifiers, enums, states, events, errors, and tool inputs.

- **Named domain concepts**: branded `Schema.Class<Self, { readonly brand: unique symbol }>("directorate/Name")(...)`. Pass a `.check(Schema.makeFilter(...))` struct for cross-field invariants.
- **Variants & state machines**: branded `Schema.TaggedClass` members combined with `Schema.Union([...]).pipe(Schema.toTaggedUnion("_tag"))` (or `Schema.TaggedUnion` for plain records).
- **Expected failures**: branded `Schema.TaggedError<Self, { readonly brand: unique symbol }>()("Tag", fields)`.
- **Closed name sets & total tables**: `Schema.Literals([...])` and `Schema.Record(KeySchema, ValueSchema)` constructed via `.make(...)` so missing keys fail at compile time and module load.
- **Anonymous shapes & tool inputs**: `Schema.Struct({ ... })`.
- **Numbers**: `Schema.Finite` (not `Schema.Number`, which accepts `NaN`/`Infinity`).

Why branding and re-construction matter: nominal brands block plain objects from passing as validated domain instances, and updating via `new Seal({ ...seal, field })` instead of `{ ...seal, field }` guarantees invariants stay true after every change.

### Branching & Membership

- **Tagged unions**: branch exhaustively with `Union.match` (or `Match.tag` + `Match.exhaustive`), test variants on decoded values with `Union.isAnyOf([...])`, and reserve `Union.guards.Tag` for validating `unknown` input (it validates the whole variant). Never read `_tag` at runtime.
- **Literals**: prefer total `Schema.Record` lookups for per-name data, `Match.value(x).pipe(..., Match.exhaustive)` for computation, and `Schema.is(LiteralsSchema)` for membership checks. Never keep bare name constants (`REVIEWER`), `Set<string>`, or `Map<string, ...>` beside the schema that owns those names.

## 2. Derive Data Types

A hand-written data type means a schema is missing.

- **Classes** (`Schema.Class`, `Schema.TaggedClass`, `Schema.TaggedError`) are both the schema and the type — no `Schema` suffix and no separate `type` alias.
- **Non-class schemas** (`Schema.Literals`, `Schema.Union`, `Schema.Struct`) use a `Schema` suffix with a derived alias (`export type Phase = typeof PhaseSchema.Type`), because lint enforces `no-redeclare`.
- Annotate function parameters with the class or derived type (`Role`, `Window`, `Phase`); let locals, return types, and generators infer. Do not narrow locals with annotations (`const phase: Phase = ...`) or type assertions (`as T`, `!`, `any`). `as const` and `satisfies` are fine, though prefer `PhaseSchema.literals` over separate `as const` arrays.
- Derive service interfaces from their constructor: `Context.Service<Store, Effect.Success<typeof make>>()`.
- **Exempt** (non-data): `@opencode/*` host types, host seams with no `make` (`Host`), function types, generic helpers, and value-derived types (`ReturnType`, `Effect.Success`, `Layer.Success`).

## 3. Primitives → Factories → Composition

Build small primitives, instantiate concrete values with factories, and compose them into policies or state machines — instead of scattering name-keyed lookup tables.

### Example A: Primitives, Factories & Time Policy (Budget)

```ts
// 1. Primitives: schemas owning their pure behavior
export const PhaseSchema = Schema.Literals(["normal", "drain", "locked"]);

export type Phase = typeof PhaseSchema.Type;

export const RoleIdSchema = Schema.Literals([
  "directorate_liaison",
  "directorate_auditor",
]);

export type RoleId = typeof RoleIdSchema.Type;

export class Role extends Schema.Class<Role, { readonly brand: unique symbol }>(
  "directorate/Role"
)({
  id: RoleIdSchema,
  orders: Schema.Record(PhaseSchema, Schema.String),
}) {
  orderFor(phase: Phase) {
    return this.orders[phase];
  }
}

export class Window extends Schema.Class<
  Window,
  { readonly brand: unique symbol }
>("directorate/Window")(
  Schema.Struct({
    closesAt: Schema.DateTimeUtc, // in-memory; persisted timestamps use DateTimeUtcFromString
    drainsAt: Schema.DateTimeUtc,
  }).check(
    Schema.makeFilter(
      (w) =>
        DateTime.isLessThan(w.drainsAt, w.closesAt) ||
        "drainsAt must precede closesAt"
    )
  )
) {
  phaseAt(now: DateTime.Utc) {
    if (DateTime.isGreaterThanOrEqualTo(now, this.closesAt)) {
      return "locked";
    }

    return DateTime.isGreaterThanOrEqualTo(now, this.drainsAt)
      ? "drain"
      : "normal";
  }
}

// 2. Factories: each instance owns its data (including prompt text)
export const Liaison = Role.make({
  id: "directorate_liaison",
  orders: {
    drain: "DRAIN: route open entries to Compliance",
    locked: "LOCKED: call directorate_report now",
    normal: "observe and investigate",
  },
});

export const Auditor = Role.make({
  id: "directorate_auditor",
  orders: {
    drain: "DRAIN: file surviving candidates now and hand off",
    locked: "LOCKED: file final candidates or notes and stop",
    normal: "investigate",
  },
});

// Single boundary registry: the only name-keyed table
const Roles = Schema.Record(RoleIdSchema, Role).make({
  directorate_auditor: Auditor,
  directorate_liaison: Liaison,
});

export const roleOf = (id: RoleId) => Roles[id];

// 3. Composition: pure policy below, single effectful operation at the edge
export const brief = Effect.fn("Budget.brief")(function* brief(
  role: Role,
  window: Window
) {
  const now = yield* DateTime.now;

  return role.orderFor(window.phaseAt(now));
});
```

### Example B: Stateful Transitions (Ship Loop)

Derive values when time is the source of truth (`Window.phaseAt`). For genuinely stateful workflows (`ship-step.ts`), model states and events as branded `Schema.TaggedClass` unions where each state carries only its valid fields, make invalid transitions an explicit `Schema.TaggedError`, and keep I/O in the surrounding service loop:

```ts
export class Active extends Schema.TaggedClass<
  Active,
  { readonly brand: unique symbol }
>()("Active", { round: Schema.Int }) {}

export class Paused extends Schema.TaggedClass<
  Paused,
  { readonly brand: unique symbol }
>()("Paused", { reason: Schema.String, round: Schema.Int }) {}

export class Complete extends Schema.TaggedClass<
  Complete,
  { readonly brand: unique symbol }
>()("Complete", { rounds: Schema.Int }) {}

export const ShipStateSchema = Schema.Union([Active, Paused, Complete]).pipe(
  Schema.toTaggedUnion("_tag")
);

export type ShipState = typeof ShipStateSchema.Type;

export class ReviewPassed extends Schema.TaggedClass<
  ReviewPassed,
  { readonly brand: unique symbol }
>()("ReviewPassed", {}) {}

export class PauseRequested extends Schema.TaggedClass<
  PauseRequested,
  { readonly brand: unique symbol }
>()("PauseRequested", { reason: Schema.String }) {}

export const ShipEventSchema = Schema.Union([
  ReviewPassed,
  PauseRequested,
]).pipe(Schema.toTaggedUnion("_tag"));

export type ShipEvent = typeof ShipEventSchema.Type;

export class InvalidShipTransition extends Schema.TaggedError<
  InvalidShipTransition,
  { readonly brand: unique symbol }
>()("InvalidShipTransition", {
  event: ShipEventSchema,
  state: ShipStateSchema,
}) {}

export const transition = (state: ShipState, event: ShipEvent) =>
  ShipStateSchema.match(state, {
    Active: (active) =>
      ShipEventSchema.match(event, {
        PauseRequested: ({ reason }) =>
          Effect.succeed(new Paused({ reason, round: active.round })),
        ReviewPassed: () =>
          Effect.succeed(new Complete({ rounds: active.round })),
      }),
    Complete: () => Effect.fail(new InvalidShipTransition({ event, state })),
    Paused: () => Effect.fail(new InvalidShipTransition({ event, state })),
  });
```

- **Resolve names once**: decode agent names at the host boundary, resolve via `roleOf`, and pass `Role` inward. Reject unknown names wherever authority or permissions are checked; allow a display fallback (e.g., Liaison copy) only at the presentation boundary.

## 4. Deep Modules, Vertical Slices & Ownership

[`../ARCHITECTURE.md`](../ARCHITECTURE.md) is the ownership map: which slices exist, what each owns, which field group of `seal.json` each may change, and how slices may depend on each other. Read it before adding or moving a module. In short:

- **Vertical slices**: each slice is a directory that owns its schema classes, pure logic, `Context.Service` + `Layer`, tool handlers, prompt text, and errors. Features live under `src/feature/`, workflows under `src/workflow/`; `seal/`, `records/`, and `platform/` sit beside them.
- **Two public surfaces**: a slice's _primitive modules_ (schemas, tagged errors, pure functions, copy, defaults; they import only `effect` and other primitive modules) may be imported by anyone. Its _entry_ (`<slice>/<slice>.ts`: service, Layer, `register()`, workflows) is imported only by higher bands and `index.ts`. Every other module is internal to its slice.
  ```text
  src/workflow/review/
  ├── review.ts    # entry: selective named exports; no export * / namespace
  ├── window.ts    # primitive: importable by any slice
  └── watchdog.ts  # internal
  ```
- **Deep interfaces**: hide multi-step orchestration behind a small set of cohesive exports, while keeping distinct contracts separate (e.g., ticking tool footer vs. cache-stable prompt notice).
- **Colocate by change, not kind**: never create `types.ts`, `constants.ts`, `utils.ts`, or a shared `model.ts`.
- **One-way dependencies**: imports point down the bands (workflow → feature → seal → records/platform → primitives). Features never import each other's entries; only workflows compose features. When a lower slice needs a higher one, it declares a `Context.Service` port. No module cycles.
- **One aggregate, one door**: every write to a review goes through `Sessions.mutate`, and each `seal.json` field group is rebuilt only by its owner's transitions.
- **Composition root**: `src/index.ts` builds Layers and calls each slice's `register()`; it holds no tool bodies, hooks, or policy. Package entry points (`index.ts`, `tui.ts`, `gui.ts`, `rpc.ts`) stay at `src/` root.
- **Services as capability seams**: use `Context.Service` only for I/O or state (filesystem, sessions, store) with dependencies captured in the `Layer` (`R = never` on methods). Keep pure logic on schema classes or exported functions.

## Gotchas

- **Stored schemas are compatibility contracts**: `seal.json`, `ledger.json`, `directorate.json`, archives, agent names, and tool names outlive the code that wrote them. Never rename literals, tighten fields, or alter encoded shapes without `Schema.withDecodingDefaultKey` (`since` in `platform/stored.ts`) or `Schema.decodeTo` (`orLegacyTrue`) plus a legacy-fixture test.
- **Tool input vs. domain vs. storage**: share field schemas, not whole codecs. Tool inputs passed to `DefineTool` are decoded by the host (do not re-decode) and must use `Schema.optionalKey` — `Schema.optional` emits `anyOf: [..., null]` in JSON Schema.
- **Decoding functions**: use `Schema.decodeUnknownEffect` for `unknown`, `Schema.decodeUnknownOption` for best-effort hook metadata, and `Schema.decodeEffect` when input already matches `Encoded` (e.g., JSON strings into `Schema.fromJsonString`).
- **`schema.make` vs. `Schema.make`**: call `MyClass.make(...)` / `new MyClass(...)` or `.makeEffect(...)` (which fails with `SchemaIssue.Issue` — map it to a domain error). Module-level `Schema.make` builds a schema from an AST, not a value. `.make` drops unknown keys by default.
- **`mapFields` drops struct checks**: `Struct.mapFields(Struct.pick([...]))` preserves field checks but drops outer `.check(...)` refinements unless reapplied.
- **Tests stay in `test/*.test.ts`**: the test script runs `node --test test/*.test.ts`, so tests inside `src/<slice>/` will not run. Test slices through public exports or the plugin, build fixtures with `.make` / `new`, and use `TestClock` for time.

## Migrating

- New concepts belong in their owning slice.
- Move code between modules in its own change — do not mix structural moves with behavior changes.
- Bring code you touch closer to these rules without pulling unrelated files into scope.

## Verification

A change under `src/` is done when:

1. `bun run check` passes.
2. `tsc --noEmit` output contains no new Effect language-service suggestions (`effect(schemaNumber)`, `effect(schemaClassMissingBrand)` exit `0` — read the output).
3. Any persisted-schema change includes round-trip and legacy-fixture tests.
