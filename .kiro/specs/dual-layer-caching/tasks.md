# Implementation Plan

> **Solo implementation note:** Work top-to-bottom; ignore `(P)` markers. Open `design.md`
> (File Structure Plan + Components + the **outcome table**) for the concrete interfaces, make the
> observable bullet true, then run the checks. See `.kiro/steering/implementation-guide.md`.

> **Revised 2026-08-08 — shadow mode.** The semantic layer's acceptance rule was measured before
> being built and is unsafe at every threshold; topic-shift detection performs below chance. The
> full evidence is in `research.md` → **Measurement Log** (E1–E4); it used to live in this file and
> was moved so this stays a checklist. What changed here:
> - **2.4 topic-shift detection — deleted.** Req 5 withdrawn.
> - **2.3, 2.5 — unblocked, reduced.** Store/search mechanics are unaffected; the verifier survives
>   as an advisory instrument that gates nothing.
> - **3.2, 3.3 — replaced** by a single shadow-observation task. There is no acceptance path to build.
> - **Group 4 — new.** The false-hit benchmark (Req 9) is now this spec's headline deliverable. It
>   depends only on 2.1, so it can be built at any point — and if time runs short, **build group 4
>   before group 3**: the benchmark carries the finding, the shadow runtime demonstrates it.
>
> The one rule that governs group 3: **no code path may return a semantic candidate to a client.**

- [x] 1. Foundation: schema, config, contracts, and utilities
- [x] 1.1 Author the semantic-cache migration
  - Add this spec's migration creating `semantic_cache_entries` with `prompt_embedding` and nullable `originating_context_embedding` as `vector(768)`, the stored normalized response, `expires_at`, and a tenant foreign key; add the HNSW cosine index and the scope and expiry indexes
  - Observable: running migrations creates the table with both `vector(768)` columns, the HNSW `vector_cosine_ops` index on the prompt embedding, the `(tenant_id, model, params_hash)` and `expires_at` indexes, and the tenant foreign key
  - _File: migrations/{timestamp}_semantic_cache.sql_
  - _Requirements: 4.1, 7.2_
- [x] 1.2 (P) Implement the cache config segment
  - Validate the cache environment segment: similarity, topic-shift, and verification thresholds; exact and semantic TTLs; and the embedding model name — with fail-fast, secret-safe semantics
  - _Shipped 2026-08-03, before the revision. The topic-shift threshold it validates is now dead; task 1.5 removes it._
  - Observable: an invalid or missing cache setting fails plugin configuration naming the setting, and a valid environment yields a typed config exposing the three thresholds, the two TTLs, and the embedding model
  - _File: src/modules/cache/config.ts_
  - _Requirements: 3.5, ~~5.5~~ (withdrawn), 7.3_
  - _Boundary: Cache Config_
- [x] 1.3 (P) Implement the cache status vocabulary, outcome types, and context signals
  - Define the canonical cache-status values, the detection/verification outcome type, and the entry/candidate contracts; refine the shared request context to the canonical status and add the outcome field with defaults; provide the writer that records exactly one status and one outcome
  - Observable: the status and outcome contracts are exported with defaults, writing records exactly one status and one outcome per request, and no savings or metrics are computed here
  - _File: src/modules/cache/types.ts, src/modules/cache/context.ts, src/platform/context/types.ts (refine CacheStatus)_
  - _Requirements: 8.1, 8.2, 8.4_
  - _Boundary: Cache Types, Context Signals_
- [x] 1.4 (P) Implement the key composer and cosine utility
  - Compose the cache-key parameter hash and the exact-match key from the tenant, resolved model, cache-relevant params, and canonicalized conversation; implement cosine similarity for two embedding vectors
  - Observable: identical tenant/model/params/messages produce the same exact key while any change produces a different one, and the cosine utility returns the correct similarity for known vectors
  - _File: src/modules/cache/key-composer.ts, src/modules/cache/cosine.ts_
  - _Requirements: 2.1, 4.1_
  - _Boundary: Key Composer, Cosine_
- [x] 1.5 Remove the withdrawn topic-shift contract from shipped code (revision cleanup)
  - Tasks 1.2 and 1.3 shipped before the revision and left dead surface behind: `TopicShiftDecision` and the `topicShift` / `topicShiftSimilarity` fields in `types.ts` (and their assertions in `context.test.ts`), plus `CACHE_TOPIC_SHIFT_THRESHOLD` in `config.ts`, `config.test.ts`, and `.env.example`. Delete all of it, and add `shadowError` to `CacheOutcome` per the revised design
  - Delete rather than deprecate. A threshold that configures nothing is a trap for the next reader, and leaving `topicShift` in the outcome type invites `telemetry-analytics` to consume a field that will never be populated
  - Observable: no `topicShift`, `TopicShiftDecision`, or `CACHE_TOPIC_SHIFT_THRESHOLD` remains anywhere in `src/` or `.env.example`; `CacheOutcome` matches the revised design; `npm run typecheck` and `npm test` pass
  - _File: src/modules/cache/types.ts, src/modules/cache/context.ts, src/modules/cache/config.ts, .env.example_
  - _Requirements: 8.2 (Req 5 withdrawn)_

