# Product Overview

Semantic Cache Gateway is a provider-agnostic, BYOK (Bring Your Own Key) LLM gateway. It fronts
OpenAI, Anthropic, and a local Ollama model behind a single `POST /v1/chat/completions`
endpoint and returns a normalized response. Its reason for existing is a dual-layer cache
(exact + semantic): every cache hit is a request the customer's own provider key was **not**
charged for.

It serves developers and teams who call multiple LLM providers and want to cut cost and latency
without changing their integration or handing their keys to a third party. The gateway is a
**pure pass-through** — it never holds its own provider account and never pays for LLM usage.

> Status: greenfield, built as an interview / portfolio-grade system. Favor self-contained,
> demonstrable increments over breadth.

## Core Capabilities

- **Unified gateway**: one provider-agnostic chat endpoint; routing to OpenAI, Anthropic, and
  Ollama using the customer's own key; normalized response schema.
- **Dual-layer caching**: exact-match (Redis) serving hits, plus a semantic layer (`pgvector`,
  cosine similarity, configurable threshold) running in **shadow** — it searches and records what it
  would have served, and never serves it. Both isolated per tenant. See the revision note below.
- **Resilience**: automatic retry to a pre-configured secondary provider, plus a per-provider,
  per-tenant circuit breaker with cooldown.
- **Cost & usage telemetry**: per-request metadata and **estimated cost saved**, exported to
  Prometheus and visualized in Grafana.
- **Multi-tenant security**: gateway API keys mapped to tenants, encrypted-at-rest provider
  credentials, and Redis token-bucket per-tenant rate limiting.

## Target Use Cases

- Reduce repeated-prompt spend and latency across multiple providers without vendor lock-in.
- Keep provider credentials under the customer's control (BYOK, per-request or encrypted storage).
- Demonstrate cost savings, cache hit rate, and latency distribution to stakeholders.
- Survive upstream provider outages via failover and circuit breaking.

## Value Proposition

**A cache hit means the customer's provider key is not called — that is the entire product.**
Everything else (routing, normalization, resilience, rate limiting, telemetry) exists to make
that saving safe, measurable, and reliable across tenants. The gateway earns trust by never
paying for LLM usage and never leaking a tenant's keys or cached answers.

### Revision 2026-08-08 — the semantic layer does not serve

Semantic matching was measured before it was built, and the acceptance rule is not safe: cosine
similarity admits wrong answers at every threshold (zero false accepts requires a threshold that
retains no genuine paraphrases), and topic-shift detection performs below chance. A larger embedding
model and a local generative verifier were both tested and rejected. Full evidence:
`.kiro/specs/dual-layer-caching/research.md` → Measurement Log.

**Therefore the semantic hit rate of this gateway is zero, deliberately.** Savings come from the
exact layer. The semantic layer ships in shadow so the claim can be measured rather than asserted,
and a committed benchmark reports the false-hit rate that serving those candidates would have caused.

This is the steering rule "correctness outranks hit rate" applied to its conclusion rather than
softened at the last step. Describe the project accordingly: it demonstrates a measured negative
result about semantic caching, not a working near-duplicate cache. Any document, README, or demo
claiming the latter is wrong.

## Explicitly Out of Scope

Streaming/SSE, dynamic weighted routing, and an Admin UI are stretch goals only. A 4th provider,
agent orchestration, gateway-side billing/Stripe, and a polished client UI are out of scope — a
Postman collection and `curl` examples in the README are sufficient.

---
_Focus on patterns and purpose, not exhaustive feature lists. See `.kiro/steering/roadmap.md`
for the spec decomposition and dependency order._
