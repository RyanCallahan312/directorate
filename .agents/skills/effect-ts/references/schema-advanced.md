# Advanced Schema

Contents: Model Domain Concepts as Schema Classes · Codecs and Recursion · Variants and Errors · Evolution and Derivation

Use this for codecs, recursion, variants, serialized contracts, or derivation.
Target installed Effect 4.1.2. Verify unfamiliar APIs in
`node_modules/effect/src/Schema.ts` and
`node_modules/effect/src/SchemaTransformation.ts`.

## Model Domain Concepts as Schema Classes

Model domain concepts with Effect Schema from the start—even for internal
values that are not parsed from external input yet. Default named domain
concepts to branded `Schema.Class` (empty class bodies with standalone pure
functions are the clean default; add methods on the class only when behavior
cohesively belongs on the type) instead of maintaining a parallel `interface`:

```ts
import { Schema } from "effect"

export const UserIdSchema = Schema.Int.pipe(Schema.brand("UserId"))
export type UserId = typeof UserIdSchema.Type

export class User extends Schema.Class<
  User,
  { readonly brand: unique symbol }
>("app/User")({
  id: UserIdSchema,
  name: Schema.NonEmptyString
}) {}

export const createUser = (id: number, name: string) =>
  User.make({ id: UserIdSchema.make(id), name })

export const renameUser = (user: User, name: string) =>
  new User({ ...user, name })
```

Pure schemas with no class methods work the same way for closed name sets,
tagged records, and anonymous shapes (`Schema.Literals`, `Schema.Struct`,
`Schema.Opaque`), deriving types with `typeof XSchema.Type` and keeping
operations as plain functions:

```ts
import { Schema } from "effect"

export const RoleSchema = Schema.Literals(["viewer", "editor", "admin"])
export type Role = typeof RoleSchema.Type

export const MembershipSchema = Schema.Struct({
  userId: Schema.Int.pipe(Schema.brand("UserId")),
  role: RoleSchema
})
export type Membership = typeof MembershipSchema.Type

export const isAdmin = Schema.is(RoleSchema.pick(["admin"]))
const isEditorRole = Schema.is(RoleSchema.pick(["editor", "admin"]))
export const canEdit = (m: Membership) => isEditorRole(m.role)
```

A `Schema.Class` unifies schema, nominal type, validated construction
(`new User(...)` / `User.make(...)`), `Equal`, and optional pure domain methods.
Branding prevents plain objects from silently satisfying a class type, and
constructing a new instance on updates (`new User({ ...user, name })`) keeps
invariants checked on every transition. Pass a checked
`Schema.Struct(...).check(...)` to `Schema.Class` for cross-field invariants.

Escape hatches: use `Schema.Struct(...)` for anonymous shapes, tool inputs, and
shared field fragments; use `Schema.Opaque` when a plain object needs nominal
identity without class behavior.

Apply constraints before `Schema.brand(...)`: a brand is nominal typing, not
runtime validation. Decode unknown input once with
`Schema.decodeUnknownEffect`; encode typed boundary output with
`Schema.encodeEffect`.

## Codecs and Recursion

Represent different encoded and domain forms with `Schema.decodeTo` and a
`SchemaTransformation`:

- Use `SchemaTransformation.transform` for pure, infallible conversion.
- Use `SchemaTransformation.transformEffect` when conversion can fail or needs
  services; return `SchemaIssue.Issue` for conversion failures.
- Keep both directions lawful; test decode and encode, not only assignability.
- Use `Schema.suspend` to defer recursion. Keep the recursive contract small and
  test malformed deep input as well as finite valid values.

Do not distribute ad-hoc parsers and formatters around a canonical codec.

## Variants and Errors

Default domain variants (internal or serialized) to branded
`Schema.TaggedClass` members combined with
`Schema.Union([...]).pipe(Schema.toTaggedUnion("_tag"))`, or
`Schema.TaggedUnion({ ... })` when plain tagged records fit better. Both supply
validated construction, `.match`, `.isAnyOf`, and `.guards` from a single
schema. Use `Data.TaggedEnum` only when a strictly internal control-flow
algebra has no reason to be a schema.

