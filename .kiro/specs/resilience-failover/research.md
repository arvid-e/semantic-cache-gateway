# Research & Design Decisions

## Summary
- **Feature**: `resilience-failover`
- **Discovery Scope**: Extension — wraps `gateway-provider-routing`'s provider call with a secondary-provider failover policy and a per-`(tenant, provider)` circuit breaker; discovery focused on the distributed breaker state machine and the composition seam beneath the cache layer.
- **Key Findings**:
  - A distributed circuit breaker must keep state in a **shared store (Redis)** with **atomic transitions**, so all gateway instances agree and a downed provider is not hammered by every replica. Per-`(tenant, provider)` keys give the required isolation (Req 2.4).
  - The standard **three-state machine** (CLOSED → OPEN → HALF_OPEN) with a rolling failure window, a cooldown (open duration), and a **single half-open probe** matches Requirements 2–3 exactly.
  - In-process libraries (e.g., `opossum`) keep breaker state per process and cannot express per-`(tenant, provider)` state shared across instances — so a small custom Redis breaker with Lua transitions is the right build (same reasoning as `rate-limiting`).
  - Failover composes cleanly by **reusing the gateway `CompletionService` contract**: on a primary failure, invoke the same service with the secondary provider (which resolves the tenant's secondary credential and normalizes) — no duplication of adapter/credential/normalization logic.

## Research Log

### Distributed circuit breaker state machine
- **Context**: Req 2 (per-`(tenant, provider)` failure tracking + open on threshold), Req 3 (cooldown + half-open recovery).
- **Sources Consulted**: Redis circuit-breaker implementations; distributed state-machine guidance (see References).
- **Findings**: States CLOSED (allow), OPEN (deny until cooldown elapses), HALF_OPEN (allow one probe). Failures counted over a rolling window; reaching the threshold opens the breaker and starts the cooldown timer. After cooldown, one probe tests recovery: success → CLOSED, failure → OPEN (new cooldown). Redis atomic ops (Lua) keep transitions conflict-free under concurrency; half-open must admit only one probe.
- **Implications**: Store per-`(tenant, provider)` state in Redis (`breaker:{tenant}:{provider}`), record failures in a rolling window (sorted set of timestamps), and drive all check/transition/record operations through atomic Lua scripts. Half-open admits a single probe via an in-flight marker; concurrent requests during half-open are treated as open (fail over).

### Failover policy and credential use
- **Context**: Req 1 (retry to a pre-configured secondary with the tenant's secondary credential; no failover without one; hardcoded sequence for v1).
- **Sources Consulted**: `gateway-provider-routing/design.md`, `auth-tenancy-credentials/design.md` (this repo).
- **Findings**: The gateway `CompletionService.complete(request)` already selects the adapter for `request.provider`, resolves that provider's credential via the `CredentialResolver`, calls it, and normalizes. A `ProviderError` (including `kind: 'timeout'`) signals an upstream failure. A `MissingCredentialError` signals the tenant has no credential for a provider.
- **Implications**: Model failover as a **configured primary→secondary map** (hardcoded for v1, no dynamic routing — Req 1.5). On a primary failure, invoke `CompletionService` again with the mapped secondary provider; a resulting `MissingCredentialError` means the tenant has no secondary credential → surface the **primary's** normalized error and do not fail over (Req 1.3). A secondary success returns its normalized response (Req 1.4).

### Composition beneath the cache layer
- **Context**: Resilience wraps provider calls; caching wraps the completion flow.
- **Sources Consulted**: `dual-layer-caching/design.md` (this repo).
- **Findings**: Caching wraps `CompletionService` and calls it only on a miss; it should be outermost (a cache hit must avoid the provider entirely). Foundation `RequestContext` already declares `failover { attempted, from, to }` and `breakerState`.
- **Implications**: Provide a `ResilientCompletionService` implementing the same `complete()` contract, wrapping the raw `CompletionService`. The app composes the completion entrypoint as **cache → resilience → completion** (`CachedCompletionService(ResilientCompletionService(CompletionService))`). This spec **populates** the existing `failover`/`breakerState` context fields (no refine) and adds a `breakerEvents` detail for per-provider transitions.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Custom Redis breaker + failover decorator over `CompletionService` | Own Lua-driven breaker; a resilient service that reuses the completion contract for the secondary | Per-`(tenant, provider)` shared state; reuses adapter/credential/normalization; clean composition | Small Lua state machine to own and test | **Selected** |
| In-process breaker (`opossum`) | Adopt a library | Battle-tested | Per-process state; cannot key per `(tenant, provider)` across instances | Rejected — wrong state scope |
| Breaker state in Postgres | Use the relational store | Durable | Higher latency on the hot path; adds load to the primary DB; Redis already present | Rejected — Redis fits and is atomic |

## Design Decisions

### Decision: Reuse the `CompletionService` contract for the secondary call
- **Context**: Req 1.1, 1.2, 1.4.
- **Selected Approach**: On primary failure (or an open primary breaker), invoke `CompletionService` again with the secondary provider from the failover map; the inner service resolves the tenant's secondary credential and normalizes.
- **Rationale**: No duplication of adapter selection, credential resolution, or normalization; failover is a thin policy on top.
- **Trade-offs**: The secondary call re-populates provider/model context fields (desired — the response is the secondary's).

### Decision: Redis breaker with atomic Lua transitions, single half-open probe
- **Context**: Req 2, 3.
- **Selected Approach**: `breaker:{tenant}:{provider}` state (CLOSED/OPEN/HALF_OPEN) with a rolling failure window (sorted set) and an in-flight probe marker; check/transition/record run as atomic Lua; cooldown drives OPEN→HALF_OPEN.
- **Rationale**: Correct, shared across instances, concurrency-safe; exactly one probe recovers or re-opens.
- **Trade-offs**: A small state machine to maintain; justified by correctness and multi-instance behavior.

### Decision: Surface failover/breaker state via existing context fields + a transitions detail
- **Context**: Req 4.
- **Selected Approach**: Populate the foundation's `failover { attempted, from, to }` and `breakerState`; add `breakerEvents: { provider, state }[]` for per-`(tenant, provider)` transitions. Emit no metrics.
- **Rationale**: Reuses the foundation contract and gives telemetry the failover + transition signals it needs.
- **Trade-offs**: One additive context field (declaration merging), no foundation refine required.

## Risks & Mitigations
- **Cross-tenant breaker interference** — Mitigation: keys include `tenantId` (Req 2.4).
- **Half-open thundering herd** — Mitigation: single in-flight probe; other requests during half-open fail over/deny.
- **Failover masking a real client error** — Mitigation: fail over only on `ProviderError`/timeout, not on validation/auth errors; absent secondary credential surfaces the primary error (Req 1.3).
- **Breaker store outage** — Mitigation: if the breaker check errors, fail open (allow the call) so a Redis blip does not block all traffic; logged.
- **Double retries** — Mitigation: adapters already run with `maxRetries: 0` (gateway); this layer owns the single primary→secondary attempt.

## References
- [Implement circuit breakers with Redis](https://oneuptime.com/blog/post/2026-01-21-redis-circuit-breaker/view) — states, thresholds, cooldown.
- [Distributed circuit breaker in Node.js with Redis](https://medium.com/@mdminhajgdr/building-a-distributed-circuit-breaker-in-node-js-with-redis-ed40852101cc) — shared state, atomicity.
- [Redis distributed state machine](https://oneuptime.com/blog/post/2026-03-31-redis-distributed-state-machine/view) — atomic transitions under concurrency.
