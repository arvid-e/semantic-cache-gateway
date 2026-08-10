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
population, TTL, and invalidation rules; and a **committed benchmark** that measures how often the
semantic layer would serve a wrong answer. Each request is tagged with its cache status and its
semantic-candidate outcome for telemetry to consume.

**Revision 2026-08-08 — the semantic layer does not serve.** The original spec accepted a semantic
candidate above a similarity threshold, guarded by topic-shift detection and context-chain
verification. Both guards were measured against labelled data before being built (see
`research.md` → Measurement Log) and both failed: the similarity threshold admits wrong answers at
every value (zero false accepts requires a threshold that retains 0/20 genuine paraphrases), and
topic-shift detection performs **below chance** (AUC 0.27–0.36 where 0.5 is chance). A stronger
embedding model and a local generative verifier were both tested and rejected.

Consequently the semantic layer ships in **shadow mode**: it searches, records the candidate it
*would* have served and why, and the request goes live regardless. No semantic candidate is ever
returned to a client. Requirement 5 is **withdrawn**; Requirement 6 is reduced to an advisory
instrument that gates nothing; Requirement 9 adds the benchmark that measures the would-be
false-hit rate. This narrows the product — the gateway's semantic hit rate is zero — and is the
direct application of the steering rule that correctness outranks hit rate.

**What this spec now claims:** an exact-match cache that demonstrably avoids provider calls, a
correct and tenant-isolated semantic store whose acceptance rule is measured rather than assumed,
and a reproducible account of why that acceptance rule is not safe to enable. The claim is *not*
a working near-duplicate cache, and must not be described as one.

Out of scope: the estimated-savings math and false-hit-rate dashboards/metrics
(`telemetry-analytics`); provider calls themselves and surfacing the conversation history into the
request context (`gateway-provider-routing`); retries and circuit breaking (`resilience-failover`);
and any cross-tenant cache sharing.

## Boundary Context

- **In scope**: the exact-match cache layer; the semantic cache layer (local key-free embeddings +
  similarity search with a configurable threshold) **running in shadow — searching and recording,
  never serving**; per-tenant cache isolation; cache population, TTL, and invalidation; storing each
  entry's originating conversation context; an advisory context-chain verification verdict that
  gates nothing; the cache-status plus candidate-outcome signal written to the shared request
  context; and the committed false-hit benchmark harness and its labelled fixtures.
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
- **Settled by measurement (2026-08-08)**: the *mechanism* of context-chain verification (Requirement
  6) was deferred to design and resolved as embedding-based. It is now moot as a gate — nothing is
  served, so nothing needs authorizing — and survives only as an advisory recorded verdict. The
  key-free constraint still binds any future acceptance mechanism.
- **Promote criterion (the one way the semantic layer starts serving)**: a candidate acceptance
  mechanism may be enabled only when it clears, on the committed fixtures of Requirement 9, **zero
  false accepts at ≥40% recall with <300 ms p95 added latency**. No mechanism tested clears it.
  Enabling serving without that evidence reintroduces the defect this revision removed.

## Requirements

### Requirement 1: Cache Lookup Flow & Provider Avoidance

**Objective:** As a customer, I want repeated prompts served from cache without calling my provider,
so that I save the cost and latency of that call.

#### Acceptance Criteria
1. When a completion request is received, the Gateway service shall check the exact-match cache first and shall run the semantic cache search only on an exact-match miss.
2. When the exact-match cache produces a hit, the Gateway service shall return the cached normalized response and shall not call any provider.
3. When the exact-match cache misses, the Gateway service shall obtain a live response through `gateway-provider-routing` and then populate both cache layers, regardless of whether the semantic search produced a candidate.
4. The Gateway service shall return cached responses in the same normalized schema as live responses, so a client cannot distinguish a hit from a miss by response shape.
5. The Gateway service shall never return a semantic candidate to a client, so that no unproven acceptance rule can serve a wrong answer.

