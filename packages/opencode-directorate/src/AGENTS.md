# Directorate `src/`: Modeling & Architecture

Rules for everything under `packages/opencode-directorate/src/`. Read the root `AGENTS.md` and the [`effect-ts` skill](../../../.agents/skills/effect-ts/SKILL.md) for general Effect 4 mechanics; this file sets Directorate's domain modeling and the Effect patterns its slices use. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) is the ownership map.

## 1. Schema First

Every domain concept starts as an Effect Schema: values, identifiers, enums, states, events, errors, and tool inputs.

- **Named domain concepts**: branded `Schema.Class<Self, { readonly brand: unique symbol }>("directorate/Name")(...)`. Pass a `.check(Schema.makeFilter(...))` struct for cross-field invariants.
- **Variants & state machines**: branded `Schema.TaggedClass` members combined with `Schema.Union([...]).pipe(Schema.toTaggedUnion("_tag"))` (or `Schema.TaggedUnion` for plain records).
- **Expected failures**: branded `Schema.TaggedError<Self, { readonly brand: unique symbol }>()("Tag", fields)`.
- **Closed name sets & total tables**: `Schema.Literals([...])` and `Schema.Record(KeySchema, ValueSchema)` constructed via `.make(...)` so missing keys fail at compile time and module load.
- **Anonymous shapes & tool inputs**: `Schema.Struct({ ... })`.
- **Numbers**: `Schema.Finite` (not `Schema.Number`, which accepts `NaN`/`Infinity`).

