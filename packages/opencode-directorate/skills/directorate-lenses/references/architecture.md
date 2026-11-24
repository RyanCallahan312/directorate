# architecture

Ask: does each responsibility sit at the boundary that owns it, and does the whole solution fit the goal, or do local fixes hide a shared cause?

Scope: ownership of data, state, policy, and lifecycles across modules, services, and entry points. The lead owns the overall approach (the report's Approach line); this lens answers Auditor-sized structural questions. It runs in `full`, and in `code-quality` when the change is structural: it moves ownership, changes dependency direction, adds a public boundary, or adds a lifecycle (a worker, a cache, a connection, a scope). A structural flaw that already causes wrong behavior is a defect in any mode.

## Where defects hide

### Ownership and policy

- The same rule enforced in two entry points instead of at the domain boundary both reach; one entry point that skips it.
- A fix applied at one caller for a bug in the callee, leaving other callers exposed.
- Two writers for one piece of state with no single authority, so they can disagree.
- Transport or persistence types (HTTP requests, ORM rows) leaking into domain logic, so policy cannot be reused or tested alone.

### Dependencies and composition

- Dependency direction from core to edge: domain code importing adapters, frameworks, or the UI.
- Import cycles between modules.
- Services or dependency containers assembled in many places instead of one composition root; shared services built per request; request context captured by an application-wide service.

### Lifecycles

- Background workers, intervals, subscriptions, connections, or tasks with no owner that starts, supervises, and stops them.
- Shutdown that does not drain in-flight work or release resources.
- Caches with no owner for invalidation.

### Fit to the goal

- Several symptoms in the change with one root cause the change does not address.
- A mechanism that duplicates an existing one in the system.
- A choice that is expensive to reverse (a data format, a public API, a vendor) made without need.

## Investigate

1. Trace the flow end to end: entry point, domain logic, storage, side effects. Note who decides each rule and who owns each piece of state.
2. `directorate_grep` for the rule's other enforcement points and for every writer of the state.
3. Read imports and dependency wiring around the changed modules to see dependency direction and where services are built.
4. Identify the concrete failure or cost: an inconsistency between entry points, a change that would need edits in many places, a leak at shutdown.

## Calibration

- **blocking:** an application-wide service retains one request's identity and serves it to others (record under security); two live writers corrupt the authoritative state.
- **important:** policy enforced in some entry points but not others, already inconsistent; a lifecycle with no owner that leaks on every deploy.
- **minor:** an avoidable dependency direction that forces concrete edits in unrelated packages.
- **not a finding:** folder layout or pattern preferences with no failure or cost.

## Not a finding

- Pattern dogma ("use clean architecture", "use CQRS", "add a repository layer") without a failure or a concrete cost in this repository.
- Rewrite proposals where a local fix resolves the issue.
- Speculative future needs.

## Evidence this lens needs

The boundary at fault, the sites that show it (one is enough when it explains the issue), and the concrete failure or cost it causes.

## By mode

- **code-quality (structural changes):** ownership, dependency direction, and lifecycle issues with a concrete cost.
- **full:** the same across the reviewed scope, plus consistency of policy across all entry points.

## Seams

- An inconsistent check that grants access is security; one that corrupts data is correctness. Record the defect there, and the ownership fix as its `fix`.
- Local simplifications within one module are quality.
