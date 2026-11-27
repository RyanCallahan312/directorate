# Vendored anti-slop

- Source: https://github.com/K-Mistele/anti-slop
- Revision: `13b020367525e8c6efe6cede8f387697b2a8d907`
- Copied: the generic and Effect Oxlint plugins, their shared code, tests,
  mode wrapper, Stylistic vendor files, and root `LICENSE`. Other rule packs
  and standalone upstream tools are not vendored.
- Local changes: the CLI smoke test invokes Oxlint through Bun instead of pnpm.
  The mode wrapper test covers only the vendored plugins.
- Retained from `dmmulroy/anti-slop@13909c9`: `no-conditional-empty-object-spread`,
  `require-readable-spacing`, their tests, and the Stylistic padding rule with
  custom statement matchers. This keeps the existing narrower spread policy and
  allows consecutive single-line bindings to stay grouped.
- Local addition: `effect/rules/throw-new-error.ts` replaces Oxlint's native
  `unicorn/throw-new-error` (disabled in the root config), which exempts only
  `Data.TaggedError` and so reports `Schema.TaggedError<E>()` and `Schema.Error<E>()`.
- License: MIT. Additional third-party notices are in `vendor/`.

The root Oxlint config keeps its existing rule selections. New upstream rules,
including the broader `no-conditional-spread`, are available but not enabled.

Run the vendored tests from the repo root with `node --test 'tools/oxlint/anti-slop/**/*.test.ts'`.

Keep `oxlint` and `@oxlint/plugins` pinned to the same exact version when
upgrading. Review upstream changes against this revision before updating the
vendored source; preserve any future local customizations.
