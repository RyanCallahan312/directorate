# impact

Contents: Where defects hide (Names & references · Contracts · Versions running together · Supporting artifacts) · Investigate · Calibration · Not a finding · Evidence · By mode · Seams

Ask: which consumers, contracts, stored data, or deploys break or drift because of this change?

Scope: everything outside the changed lines that depends on their names, shapes, defaults, or behavior: callers, clients, persisted data, messages, configuration, scripts, and the deploy itself. The evidence is always a consumer.

## Where defects hide

### Names and references

- Renamed or deleted symbols still referenced by dynamic lookup that the type checker cannot see: string-keyed registries, dependency injection keys, reflection, imports by computed path, route tables, plugin manifests.
- The public surface of a module or package: exported symbols, re-exports, package entry points, and the types consumers import.
- Config keys, env var names, feature flags, CLI flags, route paths, event and topic names, queue names, metric names, error codes, log fields that alerts match.
- Scripts, CI workflows, Makefiles, Dockerfiles, and deploy manifests that name files, commands, or flags.

### Contracts

- Arguments, defaults, return types, error types, and units that changed meaning for existing callers.
- Response and request bodies: removed or renamed fields, newly required fields, changed enums, changed status codes, changed pagination.
- Serialized values that outlive the process: JSON in the database, cache entries, cookies, tokens, type discriminators or enum strings, event payloads, files.
- CLI output that scripts parse (format, ordering, stdout versus stderr) and exit codes.

### Versions running together

- Rolling deploy: old instances and new instances serve at once. Old producer with new consumer, and new producer with old consumer.
- Migrations: code that needs the new column before the migration runs, or a migration that removes what old code still reads. Expand, migrate, contract.
- Queued work: messages or jobs enqueued by the old version, decoded by the new one.
- Rollback: whether the previous version still runs against data the new version wrote.
- Clients you do not deploy: mobile apps, SDKs, browser tabs left open, third-party integrations, webhooks consumers.

### Supporting artifacts

- Generated clients and OpenAPI or GraphQL schemas, fixtures and snapshots, examples, and docs a workflow depends on.

## Investigate

1. List what changed in the contract: compare the signature, schema, or output with `directorate_read` `side: "old"`.
2. `directorate_grep` every changed name across the whole repository (source, tests, scripts, CI, config, docs, migrations), not only the diff. Search the exact string forms too: quoted keys, discriminator values, route paths, env names.
3. Confirm each hit with `directorate_read`; classify it as updated, broken, or not a real use.
4. For persisted or wire formats, find who writes and who reads, and check both directions of the version matrix.
5. For external consumers, find the evidence that a contract is public: published package, documented API, versioned route, webhook docs.
6. Check whether CI compiles or type checks the consumer; a broken typed import in checked code is caught there (§5 of the skill), a dynamic one is not.

## Calibration

- **blocking:** a renamed persisted field makes existing rows unreadable; old and new versions cannot both handle orders during a rolling deploy; a removed env var crashes startup in production.
- **important:** a public SDK or documented API changes shape without a version; a CI or release script calls a removed flag; queued jobs from the old version fail after deploy.
- **minor:** an optional CLI completion or a secondary example goes stale.
- **not a finding:** a private rename with every caller updated.

## Not a finding

- A "breaking change" to code that is neither exported nor published and whose every caller was updated.
- Hypothetical downstream consumers with no evidence a public contract exists.
- A coordinated removal where the rollout order or deprecation is documented in the change.
- A typed caller that CI would fail to compile (mention under limits).

## Evidence this lens needs

The consumer at `path:line` (or the external contract with its URL or publication), the old and new forms, and how the consumer fails.

## By mode

- **code-quality:** duplicated contracts (two schemas for one payload), leaked internals, an unnecessarily public API, scattered configuration.
- **full:** missing deprecation path, changelog or migration notes for a public break.

## Seams

- A migration's lock time or rollback plan is ops; its compatibility is here.
- A stale doc that only misleads is docs; one that breaks a scripted workflow is here.
