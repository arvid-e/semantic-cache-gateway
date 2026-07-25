# Implementation Plan

> **Solo implementation note:** Work top-to-bottom; ignore `(P)` markers. Open `design.md`
> (File Structure Plan + Components + the **decision table**) for the concrete interfaces, make the
> observable bullet true, then run the checks. The orchestrator (group 3) is split into a walking
> skeleton first, then semantic, then verification — build and test each layer before the next.
> See `.kiro/steering/implementation-guide.md`.

- [ ] 1. Foundation: schema, config, contracts, and utilities
- [ ] 1.1 Author the semantic-cache migration
  - Add this spec's migration creating `semantic_cache_entries` with `prompt_embedding` and nullable `originating_context_embedding` as `vector(768)`, the stored normalized response, `expires_at`, and a tenant foreign key; add the HNSW cosine index and the scope and expiry indexes
  - Observable: running migrations creates the table with both `vector(768)` columns, the HNSW `vector_cosine_ops` index on the prompt embedding, the `(tenant_id, model, params_hash)` and `expires_at` indexes, and the tenant foreign key
  - _File: migrations/{timestamp}_semantic_cache.sql_
  - _Requirements: 4.1, 7.2_
- [ ] 1.2 (P) Implement the cache config segment
  - Validate the cache environment segment: similarity, topic-shift, and verification thresholds; exact and semantic TTLs; and the embedding model name — with fail-fast, secret-safe semantics
  - Observable: an invalid or missing cache setting fails plugin configuration naming the setting, and a valid environment yields a typed config exposing the three thresholds, the two TTLs, and the embedding model
  - _File: src/modules/cache/config.ts_
  - _Requirements: 3.5, 5.5, 7.3_
  - _Boundary: Cache Config_
- [ ] 1.3 (P) Implement the cache status vocabulary, outcome types, and context signals
  - Define the canonical cache-status values, the detection/verification outcome type, and the entry/candidate contracts; refine the shared request context to the canonical status and add the outcome field with defaults; provide the writer that records exactly one status and one outcome
  - Observable: the status and outcome contracts are exported with defaults, writing records exactly one status and one outcome per request, and no savings or metrics are computed here
  - _File: src/modules/cache/types.ts, src/modules/cache/context.ts, src/platform/context/types.ts (refine CacheStatus)_
  - _Requirements: 8.1, 8.2, 8.4_
  - _Boundary: Cache Types, Context Signals_
- [ ] 1.4 (P) Implement the key composer and cosine utility
  - Compose the cache-key parameter hash and the exact-match key from the tenant, resolved model, cache-relevant params, and canonicalized conversation; implement cosine similarity for two embedding vectors
  - Observable: identical tenant/model/params/messages produce the same exact key while any change produces a different one, and the cosine utility returns the correct similarity for known vectors
  - _File: src/modules/cache/key-composer.ts, src/modules/cache/cosine.ts_
  - _Requirements: 2.1, 4.1_
  - _Boundary: Key Composer, Cosine_

- [ ] 2. Core: cache layers, embeddings, and context-aware matching
- [ ] 2.1 (P) Implement the local embedding client
  - Batch-embed texts through the in-stack Ollama embed endpoint using the configured model, returning 768-dim vectors and signaling an embedding-unavailable condition on failure without any external keyed call
  - Observable: the client returns 768-dim embeddings for a batch of texts and raises the embedding-unavailable signal when the local embedder errors
  - _File: src/modules/cache/embedding-client.ts_
  - _Requirements: 3.1, 3.4, 6.3_
  - _Boundary: Embedding Client_
  - _Depends: 1.2_
- [ ] 2.2 (P) Implement the exact-match cache layer
  - Store and retrieve the normalized response under a tenant-scoped hashed key with a configurable TTL, and support invalidation by tenant
  - Observable: a set followed by a get returns the stored normalized response within TTL, a different tenant's key never matches, an expired entry is not returned, and invalidation removes a tenant's entries
  - _File: src/modules/cache/exact-cache.ts_
  - _Requirements: 2.2, 2.3, 4.2, 7.1, 7.3, 7.4_
  - _Boundary: Exact Cache_
  - _Depends: 1.3, 1.4_
- [ ] 2.3 (P) Implement the semantic cache layer
  - Store entries (prompt text/embedding, originating-context embedding, response, expiry) and search for the nearest entry within the requesting tenant, model, and params that is unexpired and at or above the similarity threshold; support invalidation by tenant
  - Observable: a stored entry is returned as a candidate above threshold, entries below threshold or owned by another tenant or expired are never returned, the originating context is persisted for later verification, and invalidation removes a tenant's entries
  - _File: src/modules/cache/semantic-cache.ts_
  - _Requirements: 3.1, 3.2, 4.1, 4.2, 4.3, 7.1, 7.2, 7.3, 7.4_
  - _Boundary: Semantic Cache_
  - _Depends: 1.1, 1.3_
