# Research & Design Decisions

## Summary
- **Feature**: `telemetry-analytics`
- **Discovery Scope**: Extension — the terminal consumer that records the request-context signals populated by routing, caching, and resilience, computes estimated savings, and exposes Prometheus metrics + Grafana dashboards; discovery focused on the observability stack and the non-blocking recording path.
- **Key Findings**:
  - `prom-client` is the standard Node Prometheus client (counters/histograms/gauges on a registry, exposed via `registry.metrics()` at `/metrics`). Using it directly gives explicit control over the custom domain series (cache status, savings, topic-shift, verification) that the auto-instrumenting `fastify-metrics` plugin does not provide.
  - **Metric updates are effectively free and inline** (in-memory counter/histogram increments in an `onResponse` hook), so they never block the request path; only the **Postgres row persistence** needs offloading.
  - Grafana supports **dashboards-as-code via provisioning YAML** (`provisioning/datasources` + `provisioning/dashboards` → versioned dashboard JSON), mounted into the container — reproducible and version-controlled (Req 4.3).
  - The false-hit rate cannot be measured with ground truth without external labeling; the practical instrumentation is the **proxy series** (semantic candidates, verification results, fallbacks), which quantify how often the safety mechanism fires — the documented, honest measure.

## Research Log

### Prometheus metrics in Node (prom-client)
- **Context**: Req 3 requires a Prometheus-scrapable endpoint with request/cache/latency/token/savings series plus context-aware matching and false-hit instrumentation, labeled without secrets.
- **Sources Consulted**: `prom-client` README; Fastify metrics guides (see References).
- **Findings**: `prom-client` exposes `Counter`, `Histogram`, `Gauge` on a `Registry`; `/metrics` responds with `await registry.metrics()` and the registry `contentType`. Labels must be low-cardinality. `collectDefaultMetrics` optionally adds process metrics.
- **Implications**: Define a dedicated registry with domain metrics (requests, cache status, latency histogram, tokens, estimated savings, topic-shift decisions, verification results). Update them inline in an `onResponse` hook from the request-context snapshot; serve `/metrics` unauthenticated for Prometheus to scrape.

### Non-blocking telemetry recording
- **Context**: Req 5 — telemetry must never block the response; a failing telemetry subsystem must not surface to the client.
- **Sources Consulted**: steering `tech.md` (BullMQ optional); Node async patterns.
- **Findings**: Metric increments are synchronous and negligible. The costly part is the Postgres write. A fire-and-forget async write (scheduled after the response is sent, errors caught and logged) satisfies non-blocking with no extra infra; a BullMQ (Redis-backed) queue adds durability and a separate worker.
- **Implications**: Model a `TelemetrySink` interface with a default **direct async** implementation (non-blocking, in-process) and an optional **BullMQ** implementation selected by config. Either way, the request path returns without awaiting the persistence write (Req 5.1, 5.2) and failures are swallowed + logged (Req 5.3, 1.4).

