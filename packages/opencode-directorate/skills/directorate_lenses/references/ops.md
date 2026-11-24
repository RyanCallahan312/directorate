# ops

Contents: Where defects hide (Configuration · Deploy & migrations · Stored data & formats · Runtime behavior · Observability) · Investigate · Calibration · Not a finding · Evidence · By mode · Seams

Ask: can this be configured, deployed, observed, rolled back, and recovered in the environments the repository actually deploys to?

Scope: configuration, deployment order, migrations on real data, startup and shutdown, timeouts and failure handling between services, and the signals an on-call engineer needs. A deploy failure or an outage is a defect in every mode; operability improvements without a failure are full-mode quality items.

## Where defects hide

### Configuration

- A new required env var or config key with no default and no entry in the deploy manifests, CI configuration, or example configuration files.
- Defaults that are unsafe or wrong in production (debug on, a dev URL, a timeout of zero, a feature flag defaulting on).
- Config read at import time, so a missing value crashes every process rather than the feature; or config validated only on first use.
- Secrets passed through logs, command lines, or build arguments.

### Deploy and migrations

- Migrations that lock or rewrite large tables during deploy (non-concurrent index creation, column type changes, adding a required field with a backfill in one step).
- Order: code that needs the migration deployed first, or a migration that breaks the running version (see impact for compatibility).
- Irreversible migrations without a stated rollback path; backfills that run in one transaction over the whole table.
- Feature flags with no off path, or with code paths that assume the flag is on.

### Stored data and formats

- Schema changes in one step instead of expand, migrate, contract: add before use, backfill, and remove only after no running version reads it.
- A new required field on existing records, a default that hides missing data, or a constraint that existing rows violate.
- Backfills that are not batched, resumable, and idempotent, or that miss rows written while they run.
- Persisted and wire formats (serialized columns, cache entries, events, files) whose decoders reject versions still stored or queued; new fields required before every writer emits them.
- Identifiers: uniqueness under concurrent writes, case and Unicode normalization, reuse after deletion.
- Deletion and retention: cascades, soft deletes that some query ignores, retention jobs with the wrong scope.

### Runtime behavior

- Startup: readiness reported before dependencies are ready; health checks that pass while workers are dead.
- Shutdown: the termination signal (for example `SIGTERM`) not handled; in-flight requests or jobs dropped; cleanup handlers that never run; a grace period shorter than the drain.
- Outbound calls without timeouts, retries without backoff, or retry storms that amplify an outage; no circuit breaking where a dependency often fails.
- Resource limits: memory or file handles the container limits will hit.

### Observability

- A new failure path that logs nothing, returns 200, or exits 0, so the failure is invisible.
- Errors logged without the context needed to act (ids, cause), or logged at a level that alerts ignore.
- Metric or log field renames that break existing dashboards or alerts (`directorate_grep` the alert and dashboard definitions if they live in the repo).
- High-cardinality metric labels (user ids, URLs) that blow up the metrics backend.

## Investigate

1. Find how the repository deploys: container files, CI workflows, deploy manifests, infrastructure-as-code, and process definitions (for example Dockerfiles, Helm charts, Terraform, Procfiles).
2. `directorate_grep` every new config key and env var across them and the example env files.
3. Read migrations with the table sizes you can find (seeds, docs, retention), and the database's locking behavior for each statement.
4. Read startup, health check, and shutdown code for the changed processes.
5. For a new failure path, follow it to its log, metric, status, or exit code.

## Calibration

- **blocking:** a deploy crashes on startup in production because a new required variable is unset; a migration locks a core table past the deploy tolerance; shutdown drops acknowledged jobs on every deploy.
- **important:** a failed worker stays "ready" with no signal; an outbound call without a timeout can hang the service; a migration has no rollback and rollback is part of the documented process.
- **minor:** a runbook's dashboard link is stale while the fallback works; an error log missing a useful id.
- **not a finding:** observability boilerplate for local developer scripts.

## Not a finding

- "Add metrics", "add logging", or "add a runbook" without naming the incident it would shorten and checking the existing signals.
- Demanding tooling the repository does not use (Prometheus, OpenTelemetry, feature-flag services).
- Log-level preferences.
- Deploy concerns for environments the repository does not deploy to.

## Evidence this lens needs

The config key, migration step, or missing signal at `path:line`, the deploy or incident step where it fails, and the deployment files you checked.

## By mode

- **default and code-quality:** deploy failures, data-affecting migrations, invisible failures on critical paths, and missing timeouts that hang services, as defects.
- **full:** rollout and rollback plans, alerting and runbooks, capacity and cost, and observability for new paths, as quality items with a concrete benefit.

## Seams

- Version compatibility across a rollout is impact; lock duration is here.
- Resource exhaustion under load is performance; its missing signal is here.
