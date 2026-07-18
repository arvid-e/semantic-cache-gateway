# Research & Design Decisions

## Summary
- **Feature**: `rate-limiting`
- **Discovery Scope**: Extension — a focused `rate-limiting` middleware module over `platform-foundation` (Redis) consuming the tenant identity from `auth-tenancy-credentials`; discovery focused on the atomic token-bucket mechanism and the standard rate-limit response headers.
- **Key Findings**:
  - A **token bucket implemented as a single atomic Redis Lua script** (refill from elapsed time, `min(capacity, tokens + elapsed·rate)`, decrement on admit) is the standard way to get burst + refill semantics with correct behavior under concurrency — the requirement's explicit model (Req 2.1, 2.2, 4.1, 4.2). ioredis `defineCommand` wraps the script as a reusable command (EVALSHA-cached), which is precisely why the foundation selected ioredis.
  - `@fastify/rate-limit` and similar libraries use a **fixed/sliding window counter**, not a refilling token bucket with a separate burst capacity — a semantic mismatch with Req 2.1/2.2. A small custom limiter gives the exact semantics and explicit atomic control.
  - The IETF "RateLimit header fields for HTTP" spec is **still an Internet-Draft** (v11, 2026) and is moving toward a combined `RateLimit` structured field plus `RateLimit-Policy`; the discrete `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` form remains the broadly-deployed, interoperable choice. `Retry-After` takes precedence over `RateLimit` reset info when both are present.
  - This module needs **no PostgreSQL and no migration**: state is entirely in Redis (`ratelimit:{tenantId}`), preserving the two-datastore rule and adding nothing to the DB schema.

## Research Log

### Atomic token bucket in Redis
- **Context**: Req 4.1/4.2 require atomic enforcement so concurrent requests cannot exceed capacity; Req 2.1/2.2 require a burst capacity plus time-based refill.
- **Sources Consulted**: Redis token-bucket rate-limiter docs; ioredis `defineCommand` guidance (see References).
- **Findings**: The check-refill-decrement sequence must run in one server-side step. A Lua script reads the stored token count and last-refill timestamp, adds `elapsed · refillPerSec` capped at `capacity`, admits and decrements if ≥ 1 token, persists the new `(tokens, timestamp)`, and sets a TTL so idle tenants expire. EVAL caches the script server-side; subsequent calls use EVALSHA. ioredis `defineCommand` handles the SHA management.
- **Implications**: Implement one Lua script invoked per request via a `defineCommand`-registered command. Store per-tenant state in a Redis hash `ratelimit:{tenantId}` with fields `tokens`, `ts`; TTL ≈ `ceil(capacity / refillPerSec)` refreshed each call.

### Standard rate-limit response headers
- **Context**: Req 3.2/3.3 require `Retry-After` and standard headers communicating limit and remaining.
- **Sources Consulted**: IETF `draft-ietf-httpapi-ratelimit-headers` (v11); HTTP header references.
- **Findings**: The draft has not yet been published as an RFC and is converging on a structured `RateLimit` field + `RateLimit-Policy`. The discrete `RateLimit-Limit`/`RateLimit-Remaining`/`RateLimit-Reset` triple is still the most widely understood by clients and tooling. `Retry-After` (delay-seconds) is the interoperable back-off signal and takes precedence.
- **Implications**: Emit `RateLimit-Limit` (capacity), `RateLimit-Remaining` (floored tokens), and `RateLimit-Reset` (seconds to full) on every gateway response (admit or reject), plus `Retry-After` (seconds until one token is available) on a 429. Document the structured-field form as a forward-compatible option.

