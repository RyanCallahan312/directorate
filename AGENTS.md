# Directorate

Use the [`effect-ts` skill](.agents/skills/effect-ts/SKILL.md) when writing or reviewing Effect code. Prefer the installed Effect source and documentation over upstream examples when APIs differ.

Run `bun install --frozen-lockfile` to install dependencies and patch TypeScript for Effect diagnostics.

From the repository root, use `bun run` for project scripts and installed tools. Do not use `bun x` or hardcode `node_modules/.bin` paths for tools already installed by the project.

- `bun run check` runs lint, formatting checks, type checking, and tests.
- `bun run lint` runs lint and formatting checks without type checking or tests.
- `bun run oxlint <path>` runs only Oxlint on the specified files or directories.
- `bun run oxfmt <path>` formats the specified files or directories in place.
