# Brief: resilience-failover

## Problem
Upstream providers fail or time out. Without protection, those failures surface directly to the
client and repeated calls to an unhealthy provider waste latency and the customer's quota. The
gateway needs automatic failover to a secondary provider and a way to stop hammering a provider
that is clearly down for a given tenant.

## Current State
`gateway-provider-routing` can call any single provider with the tenant's key via the
`ProviderAdapter` interface. `auth-tenancy-credentials` lets a tenant attach more than one
provider key. No retries or failure tracking exist.

## Desired Outcome
If the primary provider errors or times out, the gateway automatically retries against a
pre-configured secondary provider using that tenant's key for the secondary. Failures are
tracked per provider, per tenant; after `N` failures within a time window the circuit breaker
trips and that tenant's traffic stops routing to the provider for a cooldown period, then
recovers.

## Approach
Wrap provider calls (via the `ProviderAdapter` interface) with a retry policy that falls back to
a configured secondary provider on error/timeout, resolving the secondary's key from
`auth-tenancy-credentials`. A per-`(tenant, provider)` circuit breaker (state in Redis) counts
failures in a rolling window; on threshold it opens for a cooldown, then transitions to
half-open to probe recovery. Breaker state and failover decisions are written to the shared
request context for telemetry.

## Scope
- **In**: retry/fallback to a pre-configured secondary provider (using the tenant's secondary
  key); per-provider/per-tenant circuit breaker with failure window, threshold, cooldown, and
  half-open recovery; configurable policy; surfacing failover/breaker state to the request context.
- **Out**: dynamic weighted routing on cost/latency (stretch); rate limiting (rate-limiting);
  the provider adapters themselves (gateway-provider-routing); telemetry dashboards (telemetry-analytics).

## Boundary Candidates
- Retry / secondary-provider fallback policy
- Circuit breaker state machine (per tenant, per provider)
- Failure tracking store (Redis) & configuration
- Integration around provider calls

## Out of Boundary
- Selecting the primary provider or normalizing responses (gateway-provider-routing)
- Choosing providers by live cost/latency (dynamic-weighted-routing stretch)

## Upstream / Downstream
- **Upstream**: platform-foundation, gateway-provider-routing, auth-tenancy-credentials.
- **Downstream**: telemetry-analytics records failover events and breaker state.

## Existing Spec Touchpoints
- **Extends**: gateway-provider-routing (wraps provider calls via the shared `ProviderAdapter` interface).
- **Adjacent**: rate-limiting is a distinct concern — breaker tracks provider health, not tenant quota.

## Constraints
- Failover requires the tenant to have attached a secondary provider key.
- Circuit breaker is per provider, per tenant, with a configurable window/threshold/cooldown.
- v1 failover is a hardcoded primary → secondary sequence (dynamic routing is stretch).
