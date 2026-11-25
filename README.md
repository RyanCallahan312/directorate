# Directorate

The Directorate is an evidence-gated code review plugin for OpenCode. See the [`@rc312/opencode-directorate` package](packages/opencode-directorate/README.md) for installation and usage.

## Workspace development

Install Git and run `mise install` to install the pinned Bun and Node.js versions. The same commands run on macOS, Linux, and Windows.

```sh
bun install --frozen-lockfile
bun run check       # lint, format check, build, typecheck, and test the workspaces
bun run build       # build the workspaces
bun run dev         # start workspace development processes
bun run format      # apply formatting and safe lint fixes
```

## Dogfood in OpenCode

After `bun run build`, launch `opencode` from the workspace root. The project config loads the local plugin, which registers its bundled agents and skill. Try: “Use The Directorate to review my local changes in default mode with one model.” Use `/directorate-configure` to change settings for this project.

Add workspace packages under `packages/`. TypeScript packages can extend `tsconfig.base.json`.

Install patches TypeScript for Effect diagnostics. The root Oxlint config enables the Effect-specific rules, and the [`effect-ts` agent skill](.agents/skills/effect-ts/SKILL.md) documents the installed API and conventions. Declare `effect` in each workspace package that uses it; the root dev dependency supports the skill's checks.

## Publish to npm

From the workspace root, install dependencies and pack the plugin. The plugin's `prepack` script builds the Desktop bundle automatically:

```sh
bun install --frozen-lockfile
npm pack --workspace @rc312/opencode-directorate
```

Install the resulting `.tgz` in a scratch environment and verify it loads in OpenCode. With an npm account authorized to publish the package, publish that same artifact:

```sh
npm publish ./rc312-opencode-directorate-0.1.1.tgz --access public
```

Bump the plugin's version in `packages/opencode-directorate/package.json` before each subsequent release and use the matching tarball name.
