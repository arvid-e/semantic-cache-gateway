# Brief: rate-limiting

## Problem
The gateway's own infrastructure must be protected from abuse and runaway traffic. Because
callers are authenticated per tenant, limits must be enforced per tenant — independent of the
customer's own provider-side token/cost limits (which they own via their key).

## Current State
`platform-foundation` (Redis client) and `auth-tenancy-credentials` (tenant identity in the
request context) exist. No request throttling is enforced.

## Desired Outcome
Each tenant's gateway usage is bounded by a configurable Redis-backed token-bucket limit.
Requests over the limit are rejected with a clear `429` (and standard rate-limit headers),
while within-limit requests pass through. Limits are per tenant and protect gateway
infrastructure, not provider spend.

## Approach
A Redis-backed token-bucket implementation (atomic via a Lua script or equivalent) keyed by
tenant. Fastify middleware consumes a token per request, refills at a configured rate, and
returns `429` with `Retry-After` / rate-limit headers when the bucket is empty. Limits are
configurable (default + per-tenant overrides).

## Scope
- **In**: Redis token-bucket algorithm; per-tenant keying; configurable capacity/refill with
  per-tenant overrides; Fastify middleware wired to gateway routes; `429` + rate-limit headers;
  tests including concurrency/atomicity.
- **Out**: authentication/tenant modeling (auth-tenancy-credentials); provider-side token/cost
  limits (customer's concern); circuit breaking (resilience-failover); global/IP-based limits.

## Boundary Candidates
- Token-bucket core (Redis + atomic script)
- Rate-limit middleware + response headers
- Configuration & per-tenant overrides

## Out of Boundary
- Provider failure tracking / cooldown (resilience-failover owns circuit breaking)
- Authentication (relies on tenant identity already in context)

## Upstream / Downstream
- **Upstream**: platform-foundation, auth-tenancy-credentials.
- **Downstream**: applies to gateway-provider-routing endpoints; telemetry may record throttle events.

## Existing Spec Touchpoints
- **Extends**: auth-tenancy-credentials (consumes tenant identity from the shared request context).
- **Adjacent**: resilience-failover is a separate reliability concern — do not conflate rate
  limiting (infra protection) with circuit breaking (provider health).

## Constraints
- Redis-backed token bucket; must be atomic under concurrency.
- Per-tenant enforcement; protects gateway infrastructure only.
