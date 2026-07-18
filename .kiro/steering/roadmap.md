# Roadmap

## Overview
Semantic Cache Gateway is a provider-agnostic, BYOK (Bring Your Own Key) LLM gateway that
fronts OpenAI, Anthropic, and a local Ollama model behind a single
`POST /v1/chat/completions` endpoint. Its core value proposition is a dual-layer cache
(exact + semantic): every cache hit is a request the customer's own provider key was
**not** charged for. The gateway is a pure pass-through — it never holds its own provider
account and never pays for LLM usage.

The project is built as an interview / portfolio-grade system, so the decomposition favors
self-contained, demonstrable increments with clean per-domain seams that can be built,
tested, and reviewed independently over a shared foundation.

## Approach Decision
- **Chosen**: A single Fastify (TypeScript) service fronting three provider adapters, using
  Redis (exact cache + rate limiting) and PostgreSQL + `pgvector` (tenants, encrypted
  credentials, semantic vectors, telemetry) as the only two datastores. Prompt embeddings
  are generated locally by the already-present Ollama service via `nomic-embed-text`
  (768-dim). Observability is Pino → Prometheus → Grafana. Everything runs via Docker Compose.
- **Why**: Reusing Ollama for embeddings and Postgres/`pgvector` for the vector store keeps
  the moving parts minimal and the cache path key-free and offline (reinforcing the "cache
  hit = no provider key called" value prop). TypeScript + Fastify gives high performance and
  first-class schema validation, and each domain forms a naturally independent, testable seam.
- **Rejected alternatives**:
  - Qdrant — introduces a third datastore; `pgvector` reuses the Postgres already needed for logging.
  - Embedding via a cheap API — adds a provider cost and a key on the cache path, undermining the value prop.
  - Custom `/stats` frontend — superseded by the Prometheus + Grafana stack; a polished client UI is out of scope.
  - Python / Go — TypeScript + Fastify chosen for performance, schema validation, and a single-language stack.

## Semantic-Matching Correctness Decision (owned by `dual-layer-caching`)
Semantic caching on the latest user message alone produces **false cache hits** on
context-dependent follow-ups ("what command should I run?", "yes", "teach me"); embedding the
entire history kills the hit rate because histories become unique almost immediately. The chosen
strategy is **cheap detection first, expensive verification only when needed**:
1. **Embedding-based topic-shift detection** (near-free — reuses the embedding already computed):
   cosine-compare the incoming user message against the **last AI response** (denser anchor than a
   short follow-up). Low similarity → topic shifted → treat message as standalone. High similarity
   → likely context-dependent → verify.
2. **Context-chain verification on candidate matches** (MeanCache-style prior art): let semantic
   search find a candidate first, then verify the candidate's original context aligns with the
   current conversation before accepting the hit — confining the expensive check to promising cases.
3. **Safety-biased fallback**: if detection is inconclusive or verification fails, skip the cache
   and go live. A missed hit costs a little saving; a wrong cached answer costs correctness/trust.
- **Rejected alternatives**: full-history embedding (too sparse to match past turn 1–2); a fixed
  sliding window of last 2–3 turns (breaks on cascading reference chains where the anchor is
  further back); AI refinement/condensation on every request (adds latency/cost to every request
  including misses, where it is pure waste).
- **Known limitation (documented, not hidden)**: very short, low-information follow-ups ("yes",
  "ok") embed ambiguously regardless of technique — an inherent hard case (even MeanCache reports
  non-zero false hits). Goal: measurably better than the naive alternatives, with instrumentation
  (in `telemetry-analytics`) to prove it — not a perfect classifier.

## Scope
- **In**: unified provider-agnostic chat endpoint; OpenAI/Anthropic/Ollama routing; BYOK
  (per-request header or stored encrypted per-tenant credentials); response normalization;
  dual-layer cache (exact Redis + semantic `pgvector`) with per-tenant isolation and
  configurable similarity threshold; retries to a secondary provider; per-provider/per-tenant
  circuit breaker; per-request telemetry with estimated cost saved; Prometheus metrics +
  Grafana dashboards; gateway API-key auth mapped to tenants; encrypted credential storage;
  a minimal admin/provisioning API; Redis token-bucket per-tenant rate limiting; Docker Compose.
- **Out**: streaming/SSE (stretch); dynamic weighted routing (stretch); Admin UI (stretch);
  a 4th provider; agent orchestration; gateway-side billing/invoicing/Stripe; a polished
  client UI (a Postman collection + `curl` examples in the README suffice).

## Constraints
- **Non-streaming v1** — streaming is a stretch goal only.
- Gateway is a **pure pass-through**; it never pays for LLM usage. A cache hit means the
  customer's provider key is not called.
- **Exactly three providers**: OpenAI, Anthropic, Ollama. Do not add a fourth.
- **Per-tenant cache isolation** — no cross-tenant cache sharing, even on semantic matches.
- Provider credentials are **encrypted at rest**, never logged in plaintext, and never
  surfaced in errors or telemetry.
- Cost tracking is **estimated savings only**, computed from a static in-repo pricing table.
- Failover in v1 is a **hardcoded primary → secondary** sequence (dynamic routing is stretch).

## Boundary Strategy
- **Why this split**: Auth/credentials, provider routing, caching, resilience, telemetry, and
  rate limiting are each independently testable concerns. Layering them over a shared
  `platform-foundation` lets later specs proceed in parallel waves once their dependencies land.
- **Shared seams to watch**:
  - **Request context object** (tenant id, selected provider, model, params, cache status,
    token usage, latency) threaded through gateway → cache → resilience → telemetry.
  - **Cache-key composition** couples caching to auth (tenant) and routing (model + key params).
  - **Provider adapter interface** is shared by `gateway-provider-routing` and `resilience-failover`.
  - **Credential retrieval** (per-request header vs stored encrypted) is owned by
    `auth-tenancy-credentials` and consumed by routing and failover.
  - **Conversation context for semantic matching**: `gateway-provider-routing` must surface the
    full message list (including the **last AI response**) into the request context, not just the
    latest user message, so `dual-layer-caching` can run topic-shift detection and context-chain
    verification. `telemetry-analytics` reads the detection/verification outcome to instrument the
    false-hit rate.

## Specs (dependency order)
- [ ] platform-foundation -- Fastify skeleton, config loading, Pino logging, Postgres+`pgvector` and Redis wiring, DB migrations, health endpoint, Docker Compose. Dependencies: none
- [ ] auth-tenancy-credentials -- tenant model, gateway API-key authentication, encrypted provider-credential storage, minimal admin/provisioning API. Dependencies: platform-foundation
- [ ] gateway-provider-routing -- `POST /v1/chat/completions`, provider-agnostic request schema, OpenAI/Anthropic/Ollama adapters, response normalization. Dependencies: platform-foundation, auth-tenancy-credentials
- [ ] rate-limiting -- Redis-backed token-bucket per-tenant rate limiting middleware. Dependencies: platform-foundation, auth-tenancy-credentials
- [ ] dual-layer-caching -- Redis exact-match + `pgvector` semantic cache using Ollama `nomic-embed-text`, configurable threshold, per-tenant isolation, **context-aware matching (topic-shift detection + context-chain verification + safety-biased fallback)**, cache-status signal. Dependencies: platform-foundation, gateway-provider-routing
- [ ] resilience-failover -- retry to a pre-configured secondary provider + per-provider/per-tenant circuit breaker with cooldown. Dependencies: platform-foundation, gateway-provider-routing, auth-tenancy-credentials
- [ ] telemetry-analytics -- structured per-request telemetry, estimated cost saved, Prometheus metrics export + Grafana dashboards. Dependencies: gateway-provider-routing, dual-layer-caching, resilience-failover

## Stretch (future phase — no briefs yet)
- [ ] streaming-support -- SSE pass-through from upstream providers with normalized stream structure; cache stores/replays the buffered full response.
- [ ] dynamic-weighted-routing -- route on real-time cost/latency metrics instead of a hardcoded failover sequence.
- [ ] admin-ui -- web interface for managing tenants, connecting/rotating provider keys, and toggling circuit breakers, built on top of the core admin/provisioning API.
