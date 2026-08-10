# Research & Design Decisions

## Summary
- **Feature**: `dual-layer-caching`
- **Discovery Scope**: Complex Integration — wraps the `gateway-provider-routing` completion flow with an exact (Redis) + semantic (`pgvector`) cache and the roadmap's context-aware matching strategy; discovery focused on the local embedding API, `pgvector` cosine search/indexing, and the deferred context-chain verification mechanism.
- **Key Findings**:
  - Ollama's current embeddings endpoint is **`/api/embed`** (`{model, input:[...]}` → `{embeddings:[[...]]}`), batch-capable; `/api/embeddings` is legacy. `nomic-embed-text` outputs **768-dim** vectors — key-free and offline (Req 3.4).
  - `pgvector` cosine search uses the **`<=>`** operator with an **HNSW `vector_cosine_ops`** index; the query must use `<=>` to use the index. Cosine distance `= 1 − cosine similarity`, so a similarity threshold `t` maps to a distance predicate `<= 1 − t`.
  - **Context-chain verification (Req 6.3) is best done embedding-based**, not via a local-model call: it reuses embeddings already computed, is deterministic and sub-millisecond, and stays key-free — matching "cheap detection first, expensive verification only on candidates."
  - The batch `/api/embed` call lets the incoming user message and the conversation's last AI response be embedded together, so **topic-shift detection and verification share the same embeddings** with no extra provider round-trips.
  - **Superseded by measurement (2026-08-08).** The two acceptance mechanisms above were implemented as
    experiments and measured against labelled data before being built into the runtime. Neither is safe:
    the similarity threshold admits wrong answers at every value, and topic-shift detection performs below
    chance. See **Measurement Log (2026-08-08)** and the shadow-mode decision below. The API-level findings
    (`/api/embed`, `<=>`, HNSW) are unaffected and still hold.

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

## Measurement Log (2026-08-08)

Before building the acceptance logic, both mechanisms were measured against labelled pairs on the
in-stack Ollama. All four experiments are negative. They are recorded here in full because the
measurement — not the cache — is now this spec's headline deliverable (Req 9).

> The labelled sets used below were built ad hoc and **were not committed**. Req 9 exists partly to
> fix that: the harness and its fixtures ship in the repo and are reproducible with one command.

### E1 — Similarity threshold vs. answer equivalence (`nomic-embed-text`)
- **Setup**: 20 paraphrase pairs (same answer serves both) vs. 20 near-miss pairs (different answer
  required), cosine over `nomic-embed-text` at `CACHE_SIMILARITY_THRESHOLD=0.83`.
- **Result**: 65% paraphrase recall and **9/20 near-misses served wrongly**. The distributions
  interleave across the whole range: zero wrong answers requires a threshold >0.9910, which retains
  **0/20** paraphrases. Task prefixes shift both distributions down together (10% false accepts, 25%
  recall) and remain inseparable.
- **Failure class**: direction inversion and negation are near-invisible to the model —
  `"convert Celsius to Fahrenheit?"` vs `"convert Fahrenheit to Celsius?"` = **0.9910**;
  `"convert a list to a set"` vs `"convert a set to a list"` = 0.9893;
  `"enable SSH password login"` vs `"disable SSH password login"` = 0.8794 — while a genuine
  paraphrase (`"check if a number is prime"` / `"code that tests primality"`) scores only 0.6317.
- **Caveat**: the near-miss set was built adversarially, so 45% overstates real traffic. The failure
  class itself (unit conversions, enable/disable, Ubuntu/Windows) is ordinary for this audience.
- **Conclusion**: **Req 3.2's original premise — cosine proximity above a configurable threshold
  identifies a safe hit — does not hold.**