### Requirement 2: Exact-Match Cache Layer

**Objective:** As a customer, I want identical repeated prompts served instantly, so that exact
repeats cost nothing.

#### Acceptance Criteria
1. The Gateway service shall compose the exact-match cache key from the tenant identity, the resolved model, the cache-relevant request parameters, and the prompt content.
2. When an incoming request's exact-match key matches a stored entry, the Gateway service shall serve that entry as an exact cache hit.
3. If no stored entry matches the exact-match key, then the Gateway service shall treat the request as an exact-match miss and proceed to the semantic layer.

### Requirement 3: Semantic Cache Layer (Shadow)

**Objective:** As an engineer, I want a correct, tenant-isolated semantic store whose candidate
selection is recorded but never served, so that the acceptance rule can be measured without any risk
of serving a wrong answer.

> **Revised 2026-08-08.** Criterion 3.2 previously read "…as candidate matches" and the design
> treated a candidate as a servable hit. Measurement E1 (`research.md`) shows a candidate above any
> threshold is not evidence the cached answer is correct for the new prompt. A candidate is now a
> *recorded observation*, not an authorization.

#### Acceptance Criteria
1. When the exact-match layer misses, the Gateway service shall generate an embedding of the prompt and search for the most similar stored entry within the same tenant.
2. The Gateway service shall treat stored entries whose similarity to the query is at or above the configured similarity threshold as **recorded candidates**, and a recorded candidate shall not authorize serving a cached response.
3. Whether or not a candidate is found, the Gateway service shall obtain a live response, so that the semantic layer never changes what the client receives.
4. The Gateway service shall generate embeddings locally without calling any external keyed service, so that the cache path calls no provider key.
5. The Gateway service shall expose the semantic similarity threshold as configuration, so that the recorded-candidate boundary can be varied for measurement without a code change.
6. If the semantic search or the embedder fails, then the Gateway service shall record the failure and complete the request live, so that a degraded cache never fails a request.

### Requirement 4: Per-Tenant Cache Isolation

**Objective:** As a customer, I want my cached answers never served to another tenant, so that
caching creates no cross-tenant leakage.

#### Acceptance Criteria
1. The Gateway service shall scope every cache entry, exact and semantic, to the tenant that produced it.
2. When performing exact or semantic lookups, the Gateway service shall consider only cache entries owned by the requesting tenant.
3. The Gateway service shall never serve one tenant's cached response to another tenant, even when a semantic match would otherwise qualify.

### ~~Requirement 5: Context-Aware Matching — Topic-Shift Detection~~ — **WITHDRAWN 2026-08-08**

**Withdrawn, not deferred.** This requirement specified classifying the incoming user message as
standalone or context-dependent by cosine similarity to the last AI response. Measurement E3
(`research.md`) shows the classifier performs **at or below chance**: best accuracy over any
threshold equals the majority-class baseline, and AUC is 0.2678–0.3632 across two models and three
prefix variants where 0.5 is chance. The signal is *inverted* — a same-domain new topic outranks a
genuine follow-up roughly 70% of the time — because cosine of a short question against a long answer
measures topical overlap, while the requirement needs contextual dependence. No threshold converts
one quantity into the other, so this is not satisfiable by tuning or by a better model.

The requirement number is retained rather than renumbered so that the traceability in `design.md`
and the git history of `tasks.md` stay readable. **Nothing implements Req 5.** Its safety purpose is
served instead by Req 1.5: no semantic candidate is served at all, so there is no accept decision
left for a classifier to guard.

### Requirement 6: Advisory Context-Chain Verification

**Objective:** As an engineer, I want each recorded candidate accompanied by a context-alignment
verdict, so that the benchmark can report whether context verification *would* have caught the
wrong answers.

> **Reduced 2026-08-08.** Previously this requirement gated acceptance. With nothing served, it
> authorizes nothing and exists only as an instrument. Criteria 6.4–6.7 (accept on pass, fall back
> on fail, bias to live) are subsumed by Req 1.5 and 3.3, which bias to live unconditionally.

