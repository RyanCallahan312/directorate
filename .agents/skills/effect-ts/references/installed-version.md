# Installed Effect 4 API Reference

Read this before version-sensitive work or adapting beta examples. Resolve paths
below from the repository root, not from this reference directory.

## Verify the Target

- Root development dependency: `effect@4.1.2`, pinned for skill checks.
- Source root: `node_modules/effect/src/`.
- Documentation index: installed `effect/AGENTS.md`; examples: `effect/ai-docs/src/`.
- Public exports: installed `effect/package.json`; declarations: `effect/dist/`.
- Toolchain: TypeScript 7.0.2 and `@effect/tsgo@0.67.5`; run the installed `tsc`.
  The root `typescript` import no longer provides the TypeScript 5 compiler API.

```sh
bun -p 'require("effect/package.json").version'
```

Treat installed docs as API guidance, not as this project's final policy.
This skill aligns with upstream's `Schema.Class` and `Schema.TaggedError`
defaults, while package-local `AGENTS.md` files may set stricter rules. Never
follow an upstream main link as if it described the installed release.

## Replace Beta-Era Names

| Earlier skill guidance | Installed 4.1.2 guidance |
| --- | --- |
| Schema.TaggedErrorClass | `Schema.TaggedError<Self, { readonly brand: unique symbol }>()("Tag", fields)` |
| SchemaTransformation.transformOrFail | `SchemaTransformation.transformEffect` |
| Schedule.both / Schedule.either | `Schedule.max([...])` / `Schedule.min([...])` |
| Schedule.take(n) | `Schedule.upTo({ times: n })` |
| Config.string / Config.boolean / Config.redacted | `Config.String` / `Config.Boolean` / `Config.Redacted` |
| Config.mapOrFail | `Config.mapEffect` (return a `ConfigError` on failure) |
| effect/unstable/http | `effect/http` |
| effect/unstable/httpapi | `effect/http-api` |
| effect/unstable/sql | `effect/sql` |
| effect/unstable/rpc | `effect/rpc` |
| effect/unstable/workflow | `effect/workflow` |
| effect/unstable/cluster | `effect/cluster` |
| effect/unstable/ai | `effect/ai` |

Use this table for migration only; do not copy the old column into new code.
`Schedule.max` continues while all schedules continue and uses the slowest
delay; `min` continues while any continues and uses the fastest. They accept an
array, not the old binary pipeable shape. Schedule callbacks such as `map`,
`modifyDelay`, `tap`, and `while` receive metadata. Read `input`, `output`, and
`duration` from it rather than using old positional callback arguments.

```ts
import { Effect, Schema } from "effect"

export class InvalidName extends Schema.TaggedError<InvalidName, {
  readonly brand: unique symbol
}>()("InvalidName", {
  message: Schema.String
}) {}

export const validateName = Effect.fn("User.validateName")(function* (name: string) {
  if (name.length === 0) {
    return yield* new InvalidName({ message: "Name must not be empty" })
  }
  return name
})
```

## Optional Integrations

Optional platform, SQL-driver, Drizzle, AI-provider, and OpenTelemetry packages
are not implied by installing `effect`. Check their presence and compatible
versions before recommending imports or Layers.
