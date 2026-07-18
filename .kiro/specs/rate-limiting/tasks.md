# Implementation Plan

> **Solo implementation note:** Work top-to-bottom; ignore `(P)` markers. Open `design.md`
> (File Structure Plan + Components) for the concrete interfaces, make the observable bullet true,
> then run the checks. The middleware is applied to the gateway routes *after* auth — see
> `.kiro/steering/implementation-guide.md`.

- [ ] 1. Foundation: contracts and configuration
- [ ] 1.1 Define rate-limit contracts and the config segment
  - Define the shared types (config, effective limit, decision, limiter interface) and validate the rate-limit environment segment: default capacity (burst), default refill rate, and a per-tenant overrides map parsed from configuration
  - Observable: an invalid or missing rate-limit setting fails plugin configuration naming the setting, a valid environment yields a typed config with the default limit and parsed per-tenant overrides, and the shared contracts are exported
  - _File: src/modules/rate-limiting/config.ts, src/modules/rate-limiting/types.ts_
  - _Requirements: 2.1, 2.3, 2.4_

- [ ] 2. Core: token bucket, resolution, and headers
- [ ] 2.1 (P) Implement the atomic token-bucket limiter
  - Author the Lua script that, using Redis server time, refills a tenant's bucket by elapsed time capped at capacity, admits and decrements when a token is available, persists the bucket state under a per-tenant key with a TTL, and reports remaining/reset/retry-after; wrap it as a reusable Redis command and expose a `consume` method returning the decision
  - Observable: a full bucket admits and decrements, an empty bucket rejects, tokens refill over elapsed time up to but never beyond capacity, and different tenants use different keys
  - _File: src/modules/rate-limiting/token-bucket.ts, src/modules/rate-limiting/token-bucket.lua_
  - _Requirements: 1.2, 1.3, 2.1, 2.2, 4.1, 4.2_
  - _Boundary: TokenBucketLimiter, Lua Script_
  - _Depends: 1.1_
- [ ] 2.2 (P) Implement the limit resolver
  - Resolve the effective limit for a tenant, returning the configured per-tenant override when present and the default otherwise
  - Observable: a tenant with an override resolves to that capacity/refill and a tenant without one resolves to the default
  - _File: src/modules/rate-limiting/limit-resolver.ts_
  - _Requirements: 2.3, 2.4_
  - _Boundary: Limit Resolver_
  - _Depends: 1.1_
- [ ] 2.3 (P) Implement the rate-limit header builder
  - Build the standard rate-limit response headers from a decision, setting limit/remaining/reset on every response and adding a retry-after value when the request is rejected
  - Observable: an admitted decision sets the limit, remaining, and reset headers, and a rejected decision additionally sets the retry-after header
  - _File: src/modules/rate-limiting/headers.ts_
  - _Requirements: 3.2, 3.3_
  - _Boundary: Header Builder_
  - _Depends: 1.1_

- [ ] 3. Integration: middleware and pipeline wiring
- [ ] 3.1 Implement the rate-limit middleware
  - Implement the preHandler that reads the tenant identity from the request context, resolves the effective limit, consumes a token atomically, sets the rate-limit headers, and either proceeds (admit) or responds `429` with retry-after (reject) before the completion handler; a limiter infrastructure error is logged and fails open
  - Observable: a within-limit request proceeds with rate-limit headers set, while an over-limit request receives a `429` with retry-after and rate-limit headers and never reaches the completion handler
  - _File: src/modules/rate-limiting/middleware.ts_
  - _Requirements: 1.1, 1.2, 1.4, 3.1, 3.3_
  - _Boundary: Rate-Limit Middleware_
  - _Depends: 2.1, 2.2, 2.3_
- [ ] 3.2 Register the plugin and apply the limiter to gateway routes
  - Register the rate-limiting plugin onto the foundation app (registering the Lua command on the shared Redis client) and apply the exported middleware to the gateway request endpoints after authentication, leaving the foundation liveness/readiness endpoints unthrottled; document the rate-limit environment variables
  - Observable: the app boots with the limiter enforced on the gateway completion endpoint after authentication, and the liveness and readiness endpoints remain reachable without being rate limited
  - _File: src/modules/rate-limiting/index.ts, src/app.ts_
  - _Requirements: 1.5_
  - _Depends: 3.1_

- [ ] 4. Validation: concurrency and enforcement tests
- [ ] 4.1 Add integration tests against dockerized Redis
  - Exercise: fire more concurrent requests than capacity for one tenant and assert exactly capacity are admitted; verify two tenants have independent allowances; confirm an over-limit request returns `429` with retry-after and rate-limit headers and is not forwarded; confirm liveness/readiness are never throttled; and confirm a throttled tenant is admitted again after the configured refill interval
  - Observable: the integration suite passes, proving atomic concurrency enforcement, per-tenant isolation, the `429` response contract, health-endpoint exemption, and time-based refill
  - _File: test/integration/rate-limiting.test.ts_
  - _Requirements: 1.1, 1.3, 1.5, 2.2, 3.1, 4.1, 4.2_
  - _Depends: 3.2_