Why branding and re-construction matter: nominal brands block plain objects from passing as validated domain instances, and rebuilding through the class instead of spreading into a plain object (`{ ...x, field }`) keeps invariants true after every change. Small classes rebuild with `new X({ ...x, field })` or a method that does it (`Region.shown`, `Gates.remembering`). Aggregates rebuild only through their class's own methods: a `Seal` changes only through its `with<Group>` methods, called from the owning slice's transitions (see [One aggregate, one door](../ARCHITECTURE.md#one-aggregate-one-door)).

### Branching & Membership

- **Tagged unions**: branch exhaustively with `Union.match` (or `Match.tag` + `Match.exhaustive`), test variants on decoded values with `Union.isAnyOf([...])`, and reserve `Union.guards.Tag` for validating `unknown` input (it validates the whole variant). Never read `_tag` at runtime.
- **Names are never compared raw.** A name is a member of a literal schema, a host union's discriminant, or a marker we invented. Never compare one with `===` or `!==`, `switch`/`case`, or `[...].includes(...)`. Ask its owner instead:
  - a **predicate**: `export const isLocked = Schema.is(PhaseSchema.pick(["locked"]))` (`workflow/review/window.ts`);
  - a **getter or method** on the owning class, built on a predicate: `ToolCall.ownerOnly` (`seal/sessions.ts`), `Seal.pinsCommit`;
  - exhaustive **`Match`** for multi-way branching: `stateFor` in `feature/dispatch/lifecycle.ts` (`Match.value(status).pipe(Match.when("launching", () => Launching), ..., Match.exhaustive)`);
  - a total **`Schema.Record(...).make`** for per-name data: `SCOPE_TITLES` in `feature/settings/configure-flow.ts`.
- **Host unions** branch with `Match` on the discriminant (`idleAt`: `Match.when({ state: "idle" }, ...)`) or a named predicate (`isUserInput`: `Schema.is(Schema.Struct({ type: Schema.Literal("user") }))`). Predicates over host records that several slices use live in `platform/host-record.ts`.
- **Where predicates live**: beside the schema that owns the name. Reuse the owner's predicate; never define a second one elsewhere. Build each once at module level, never inside a loop, a function body, or a getter.
- **Plain text is not a name** and may be compared directly: `""`, `"."`, `".."`, path separators, and git's literal output lines (`rel === ".."` in `seal/content.ts`, `line === "GIT binary patch"` in `seal/diff.ts`).
- Never keep bare name constants (`REVIEWER`), `Set<string>`, or `Map<string, ...>` beside the schema that owns those names.
- **Agent ids** never appear inside a string. Interpolate the `Agent`'s id (`` `Only ${Liaison.id} runs a Directorate review` ``), so the ids are written only in `feature/agents/agent.ts`.
- **Lint enforces both**: `directorate/no-name-comparison` and `directorate/no-agent-id-in-string` (in `tools/oxlint/directorate/` at the repository root) fail `bun run check` on a raw name comparison or a spelled-out agent id anywhere under `src/`.

## 2. Derive Data Types

A hand-written data type means a schema is missing.

- **Classes** (`Schema.Class`, `Schema.TaggedClass`, `Schema.TaggedError`) are both the schema and the type — no `Schema` suffix and no separate `type` alias.
- **Non-class schemas** (`Schema.Literals`, `Schema.Union`, `Schema.Struct`) use a `Schema` suffix with a derived alias (`export type Phase = typeof PhaseSchema.Type`), because lint enforces `no-redeclare`. Omit the alias when nothing would use it.
- **Stored field groups and stored codecs** are the exception: they are named for the stored shape and take no `Schema` suffix (`Containment`, `Custody`, `StoredWindow`, `Protocol`, `StoredDispatch`, `StoredShipState`).
- Annotate function parameters with the class or derived type (`Agent`, `Window`, `Phase`); let locals, return types, and generators infer. Do not narrow locals with annotations (`const phase: Phase = ...`) or type assertions (`as T`, `!`, `any`). `as const` and `satisfies` are fine, though prefer `PhaseSchema.literals` over separate `as const` arrays.
- **Argument objects** are a named `Schema.Struct` or derived from one: `createSeal`'s `input` is `typeof SealRequestSchema.Type`, and `Dialogs.prompt` takes `typeof PromptDialogSchema.Type`. With at most three simple parameters, pass them positionally instead.
- **Generic types** let a schema own every non-generic field and add only the generic slot: `DialogChoice<V>` is `ChoiceLabelSchema`'s type plus `{ readonly value: V }`, and the door's `Revision<A>` is `RevisedSchema`'s or `FiledSchema`'s type plus `{ readonly out: A }`.
- **Ports** are pure function bags (`Dialogs`, `ActiveSeal`) or derived from their constructor: `Backend` is `ReturnType<typeof backend>`, and services are `Context.Service<Records, Effect.Success<typeof make>>()`.
- **Exempt** (non-data): `@opencode/*` host types, host seams with no `make` (`Host`), function types (including `DefineTool` and its tool spec), and value-derived types (`ReturnType`, `Effect.Success`, `Layer.Success`).
- **Lint enforces this**: `directorate/no-handwritten-object-type` rejects every object type literal and interface under `src/` except the class brand, a generic slot (a shape that names a type parameter in scope), and a pure function bag.

## 3. Primitives → Factories → Composition

Build small primitives, instantiate concrete values with factories, and compose them into policies or state machines — instead of scattering name-keyed lookup tables.

### Example A: Primitives, Factories & Time Policy (agents and the budget)

Abridged from `workflow/review/window.ts` and `feature/agents/agent.ts`:

```ts
// 1. Primitives: schemas owning their pure behavior (workflow/review/window.ts)
export const PhaseSchema = Schema.Literals(["normal", "drain", "locked"]);

export type Phase = typeof PhaseSchema.Type;

export class Window extends Schema.Class<
  Window,
  { readonly brand: unique symbol }
>("directorate/Window")(
  Schema.Struct({
    budgetMinutes: Schema.Finite,
    createdAt: Schema.DateTimeUtc, // in memory; StoredWindow stores it with Time
    deadline: Schema.DateTimeUtc,
  }).check(windowCheck) // the deadline never precedes createdAt
) {
  /** Normal, then drain for the last 20% (6 minutes if longer, but never more than half), then locked at the deadline. */
  phaseAt(now: DateTime.Utc) {
    const at = DateTime.toEpochMillis(now);
    const end = DateTime.toEpochMillis(this.deadline);
    const total = Math.max(1, end - DateTime.toEpochMillis(this.createdAt));
    const drainMs = Math.max(0.2 * total, Math.min(6 * 60_000, 0.5 * total));

    if (at >= end) {
      return "locked";
    }

    return at >= end - drainMs ? "drain" : "normal";
  }
}

// (feature/agents/agent.ts)
export const AgentIdSchema = Schema.Literals([
  "directorate_liaison",
  "directorate_auditor",
  "directorate_seat",
  "directorate_compliance",
]);

type AgentId = typeof AgentIdSchema.Type;

export class Agent extends Schema.Class<
  Agent,
  { readonly brand: unique symbol }
>("directorate/Agent")({
  dispatches: Schema.Array(AgentIdSchema),
  id: AgentIdSchema,
  launchableIn: Schema.Array(PhaseSchema),
  orders: Schema.Record(PhaseSchema, Schema.String),
  title: Schema.String,
}) {
  mayLaunch(child: Agent, phase: Phase) {
    return (
      this.dispatches.includes(child.id) && child.launchableIn.includes(phase)
    );
  }

  orderFor(phase: Phase) {
    return this.orders[phase];
  }
}

// 2. Factories: each instance owns its data (including prompt text)
export const Auditor = Agent.make({
  dispatches: [],
  id: "directorate_auditor",
  launchableIn: ["normal"],
  orders: {
    drain: "DRAIN: file surviving candidates now and hand off",
    locked: "LOCKED: file final candidates or notes and stop",
    normal: "investigate",
  },
  title: "Auditor",
});

// … Liaison, Seat, and Compliance alike.

// The single registry: the only name-keyed table
const Agents = Schema.Record(AgentIdSchema, Agent).make({
  directorate_auditor: Auditor,
  directorate_compliance: Compliance,
  directorate_liaison: Liaison,
  directorate_seat: Seat,
});

export const agentOf = (id: AgentId) => Agents[id];

// 3. Composition: pure policy below, one effectful operation at the edge
export const budgetLine = Effect.fnUntraced(function* budgetLine(
  agent: Agent,
  window: Window
) {
  const b = yield* budget(window); // the phase and minutes left now

  return phaseLine(
    agent,
    b.phase,
    `${b.minutesLeft} min left of ${window.budgetMinutes} · phase ${b.phase}`
  );
});
```

### Example B: Stateful Transitions (dispatches and the ship loop)

Derive values when time is the source of truth (`Window.phaseAt`). For genuinely stateful records, model the states as branded `Schema.TaggedClass` members of one tagged union, and keep I/O in the surrounding service. `Dispatch` (`feature/dispatch/lifecycle.ts`) and ship state (`workflow/ship/state.ts`) follow the same pattern:

- **States share the stored field set.** A stored record keeps whatever any version wrote, and a round trip must be lossless, so every state carries every field. What a state actually sets is up to the transitions into it.
- **The union decodes from the stored shape.** The record stores its state as a `status` field, not a `_tag`; `Schema.decodeTo` maps the stored struct to the union and back.
- **Changes are named transitions** that build the next state through its class, branching with exhaustive `match`.
- **A transition that does not apply returns no change.** Dispatch transitions return `undefined`, so callers write only real changes; ship transitions rebuild the same state. Neither raises an invalid-transition error.

Abridged from `feature/dispatch/lifecycle.ts`:

```ts
/** What every run carries in every state. */
const dispatchFields = {
  agent: Schema.String, // as stored: older records may hold any name
  call: Schema.String,
  endedAt: opt(Schema.DateTimeUtc),
  prompt: Schema.String,
  session: opt(Schema.String),
  startedAt: Schema.DateTimeUtc,
  // …
};

export class Running extends Schema.TaggedClass<
  Running,
  { readonly brand: unique symbol }
>()("Running", dispatchFields) {}

export class Completed extends Schema.TaggedClass<
  Completed,
  { readonly brand: unique symbol }
>()("Completed", dispatchFields) {}

// … Launching and Failed alike.

export const DispatchSchema = Schema.Union([
  Launching,
  Running,
  Completed,
  Failed,
]).pipe(Schema.toTaggedUnion("_tag"));

export type Dispatch = typeof DispatchSchema.Type;

export const statusOf = (d: Dispatch) =>
  DispatchSchema.match(d, {
    Completed: () => "completed" as const,
    Failed: () => "failed" as const,
    Launching: () => "launching" as const,
    Running: () => "running" as const,
  });

/** A dispatch in seal.json's children: its state is a `status` field, not a tag. */
const StoredDispatch = Schema.Struct({
  // … the same fields, with endedAt and startedAt as Time …
  status: DispatchStatusSchema,
});

export const DispatchFromStored = StoredDispatch.pipe(
  Schema.decodeTo(Schema.toType(DispatchSchema), {
    decode: SchemaGetter.transform(
      (stored) =>
        new (stateFor(stored.status))(DispatchFieldsSchema.make(stored))
    ),
    encode: SchemaGetter.transform((d) => ({
      ...fieldsOf(d),
      status: statusOf(d),
    })),
  })
);

/** The new seal, or undefined when no run changed. */
export const update = (seal: Seal, step: (c: Dispatch) => Dispatch) => {
  const children = seal.children.map(step);

  return children.some((c, i) => c !== seal.children[i])
    ? seal.withDispatches(children)
    : undefined;
};

/** A completed run doing more work without a new launch is running again. */
export const resumed = (seal: Seal, session: string) => {
  const run = latest(seal, session);

  return update(seal, (c) =>
    c === run && isCompleted(c)
      ? new Running({ ...fieldsOf(c), endedAt: undefined })
      : c
  );
};
```

- **Resolve names once**: decode agent names at the host boundary into an `Actor` (platform's `actor`), resolve them with `agentNamed` or `dispatchableNamed` (both through `agentOf`) or `Actor.role`, and pass `Agent` inward. Reject unknown names wherever authority or permissions are checked; allow a display fallback (e.g., Liaison copy) only at the presentation boundary.

## 4. Deep Modules, Vertical Slices & Ownership

[`../ARCHITECTURE.md`](../ARCHITECTURE.md) is the ownership map: which slices exist, what each owns, which field group of `seal.json` each may change, and how slices may depend on each other. Read it before adding or moving a module. In short:

- **Vertical slices**: each slice is a directory that owns its schema classes, pure logic, `Context.Service` + `Layer`, tool handlers, prompt text, and errors. Features live under `src/feature/`, workflows under `src/workflow/`; `seal/`, `records/`, and `platform/` sit beside them.
- **Two public surfaces**: a slice's _primitive modules_ (schemas, tagged errors, functions over them, copy, defaults; they import only `effect` and other primitive modules, and need no `Layer`) may be imported by anyone. Its _entry_ (`<slice>/<slice>.ts`: named re-exports of its service, Layer, registrations, and workflows) is imported only by higher bands and `index.ts`. Every other module is internal to its slice.
  ```text
  src/workflow/review/
  ├── review.ts    # entry: selective named exports; no export * / namespace
  ├── window.ts    # primitive: importable by any slice
  └── watchdog.ts  # internal
  ```
- **Deep interfaces**: hide multi-step orchestration behind a small set of cohesive exports, while keeping distinct contracts separate (e.g., ticking tool footer vs. cache-stable prompt notice).
- **Colocate by change, not kind**: never create `types.ts`, `constants.ts`, `utils.ts`, or a shared `model.ts`.
- **One-way dependencies**: imports point down the bands (workflow/ship → workflow/review → feature → seal → records → platform; primitives from anywhere). Features never import each other's entries; only workflows compose features. When a lower slice needs a higher one, or a feature needs a sibling, it declares a port: a `Context.Service` provided in a `Layer` (`ActiveSeal`), or a registration parameter that `index.ts` wires. No value-import cycles.
- **One aggregate, one door**: every write to a review goes through `Sessions.mutate` (a new review through `openReview`), and each `seal.json` field group is rebuilt only through its owner's transitions and `Seal`'s `with<Group>` methods. Another owner's transition may compose it, never rebuild the group itself.
- **Composition root**: `src/index.ts` builds the Layers, runs each slice's registration in order, and wires slices to each other; it holds no tool bodies, hooks, or policy. Package entry points (`index.ts`, `tui.ts`, `gui.ts`, `rpc.ts`) stay at `src/` root.
- **Services as capability seams**: use `Context.Service` only for I/O or state (filesystem, sessions, records) with dependencies captured in the `Layer` (`R = never` on methods). Keep pure logic on schema classes or exported functions.
- **Placement**: new concepts belong in their owning slice ([Where new code goes](../ARCHITECTURE.md#where-new-code-goes)). Move code between modules in its own change; do not mix structural moves with behavior changes.

## Gotchas

- **Stored schemas are compatibility contracts**: `seal.json`, `ledger.json`, `directorate.json`, ship state, archives, agent names, and tool names outlive the code that wrote them. Never rename literals, tighten fields, or alter encoded shapes without `Schema.withDecodingDefaultKey` (`since` in `platform/stored.ts`) or `Schema.decodeTo` (`orLegacyTrue`) plus a legacy fixture.
- **Fixtures guard the contracts**: a stored-contract or host-surface change needs fixtures under `test/stored/`. `test/contracts.test.ts` round-trips them byte for byte, `test/surface.test.ts` compares the registered surface with `test/stored/surface.json`, and `test/architecture.test.ts` checks imports and the Layout block in `ARCHITECTURE.md`.
- **Tool input vs. domain vs. storage**: share field schemas, not whole codecs. Tool inputs passed to `DefineTool` are decoded by the host (do not re-decode) and must use `Schema.optionalKey` — `Schema.optional` emits `anyOf: [..., null]` in JSON Schema.
- **Decoding functions**: use `Schema.decodeUnknownEffect` for `unknown`, `Schema.decodeUnknownOption` for best-effort hook metadata, and `Schema.decodeEffect` when input already matches `Encoded` (e.g., JSON strings into `Schema.fromJsonString`).
- **`schema.make` vs. `Schema.make`**: call `MyClass.make(...)` / `new MyClass(...)` or `.makeEffect(...)` (which fails with `SchemaIssue.Issue` — map it to a domain error). Module-level `Schema.make` builds a schema from an AST, not a value. `.make` drops unknown keys by default.
- **`mapFields` drops struct checks**: `Struct.mapFields(Struct.pick([...]))` preserves field checks but drops outer `.check(...)` refinements unless reapplied. Spreading a struct's `.fields` drops them too, which is why `Seal` re-applies `windowCheck`.
- **Tests stay in `test/*.test.ts`**: the test script runs `node --test test/*.test.ts`, so tests inside `src/<slice>/` will not run. Tests sit outside the bands and may import a slice's internal modules directly. Build fixtures with `.make` / `new`, and use `TestClock` for time.

## Verification

A change under `src/` is done when:

1. `bun run check` passes.
2. `tsc --noEmit` output contains no new Effect language-service suggestions (`effect(schemaNumber)`, `effect(schemaClassMissingBrand)` exit `0` — read the output).
3. Any persisted-schema change includes round-trip and legacy-fixture tests.