### E2 — Does a stronger embedding model help? (`mxbai-embed-large`)
- **Setup**: same pairs, 1024-dim `mxbai-embed-large`, raw and prompted.
- **Result**: **AUC 0.6200** vs `nomic-embed-text`'s 0.6450 — slightly *worse*, both far from
  separable. At its own optimal threshold (0.9221) it still accepts Celsius/Fahrenheit at **0.9912**
  while rejecting 13/20 genuine paraphrases. Best of all four configurations tested is
  `nomic-embed-text` with task prefixes at AUC 0.6825 / 15% recall at zero wrong answers.
- **Conclusion**: not a capacity limit but a **bi-encoder property** — both directions mention the
  same terms in the same frame, and one pooled vector has nowhere to encode the asymmetry. Adopting
  it would also mean changing `vector(768)` and the embedding dimension for no gain. **Rejected.**

### E3 — Topic-shift detection separability (Req 5)
- **Setup**: 39 follow-ups vs. 18 same-domain new topics across 5 conversation contexts; cosine of
  the incoming user message against the last AI response, three prefix variants.
- **Result**: **the classifier performs at chance.** Best achievable accuracy over *any* threshold is
  68.4% in all variants — identical to the majority-class baseline, reached only at the degenerate
  threshold that labels everything a follow-up. At the configured 0.6, **2 of 39** follow-ups
  classify context-dependent; the other 37 take the unverified standalone path.
- **The signal is inverted**, not merely absent. AUC for follow-up vs. same-domain new topic is
  **below chance in every configuration**: `nomic-embed-text` 0.2963 raw / 0.3632 prefixed,
  `mxbai-embed-large` 0.2678 raw / 0.2906 prompted (0.5 = chance). The consistent ordering —
  same-domain new (0.4776–0.5054) > follow-ups (0.4231–0.5044) > cross-domain new (0.2865–0.4095) —
  shows the score tracking lexical and topical overlap, which correlates with question length and
  shared vocabulary rather than with dependence on the prior turn.
- **Consequence — an unverified false-hit path.** Identical short text scores 1.0 against itself,
  clearing 0.83. `exactKey` hashes the whole message list, so two conversations both ending in
  `"yes"` have *different* exact keys but the *same* latest-message embedding: exact miss → semantic
  candidate at 1.0 → classified standalone → served with no verification. Verification would have
  rejected it (the two unrelated prior AI responses score 0.4580, under 0.75) but never runs. The
  original design recorded these cases as "biased to live"; they were biased to **hit**.
- **Conclusion**: the comparison measures topical overlap; the design needs contextual dependence.
  They are different quantities and no threshold converts one into the other. Inverting the
  comparison does not rescue it — that detects "changed subject", a third quantity. **Req 5 is
  withdrawn.**

### E4 — Local generative second stage (`llama3.2:3b`)
- **Setup**: same 20+20 pairs, in-stack Ollama, temperature 0, zero-shot and two-shot prompts.
- **Result**: zero-shot 60% recall, **3/20 wrong answers served (15%)**, 2664 ms mean / 3957 ms p95.
  Two-shot 80% recall, **6/20 wrong answers (30%)**, 6508 ms mean / 7939 ms p95.
- **Assessment**: a real improvement on the bare threshold (15% false accepts vs. 45% at comparable
  recall) but it still authorizes wrong answers, and the two-shot variant still accepts
  Celsius/Fahrenheit and `"who wrote Pride and Prejudice?"` vs `"who wrote Wuthering Heights?"`.
- **Latency is separately disqualifying** on the target hardware (CPU-only i5-8350U, no GPU): the
  cache exists to avoid a provider call that typically returns in 1–3 s, and the verifier costs
  2.7–6.5 s on *every* candidate including rejected ones. A 7B model roughly doubles that here.
  The latency result is hardware-specific; a GPU deployment would change it. The 3B accuracy result
  is not. **Rejected.**

