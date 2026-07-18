# Research & Design Decisions

## Summary
- **Feature**: `dual-layer-caching`
- **Discovery Scope**: Complex Integration — wraps the `gateway-provider-routing` completion flow with an exact (Redis) + semantic (`pgvector`) cache and the roadmap's context-aware matching strategy; discovery focused on the local embedding API, `pgvector` cosine search/indexing, and the deferred context-chain verification mechanism.
- **Key Findings**:
  - Ollama's current embeddings endpoint is **`/api/embed`** (`{model, input:[...]}` → `{embeddings:[[...]]}`), batch-capable; `/api/embeddings` is legacy. `nomic-embed-text` outputs **768-dim** vectors — key-free and offline (Req 3.4).
  - `pgvector` cosine search uses the **`<=>`** operator with an **HNSW `vector_cosine_ops`** index; the query must use `<=>` to use the index. Cosine distance `= 1 − cosine similarity`, so a similarity threshold `t` maps to a distance predicate `<= 1 − t`.
  - **Context-chain verification (Req 6.3) is best done embedding-based**, not via a local-model call: it reuses embeddings already computed, is deterministic and sub-millisecond, and stays key-free — matching "cheap detection first, expensive verification only on candidates."
  - The batch `/api/embed` call lets the incoming user message and the conversation's last AI response be embedded together, so **topic-shift detection and verification share the same embeddings** with no extra provider round-trips.

## Research Log

### Local embeddings via Ollama `nomic-embed-text`
- **Context**: Req 3.1/3.4 require locally generated embeddings with no external keyed call.
- **Sources Consulted**: Ollama `nomic-embed-text` model page; Ollama API docs (see References).
- **Findings**: `POST {OLLAMA_URL}/api/embed` with `{ "model": "nomic-embed-text", "input": [text, ...] }` returns `{ "embeddings": [[...768 floats...], ...] }`. 768 dimensions. Runs entirely in-stack (the foundation already runs Ollama).
- **Implications**: One batch call per request embeds the latest user message and the last AI response together. Store prompt embeddings as `vector(768)`. Embedding failure triggers the safety-biased fallback to live (Req 6.6).

### `pgvector` cosine search and indexing
- **Context**: Req 3.1–3.3 require nearest-entry search above a configurable similarity threshold, scoped per tenant.
- **Sources Consulted**: `pgvector` README; HNSW/cosine guides (see References).
- **Findings**: Cosine distance operator `<=>`; HNSW index `USING hnsw (prompt_embedding vector_cosine_ops)`; `ef_search` tunes recall. Query: `... ORDER BY prompt_embedding <=> $q LIMIT 1`, filtered by tenant/model/params and non-expiry. A candidate qualifies when `1 - distance >= similarityThreshold`.
- **Implications**: Store entries in `semantic_cache_entries(tenant_id, model, params_hash, prompt_embedding vector(768), originating_context_embedding vector(768) NULL, response_json, expires_at)` with an HNSW cosine index. Scope the search to `(tenant_id, model, params_hash)` and `expires_at > now()` for correctness and isolation (Req 4).

### Context-chain verification mechanism (deferred decision, Req 6.3)
- **Context**: Verification must be key-free and confined to context-dependent messages that already have a candidate.
- **Sources Consulted**: roadmap Semantic-Matching Correctness Decision; MeanCache-style prior art.
- **Findings**: Two viable key-free mechanisms — (A) embedding-based context comparison; (B) a small local Ollama chat-model call. (B) adds a generation call per candidate (latency, nondeterminism) for marginal benefit; (A) reuses the embeddings already computed for topic-shift detection.
- **Decision**: **Embedding-based.** Store each entry's originating context = the embedding of the last AI response that preceded it; verify by cosine-comparing the current conversation's last-AI-response embedding to the candidate's stored originating-context embedding against a configurable verification threshold. A missing stored context (candidate had no prior AI turn) is treated as inconclusive → live (safety bias).
- **Implications**: Adds one nullable `vector(768)` column and one in-app cosine comparison per verified candidate; no extra provider/network call.

