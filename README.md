# Directorate

A Bun/Turborepo workspace for Effect 4, with no packages yet.

## Workspace development

Run `mise install` to install the pinned Bun and Node.js versions.

```sh
bun install --frozen-lockfile
bun run check       # lint, typecheck, and test the workspaces
bun run build       # build the workspaces
bun run dev         # start workspace development processes
bun run format      # apply formatting and safe lint fixes
```

Add workspace packages under `packages/`. TypeScript packages can extend `tsconfig.base.json`.

Install patches TypeScript for Effect diagnostics. The root Oxlint config enables the Effect-specific rules, and the [`effect-ts` agent skill](.agents/skills/effect-ts/SKILL.md) documents the installed API and conventions. Declare `effect` in each workspace package that uses it; the root dev dependency supports the skill's checks.