### Why "verify every candidate" does not rescue the layer
The obvious repair for E3 — drop the standalone fast path and verify every candidate — closes the
`"yes"`/`"ok"` false-hit path but does not address E1, and it removes the product. Verification
compares the candidate's stored *originating context* against the current last-AI response. A
first-turn standalone prompt has no prior AI response, so `originating_context_embedding` is NULL →
`inconclusive` → live. Celsius/Fahrenheit is then rejected only because *every* first-turn prompt is
rejected, and the semantic layer can only ever serve mid-conversation follow-ups — precisely the
traffic where near-duplicate reuse is rarest. **Verify-everything ≈ no semantic hits, by a longer
route.** E1 and E3 are therefore one finding, not two: under the key-free local-only constraint
(Req 3.4, 6.3), no accept rule tested is both safe and useful.

### Untested: cross-encoder / NLI reranking
The model classes tested are bi-encoders (E1, E2 — fail by construction) and a generative LLM
(E4 — too slow, still wrong). The untested middle is a **cross-encoder**, which encodes both prompts
jointly so attention runs across the pair and directional asymmetry has somewhere to live; an **NLI**
cross-encoder is the closest task framing, since negation and directionality are core MNLI/SNLI
training targets. Size 22–180M params → roughly 20–300 ms CPU rather than 2.7 s. Ollama does not
serve rerankers, so this would be ONNX in-process (`@huggingface/transformers`) or a small sidecar —
still key-free and local, so Req 3.4/6.3 hold.

**Not scheduled.** Recorded as the named next experiment. If run, it is a timeboxed spike with the
kill criterion fixed in advance (zero false accepts at ≥40% recall, <300 ms p95); Req 9's harness is
what would evaluate it, and a negative result is another row in the report rather than wasted work.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Decorator over `CompletionService` + layered cache services | Cache orchestrator wraps the completion service; exact/semantic/detector/verifier as cohesive units | Clean seam; correctness-first branching in one place; testable units | Orchestration logic is the correctness-critical hotspot | **Selected** |
| Embed full conversation history | Embed the whole message list | Captures context | Histories become unique after 1–2 turns → hit rate collapses | Rejected (roadmap) |
| Fixed sliding window (last 2–3 turns) | Embed a fixed window | Simple | Breaks on cascading reference chains | Rejected (roadmap) |
| Refine/condense every request via a model | LLM rewrite before matching | Higher precision | Adds latency/cost to every request incl. misses | Rejected (roadmap) |
| Local-model context verification | Ask a local chat model if contexts align | Nuanced | Per-candidate generation latency; nondeterministic | Rejected — measured in E4: still 15% wrong answers, 2.7–6.5 s |
| Larger bi-encoder (`mxbai-embed-large`) | Swap the embedding model | Drop-in | Same bi-encoder blind spot | Rejected — measured in E2: AUC 0.6200, *worse* |
| Shadow mode (search, record, never serve) | Semantic layer runs but authorizes nothing; harness measures the would-be false-hit rate | Cannot serve a wrong answer; keeps mechanics + promote path; makes the finding reproducible | Semantic hit rate is zero | **Selected (2026-08-08)** |
| Cross-encoder / NLI acceptance gate | Joint encoding of the pair; asymmetry representable | Targets the measured failure class directly | Not served by Ollama; unproven here | Not tested — named next experiment |

## Design Decisions

### Decision: Exact key on the full conversation; semantic match on the latest user message
- **Context**: Req 2.1, 3.1.
- **Selected Approach**: Exact key = `hash(tenant | model | params_hash | canonical(messages[]))` so only identical conversations exact-hit. Semantic layer embeds the latest user message and searches within `(tenant, model, params_hash)`.
- **Rationale**: Exact layer must be conservative (identical request → identical response); semantic layer captures near-duplicate prompts, with context-awareness guarding follow-ups.
- **Trade-offs**: Multi-turn identical conversations are required for an exact hit; near-duplicates rely on the semantic layer.

