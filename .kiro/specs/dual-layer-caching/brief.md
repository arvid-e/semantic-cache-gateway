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
tagged `cache_hit_exact`, `cache_hit_semantic`, or `live_provider`. Crucially, semantic hits are
**context-aware**: context-dependent follow-ups ("what command should I run?", "yes", "teach me")
do not produce false hits against unrelated conversations, and uncertainty always biases toward
going live rather than serving a wrong cached answer.

## Approach
**Layer 1 (exact)**: hash the normalized prompt + cache-key namespace `(tenant, model, key
params)` and look up Redis. **Layer 2 (semantic)**: on a Layer-1 miss, embed the prompt via
Ollama `nomic-embed-text` (768-dim) and run a cosine-similarity search in `pgvector` scoped to
the tenant; a hit above the configured threshold serves the stored response. On a full miss,
call the provider (via routing), then populate both layers. The cache status (and the
detection/verification outcome) is written to the shared request context for telemetry.

**Context-aware semantic matching** (cheap detection first, expensive verification only when
needed — see the Semantic-Matching Correctness Decision in `roadmap.md`):
1. **Topic-shift detection** (near-free, reuses the embedding being computed): cosine-compare the
   incoming user message against the **last AI response** from the conversation (a denser anchor
   than a short follow-up). *Low* similarity → topic shifted → treat the message as standalone and
   search/store on the message alone. *High* similarity → likely context-dependent → proceed to
   verification.
2. **Context-chain verification on candidate matches** (MeanCache-style): let the semantic search
   return a candidate first, then verify the candidate's stored originating context actually aligns
   with the current conversation before accepting it as a real hit. This confines the expensive
   check to candidates that already look promising, not every request.
3. **Safety-biased fallback**: if detection is inconclusive or verification fails, skip the
   semantic cache and go live. A missed hit costs a little saving; a wrong cached answer costs
   correctness and trust.

## Scope
- **In**: exact-match Redis cache (hash + `(tenant, model, params)` namespace); semantic cache
  via Ollama embeddings + `pgvector` cosine search; configurable similarity threshold;
  per-tenant isolation; population/invalidation/TTL rules; **context-aware matching — topic-shift
  detection (incoming message vs last AI response), context-chain verification on candidate hits,
  and safety-biased fallback to live**; storing each cache entry's originating context so
  verification is possible; `cache_hit_exact` / `cache_hit_semantic` / `live_provider` status
  signal **plus the detection/verification outcome** written to the request context; integration
  wrapping the completion flow.
- **Out**: the estimated-savings math and false-hit-rate **dashboards/metrics** (telemetry-analytics
  consumes the outcome signal); provider calls themselves (gateway-provider-routing); the request
  schema / surfacing conversation history into context (gateway-provider-routing owns that);
  retries/circuit breaking (resilience-failover); cross-tenant cache sharing.

## Boundary Candidates
- Cache-key composition (tenant, model, params, prompt hash)
- Exact-match (Redis) layer
- Embedding + semantic (`pgvector`) layer
- Topic-shift detection (incoming message vs last AI response)
- Context-chain verification + safety-biased fallback
- Threshold configuration & isolation
- Completion-flow integration + cache-status / detection-outcome signal

## Out of Boundary
- Computing estimated cost saved and the false-hit-rate instrumentation dashboards
  (telemetry-analytics consumes the cache-status + detection-outcome signals)
- Surfacing the conversation message list / last AI response into the request context
  (gateway-provider-routing owns the request schema and context population)
- Choosing/calling providers on a miss (delegates to gateway-provider-routing)

## Upstream / Downstream
- **Upstream**: platform-foundation, gateway-provider-routing (which must surface the conversation
  message list + last AI response into the request context), and tenant context from auth.
- **Downstream**: telemetry-analytics reads the cache-status **and detection/verification outcome**
  signals to compute savings/hit rate and instrument the false-hit rate.

## Existing Spec Touchpoints
- **Extends**: gateway-provider-routing (wraps the completion flow before/after provider calls).
- **Adjacent**: cache-key namespace couples to auth (tenant) and routing (model/params) — reuse those contracts.

## Constraints
- Per-tenant isolation; never serve one tenant's cached answer to another, even on semantic match.
- Embeddings via local Ollama `nomic-embed-text` (768-dim) → `pgvector(768)` column; key-free and offline.
- Similarity threshold configurable; topic-shift and verification thresholds are configurable too.
- Cache hit = provider key not called; the status signal must be accurate for telemetry.
- **Uncertainty biases toward going live, never toward a possibly-wrong cached answer.** Correctness
  outranks hit rate.
- **Known limitation (documented, not hidden)**: very short, low-information follow-ups ("yes",
  "ok") embed ambiguously regardless of technique — an inherent hard case in the problem space
  (even MeanCache reports non-zero false hits), not a flaw unique to this design. The goal is to be
  measurably better than the naive alternatives (full-history embedding, fixed sliding window,
  refine-on-every-request), with instrumentation to prove it — not a perfect classifier.