### Integration with the request pipeline
- **Context**: Steering pipeline order is auth → rate limit → cache → provider; Req 1.1 requires accounting before provider-calling logic and Req 1.5 excludes health endpoints.
- **Sources Consulted**: `platform-foundation/design.md`, `auth-tenancy-credentials/design.md`, `gateway-provider-routing/design.md` (this repo).
- **Findings**: Auth exposes tenant identity in `RequestContext.tenantId` and applies its `authenticate` middleware to gateway routes; the gateway completion route runs a preHandler chain. The foundation's health endpoints are unauthenticated and outside the gateway route scope.
- **Implications**: Expose a `rateLimit` preHandler applied to the gateway routes **after** `authenticate`, mirroring how auth's middleware is consumed. Because it is scoped to gateway routes and runs post-auth, it naturally never throttles liveness/readiness (Req 1.5) and always has a tenant identity (Req 1.1).

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Custom token bucket via atomic Lua + Fastify middleware | Own Lua script, ioredis `defineCommand`, exported preHandler | Exact burst+refill semantics; explicit atomicity; per-tenant overrides | Must write/maintain a small Lua script | **Selected** |
| `@fastify/rate-limit` with Redis store | Adopt the plugin, key by tenant | Battle-tested; headers built-in | Window counter, not token bucket; burst/refill semantics don't match Req 2.1/2.2 | Rejected — semantic mismatch |
| In-memory per-process limiter | Local counters | Simplest | Not correct across processes; loses state on restart | Rejected — not shared/atomic |

## Design Decisions

### Decision: Build a token-bucket limiter on an atomic Lua script
- **Context**: Req 2.1, 2.2, 4.1, 4.2.
- **Alternatives Considered**: 1) `@fastify/rate-limit` (window); 2) multi-command Redis (non-atomic); 3) custom atomic Lua token bucket.
- **Selected Approach**: One Lua script per request performing refill + conditional decrement; registered via ioredis `defineCommand`; per-tenant Redis hash with TTL.
- **Rationale**: Matches the required burst-capacity + refill model and guarantees atomic enforcement in a single round-trip.
- **Trade-offs**: A small amount of Lua to own and test; justified by correctness and exact semantics.

### Decision: Config-based default + per-tenant overrides
- **Context**: Req 2.3, 2.4.
- **Selected Approach**: A gateway/rate-limit config segment provides `defaultCapacity`, `defaultRefillPerSec`, and an `overrides` map keyed by tenant id (from env JSON); a resolver returns the override when present, else the default.
- **Rationale**: Simple, in-scope, and requires no datastore; matches "configurable with per-tenant overrides."
- **Trade-offs**: Overrides change requires a config update/restart; acceptable for the interview scope (dynamic override management is not in scope).

### Decision: Exported `rateLimit` preHandler applied after auth on gateway routes
- **Context**: Req 1.1, 1.5; steering pipeline order.
- **Selected Approach**: Mirror auth's middleware pattern — the module exports a preHandler that the gateway routes apply after `authenticate`; it is never registered on health endpoints.
- **Rationale**: Keeps modules decoupled, guarantees post-auth tenant identity, and excludes health by scope.
- **Trade-offs**: The gateway route composes an ordered preHandler list (documented integration touchpoint).

## Risks & Mitigations
- **Non-atomic race admitting over capacity** — Mitigation: single Lua script for refill+decrement (Req 4.1, 4.2); concurrency test asserts no over-admission.
- **Clock/timestamp source drift** — Mitigation: use Redis server time (`TIME`) inside the Lua script rather than app clocks, so refill math is consistent across app instances.
- **Idle-tenant key growth** — Mitigation: TTL on each bucket key, refreshed per call.
- **Header/consumer confusion from the evolving IETF draft** — Mitigation: emit the broadly-interoperable discrete headers + `Retry-After`; document the structured-field option.
- **Throttling health checks** — Mitigation: middleware scoped to gateway routes only (Req 1.5).

## References
- [Redis token bucket rate limiter](https://redis.io/docs/latest/develop/use-cases/rate-limiter/) — algorithm and Lua atomicity.
- [Redis rate limiting algorithms comparison](https://redis.io/tutorials/howtos/ratelimiting/) — token bucket vs window trade-offs.
- [IETF RateLimit header fields draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/) — header naming and `Retry-After` precedence.
