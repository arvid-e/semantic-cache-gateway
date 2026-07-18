# Brief: gateway-provider-routing

## Problem
Clients want a single, provider-agnostic chat endpoint instead of integrating separately with
OpenAI, Anthropic, and Ollama. Each provider has a different request/response shape, so the
gateway must translate a unified request into provider-specific calls and normalize every
upstream response back into one consistent schema.

## Current State
`platform-foundation` and `auth-tenancy-credentials` exist: the service boots, authenticates
tenants, and can resolve a tenant's provider key. No completion endpoint or provider adapters yet.

## Desired Outcome
`POST /v1/chat/completions` accepts a provider-agnostic payload, selects the target provider,
calls it using the tenant's BYOK key (resolved from header or encrypted storage), and returns
a normalized JSON response with token usage and the resolved model. The abstraction is proven
across all three providers without provider-specific leakage in the client contract.

## Approach
Define a provider-agnostic request schema (messages, model/provider selection, common params)
validated by Fastify schemas. A `ProviderAdapter` interface with OpenAI, Anthropic, and Ollama
implementations translates to/from each upstream API using the tenant's key. A normalizer maps
each provider response into a single schema (content, role, token usage, model, finish reason).
The completion flow populates the shared request context (provider, model, params, token usage,
latency) that caching, resilience, and telemetry later hook into.

## Scope
- **In**: `POST /v1/chat/completions`; provider-agnostic request schema + validation (accepts the
  full `messages` conversation array); provider selection; `ProviderAdapter` interface;
  OpenAI/Anthropic/Ollama adapters using BYOK keys; response normalization to a unified schema;
  population of the shared request context — **including the conversation message list and, derived
  from it, the latest user message and the last AI (assistant) response** so `dual-layer-caching`
  can run topic-shift detection and context-chain verification.
- **Out**: caching and any topic-shift / context-verification logic (dual-layer-caching consumes
  the conversation context this spec exposes); retries/circuit breaker (resilience-failover);
  telemetry/metrics (telemetry-analytics); rate limiting (rate-limiting); streaming (stretch);
  additional providers.

## Boundary Candidates
- Provider-agnostic request/response schema
- `ProviderAdapter` interface
- Per-provider adapters (OpenAI, Anthropic, Ollama)
- Response normalizer
- Completion endpoint orchestration

## Out of Boundary
- Deciding whether to serve from cache (dual-layer-caching wraps this flow)
- Retry/failover between providers (resilience-failover wraps provider calls)

## Upstream / Downstream
- **Upstream**: platform-foundation, auth-tenancy-credentials.
- **Downstream**: dual-layer-caching (wraps the completion flow), resilience-failover
  (wraps provider calls), telemetry-analytics (reads context fields).

## Existing Spec Touchpoints
- **Extends**: platform-foundation (adds the completion route), auth-tenancy-credentials (consumes credential resolver).
- **Adjacent**: the `ProviderAdapter` interface is shared with resilience-failover — design it for
  reuse. The conversation context (message list + last AI response) placed in the request context is
  the seam consumed by dual-layer-caching's context-aware matching — expose it, don't interpret it.

## Constraints
- Exactly three providers: OpenAI, Anthropic, Ollama.
- Pure pass-through using the customer's key; the gateway holds no provider account.
- Non-streaming v1.
- Normalized response schema is the stable client contract; providers must not leak through it.