### Wrapping the completion flow
- **Context**: The cache must run before the provider and populate after a miss, without owning provider calls or context surfacing.
- **Sources Consulted**: `gateway-provider-routing/design.md`, `platform-foundation/design.md` (this repo).
- **Findings**: Gateway exposes a wrappable `CompletionService` and surfaces the conversation context (`messages`, `latestUserMessage`, `lastAssistantMessage`) into `RequestContext`. The foundation `RequestContext` has a placeholder `cacheStatus`.
- **Implications**: Implement a `CachedCompletionService` with the same contract that calls the injected `CompletionService` only on a miss/reject. Read `latestUserMessage`/`lastAssistantMessage` from context (do not re-surface them). Refine the canonical `cacheStatus` vocabulary to the three required values and add a `cacheOutcome` field (documented foundation revalidation).

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Decorator over `CompletionService` + layered cache services | Cache orchestrator wraps the completion service; exact/semantic/detector/verifier as cohesive units | Clean seam; correctness-first branching in one place; testable units | Orchestration logic is the correctness-critical hotspot | **Selected** |
| Embed full conversation history | Embed the whole message list | Captures context | Histories become unique after 1–2 turns → hit rate collapses | Rejected (roadmap) |
| Fixed sliding window (last 2–3 turns) | Embed a fixed window | Simple | Breaks on cascading reference chains | Rejected (roadmap) |
| Refine/condense every request via a model | LLM rewrite before matching | Higher precision | Adds latency/cost to every request incl. misses | Rejected (roadmap) |
| Local-model context verification | Ask a local chat model if contexts align | Nuanced | Per-candidate generation latency; nondeterministic | Rejected in favor of embedding-based |

## Design Decisions

### Decision: Exact key on the full conversation; semantic match on the latest user message
- **Context**: Req 2.1, 3.1.
- **Selected Approach**: Exact key = `hash(tenant | model | params_hash | canonical(messages[]))` so only identical conversations exact-hit. Semantic layer embeds the latest user message and searches within `(tenant, model, params_hash)`.
- **Rationale**: Exact layer must be conservative (identical request → identical response); semantic layer captures near-duplicate prompts, with context-awareness guarding follow-ups.
- **Trade-offs**: Multi-turn identical conversations are required for an exact hit; near-duplicates rely on the semantic layer.

### Decision: Cheap detection first, verification only on candidates, safety-biased fallback
- **Context**: Req 5, 6.
- **Selected Approach**: (1) topic-shift detection = cosine(user message, last AI response) vs topic-shift threshold; (2) semantic search returns a candidate; (3) for context-dependent messages, embedding-based context-chain verification of the candidate; (4) any uncertainty (embedding failure, no candidate, missing stored context, sub-threshold verification) → live.
- **Rationale**: Confines expensive work to promising cases and never serves a possibly-wrong hit (Req 6.6, 6.7).
- **Trade-offs**: Very short low-information follow-ups ("yes", "ok") remain an inherent hard case; the design biases them to live and exposes signals so telemetry can measure the false-hit rate — it is not a perfect classifier.

### Decision: This module owns the canonical cache-status vocabulary
- **Context**: Req 8.1–8.3.
- **Selected Approach**: `cacheStatus ∈ {unknown, cache_hit_exact, cache_hit_semantic, live_provider}` plus a `cacheOutcome` detail object (topic-shift decision, similarities, candidate presence, verification result, fell-back-to-live). Refine the foundation placeholder to these values.
- **Rationale**: Status must accurately reflect whether a provider was called so telemetry can compute savings; the detail object instruments the false-hit rate.
- **Trade-offs**: A one-line foundation revalidation to align the enum (foundation is not yet implemented).

## Risks & Mitigations
- **False cache hits on context-dependent follow-ups** — Mitigation: topic-shift detection + context-chain verification + safety-biased fallback; exposed signals for measurement.
- **Cross-tenant leakage** — Mitigation: every exact key and semantic row is tenant-scoped; searches filter by `tenant_id` (Req 4).
- **Embedding/Ollama unavailability on the cache path** — Mitigation: fall back to live on any embedding error (Req 6.6); never fail the request because the cache is degraded.
- **Stale entries** — Mitigation: configurable TTL (Redis expiry + `expires_at` filter) and an invalidation method (Req 7.3, 7.4).
- **Inaccurate status confusing telemetry** — Mitigation: set `cacheStatus` from the actual path taken; `live_provider` only when the provider was called (Req 8.3).
- **Nonce/HNSW recall gaps** — Mitigation: tune `ef_search`; correctness is still guarded by the threshold + verification, so a recall miss only costs a live call.

## References
- [Ollama nomic-embed-text](https://ollama.com/library/nomic-embed-text) — 768-dim local embeddings.
- [Ollama API docs](https://github.com/ollama/ollama/blob/main/docs/api.md) — `/api/embed` request/response.
- [pgvector](https://github.com/pgvector/pgvector) — `<=>` cosine operator, HNSW `vector_cosine_ops` index.
- [Understanding HNSW with pgvector](https://neon.com/blog/understanding-vector-search-and-hnsw-index-with-pgvector) — index tuning and recall.
