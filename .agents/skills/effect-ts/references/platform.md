# Platform I/O, Processes, and Encoding

Read this for `FileSystem`, `Path`, child processes (`effect/process`), binary
or structured encoding (`effect/encoding`), or platform Layers. Target installed
Effect 4.1.2; verify runtime package presence (`@effect/platform-bun` or
`@effect/platform-node`) before wiring Layers.

## Choose

| Need | API |
|---|---|
| Files, directories, temp paths | `FileSystem.FileSystem` |
| OS-aware path manipulation | `Path.Path` |
| Spawn commands or pipelines | `ChildProcess.make` + `ChildProcessSpawner.ChildProcessSpawner` (`effect/process`) |
| Structured/binary encoding | `Yaml`, `Zip`, `Hex` (`effect/encoding`) and `Bytes` |
| Platform failure typing | `PlatformError` (`effect/PlatformError`) |
| Runtime platform Layers | `@effect/platform-bun` or `@effect/platform-node` (provide at the boundary) |

## Rules

- Depend on `FileSystem`, `Path`, and `ChildProcessSpawner` services inside
  Effect operations rather than importing `node:fs` or `node:child_process`
  directly. This keeps I/O testable, interruptible, and typed.
- Build commands with `ChildProcess.make(cmd, args, options)`—never concatenate
  untrusted arguments into a shell string.
- Map `PlatformError` to a branded `Schema.TaggedError` at the adapter or
  feature boundary instead of leaking low-level I/O failures inward.
- Capture platform service dependencies while building your adapter Layer so
  service methods expose `R = never`.
- When using unstable/experimental platform subpaths with
  `@effect/language-service`, configure `allowedUnstableApis` /
  `allowedExperimentalApis` in `tsconfig.json` rather than suppressing
  diagnostics inline.

```ts
import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class GitError extends Schema.TaggedError<
  GitError,
  { readonly brand: unique symbol }
>()("GitError", {
  cause: Schema.Defect()
}) {}

export class Git extends Context.Service<Git, {
  readonly headSha: Effect.Effect<string, GitError>
}>()("app/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return Git.of({
        headSha: spawner
          .string(ChildProcess.make("git", ["rev-parse", "HEAD"]))
          .pipe(
            Effect.map((out) => out.trim()),
            Effect.mapError((cause) => new GitError({ cause }))
          )
      })
    })
  )
}
```

## Do not

- Do not call `node:fs`, `node:child_process`, or `Bun.spawn` directly inside
  Effect services when `FileSystem` or `ChildProcessSpawner` fits.
- Do not interpolate untrusted input into a shell command string.
- Do not assume `@effect/platform-bun` or `@effect/platform-node` is installed
  without checking the target workspace's `package.json`.

Pinned starting points:

- `node_modules/effect/src/FileSystem.ts`
- `node_modules/effect/src/Path.ts`
- `node_modules/effect/src/process/ChildProcess.ts`
- `node_modules/effect/ai-docs/src/60_child-process/10_working-with-child-processes.ts`