### Grafana dashboards-as-code and the compose observability layer
- **Context**: Req 4 (reproducible dashboards) and the spec owning the Prometheus/Grafana stack.
- **Sources Consulted**: Grafana provisioning docs; Prometheus + Grafana compose guides (see References).
- **Findings**: Grafana loads `provisioning/datasources/*.yml` (a Prometheus datasource) and `provisioning/dashboards/*.yml` (a file provider pointing at dashboard JSON) at startup. Prometheus scrapes targets from `prometheus.yml` using compose service names.
- **Implications**: Ship versioned `grafana/provisioning/*` + `grafana/dashboards/*.json` and `prometheus/prometheus.yml`; add `prometheus` and `grafana` services to the compose file (a documented modification to the foundation's compose — telemetry owns this layer).

### Estimated cost saved
- **Context**: Req 2 — savings from a static in-repo pricing table on cache hits; zero on live; graceful handling of missing entries.
- **Findings**: A cache hit's stored `NormalizedResponse` carries the token usage from its original live generation; savings = `promptTokens·inputRate + completionTokens·outputRate` for the `(provider, model)`. Live requests record zero. A missing pricing entry records the request with no computed saving and never fails it.
- **Implications**: A typed static `pricing.ts` table keyed by `(provider, model)` with input/output per-token rates; a `CostEstimator` that returns a saving only for cache hits with a pricing entry.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| `onResponse` recorder + prom-client registry + offloaded persistence | Inline metric updates, fire-and-forget row write, `/metrics` endpoint, dashboards-as-code | Non-blocking; explicit custom series; reproducible dashboards | Must guard label cardinality and secret exclusion | **Selected** |
| `fastify-metrics` auto-instrumentation | Adopt the plugin | Quick default HTTP metrics | Doesn't model domain series (cache/savings/verification); less control | Rejected for the custom series (may still inspire defaults) |
| Synchronous telemetry write in the handler | Persist inline | Simple | Blocks the response; a DB blip fails requests | Rejected — violates Req 5 |
| Live pricing feed | Query provider pricing APIs | Accurate | Adds a keyed external call; out of scope | Rejected — static table only |

## Design Decisions

### Decision: Inline metrics, offloaded persistence
- **Context**: Req 5, 1.4.
- **Selected Approach**: An `onResponse` hook snapshots the context, updates prom-client metrics inline, and hands the record to a `TelemetrySink` that persists asynchronously (direct async by default; optional BullMQ).
- **Rationale**: Keeps the request path free of I/O while still exporting real-time metrics; isolates persistence failures.
- **Trade-offs**: A crash could drop unpersisted rows in direct mode (metrics already updated); BullMQ addresses durability when configured.

### Decision: Metadata-only telemetry, low-cardinality labels
- **Context**: Req 6.
- **Selected Approach**: Persist only non-secret metadata (tenant, provider, model, token counts, cache status, latency, failover/breaker, matching outcomes, savings) — never credentials, prompts, or responses; metric labels are restricted to bounded dimensions (provider, model, cache status, decision, result).
- **Rationale**: No leakage path and no label-cardinality explosion.
- **Trade-offs**: Raw prompt/response are not queryable from telemetry (acceptable; not in scope).

### Decision: False-hit instrumentation via proxy series
- **Context**: Req 3.3, 4.2.
- **Selected Approach**: Export semantic-candidate counts, verification results (passed/failed/inconclusive), and fallback counts; dashboards show the rate at which verification rejects candidates and the standalone/context-dependent split.
- **Rationale**: Direct false-hit ground truth needs external labeling; these proxies quantify the safety mechanism and detection effectiveness — the honest, documented measure.
- **Trade-offs**: Not a labeled false-hit rate; documented as such.

## Risks & Mitigations
- **Telemetry write failure affecting the client** — Mitigation: fire-and-forget + catch; never awaited on the response path (Req 1.4, 5.3).
- **Secret/PII leakage** — Mitigation: metadata-only rows; no secrets/prompts; bounded metric labels (Req 6.1, 6.2).
- **Label cardinality blow-up** — Mitigation: restrict labels to provider/model/status/decision/result; no tenant id or content in labels.
- **Missing pricing entry** — Mitigation: record without a saving; never fail the request (Req 2.5).
- **Compose coupling** — Mitigation: additive Prometheus/Grafana services + provisioning; documented as this spec's ownership of the observability layer.

## References
- [prom-client](https://github.com/siimon/prom-client) — counters/histograms, registry, `/metrics`.
- [Node.js + Prometheus guide](https://betterstack.com/community/guides/scaling-nodejs/nodejs-prometheus/) — metric patterns.
- [Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/) — datasources + dashboards as code.
- [Configure the Prometheus data source](https://grafana.com/docs/grafana/latest/datasources/prometheus/configure/) — provisioning a Prometheus datasource.
