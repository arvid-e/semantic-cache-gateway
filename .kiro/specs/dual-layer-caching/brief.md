# Brief: dual-layer-caching

## Problem
Calling upstream providers costs the customer money and adds latency. Many prompts are exact
or near-duplicate repeats. Serving those from cache — without calling the customer's provider
key — is the entire value proposition of the gateway.

## Current State
`gateway-provider-routing` can serve a normalized completion by calling a provider with the
tenant's key. Every request currently hits a live provider. Ollama (for embeddings) and
Postgres/`pgvector` are available from the foundation.

## Desired Outcome
Before calling a provider, the gateway checks an exact-match cache, then a semantic cache. On
a hit it returns the cached normalized response and does **not** call the provider. Caching is
isolated per tenant, the semantic similarity threshold is configurable, and each response is
tagged `cache_hit_exact`, `cache_hit_semantic`, or `live_provider`.

## Approach
**Layer 1 (exact)**: hash the normalized prompt + cache-key namespace `(tenant, model, key
params)` and look up Redis. **Layer 2 (semantic)**: on a Layer-1 miss, embed the prompt via
Ollama `nomic-embed-text` (768-dim) and run a cosine-similarity search in `pgvector` scoped to
the tenant; a hit above the configured threshold serves the stored response. On a full miss,
call the provider (via routing), then populate both layers. The cache status is written to the
shared request context for telemetry.

## Scope
- **In**: exact-match Redis cache (hash + `(tenant, model, params)` namespace); semantic cache
  via Ollama embeddings + `pgvector` cosine search; configurable similarity threshold;
  per-tenant isolation; population/invalidation/TTL rules; `cache_hit_exact` /
  `cache_hit_semantic` / `live_provider` status signal; integration wrapping the completion flow.
- **Out**: the estimated-savings math and dashboards (telemetry-analytics); provider calls
  themselves (gateway-provider-routing); retries/circuit breaking (resilience-failover);
  cross-tenant cache sharing.

## Boundary Candidates
- Cache-key composition (tenant, model, params, prompt hash)
- Exact-match (Redis) layer
- Embedding + semantic (`pgvector`) layer
- Threshold configuration & isolation
- Completion-flow integration + cache-status signal

## Out of Boundary
- Computing estimated cost saved (telemetry-analytics consumes the cache-status signal)
- Choosing/calling providers on a miss (delegates to gateway-provider-routing)

## Upstream / Downstream
- **Upstream**: platform-foundation, gateway-provider-routing (and tenant context from auth).
- **Downstream**: telemetry-analytics reads the cache-status signal to compute savings/hit rate.

## Existing Spec Touchpoints
- **Extends**: gateway-provider-routing (wraps the completion flow before/after provider calls).
- **Adjacent**: cache-key namespace couples to auth (tenant) and routing (model/params) — reuse those contracts.

## Constraints
- Per-tenant isolation; never serve one tenant's cached answer to another, even on semantic match.
- Embeddings via local Ollama `nomic-embed-text` (768-dim) → `pgvector(768)` column; key-free and offline.
- Similarity threshold configurable.
- Cache hit = provider key not called; the status signal must be accurate for telemetry.
