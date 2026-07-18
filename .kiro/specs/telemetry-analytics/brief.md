# Brief: telemetry-analytics

## Problem
The gateway's value must be measurable: how much the customer saved by serving from cache
instead of calling their provider, how fast requests are, and how often the cache hits. Without
telemetry and dashboards there is no way to prove the value proposition or observe the system.

## Current State
The completion flow (routing), caching, and resilience all populate a shared request context
(tenant, provider, model, token usage, cache status, latency, failover/breaker state). Nothing
persists or aggregates that data, and there is no metrics export or dashboard.

## Desired Outcome
Every request is logged with structured metadata: provider, input/output token usage, cache
status, latency, failover/breaker events, and the **estimated cost saved** for the customer
(what they would have paid their provider had the cache not served the response). Metrics are
exported to Prometheus and visualized in Grafana dashboards showing total cost saved, latency
distribution, and cache hit rate over time. Telemetry also records the **context-aware matching
outcome** from dual-layer-caching (topic-shift decision: standalone vs context-dependent;
verification result: verified hit / verification-failed fallback / inconclusive fallback) so the
**false-hit rate and detection effectiveness are measurable** — the evidence that the semantic
cache beats the naive alternatives.

## Approach
Persist per-request telemetry to Postgres (optionally offloaded via a BullMQ queue so logging
never blocks the request path). Compute estimated cost saved from a static, in-repo pricing
table (per provider/model input/output token rates) applied to cache hits. Expose a Prometheus
metrics endpoint (counters/histograms for requests, cache status, latency, tokens, savings) and
ship Grafana dashboards-as-code for the key views. Secrets never appear in telemetry.

## Scope
- **In**: structured per-request telemetry persistence; static pricing table + estimated-cost-saved
  computation; Prometheus metrics export (request/cache/latency/token/savings series **plus
  context-aware matching series: topic-shift decisions, verification outcomes, and false-hit-rate
  instrumentation**); Grafana dashboards (total cost saved, latency distribution, cache hit rate
  over time, **detection/verification outcome breakdown**); optional BullMQ offload for
  non-blocking logging.
- **Out**: gateway-side billing/invoicing/Stripe (out of scope); live pricing feeds; a custom
  client-facing frontend (Grafana is the dashboard; Postman/`curl` for the API); computing the
  cache status or the topic-shift/verification decision itself (dual-layer-caching owns those
  signals — telemetry only records and aggregates them).

## Boundary Candidates
- Telemetry schema & persistence (+ optional BullMQ offload)
- Static pricing table & estimated-savings calculation
- Prometheus metrics export
- Grafana dashboards-as-code

## Out of Boundary
- Producing the cache-status/failover signals (consumes them from caching & resilience)
- Any billing or charging logic

## Upstream / Downstream
- **Upstream**: gateway-provider-routing, dual-layer-caching (cache status **and detection/
  verification outcome**), resilience-failover (reads their request-context signals).
- **Downstream**: terminal for v1 — feeds a future Admin UI / dynamic-weighted-routing (stretch).

## Existing Spec Touchpoints
- **Extends**: the shared request context populated by routing, caching, and resilience.
- **Adjacent**: reuses Pino logging and datastores from platform-foundation; adds the Prometheus/Grafana layer.

## Constraints
- Estimated savings only, from a static in-repo pricing table (no live pricing, no billing).
- Provider credentials and secrets must never appear in telemetry, metrics, or logs.
- Logging must not block the request path (BullMQ offload optional but preferred).