- [ ] 2. Core: cache layers, embeddings, and the advisory verdict
- [x] 2.1 (P) Implement the local embedding client
  - Batch-embed texts through the in-stack Ollama embed endpoint using the configured model, returning 768-dim vectors and signaling an embedding-unavailable condition on failure without any external keyed call
  - Observable: the client returns 768-dim embeddings for a batch of texts and raises the embedding-unavailable signal when the local embedder errors
  - _File: src/modules/cache/embedding-client.ts_
  - _Requirements: 3.1, 3.4, 6.3_
  - _Boundary: Embedding Client_
  - _Depends: 1.2_
- [x] 2.2 (P) Implement the exact-match cache layer
  - Store and retrieve the normalized response under a tenant-scoped hashed key with a configurable TTL, and support invalidation by tenant
  - Observable: a set followed by a get returns the stored normalized response within TTL, a different tenant's key never matches, an expired entry is not returned, and invalidation removes a tenant's entries
  - _File: src/modules/cache/exact-cache.ts_
  - _Requirements: 2.2, 2.3, 4.2, 7.1, 7.3, 7.4_
  - _Boundary: Exact Cache_
  - _Depends: 1.3, 1.4_
- [ ] 2.3 (P) Implement the semantic cache layer
  - Store entries (prompt text/embedding, originating-context embedding, response, expiry) and search for the nearest entry within the requesting tenant, model, and params that is unexpired and at or above the similarity threshold; support invalidation by tenant
  - Unchanged by the revision — the store/search/invalidate mechanics were never what failed. What changed is downstream: a returned candidate is an observation, not an authorization (Req 3.2). Return the best similarity even when it falls below the threshold, so the shadow signal can record the distribution
  - Observable: a stored entry is returned as a candidate above threshold, entries below threshold or owned by another tenant or expired are never returned as candidates, the best similarity is reported regardless, the originating context is persisted, and invalidation removes a tenant's entries
  - _File: src/modules/cache/semantic-cache.ts_
  - _Requirements: 3.1, 3.2, 4.1, 4.2, 4.3, 7.1, 7.2, 7.3, 7.4_
  - _Boundary: Semantic Cache_
  - _Depends: 1.1, 1.3_
- [x] ~~2.4 (P) Implement topic-shift detection~~ — **DELETED 2026-08-08, Req 5 withdrawn**
  - Not deferred and not blocked: the mechanism performs at or below chance (AUC 0.2678–0.3632 across two models and three prefix variants, 0.5 = chance) and is not fixable by tuning. See `research.md` → E3
  - Nothing to build. `src/modules/cache/topic-shift-detector.ts` is not created. Checked off so the group can close; the strikethrough is the record
  - _Requirements: ~~5.1, 5.2, 5.3, 5.4~~ (withdrawn)_
- [ ] 2.5 (P) Implement the advisory context-chain verdict
  - Compare the current conversation's last-AI-response embedding to a candidate's stored originating-context embedding against the verification threshold, treating a missing stored context as inconclusive, using no external or keyed call
  - **This gates nothing** (Req 6.5). It returns a verdict that is written to `cacheOutcome` and read by no branch. Name it so that is obvious at the call site, and do not give it a boolean-returning convenience wrapper — that is the shape that invites a future `if`
  - Observable: an aligned context at or above the threshold yields `passed`, a below-threshold context yields `failed`, a candidate with no stored originating context yields `inconclusive`, and no caller branches on the result
  - _File: src/modules/cache/context-chain-verifier.ts_
  - _Requirements: 6.1, 6.3, 6.4, 6.5_
  - _Boundary: Context-Chain Verifier_
  - _Depends: 1.2, 1.4_

- [ ] 3. Integration: orchestration (two layers) and wiring
- [ ] 3.1 Implement the orchestrator skeleton: exact layer, live path, and signals
  - Implement the cached completion service's outer skeleton: check the exact layer first and return its hit without calling the wrapped completion service; on an exact miss, call the wrapped completion service, populate both cache layers with the new entry (including the originating context) and TTL, and write the cache status and outcome
  - The "unconditionally" that used to be a temporary scaffold here is now the permanent behaviour (Req 3.3). Task 3.2 adds observation around this path, never a branch through it
  - Observable: a repeated identical request returns an exact hit without invoking the wrapped completion service, a non-repeat calls it once and populates both layers, and the request records `cache_hit_exact` or `live_provider` matching whether the provider was called
  - _File: src/modules/cache/cache-orchestrator.ts_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.3, 7.1, 8.1, 8.2, 8.3_
  - _Boundary: Cache Orchestrator_
  - _Depends: 2.1, 2.2, 2.3_
