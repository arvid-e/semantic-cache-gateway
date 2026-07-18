# Requirements Document

## Project Description (Input)

Upstream providers fail or time out. Without protection, those failures surface directly to the
client, and repeated calls to an unhealthy provider waste latency and the customer's quota. The
gateway needs automatic failover to a secondary provider and a way to stop hammering a provider
that is clearly down for a given tenant.

This spec establishes: automatic retry/failover from the primary provider to a pre-configured
secondary provider using the tenant's own secondary credential; and a per-`(tenant, provider)`
circuit breaker that counts failures in a rolling window and, on reaching a threshold, opens for a
cooldown period before probing recovery through a half-open state. Failover decisions and breaker
state are surfaced to the shared request context for telemetry.

Out of scope: dynamic weighted routing on live cost/latency (stretch), rate limiting
(`rate-limiting`), the provider adapters and response normalization themselves
(`gateway-provider-routing`), and telemetry dashboards/metrics (`telemetry-analytics`).

## Boundary Context

- **In scope**: retry/failover to a pre-configured secondary provider using the tenant's secondary
  credential; a per-`(tenant, provider)` circuit breaker with a configurable failure window,
  threshold, cooldown, and half-open recovery; and surfacing failover and breaker state to the
  shared request context.
- **Out of scope**: selecting the primary provider or normalizing responses
  (`gateway-provider-routing`); dynamic cost/latency-based routing (stretch); rate limiting
  (`rate-limiting`); and telemetry dashboards or metrics (`telemetry-analytics`).
- **Adjacent expectations**: depends on `platform-foundation` (datastore for breaker state, shared
  request context), `gateway-provider-routing` (wraps provider calls through the shared
  provider-adapter interface), and `auth-tenancy-credentials` (resolves the tenant's secondary
  provider credential). Downstream, `telemetry-analytics` records failover events and breaker-state
  transitions. Circuit breaking (provider health) is distinct from rate limiting (tenant quota).

## Requirements

### Requirement 1: Secondary-Provider Failover

**Objective:** As a customer, I want automatic failover to a secondary provider when the primary
fails, so that a provider outage does not surface as a failed request.

#### Acceptance Criteria
1. If the primary provider returns an error or times out, then the Gateway service shall retry the request against the tenant's pre-configured secondary provider.
2. When failing over, the Gateway service shall use the tenant's own credential for the secondary provider, resolved by `auth-tenancy-credentials`.
3. If the tenant has not attached a secondary provider credential, then the Gateway service shall not attempt failover and shall surface the primary provider's normalized error.
4. When the secondary provider returns a successful response, the Gateway service shall return that normalized response to the client.
5. The Gateway service shall follow a pre-configured primary-to-secondary sequence for v1 and shall not perform dynamic cost- or latency-based routing.

### Requirement 2: Per-Tenant, Per-Provider Circuit Breaker

**Objective:** As an operator, I want the gateway to stop calling a provider that is clearly failing
for a tenant, so that we do not waste latency and the customer's quota on a downed provider.

#### Acceptance Criteria
1. The Gateway service shall track provider failures per `(tenant, provider)` over a configurable rolling time window.
2. When the failure count for a `(tenant, provider)` reaches the configured threshold within the window, the Gateway service shall open the circuit breaker for that `(tenant, provider)`.
3. While a circuit breaker is open for a `(tenant, provider)`, the Gateway service shall not route that tenant's requests to that provider, and shall fail over to the secondary provider or return an error according to policy.
4. The Gateway service shall keep circuit-breaker state isolated per tenant so that one tenant's provider failures do not trip the breaker for another tenant.

### Requirement 3: Breaker Cooldown & Recovery

**Objective:** As an operator, I want a tripped breaker to recover automatically, so that service
resumes once the provider is healthy again.

#### Acceptance Criteria
1. When a circuit breaker opens, the Gateway service shall keep it open for a configurable cooldown period.
2. When the cooldown period elapses, the Gateway service shall transition the breaker to a half-open state and allow a limited probe request to test provider recovery.
3. When a half-open probe succeeds, the Gateway service shall close the breaker and resume normal routing to that provider.
4. If a half-open probe fails, then the Gateway service shall re-open the breaker for another cooldown period.

### Requirement 4: Failover & Breaker State Signal

**Objective:** As a telemetry consumer, I want failover and breaker events surfaced, so that
resilience behavior is observable.

#### Acceptance Criteria
1. When a failover occurs, the Gateway service shall record in the shared request context that the request was served by the secondary provider.
2. When a circuit breaker changes state (open, half-open, or closed), the Gateway service shall record the new breaker state for the affected `(tenant, provider)` in the shared request context.
3. The Gateway service shall expose these failover and breaker signals for `telemetry-analytics` to consume and shall not itself produce dashboards or metrics.
