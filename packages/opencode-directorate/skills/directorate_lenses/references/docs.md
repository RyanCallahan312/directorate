# docs

Ask: after this change, are documented contracts, commands, examples, and setup steps still true?

Scope: README files, API references (for example OpenAPI or GraphQL descriptions), CLI help text, env and config tables, examples, runbooks, changelogs and migration notes, and comments that state a contract. A doc that now makes a user's workflow fail is a defect in every mode; completeness and polish are full-mode quality items.

## Where defects hide

- Commands, flags, and scripts in docs that the change renamed, removed, or changed the meaning of; package or make scripts that no longer exist.
- Examples whose code no longer compiles or runs against the changed API.
- Env var and config tables that miss a new required key or show a wrong default.
- API references and response examples that contradict the changed schema, status codes, or errors.
- CLI help and usage text that disagree with the argument parser.
- Setup and install steps that skip a new prerequisite (a migration, a service, a version bump).
- Runbooks whose recovery steps no longer work, or now destroy data.
- Comments and docstrings that state a contract the code no longer honors.
- A breaking change to a public contract with no changelog or migration note, where the repository keeps one.

## Investigate

1. List what changed that users see: names, flags, defaults, routes, errors, setup.
2. `directorate_grep` each across documentation files, API description and schema files, help strings, examples, and comments.
3. Read each hit and compare it with the changed code at `path:line`.
4. For commands, follow them to the script, parser, or entry point they run.

## Calibration

- **blocking:** a documented recovery or setup step now deletes or corrupts the only copy of data.
- **important:** following the README or API reference now fails (a removed command, a required env var not documented, a wrong request shape for a public API).
- **minor:** an optional example uses a stale flag; an internal comment states an outdated contract.
- **not a finding:** typos and wording; missing docs for internal code.

## Not a finding

- Grammar, tone, and wording preferences.
- "Add docstrings" or comments for readable code.
- Docs for behavior the change did not touch.
- Claims that are wrong only for versions the project no longer supports.

## Evidence this lens needs

The doc line at `path:line`, the code it now contradicts at `path:line`, and what a reader who follows the doc experiences.

## By mode

- **default and code-quality:** docs that make a documented workflow fail.
- **full:** completeness (new features undocumented, missing migration notes, missing examples for new public APIs), as quality items.

## Seams

- A changed CLI output that scripts parse is impact; its help text is here.
- A runbook step that fails during an incident is also ops; record it once.