### ~~Decision: Cheap detection first, verification only on candidates, safety-biased fallback~~ (SUPERSEDED 2026-08-08)
- **Context**: Req 5, 6.
- **Selected Approach**: (1) topic-shift detection = cosine(user message, last AI response) vs topic-shift threshold; (2) semantic search returns a candidate; (3) for context-dependent messages, embedding-based context-chain verification of the candidate; (4) any uncertainty (embedding failure, no candidate, missing stored context, sub-threshold verification) → live.
- **Rationale**: Confines expensive work to promising cases and never serves a possibly-wrong hit (Req 6.6, 6.7).
- **Trade-offs**: Very short low-information follow-ups ("yes", "ok") remain an inherent hard case; the design biases them to live and exposes signals so telemetry can measure the false-hit rate — it is not a perfect classifier.
- **Superseded by E1/E3/E4.** Step (1) performs below chance and is withdrawn (Req 5). Step (4)'s
  safety bias did not hold: the cases assumed "biased to live" were biased to hit. The trade-off note
  above understated the problem — it treated short follow-ups as a narrow hard case, when the
  measurement shows the accept rule is unsafe for ordinary first-turn prompts too. Replaced by the
  shadow-mode decision below.

### Decision: The semantic layer ships in shadow mode; the measurement is the deliverable
- **Context**: E1–E4 leave no safe accept rule under Req 3.4/6.3. The options were to scrap the
  semantic layer, to ship it serving hits anyway, or to ship it without serving.
- **Selected Approach**: build the semantic layer's store/search/invalidate mechanics in full and run
  them on every exact miss, but **never serve a semantic candidate**. The candidate, its similarity,
  and an advisory verification verdict are recorded to `cacheOutcome`; the request goes live
  regardless. A committed benchmark harness (Req 9) measures the false-hit rate that *would* have
  occurred, against labelled fixtures.
- **Rationale**: Shipping hits would knowingly serve wrong answers and contradicts the steering rule
  that correctness outranks hit rate. Scrapping the layer outright would discard working mechanics
  (pgvector/HNSW, tenant scoping, TTL) that are correct and independently demonstrable, and would
  leave the finding unevidenced in the repo. Shadow mode keeps the machinery real, keeps the
  promote-to-serving path open behind one decision, and makes the negative result reproducible.
- **Trade-offs**: the gateway's semantic hit rate is **zero** — the product claim narrows to the exact
  layer plus a measured account of why the semantic layer does not serve. `cache_hit_semantic` stays
  in the status vocabulary but is never emitted, preserving the `telemetry-analytics` seam.
- **Promote criterion**: the layer serves only when a mechanism clears the fixed bar on the committed
  fixtures — zero false accepts at ≥40% recall, <300 ms p95 added latency. Nothing tested clears it.

### Decision: This module owns the canonical cache-status vocabulary
- **Context**: Req 8.1–8.3.
- **Selected Approach**: `cacheStatus ∈ {unknown, cache_hit_exact, cache_hit_semantic, live_provider}` plus a `cacheOutcome` detail object (topic-shift decision, similarities, candidate presence, verification result, fell-back-to-live). Refine the foundation placeholder to these values.
- **Rationale**: Status must accurately reflect whether a provider was called so telemetry can compute savings; the detail object instruments the false-hit rate.
- **Trade-offs**: A one-line foundation revalidation to align the enum (foundation is not yet implemented).

## Risks & Mitigations
- **False cache hits on context-dependent follow-ups** — ~~Mitigation: topic-shift detection + context-chain verification + safety-biased fallback~~. **Realised, not mitigated** (E1, E3): the mitigation did not work. Now eliminated by construction — the semantic layer serves nothing (shadow mode), so no candidate, correct or not, can reach a client. The residual risk moves to Req 9: the reported false-hit rate must be measured against committed fixtures, not asserted.
- **Shadow mode silently becoming a serving path** — Mitigation: the orchestrator has no code path from candidate to response; promotion requires a deliberate change plus the fixed promote criterion above. Integration tests assert a semantic candidate is recorded *and* the provider was still called.
- **The benchmark being written to pass** — Mitigation: fixtures are labelled by required outcome, committed, and reviewed independently of the run; the harness reports the number rather than asserting a threshold.
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
