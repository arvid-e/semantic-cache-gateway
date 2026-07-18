# Implementation Plan

- [ ] 1. Foundation: config and signals
- [ ] 1.1 (P) Implement the resilience config segment
  - Validate the resilience environment segment: the primary→secondary failover map, the rolling failure-window duration, the failure threshold, and the cooldown period — with fail-fast, secret-safe semantics
  - Observable: an invalid or missing resilience setting fails plugin configuration naming the setting, and a valid environment yields a typed config exposing the failover map, window, threshold, and cooldown
  - _Requirements: 1.5, 2.1, 2.2, 3.1_
  - _Boundary: Resilience Config_
- [ ] 1.2 (P) Implement resilience types and context signals
  - Define the breaker state, decision, and event types, and provide the writers that populate the shared context's failover fields and breaker state and append per-provider breaker-transition events
  - Observable: the signal writers set the failover attempted/from/to fields, set the breaker state, and append breaker-transition events, computing no metrics
  - _Requirements: 4.1, 4.2, 4.3_
  - _Boundary: Resilience Types, Signals Writer_

- [ ] 2. Core: circuit breaker and failover policy
- [ ] 2.1 (P) Implement the per-tenant, per-provider circuit breaker
  - Author the atomic Lua transitions and the breaker service: record failures in a rolling window keyed per tenant and provider, open on reaching the threshold, keep open for the cooldown, transition to half-open after cooldown admitting a single probe, close on probe success and re-open on probe failure, using Redis server time; fail open on a breaker-store error
  - Observable: reaching the threshold within the window opens the breaker, the cooldown elapsing admits exactly one half-open probe, a probe success closes it and a probe failure re-opens it, and one tenant's failures never affect another tenant's breaker for the same provider
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4_
  - _Boundary: Circuit Breaker, Lua_
  - _Depends: 1.1_
- [ ] 2.2 (P) Implement the failover policy
  - Resolve the secondary provider for a given primary from the configured failover map, returning none when no secondary is mapped
  - Observable: a primary with a configured secondary resolves to that secondary, and a primary with no mapping resolves to none
  - _Requirements: 1.5_
  - _Boundary: Failover Policy_
  - _Depends: 1.1_

- [ ] 3. Integration: resilient completion and composition
- [ ] 3.1 Implement the resilient completion service
  - Implement the service that gates each provider on its breaker and, on a primary error/timeout or an open primary breaker, fails over to the mapped secondary by re-invoking the underlying completion service with the secondary provider; record successes and failures against the affected breaker, populate the failover and breaker signals, and surface the primary's normalized error when no secondary credential is available
  - Observable: a primary success returns without failover, a primary failure with a secondary credential returns the secondary's normalized response with failover recorded, a primary failure without a secondary credential surfaces the primary error, an open primary breaker skips the primary and fails over, and breaker state is recorded per provider tried
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.3, 4.1, 4.2_
  - _Boundary: ResilientCompletionService_
  - _Depends: 2.1, 2.2_
- [ ] 3.2 Register the plugin and compose the completion entrypoint
  - Register the resilience plugin onto the foundation app (registering the breaker Lua commands on the shared Redis client) and compose the completion entrypoint so the cache wraps the resilient service, which wraps the underlying completion service; document the resilience environment variables
  - Observable: the app boots with the completion entrypoint composed as cache over resilience over the completion service, so a live call passes through the breaker gate and failover before reaching a provider
  - _Requirements: 1.1_
  - _Depends: 3.1_

- [ ] 4. Validation: resilience integration tests
- [ ] 4.1 Add integration tests against dockerized Redis with stubbed providers
  - Exercise: a failing primary with a healthy secondary (and a secondary credential) returns the secondary response and records failover; a failing primary with no secondary credential surfaces the primary error without failover; repeated primary failures open the breaker so subsequent requests skip the primary and fail over; after cooldown a single half-open probe recovers and closes the breaker; and one tenant's failures do not open another tenant's breaker
  - Observable: the integration suite passes, proving secondary failover, the no-secondary error path, breaker opening and open-state failover, half-open recovery, and per-tenant isolation
  - _Requirements: 1.1, 1.3, 1.4, 2.2, 2.3, 2.4, 3.1, 3.3, 4.1, 4.2_
  - _Depends: 3.2_
