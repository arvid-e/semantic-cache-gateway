# Implementation Plan

> **Solo implementation note:** Work top-to-bottom; ignore `(P)` markers. Open `design.md`
> (File Structure Plan + Components + the breaker state diagram) for the concrete interfaces, make
> the observable bullet true, then run the checks. This service reuses the gateway `CompletionService`
> for the secondary call and composes as cache → resilience → completion — see
> `.kiro/steering/implementation-guide.md`.

- [ ] 1. Foundation: config and signals
- [ ] 1.1 (P) Implement the resilience config segment
  - Validate the resilience environment segment: the primary→secondary failover map, the rolling failure-window duration, the failure threshold, and the cooldown period — with fail-fast, secret-safe semantics
  - Observable: an invalid or missing resilience setting fails plugin configuration naming the setting, and a valid environment yields a typed config exposing the failover map, window, threshold, and cooldown
  - _File: src/modules/resilience/config.ts_
  - _Requirements: 1.5, 2.1, 2.2, 3.1_
  - _Boundary: Resilience Config_
- [ ] 1.2 (P) Implement resilience types and context signals
  - Define the breaker state, decision, and event types, and provide the writers that populate the shared context's failover fields and breaker state and append per-provider breaker-transition events
  - Observable: the signal writers set the failover attempted/from/to fields, set the breaker state, and append breaker-transition events, computing no metrics
  - _File: src/modules/resilience/types.ts, src/modules/resilience/context.ts_
  - _Requirements: 4.1, 4.2, 4.3_
  - _Boundary: Resilience Types, Signals Writer_

- [ ] 2. Core: circuit breaker and failover policy
- [ ] 2.1 (P) Implement the per-tenant, per-provider circuit breaker
  - Author the atomic Lua transitions and the breaker service: record failures in a rolling window keyed per tenant and provider, open on reaching the threshold, keep open for the cooldown, transition to half-open after cooldown admitting a single probe, close on probe success and re-open on probe failure, using Redis server time; fail open on a breaker-store error
  - Observable: reaching the threshold within the window opens the breaker, the cooldown elapsing admits exactly one half-open probe, a probe success closes it and a probe failure re-opens it, and one tenant's failures never affect another tenant's breaker for the same provider
  - _File: src/modules/resilience/circuit-breaker.ts, src/modules/resilience/circuit-breaker.lua_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4_
  - _Boundary: Circuit Breaker, Lua_
  - _Depends: 1.1_
- [ ] 2.2 (P) Implement the failover policy
  - Resolve the secondary provider for a given primary from the configured failover map, returning none when no secondary is mapped
  - Observable: a primary with a configured secondary resolves to that secondary, and a primary with no mapping resolves to none
  - _File: src/modules/resilience/failover-policy.ts_
  - _Requirements: 1.5_
  - _Boundary: Failover Policy_
  - _Depends: 1.1_

- [ ] 3. Integration: resilient completion and composition
- [ ] 3.1 Implement the primary attempt with breaker gating
  - Implement the resilient completion service's primary path: check the primary provider's breaker; when it allows, call the wrapped completion service and record a success (closing a half-open probe) or, on a provider error/timeout, record a failure that may open the breaker; when the breaker is open, skip the primary; record the breaker state for the affected provider
  - Observable: a primary success returns its normalized response and records the closed state, a primary error records a failure that opens the breaker after the threshold, and an open primary breaker skips the primary call
  - _File: src/modules/resilience/resilient-completion-service.ts_
  - _Requirements: 2.3, 4.2_
  - _Boundary: ResilientCompletionService_
  - _Depends: 2.1_
- [ ] 3.2 Add secondary-provider failover
  - On a primary failure or an open primary breaker, resolve the mapped secondary and, when the secondary's breaker allows, re-invoke the wrapped completion service with the secondary provider (reusing its credential resolution and normalization); surface the primary's normalized error when no secondary is mapped or the tenant has no secondary credential; record that the request was served by the secondary
  - Observable: a failing primary with a healthy secondary returns the secondary's normalized response with failover recorded, and a failing primary with no secondary mapping or credential surfaces the primary error without failover
  - _File: src/modules/resilience/resilient-completion-service.ts_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 4.1_
  - _Boundary: ResilientCompletionService_
  - _Depends: 3.1, 2.2_
- [ ] 3.3 Register the plugin and compose the completion entrypoint
  - Register the resilience plugin onto the foundation app (registering the breaker Lua commands on the shared Redis client) and compose the completion entrypoint so the cache wraps the resilient service, which wraps the underlying completion service; document the resilience environment variables
  - Observable: the app boots with the completion entrypoint composed as cache over resilience over the completion service, so a live call passes through the breaker gate and failover before reaching a provider
  - _File: src/modules/resilience/index.ts, src/app.ts_
  - _Requirements: 1.1_
  - _Depends: 3.2_

- [ ] 4. Validation: resilience integration tests
- [ ] 4.1 Add integration tests against dockerized Redis with stubbed providers
  - Exercise: a failing primary with a healthy secondary (and a secondary credential) returns the secondary response and records failover; a failing primary with no secondary credential surfaces the primary error without failover; repeated primary failures open the breaker so subsequent requests skip the primary and fail over; after cooldown a single half-open probe recovers and closes the breaker; and one tenant's failures do not open another tenant's breaker
  - Observable: the integration suite passes, proving secondary failover, the no-secondary error path, breaker opening and open-state failover, half-open recovery, and per-tenant isolation
  - _File: test/integration/resilience.test.ts_
  - _Requirements: 1.1, 1.3, 1.4, 2.2, 2.3, 2.4, 3.1, 3.3, 4.1, 4.2_
  - _Depends: 3.3_
