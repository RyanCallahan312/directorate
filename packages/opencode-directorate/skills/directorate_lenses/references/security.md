# security

Contents: Actors · Where defects hide (Authentication · Authorization & isolation · Untrusted input to a sink · Sensitive data · Cryptography · Abuse) · Investigate · Calibration · Not a finding · Evidence · By mode · Seams

Ask: what can an actor reach, read, change, or exhaust across a trust boundary?

Scope: authentication, authorization, isolation, untrusted input reaching a sink, sensitive data, cryptography, and abuse. Start every claim by naming the actor.

## Actors

| Actor | Usually controls |
| --- | --- |
| Anonymous internet user | request path, query, headers, body, uploads, timing |
| Authenticated user | the above, plus ids of their own and others' resources |
| User of another tenant | the same, against your tenant's ids |
| Lower-privilege role (viewer, staff) | admin-only routes and fields |
| Third party (webhook sender, OAuth provider, fetched URL) | payloads, redirects, response bodies |
| Content author (README, issue, document fed to a tool or model) | text that later reaches an interpreter or an agent |
| Local CLI user or operator | arguments, environment, config files; usually already trusted |

A finding needs an actor that is less trusted than the authority it reaches. An admin reaching admin data, or a local user running their own CLI, is not a boundary crossing.

## Where defects hide

### Authentication

- Tokens decoded but not verified (for example, a JWT library's decode used where verify was needed), signature algorithm not pinned, missing audience, issuer, expiry, or not-before checks; clock-skew allowances unbounded, or time taken from the client instead of the server.
- Sessions not rotated at login or privilege change; logout or revocation not enforced on long-lived tokens or caches; refresh tokens reusable where the provider expects single use.
- Delegated login (for example OAuth or OIDC): the protocol's anti-forgery and code-binding checks (`state`, PKCE) missing; redirect URIs not taken from an allowlist; only the access token validated, not the id token.
- Password and reset flows: reset tokens that are reusable, never expire, or are not bound to the account; account enumeration through different responses or timing.
- Webhooks without signature verification, or verified over a re-serialized body instead of the raw bytes; no replay window.
- Timing-unsafe comparison of secrets or signatures.

### Authorization and isolation

- A check present on the main route and missing on a sibling: batch, export, bulk, search, GraphQL field, admin, webhook, background job, or RPC.
- The tenant or owner taken from the request body or path instead of the verified identity (IDOR).
- Queries without a tenant filter, or row-level security bypassed by a privileged connection or role.
- Middleware order: authorization placed after the handler, or skipped for a route registered outside the protected router.
- Authenticated mistaken for authorized; a role check that allows by default.
- Cache keys, memoized services, or application-wide singletons that capture the identity of the first request and serve it to later ones.
- Background jobs that run with system authority on behalf of a user without re-checking access.

### Untrusted input to a sink

Trace source to sink and check the escaping right for that sink:

| Sink | Look for |
| --- | --- |
| Queries (SQL and other query languages) | string interpolation or concatenation, raw-query escape hatches, identifiers or sort fields from input |
| Shell and processes | commands built as strings and run through a shell (`sh -c`, `shell=True`), arguments that start with `-` |
| HTML and templates | raw-HTML escape hatches that bypass the framework's escaping (for example `innerHTML` or a template's "safe" filter), user-supplied URLs in links (`javascript:` URLs) |
| Paths | joining or resolving paths with input, archive extraction (zip slip), symlinks |
| Outbound requests | fetching a user-supplied URL: SSRF to metadata or internal hosts, redirects, DNS rebinding |
| Redirects | redirecting to an input URL without an allowlist |
| Deserialization and merging | loaders that can instantiate arbitrary types from input (for example Python's pickle, unsafe YAML loading, Java object deserialization); deep merges of parsed input into objects (prototype pollution in JavaScript) |
| Regular expressions | user-supplied patterns, or catastrophic backtracking on user input |
| Prompts, skills, and agent tools | Lethal Trifecta (private data + untrusted text/files/tool output + external network or privileged writes without human approval); third-party `SKILL.md`/`.mcp.json`/hooks with hidden Unicode or natural-language prompt injection, overly broad `allowed-tools`, pre-execution shell commands, or side-effecting skills missing manual-only gating (`disable-model-invocation: true` / `allow_implicit_invocation: false`) |

### Sensitive data

- Secrets, tokens, or personal data in logs, error messages and causes, URLs, analytics, client bundles, or caches shared across users.
- Responses or serializers that return more fields than the caller may see.
- Secrets committed, defaulted in code, or readable by a broader role.
- Never reproduce a secret value in an entry; cite its location.

### Cryptography

- Non-cryptographic random generators or predictable ids for tokens, reset links, or invites.
- Fast hashes for passwords; missing salt; homemade encryption or signing.
- Nonce or IV reuse; keys in code; missing integrity on encrypted data.

### Abuse

- Attacker-controlled expensive work: unbounded page sizes, file sizes, regexes, fan-out, or decompression, on a route the attacker can reach.
- Missing limits on enumeration, signup, or reset flows that the deployment does not already limit (check gateway and proxy configuration).
- Unsafe production defaults: debug endpoints, permissive CORS with credentials, open admin routes.

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
