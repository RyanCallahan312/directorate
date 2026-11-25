# quality (code-quality and full only)

Ask: is there a simpler, more local design that keeps exactly the same behavior, and is it worth the change?

Scope: implementation quality of the changed code: reuse of existing primitives, removal of unneeded machinery, cohesion, coupling, and clarity. Every item is kind `quality`, needs a concrete benefit and its tradeoff, and is at most important (usually minor). In default mode this lens records nothing; a defect found here is recorded as a defect under its proper lens.

## Where improvements hide

### Delete

- Dead code: unreachable branches, unused exports or options, parameters every caller passes the same value for.
- Speculative machinery: extension points, flags, generic parameters, or layers with one implementation and no stated need.
- Defensive code for states the types or schemas exclude.
- Avoidable dependencies for a few lines the platform or an installed library already provides.

### Reuse

- A helper, service, or component already in the repository that does this (`directorate_grep` for the operation's verbs and nouns, not only the new name).
- A language, standard-library, or framework facility the project already uses: URL and path handling, cancellation and timeouts, retry and backoff utilities, schema validators, connection pools, caches, streams, and schedulers, instead of hand-rolled loops, parsers, pools, caches, and timers.
- Verify the replacement satisfies the whole contract: error semantics, cancellation, ordering, portability, and the installed version.

### Localize

- A rule or invariant duplicated across files that must change together; name the second copy.
- A change that forces edits in unrelated modules; responsibilities in the wrong module; dependency direction pointing from core to edge.
- Functions mixing I/O, parsing, and policy so the policy cannot be tested alone.

### Clarify

- Names that mislead about behavior: `validate` that persists, `get` that mutates, `isX` that throws.
- Control flow that hides the main path; flags that change a function's meaning; boolean parameters at call sites that read as magic.
- Comments that contradict the code.

## Investigate

1. State the behavior the code must keep, including errors and edge cases.
2. Search for the existing primitive: `directorate_grep` the repository; read the dependency manifest and locate installed library files with `directorate_ls` before reading their API with `directorate_read`.
3. Sketch the simpler version and check it against every caller and test.
4. Count the concrete benefit: lines or branches removed, a dependency dropped, a bug class excluded, an edit made local. Name the tradeoff.

## Calibration

- **important:** duplicated policy that has already diverged or must change in lockstep across live code paths; hand-rolled machinery that a project primitive replaces and that already carries a known bug class.
- **minor:** removing dead code or a speculative option; replacing a helper with a verified native facility; a misleading name.
- **never blocking:** quality alone does not block a merge. If the design causes a defect, record the defect under its lens.
- **not a finding:** formatting, naming taste, or splitting a function for its length.

## Not a finding

- Style, formatting, import order, naming preferences.
- "Extract a helper" for two similar sites that do not need to change together.
- A reuse suggestion where the existing helper does not satisfy the contract.
- Abstractions or wrappers that add lines and indirection to save none.
- Limits documented with a `shortcut:` comment that current use does not exceed.
- "Fewer lines" that loses behavior, errors, or clarity.

## Evidence this lens needs

The existing primitive or second copy at `path:line` (or in the installed version), the benefit in concrete terms, and the tradeoff.

## By mode

- **code-quality:** everything above, for the changed code.
- **full:** the same bar across the reviewed scope, plus consistency with the repository's established patterns.

## Seams

- A misplaced responsibility that spans modules or entry points is architecture.
- Machinery that wastes resources at real workload is performance.