- [ ] 2.4 (P) Implement topic-shift detection
  - Classify the incoming user message as standalone or context-dependent by comparing its similarity to the last AI response against the topic-shift threshold, treating a conversation with no prior AI response as standalone
  - Observable: no prior AI response yields standalone, a similarity below the threshold yields standalone, and a similarity at or above the threshold yields context-dependent
  - _File: src/modules/cache/topic-shift-detector.ts_
  - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - _Boundary: Topic-Shift Detector_
  - _Depends: 1.2, 1.4_
- [ ] 2.5 (P) Implement context-chain verification
  - Verify a context-dependent candidate by comparing the current conversation's last-AI-response embedding to the candidate's stored originating-context embedding against the verification threshold, treating a missing stored context as inconclusive, using no external or keyed call
  - Observable: an aligned context at or above the threshold passes, a below-threshold context fails, and a candidate with no stored originating context is inconclusive
  - _File: src/modules/cache/context-chain-verifier.ts_
  - _Requirements: 6.1, 6.3, 6.4, 6.5_
  - _Boundary: Context-Chain Verifier_
  - _Depends: 1.2, 1.4_

- [ ] 3. Integration: orchestration (build in three layers) and wiring
- [ ] 3.1 Implement the orchestrator skeleton: exact layer, live fallback, and signals
  - Implement the cached completion service's outer skeleton: check the exact layer first and return its hit without calling the wrapped completion service; on an exact miss (for now, unconditionally), call the wrapped completion service, populate both cache layers with the new entry (including the originating context) and TTL, and write the cache status and outcome
  - Observable: a repeated identical request returns an exact hit without invoking the wrapped completion service, a non-repeat calls it once and populates both layers, and the request records `cache_hit_exact` or `live_provider` matching whether the provider was called
  - _File: src/modules/cache/cache-orchestrator.ts_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.3, 7.1, 8.1, 8.2, 8.3_
  - _Boundary: Cache Orchestrator_
  - _Depends: 2.1, 2.2, 2.3_
- [ ] 3.2 Add the semantic standalone path (embed + topic-shift + search)
  - On an exact miss, embed the latest user message (and last AI response), run topic-shift detection, and on a standalone classification accept a qualifying semantic candidate as a semantic hit or, with no candidate, fall through to live; fall back to live if embedding is unavailable
  - Observable: a near-duplicate standalone prompt returns `cache_hit_semantic` when a candidate is above threshold and goes live when none qualifies, and an embedding failure goes live
  - _File: src/modules/cache/cache-orchestrator.ts_
  - _Requirements: 3.3, 5.2, 6.6_
  - _Boundary: Cache Orchestrator_
  - _Depends: 3.1, 2.4_
- [ ] 3.3 Add the context-dependent path: verification and safety-biased fallback
  - For a context-dependent classification, require context-chain verification of the semantic candidate before accepting it; accept on verification pass, and on verification failure, an inconclusive result, no candidate, or any uncertainty, fall back to a live response — prioritizing correctness over hit rate
  - Observable: a context-dependent follow-up whose candidate verifies is accepted as `cache_hit_semantic`, while a follow-up matching an unrelated candidate (or any uncertain case) falls back to live
  - _File: src/modules/cache/cache-orchestrator.ts_
  - _Requirements: 5.3, 6.2, 6.4, 6.5, 6.7_
  - _Boundary: Cache Orchestrator_
  - _Depends: 3.2, 2.5_
- [ ] 3.4 Register the plugin and route the completion flow through the cache
  - Register the cache plugin onto the foundation app after the gateway, wire the completion route to the cached completion service wrapping the underlying one, align the foundation cache-status vocabulary to the canonical values, and document the cache environment variables
  - Observable: the app boots with the completion route served through the cache wrapper so the provider is called only on a miss, and the shared cache-status field reflects the canonical values
  - _File: src/modules/cache/index.ts, src/app.ts_
  - _Requirements: 8.3_
  - _Depends: 3.3_

- [ ] 4. Validation: caching integration tests
- [ ] 4.1 Add integration tests against dockerized Postgres, Redis, and Ollama
  - Exercise: a repeated identical request returns an exact hit without calling the provider; a near-duplicate standalone prompt returns a semantic hit above threshold and goes live below it; a context-dependent follow-up matching an unrelated entry is rejected by verification and goes live while a genuinely aligned follow-up is accepted; one tenant's entries are never returned to another; and a miss populates both layers with the originating context, respects TTL, and can be invalidated
  - Observable: the integration suite passes, proving exact and semantic hits, context-aware acceptance and rejection, per-tenant isolation, and population/TTL/invalidation behavior end to end
  - _File: src/modules/cache/cache.integration.test.ts_
  - _Requirements: 1.1, 1.2, 2.2, 3.1, 3.2, 3.3, 4.1, 4.3, 5.2, 6.1, 6.4, 6.5, 7.1, 7.3, 7.4_
  - _Depends: 3.4_