#### Acceptance Criteria
1. When the semantic search records a candidate, the Gateway service shall compute a verification verdict by comparing the candidate entry's stored originating context to the current conversation's last AI response.
2. The Gateway service shall compute the verdict for every recorded candidate, and shall not compute it when the semantic search recorded no candidate.
3. The Gateway service shall compute the verdict without calling any external or keyed provider, so that the cache path remains key-free.
4. The Gateway service shall record the verdict as one of passed, failed, or inconclusive, treating a candidate with no stored originating context as inconclusive.
5. The Gateway service shall not allow the verdict to affect the response returned to the client, so that the instrument cannot become an acceptance path.
6. The Gateway service shall prioritize correctness over hit rate wherever the two conflict.

### Requirement 7: Cache Population, TTL & Invalidation

**Objective:** As an operator, I want cache entries populated, expired, and invalidated correctly,
so that the cache stays fresh and later verification is possible.

#### Acceptance Criteria
1. When a live response is obtained on a cache miss, the Gateway service shall populate both the exact-match and semantic layers with the new entry.
2. When storing a semantic cache entry, the Gateway service shall store the entry's originating conversation context so that later context-chain verification is possible.
3. The Gateway service shall apply a configurable time-to-live to cache entries and shall not serve entries that have expired.
4. The Gateway service shall provide a means to invalidate cache entries.

### Requirement 8: Cache-Status & Candidate-Outcome Signal

**Objective:** As a telemetry consumer, I want each request tagged with its cache outcome and its
detection/verification result, so that savings and the false-hit rate can be measured.

#### Acceptance Criteria
1. When a request completes, the Gateway service shall record its cache status in the shared request context as exactly one of `cache_hit_exact`, `cache_hit_semantic`, or `live_provider`.
2. When a request completes, the Gateway service shall record its semantic-candidate outcome — whether a candidate was recorded, its similarity, and the advisory verification verdict — in the shared request context.
3. The Gateway service shall ensure the recorded cache status accurately reflects whether a provider was actually called, so that telemetry can compute savings correctly.
4. The Gateway service shall not compute estimated savings or emit metrics itself, and shall only expose these signals for `telemetry-analytics` to consume.
5. While the semantic layer runs in shadow, the Gateway service shall never record `cache_hit_semantic`; the value is retained in the vocabulary so the `telemetry-analytics` contract survives promotion unchanged.

### Requirement 9: False-Hit Benchmark

**Objective:** As an engineer, I want the semantic layer's would-be false-hit rate measured against
committed labelled data, so that the claim "the acceptance rule is unsafe" is reproducible by
someone who did not run the original experiments.

> This requirement carries the spec's headline result. A false-hit rate cannot be derived from live
> shadow traffic, because deciding whether a candidate *would have been wrong* requires knowing the
> correct answer — that is, labels. Shadow mode supplies candidate rates and similarity
> distributions on real traffic; this benchmark supplies correctness.

#### Acceptance Criteria
1. The repository shall contain a labelled fixture set of prompt pairs, each labelled with the required outcome — whether one cached answer legitimately serves both prompts.
2. The benchmark harness shall run the semantic layer's acceptance rule over the fixture set and report the false-accept count, the recall, and the similarity distribution per class.
3. The benchmark harness shall be runnable with a single documented command against the local stack, so that the result is reproducible without reconstructing the experiment.
4. The benchmark harness shall report measured numbers rather than assert a pass threshold, so that a fixture change cannot silently turn a regression into a pass.
5. The benchmark harness shall support evaluating an alternative acceptance mechanism over the same fixtures, so that a future candidate mechanism is measured on equal terms against the promote criterion.
6. The benchmark harness shall not be part of the unit or integration suites, so that a slow local model run never gates the ordinary test loop.
