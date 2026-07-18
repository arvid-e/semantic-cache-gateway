# Requirements Document

## Project Description (Input)

Calling upstream providers costs the customer money and adds latency. Many prompts are exact or
near-duplicate repeats. Serving those from cache — without calling the customer's provider key — is
the entire value proposition of the gateway. But semantic caching on the latest user message alone
produces false cache hits on context-dependent follow-ups ("what command should I run?", "yes",
"teach me"), while embedding the whole conversation history kills the hit rate. Neither extreme is
acceptable.

This spec establishes: an exact-match cache keyed on `(tenant, model, key params, prompt)`; a
semantic cache that embeds the prompt locally (key-free, offline) and searches for the most similar
prior entry within the same tenant above a configurable similarity threshold; per-tenant isolation;
population, TTL, and invalidation rules; and **context-aware matching** — cheap topic-shift
detection first (compare the incoming user message to the last AI response), then context-chain
verification only on promising candidates, with a safety-biased fallback to a live provider call
whenever detection or verification is uncertain. Each request is tagged with its cache status and
its context-aware matching outcome for telemetry to consume.

**Known limitation (explicit, not hidden):** very short, low-information follow-ups ("yes", "ok")
embed ambiguously regardless of technique — an inherent hard case in the problem space (even
MeanCache reports non-zero false hits). The goal is a system measurably better than the naive
alternatives (full-history embedding, fixed sliding window, refine-on-every-request), with
instrumentation to prove it — not a perfect classifier.

Out of scope: the estimated-savings math and false-hit-rate dashboards/metrics
(`telemetry-analytics`); provider calls themselves and surfacing the conversation history into the
request context (`gateway-provider-routing`); retries and circuit breaking (`resilience-failover`);
and any cross-tenant cache sharing.

## Boundary Context

- **In scope**: the exact-match cache layer; the semantic cache layer (local key-free embeddings +
  similarity search with a configurable threshold); per-tenant cache isolation; cache population,
  TTL, and invalidation; storing each entry's originating conversation context; context-aware
  matching (topic-shift detection, context-chain verification, and safety-biased fallback); and the
  cache-status plus detection/verification-outcome signal written to the shared request context.
- **Out of scope**: computing estimated cost saved and the false-hit-rate dashboards/metrics
  (`telemetry-analytics` consumes the signals this spec exposes); calling providers on a miss
  (`gateway-provider-routing`); surfacing the conversation message list / last AI response into the
  request context (`gateway-provider-routing` owns the request schema and context population);
  retries and circuit breaking (`resilience-failover`); and cross-tenant cache sharing.
- **Adjacent expectations**: depends on `platform-foundation` (datastores, shared request context),
  `gateway-provider-routing` (provides the live completion on a miss and surfaces the conversation
  context this spec reads), and `auth-tenancy-credentials` (tenant identity for isolation).
  Downstream, `telemetry-analytics` reads the cache-status and detection/verification-outcome
  signals to compute savings, hit rate, and the false-hit rate.
- **Established constraint**: embeddings are generated locally by the in-stack Ollama
  `nomic-embed-text` model (768-dim) so the cache path calls no external keyed service. Correctness
  outranks hit rate: uncertainty always biases toward a live call, never a possibly-wrong hit.
- **Deferred to design**: the *mechanism* of context-chain verification (Requirement 6) — an
  embedding-based context comparison versus a small local-model call — is a design decision, bounded
  by two requirement-level constraints: it runs only on context-dependent messages that already have
  a candidate, and it must stay key-free (no external or provider call). A small **local** Ollama
  model call would satisfy the key-free constraint; an external LLM call would not.

## Requirements

### Requirement 1: Cache Lookup Flow & Provider Avoidance

**Objective:** As a customer, I want repeated prompts served from cache without calling my provider,
so that I save the cost and latency of that call.

#### Acceptance Criteria
1. When a completion request is received, the Gateway service shall check the exact-match cache first and shall check the semantic cache only on an exact-match miss.
2. When a cache lookup produces an accepted hit, the Gateway service shall return the cached normalized response and shall not call any provider.
3. When both cache layers miss or a semantic candidate is rejected, the Gateway service shall obtain a live response through `gateway-provider-routing` and then populate the cache.
4. The Gateway service shall return cached responses in the same normalized schema as live responses, so a client cannot distinguish a hit from a miss by response shape.

### Requirement 2: Exact-Match Cache Layer

**Objective:** As a customer, I want identical repeated prompts served instantly, so that exact
repeats cost nothing.

#### Acceptance Criteria
1. The Gateway service shall compose the exact-match cache key from the tenant identity, the resolved model, the cache-relevant request parameters, and the prompt content.
2. When an incoming request's exact-match key matches a stored entry, the Gateway service shall serve that entry as an exact cache hit.
3. If no stored entry matches the exact-match key, then the Gateway service shall treat the request as an exact-match miss and proceed to the semantic layer.

### Requirement 3: Semantic Cache Layer

