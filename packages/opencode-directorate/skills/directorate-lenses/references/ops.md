# ops

Ask: can this be configured, deployed, observed, rolled back, and recovered in the environments the repository actually deploys to?

Scope: configuration, deployment order, migrations on real data, startup and shutdown, timeouts and failure handling between services, and the signals an on-call engineer needs. A deploy failure or an outage is a defect in every mode; operability improvements without a failure are full-mode quality items.

## High-signal failure modes

- **Configuration:** new required env var/config key missing defaults and deploy/CI/example entries; unsafe production defaults (debug on, dev URL, zero timeout, flag defaulting on); import-time config crashes or secrets in logs/CLI/build args.
- **Deploy, migrations & stored data:** table-locking migrations (non-concurrent index, column rewrite, single-transaction backfill), breaking expand-migrate-contract rollout/rollback order, non-idempotent/unresumable backfills, decoders rejecting still-stored/queued versions, feature flags with no off path, soft-delete or retention scope bugs.
- **Runtime behavior:** readiness reported before dependencies are ready or while workers are dead; unhandled `SIGTERM` / dropped in-flight work / drain longer than grace period; outbound calls without timeouts or backoff/jitter; container memory/FD limits exceeded.
- **Observability:** new failure paths returning 200 / exit 0 with no log/signal, error logs missing actionable ids/cause, renamed metrics/log fields breaking in-repo alerts/dashboards, high-cardinality metric labels (user ids, URLs).

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