- [ ] 3.2 Add the shadow observation (embed + search + advisory verdict), serving nothing
  - On an exact miss, after the live path is already determined, embed the latest user message and last AI response, run the semantic search, compute the advisory verdict when a candidate is found, and record candidate presence, best similarity, verdict, and any shadow error to the outcome signal. Catch and record every failure inside this path; it must not fail, delay, or alter the request
  - Replaces the former 3.2 and 3.3 (the standalone-accept and verified-accept paths). There is no acceptance branch to build — that is the revision
  - Write the code so the candidate is not in scope where the response is produced. If a reviewer has to trace a boolean to see whether a candidate can be served, the structure is wrong
  - Observable: a near-duplicate prompt records a candidate above threshold **and the wrapped completion service is still called exactly once**; a candidate at similarity 1.0 with a `passed` verdict is still not served; an embedder outage records `shadowError` and the request succeeds live; `cache_hit_semantic` is never written
  - _File: src/modules/cache/cache-orchestrator.ts_
  - _Requirements: 1.5, 3.3, 3.6, 6.2, 6.5, 8.2, 8.5_
  - _Boundary: Cache Orchestrator_
  - _Depends: 3.1, 2.3, 2.5_
- [ ] 3.4 Register the plugin and route the completion flow through the cache
  - Register the cache plugin onto the foundation app after the gateway, wire the completion route to the cached completion service wrapping the underlying one, align the foundation cache-status vocabulary to the canonical values, and document the cache environment variables
  - Observable: the app boots with the completion route served through the cache wrapper so the provider is called only on a miss, and the shared cache-status field reflects the canonical values
  - _File: src/modules/cache/index.ts, src/app.ts_
  - _Requirements: 8.3_
  - _Depends: 3.2_

- [ ] 4. Measurement: the false-hit benchmark (Req 9 — this spec's headline deliverable)
  > Depends only on 2.1. Buildable at any point, and **the last thing to cut**: it carries the
  > finding on its own, whereas the shadow runtime without it is a cache that does nothing.
- [ ] 4.1 Commit the labelled fixture set
  - Author `prompt-pairs.json`: prompt pairs each labelled with whether one cached answer legitimately serves both, tagged by failure class (`paraphrase`, `direction-inversion`, `negation`, `entity-swap`, …). Reconstruct the 20 paraphrase + 20 near-miss pairs used in E1/E2/E4 and the 39 follow-up / 18 same-domain-new-topic items from E3 so the recorded numbers are reproducible
  - Label by what a correct system *must* do, decided before running anything. A fixture edited after seeing a score is no longer evidence
  - Observable: the fixture file is committed, every entry carries a label and a class, and the class breakdown covers the failure families named in `research.md`
  - _File: scripts/bench/fixtures/prompt-pairs.json_
  - _Requirements: 9.1_
- [ ] 4.2 Implement the benchmark harness
  - Load the fixtures, embed both sides through the same embedding client the runtime uses, apply each registered acceptance rule, and report per rule: false accepts, recall, similarity distribution per class, AUC, and the best threshold achieving zero false accepts. Register the threshold rule of Req 3.2 today, behind an interface a future mechanism can also implement
  - Report; do not assert (Req 9.4). Exit 0 whatever the numbers say, and keep it out of both Vitest projects (Req 9.6) — wire it as `npm run bench:false-hit`
  - Observable: one documented command prints the per-rule report against the committed fixtures, reproducing the `research.md` figures within run-to-run noise; a second rule can be registered and appears in the same report without touching the harness
  - _File: scripts/bench/false-hit-bench.ts, scripts/bench/acceptance-rules.ts_
  - _Requirements: 9.2, 9.3, 9.4, 9.5, 9.6_
  - _Boundary: Benchmark Harness_
  - _Depends: 2.1_
- [ ] 4.3 Write the findings report
  - Summarize the measured result for a reader who was not here: what was claimed, what was measured, what the numbers were, what was decided, and what would change the decision. Link it from the README. State plainly that the semantic hit rate is zero and why that was the correct outcome rather than a failure to finish
  - Observable: a reader unfamiliar with the project can, from this document plus one command, reproduce the headline numbers and explain why the semantic layer does not serve
  - _File: .kiro/specs/dual-layer-caching/findings.md, README.md_
  - _Requirements: 9.3_
  - _Depends: 4.2_

- [ ] 5. Validation: caching integration tests
- [ ] 5.1 Add integration tests against dockerized Postgres, Redis, and Ollama
  - Exercise: a repeated identical request returns an exact hit without calling the provider; a near-duplicate prompt records a semantic candidate above threshold **and still calls the provider**; an embedder outage still completes the request live with `shadowError` recorded; one tenant's entries are never returned to another; and a miss populates both layers with the originating context, respects TTL, and can be invalidated
  - Include the short low-information case end to end against the real embedder: a bare "yes"/"ok" after one conversation matches the same word after an unrelated one at ~1.0 similarity. Assert that this is *recorded as a candidate and not served*. This is the case that motivated the revision; it is the regression guard against anyone re-enabling serving
  - Observable: the integration suite passes, proving the exact hit, shadow recording without serving, per-tenant isolation, population/TTL/invalidation, and that no request in the suite ever returned a semantically matched response
  - _File: src/modules/cache/cache.integration.test.ts_
  - _Requirements: 1.1, 1.2, 1.5, 2.2, 3.1, 3.2, 3.3, 3.6, 4.1, 4.3, 6.1, 7.1, 7.3, 7.4, 8.5_
  - _Depends: 3.4_