**Objective:** As a customer, I want near-duplicate prompts served from cache, so that semantically
equivalent repeats also save cost.

#### Acceptance Criteria
1. When the exact-match layer misses, the Gateway service shall generate an embedding of the prompt and search for the most similar stored entry within the same tenant.
2. The Gateway service shall treat only stored entries whose similarity to the query is at or above the configured similarity threshold as candidate matches.
3. If no stored entry meets the configured similarity threshold, then the Gateway service shall treat the request as a semantic miss and obtain a live response.
4. The Gateway service shall generate embeddings locally without calling any external keyed service, so that the cache path calls no provider key.
5. The Gateway service shall expose the semantic similarity threshold as configuration.

### Requirement 4: Per-Tenant Cache Isolation

**Objective:** As a customer, I want my cached answers never served to another tenant, so that
caching creates no cross-tenant leakage.

#### Acceptance Criteria
1. The Gateway service shall scope every cache entry, exact and semantic, to the tenant that produced it.
2. When performing exact or semantic lookups, the Gateway service shall consider only cache entries owned by the requesting tenant.
3. The Gateway service shall never serve one tenant's cached response to another tenant, even when a semantic match would otherwise qualify.

### Requirement 5: Context-Aware Matching — Topic-Shift Detection

**Objective:** As a customer, I want context-dependent follow-ups handled safely, so that a short
follow-up does not match an unrelated cached answer.

#### Acceptance Criteria
1. When evaluating whether a message may use the semantic cache, the Gateway service shall classify the incoming user message as standalone or context-dependent by comparing its similarity to the last AI (assistant) response from the conversation.
2. When the similarity between the incoming user message and the last AI response is below the configured topic-shift threshold, the Gateway service shall treat the message as a topic shift (standalone) and shall accept a qualifying semantic candidate on the message alone, without performing context-chain verification.
3. When the similarity between the incoming user message and the last AI response is at or above the configured topic-shift threshold, the Gateway service shall treat the message as context-dependent and shall require context-chain verification (Requirement 6) to pass before accepting any semantic candidate; if the semantic search returns no candidate, the Gateway service shall treat the request as a semantic miss and obtain a live response.
4. When the conversation has no prior AI response, the Gateway service shall treat the message as standalone.
5. The Gateway service shall expose the topic-shift threshold as configuration.

### Requirement 6: Context-Aware Matching — Verification & Safety-Biased Fallback

**Objective:** As a customer, I want a candidate hit accepted only when its original context matches
mine, so that I never receive a wrong cached answer.

#### Acceptance Criteria
1. When a message is context-dependent, the Gateway service shall first obtain a semantic candidate from the semantic search and then verify that the candidate entry's stored originating context aligns with the current conversation before accepting it as a hit.
2. The Gateway service shall perform context-chain verification only for context-dependent messages that already have a semantic candidate, and shall not perform it on standalone messages or on requests for which the semantic search returned no candidate.
3. The Gateway service shall perform context-chain verification without calling any external or keyed provider, so that the cache path remains key-free; whether verification is embedding-based or uses a local model is deferred to the design phase.
4. When context-chain verification succeeds, the Gateway service shall accept the candidate as a semantic cache hit.
5. If context-chain verification fails or is inconclusive, then the Gateway service shall reject the candidate and obtain a live response instead of serving a possibly-wrong cached answer.
6. If topic-shift detection or context-chain verification cannot be performed reliably, then the Gateway service shall bias toward obtaining a live response rather than serving a cached one.
7. The Gateway service shall prioritize correctness over hit rate whenever detection or verification is uncertain.

### Requirement 7: Cache Population, TTL & Invalidation

**Objective:** As an operator, I want cache entries populated, expired, and invalidated correctly,
so that the cache stays fresh and later verification is possible.

#### Acceptance Criteria
1. When a live response is obtained on a cache miss, the Gateway service shall populate both the exact-match and semantic layers with the new entry.
2. When storing a semantic cache entry, the Gateway service shall store the entry's originating conversation context so that later context-chain verification is possible.
3. The Gateway service shall apply a configurable time-to-live to cache entries and shall not serve entries that have expired.
4. The Gateway service shall provide a means to invalidate cache entries.

### Requirement 8: Cache-Status & Detection-Outcome Signal

**Objective:** As a telemetry consumer, I want each request tagged with its cache outcome and its
detection/verification result, so that savings and the false-hit rate can be measured.

#### Acceptance Criteria
1. When a request completes, the Gateway service shall record its cache status in the shared request context as exactly one of `cache_hit_exact`, `cache_hit_semantic`, or `live_provider`.
2. When a request completes, the Gateway service shall record its context-aware matching outcome — the topic-shift decision and the verification result, including any fallback to live — in the shared request context.
3. The Gateway service shall ensure the recorded cache status accurately reflects whether a provider was actually called, so that telemetry can compute savings correctly.
4. The Gateway service shall not compute estimated savings or emit metrics itself, and shall only expose these signals for `telemetry-analytics` to consume.