```ts
import { Schema } from "effect"

export class Pending extends Schema.TaggedClass<
  Pending,
  { readonly brand: unique symbol }
>()("Pending", {
  id: Schema.NonEmptyString
}) {}

export class Shipped extends Schema.TaggedClass<
  Shipped,
  { readonly brand: unique symbol }
>()("Shipped", {
  id: Schema.NonEmptyString,
  trackingCode: Schema.NonEmptyString
}) {}

export const ShipmentSchema = Schema.Union([Pending, Shipped]).pipe(
  Schema.toTaggedUnion("_tag")
)
export type Shipment = typeof ShipmentSchema.Type

export const ship = (shipment: Shipment, trackingCode: string) =>
  ShipmentSchema.match(shipment, {
    Pending: (p) => Shipped.make({ id: p.id, trackingCode }),
    Shipped: (s) => s
  })
```

For deciding which slice owns transitions and when to route mutations through a
single guarded door, see [Architecture](./architecture.md).

Do not inspect `_tag` directly in runtime application code. This includes
comparisons, ternaries, `switch`, optional reads, destructuring, collection
membership such as `states.has(value._tag)`, and copying the discriminator into
persistence or diagnostics. Use the API belonging to the tagged value:

| Need | Preferred API |
|---|---|
| Check one or several union variants | `Union.isAnyOf(["Tag", ...])(value)` |
| Exhaustively branch over a union | `Union.match(value, cases)` |
| Branch incrementally or group several tags | `Match.value(value)` with `Match.tag(...)` and `Match.exhaustive` |
| Validate unknown input as one schema variant | `Union.guards.Tag(value)` |
| Check / branch on a `Data.TaggedEnum` (when used) | `Constructors.$is("Tag")(value)` / `Constructors.$match(value, cases)` |
| Handle typed Effect failures | `Effect.catchTag` / `Effect.catchTags` |
| Inspect `Cause`, `Option`, `Either`, `Exit`, or `Result` | Their `is*`, `match`, and extraction helpers |

Prefer `isAnyOf` over full schema guards for values that have already been
decoded: `guards.Tag` validates the complete variant, while `isAnyOf` performs
the intended discriminator membership check and narrows the type. Define tag
lists with `as const satisfies ReadonlyArray<keyof typeof Union.cases>` so policy
tables reject misspelled or removed variants.

When a state name must cross a boundary, define one exhaustive projection with
the generated matcher rather than reading `_tag` at each call site. When
transitioning between variants, explicitly project shared fields rather than
removing `_tag` with object destructuring. These choices make additions to a
closed union visible to TypeScript instead of silently flowing through an
`else`, default branch, or string set.

Direct `_tag` syntax remains appropriate only where it defines the algebra or
its type, such as `Schema.TaggedClass`, `Schema.TaggedStruct`,
`Data.TaggedEnum`, and type-level `Extract<Union, { _tag: "Tag" }>`
declarations. It is not a runtime branching or state-access API.

Default errors to branded `Schema.TaggedError<Self, { readonly brand: unique symbol }>()("Tag", fields)`
so every domain failure is schema-validated, yieldable, and ready to cross any
boundary. Give errors stable, domain-specific tags and schema fields; map
infrastructure failures at the adapter boundary. Reserve `Data.TaggedError` for
strictly local, non-schema errors where schema validation adds no value.

## Evolution and Derivation

Treat encoded persisted and remote schemas as compatibility contracts. Make
versions and migrations explicit; never silently widen a schema and assume old
producers or stored values remain compatible.

Add annotations only when a consumer needs identifiers, descriptions, examples,
or protocol metadata (for example JSON Schema, OpenAPI, RPC, or diagnostics).
Do not inspect `SchemaAST` for ordinary modeling. Before AST or derived-spec work,
inspect the installed source and the relevant derivation module. A valid Effect
Schema is not necessarily losslessly representable in every derived format.
