# Requirements Document

## Project Description (Input)

The gateway's value must be measurable: how much the customer saved by serving from cache instead
of calling their provider, how fast requests are, and how often the cache hits. Without telemetry
and dashboards there is no way to prove the value proposition or observe the system. Crucially, the
context-aware caching design requires instrumentation of its own detection and verification
outcomes — including the false-hit rate — to prove the cache is measurably better than the naive
alternatives.

This spec establishes: structured per-request telemetry persistence; estimated cost-saved
computation from a static, in-repo pricing table; metrics export in a Prometheus-scrapable format
(request, cache-status, latency, token, and savings series, plus context-aware matching series and
false-hit-rate instrumentation); Grafana dashboards-as-code for the key views; and non-blocking
telemetry recording (optionally offloaded to a background queue) so observability never adds latency
to the request path. Secrets never appear in telemetry, metrics, or dashboards.

Out of scope: gateway-side billing/invoicing/Stripe, live pricing feeds, a custom client-facing
frontend (Grafana is the dashboard; Postman/`curl` cover the API), and computing the cache status
or the topic-shift/verification decisions themselves (`dual-layer-caching` owns those signals).

## Boundary Context

- **In scope**: structured per-request telemetry persistence; a static in-repo pricing table and
  estimated cost-saved computation; metrics export (request/cache/latency/token/savings plus
  context-aware matching outcomes and false-hit-rate instrumentation); Grafana dashboards-as-code;
  non-blocking telemetry recording (optional background-queue offload); and secret exclusion from
  all telemetry, metrics, and dashboards.
- **Out of scope**: billing, invoicing, or charging of any kind; live pricing feeds; a custom
  client-facing frontend; and producing the cache-status, topic-shift, or verification signals
  themselves — this spec only records and aggregates the signals other specs expose.
- **Adjacent expectations**: depends on `platform-foundation` (shared logger and datastore) and
  consumes the shared request-context signals populated by `gateway-provider-routing`,
  `dual-layer-caching` (cache status plus detection/verification outcome), and `resilience-failover`
  (failover events and breaker state). This spec is terminal for v1 and later feeds a stretch Admin
  UI / dynamic-weighted-routing.
- **Established constraint**: cost figures are estimated savings only, computed from a static in-repo
  pricing table — no live pricing and no billing. Prometheus and Grafana are the observability stack
  owned by this spec.

## Requirements

### Requirement 1: Per-Request Telemetry Persistence

**Objective:** As an operator, I want every request recorded with structured metadata, so that I can
analyze cost, performance, and cache effectiveness.

#### Acceptance Criteria
1. When a request completes, the Gateway service shall persist a structured telemetry record capturing the tenant, provider, resolved model, input and output token usage, cache status, latency, and failover/breaker state.
2. When a request completes, the Gateway service shall include the context-aware matching outcome — the topic-shift decision and the verification result, including any fallback to live — in the telemetry record.
3. The Gateway service shall read these values from the shared request context populated by routing, caching, and resilience, and shall not recompute the underlying decisions.
4. If persisting a telemetry record fails, then the Gateway service shall not fail or delay the client's response.

### Requirement 2: Estimated Cost-Saved Computation

**Objective:** As a stakeholder, I want to see how much was saved by cache hits, so that the value
proposition is measurable.

#### Acceptance Criteria
1. When a request is served from cache (exact or semantic), the Gateway service shall compute the estimated cost saved as what the customer would have paid the provider for that request had it been served live.
2. The Gateway service shall compute estimated cost from a static, in-repo pricing table of per-provider and per-model input and output token rates.
3. When a request is served live, the Gateway service shall record zero cost saved for that request.
4. The Gateway service shall present cost figures as estimated savings only and shall not perform billing, invoicing, or charging.
5. Where a provider or model has no entry in the pricing table, the Gateway service shall record the request without a computed saving and shall not fail the request.

### Requirement 3: Metrics Export

**Objective:** As an operator, I want metrics exported for monitoring, so that I can observe the
system over time.

#### Acceptance Criteria
1. The Gateway service shall expose a metrics endpoint in a format a Prometheus-compatible monitoring system can scrape.
2. The Gateway service shall export metrics series for request counts, cache status (exact, semantic, live), latency distribution, token usage, and estimated cost saved.
3. The Gateway service shall export metrics series for the context-aware matching outcomes (topic-shift decisions and verification results) and for the false-hit-rate instrumentation.
4. The Gateway service shall label metrics so they can be broken down by relevant dimensions (for example, provider and cache status) without exposing secret material.

### Requirement 4: Dashboards

**Objective:** As a stakeholder, I want dashboards visualizing the key views, so that I can see
savings, performance, and cache effectiveness at a glance.

#### Acceptance Criteria
1. The Gateway service shall provide Grafana dashboards visualizing total estimated cost saved, latency distribution, and cache hit rate over time.
2. The Gateway service shall provide a dashboard view breaking down the context-aware matching outcomes and the false-hit-rate instrumentation.
3. The Gateway service shall provision dashboards from version-controlled definitions so that they are reproducible.

### Requirement 5: Non-Blocking Telemetry

**Objective:** As a developer, I want telemetry never to slow the request path, so that observability
does not cost latency.

#### Acceptance Criteria
1. When recording telemetry, the Gateway service shall do so without blocking the client response path.
2. Where telemetry writes are offloaded to a background queue, the Gateway service shall return the client response without waiting for the telemetry write to complete.
3. If the telemetry subsystem is unavailable, then the Gateway service shall continue serving requests and shall not surface the telemetry failure to the client.

### Requirement 6: Secret Exclusion

**Objective:** As a customer, I want secrets never present in telemetry or metrics, so that
observability creates no leakage path.

#### Acceptance Criteria
1. The Gateway service shall exclude provider credentials, gateway API keys, and encryption material from all telemetry records, metrics, and dashboards.
2. The Gateway service shall not place raw prompt or response content into metric labels.
