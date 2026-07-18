# Requirements Document

## Project Description (Input)

The gateway's own infrastructure must be protected from abuse and runaway traffic. Because callers
are authenticated per tenant, limits must be enforced per tenant — independent of the customer's
own provider-side token/cost limits (which they own via their key).

This spec establishes a configurable, per-tenant request rate limit enforced as middleware on the
gateway's request endpoints: within-limit requests pass through; over-limit requests are rejected
with `429 Too Many Requests` and standard rate-limit headers. Limits have a default plus optional
per-tenant overrides, and enforcement is correct (atomic) under concurrent load.

Out of scope: authentication and tenant modeling (`auth-tenancy-credentials`, which supplies the
tenant identity), provider-side token/cost limits (owned by the customer via their key), circuit
breaking and provider-health handling (`resilience-failover`), and global or IP-based limits.

## Boundary Context

- **In scope**: per-tenant request rate limiting enforced on gateway request endpoints; a
  configurable capacity (burst) and refill rate with optional per-tenant overrides; `429` responses
  with standard rate-limit headers; and correct (atomic) enforcement under concurrency.
- **Out of scope**: authentication and tenant modeling (`auth-tenancy-credentials`); the customer's
  provider-side token or cost limits; circuit breaking and provider health (`resilience-failover`);
  and global or IP-based rate limiting.
- **Adjacent expectations**: depends on `platform-foundation` (the shared datastore used for
  rate-limit state and the request pipeline) and on `auth-tenancy-credentials` (the authenticated
  tenant identity already present in the shared request context). It applies to the endpoints
  provided by `gateway-provider-routing`, and `telemetry-analytics` may later record throttle
  events.

## Requirements

### Requirement 1: Per-Tenant Rate Limiting Enforcement

**Objective:** As a gateway operator, I want each tenant's request rate bounded, so that no single
tenant can exhaust gateway infrastructure.

#### Acceptance Criteria
1. When a request is authenticated to a tenant, the rate limiter shall account the request against that tenant's own limit before the request reaches provider-calling logic.
2. While a tenant is within its configured limit, the rate limiter shall admit the request and allow it to proceed.
3. The rate limiter shall enforce limits independently per tenant so that one tenant's usage does not consume another tenant's allowance.
4. The rate limiter shall limit only the tenant's request rate against the gateway and shall not attempt to limit the customer's provider-side token or cost usage.
5. The rate limiter shall apply to gateway request endpoints and shall not throttle the liveness or readiness endpoints.

### Requirement 2: Configurable Limits & Per-Tenant Overrides

**Objective:** As an operator, I want configurable limits with per-tenant overrides, so that I can
tune capacity and burst for individual customers.

#### Acceptance Criteria
1. The rate limiter shall enforce a configurable request capacity (burst) and a configurable refill rate over time.
2. When time elapses, the rate limiter shall replenish a tenant's allowance according to the configured refill rate, up to the configured capacity.
3. Where a per-tenant override is configured, the rate limiter shall apply that tenant's override instead of the default limit.
4. Where no per-tenant override is configured, the rate limiter shall apply the default limit.

### Requirement 3: Over-Limit Response

**Objective:** As a developer, I want a clear signal when I exceed the limit, so that I can back
off correctly.

#### Acceptance Criteria
1. If a tenant exceeds its configured limit, then the Gateway service shall reject the request with a `429 Too Many Requests` status and shall not call any provider.
2. When a request is rejected for exceeding the limit, the Gateway service shall include a `Retry-After` header indicating when the client may retry.
3. When a request is admitted or rejected, the Gateway service shall include standard rate-limit headers communicating the tenant's limit and remaining allowance.

### Requirement 4: Concurrency Correctness

**Objective:** As an operator, I want limits enforced correctly under concurrent load, so that
bursts cannot slip past the limit.

#### Acceptance Criteria
1. When multiple requests for the same tenant are processed concurrently, the rate limiter shall enforce the limit atomically so that no more than the configured capacity is admitted.
2. The rate limiter shall not admit requests beyond the configured limit as a result of race conditions between concurrent requests.
