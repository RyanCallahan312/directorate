# security

Ask: what can an actor reach, read, change, or exhaust across a trust boundary?

Scope: authentication, authorization, isolation, untrusted input reaching a sink, sensitive data, cryptography, and abuse. Start every claim by naming the actor.

## Actors

A finding needs an actor less trusted than the authority it reaches (anonymous user, authenticated user targeting another's resource/tenant, lower-privilege role, third-party webhook/redirect/URL, or content author whose text reaches a parser/model). An admin reaching admin data, or a local operator running their own CLI, is not a boundary crossing.

## High-signal failure modes

- **Authentication:** JWT `decode` instead of `verify`, unpinned alg/aud/iss/exp, unrotated sessions or ignored revocation, OAuth missing `state`/PKCE or redirect allowlist, reusable reset tokens, webhooks verified on re-serialized body or without replay window, non-constant-time secret comparison.
- **Authorization & isolation:** check present on main route but missing on siblings (batch, export, bulk, search, GraphQL field, admin, webhook, job, RPC); tenant/owner taken from request input instead of verified identity (IDOR); missing tenant filter or RLS bypassed by privileged role; middleware ordering/unprotected router; cache keys or singletons capturing one request's identity; system-authority background jobs not re-checking access.
- **Untrusted input to a sink:** trace source → sink and verify sink-appropriate escaping/allowlisting for SQL/queries, shell/process args (including leading `-`), raw HTML/`javascript:` URLs, path traversal/zip slip/symlinks, SSRF/redirects/DNS rebinding, unsafe deserialization/prototype pollution, ReDoS.
- **Prompts, skills & agent tools:** Lethal Trifecta (private data + untrusted text/files/tool output + external network or privileged writes without per-action human approval); third-party `SKILL.md`/`.mcp.json`/hooks with hidden Unicode or prompt injection, overly broad `allowed-tools`, pre-execution shell commands, or side-effecting skills missing manual-only gating (`disable-model-invocation: true` / `metadata.opencode/autoinvoke: false` / `allow_implicit_invocation: false`).
- **Sensitive data & crypto:** secrets/tokens/PII in logs, error causes, URLs, client bundles, or shared caches; over-broad response serializers; committed/defaulted secrets (cite location, never reproduce the secret value); non-CSPRNG tokens, fast password hashes, nonce/IV reuse, missing integrity on ciphertext.
- **Abuse & unsafe defaults:** attacker-controlled unbounded work (page/file sizes, fan-out, decompression), unthrottled auth/reset enumeration (verify gateway/proxy config first), debug/admin routes or permissive CORS with credentials enabled by default.

## Investigate

1. Name the actor and the authority they should not have.
2. Find the route or entry registration and the middleware chain that wraps it; read the order.
3. `directorate_grep` sibling entry points that reach the same service or query, and check each for the same guard.
4. Trace the identity: where it is verified, and where the tenant or owner used by the query comes from.
5. For input to a sink, follow the value from its source through every transformation to the sink; confirm the escaping or validation is right for that sink, not just present.
6. Read gateway, proxy, and framework configuration before claiming a missing limit or header.
7. For a dependency vulnerability, show that the affected function is called with attacker-controlled input.

## Calibration

- **blocking:** reading or writing another tenant's records; an unauthenticated route reaching data or actions; any path that accepts an unverified identity or another user's; SQL or shell injection from request input; secrets in responses or production logs; an unverified webhook that moves money.
- **important:** a lower role sees fields reserved for a higher one; a check that depends on a client-side value but needs an uncommon state; personal data newly written to logs; an SSRF limited to a non-sensitive internal service.
- **minor:** low-sensitivity internal ids in logs; a defense-in-depth gap where the primary control is verified (full mode only).
- **not a finding:** no less-trusted actor reaches the sink.

## Not a finding

- A missing rate limit, CSRF token, or security header with no reachable abuse path, or one already enforced by the gateway, proxy, or framework (cite it).
- "Injection" through a parameterized query or an escaping template.
- Placeholder or test-fixture secrets; example values in example configuration files.
- A CVE in a dependency whose affected API is never called with untrusted input.
- Non-cryptographic randomness for values that are not secrets.
- An actor who already holds the authority: an admin, the local CLI user, the operator.
- XSS on a response that is never rendered as HTML.

## Evidence this lens needs

The actor, what they control, the path from their input to the sink or resource, and the guard you looked for and did not find, or found bypassed. Never write exploit payloads beyond the minimal input that shows the trigger.

## By mode

- **code-quality:** validation duplicated across entry points; implicit actor context; APIs where unsafe use is easier than safe use.
- **full:** threat-model gaps, dependency lifecycle, and defense in depth with a concrete benefit (never claimed as an exploitable vulnerability).

## Seams

- A scoping bug found through caching or jobs is still security.
- A missing check that is also a missing test: one defect entry; its fix includes the test.
- Abuse that depends on workload sizing belongs with performance evidence.
