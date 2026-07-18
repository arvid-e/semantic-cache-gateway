# Requirements Document

## Project Description (Input)

Clients want a single, provider-agnostic chat endpoint instead of integrating separately with
OpenAI, Anthropic, and Ollama. Each provider has a different request/response shape, so the
gateway must translate a unified request into provider-specific calls and normalize every upstream
response back into one consistent schema.

This spec establishes: a `POST /v1/chat/completions` endpoint with a provider-agnostic, validated
request schema that accepts the full conversation `messages` array; provider selection across the
three supported providers; a shared provider-adapter interface with OpenAI, Anthropic, and Ollama
implementations that call each provider using the tenant's own (BYOK) key; normalization of every
upstream response into one stable client schema; and population of the shared request context —
including the conversation message list and, derived from it, the latest user message and the last
AI (assistant) response — so that `dual-layer-caching` can later run topic-shift detection and
context-chain verification.

Out of scope: caching and any topic-shift/context-verification logic (`dual-layer-caching`),
retries/failover/circuit breaking (`resilience-failover`), telemetry and metrics
(`telemetry-analytics`), rate limiting (`rate-limiting`), streaming (stretch), and any additional
provider.

## Boundary Context

- **In scope**: the `POST /v1/chat/completions` endpoint; the provider-agnostic request schema and
  validation (including the full conversation `messages` array); provider selection; the shared
  provider-adapter interface; OpenAI/Anthropic/Ollama adapters that call providers with the
  tenant's BYOK key; response normalization to one unified schema; and population of the shared
  request context, including the conversation context needed for context-aware caching.
- **Out of scope**: deciding whether to serve from cache and any topic-shift or context-chain
  verification logic (`dual-layer-caching` consumes the conversation context this spec exposes);
  retries, failover, and circuit breaking (`resilience-failover`); telemetry/metrics
  (`telemetry-analytics`); rate limiting (`rate-limiting`); streaming (stretch); and a fourth
  provider.
- **Adjacent expectations**: depends on `platform-foundation` (running service, datastore clients,
  shared request context) and on `auth-tenancy-credentials` (authenticated tenant identity and the
  credential resolver). Downstream, `dual-layer-caching` wraps this completion flow, and
  `resilience-failover` wraps provider calls through the shared adapter interface;
  `telemetry-analytics` reads the request-context fields this spec populates.

## Requirements

### Requirement 1: Unified Chat Completion Endpoint & Request Schema

**Objective:** As a developer, I want a single provider-agnostic chat endpoint, so that I can call
OpenAI, Anthropic, or Ollama without integrating each provider separately.

#### Acceptance Criteria
1. The Gateway service shall expose a `POST /v1/chat/completions` endpoint that accepts a provider-agnostic request payload.
2. When a request is received, the Gateway service shall validate the payload — including the conversation `messages` array, the provider/model selection, and common generation parameters — before any provider is called.
3. If the request payload fails validation, then the Gateway service shall reject it with a client error identifying the invalid input and shall not call any provider.
4. The Gateway service shall accept the full conversation `messages` array in a single provider-agnostic shape, not only the latest user message.

### Requirement 2: Provider Selection

**Objective:** As a developer, I want to select which provider and model handles my request, so
that I control routing while keeping one request shape.

#### Acceptance Criteria
1. When a request specifies a supported provider, the Gateway service shall route the request to that provider's adapter.
2. If a request specifies an unknown or unsupported provider, then the Gateway service shall reject it with a client error and shall not call any provider.
3. The Gateway service shall support exactly three providers — OpenAI, Anthropic, and Ollama — and no others.
4. When a request specifies a model, the Gateway service shall pass the resolved model to the selected provider and reflect the resolved model in the response.

### Requirement 3: Provider Adapters & BYOK Invocation

**Objective:** As a developer, I want each provider called with my own key behind a shared adapter,
so that the gateway never holds a provider account and provider quirks stay hidden.

#### Acceptance Criteria
1. The Gateway service shall call every provider through a shared provider-adapter interface so that provider-specific request and response handling stays behind that interface.
2. When calling a provider, the Gateway service shall use the tenant's own provider credential resolved by `auth-tenancy-credentials` and shall hold no provider account of its own.
3. If the credential for the selected provider is unavailable, then the Gateway service shall reject the request with an error indicating a missing provider credential and shall not call the provider.
4. When the gateway calls a provider, the Gateway service shall translate the provider-agnostic request into that provider's required request shape.
5. The Gateway service shall operate in non-streaming mode for v1, returning a single complete response per request.

### Requirement 4: Response Normalization

**Objective:** As a developer, I want one consistent response schema regardless of provider, so
that my integration does not change per provider.

#### Acceptance Criteria
1. When a provider returns a successful response, the Gateway service shall normalize it into a single unified response schema containing message content and role, token usage, the resolved model, and a finish reason.
2. The Gateway service shall prevent provider-specific fields and shapes from leaking into the normalized client response.
3. If a provider returns an error or times out, then the Gateway service shall surface a normalized error to the client without exposing the tenant's provider credential.
4. The Gateway service shall keep the normalized response schema stable as the client contract across all three providers.

### Requirement 5: Shared Request-Context Population (incl. Conversation Context)

**Objective:** As a platform engineer, I want the completion flow to populate the shared request
context, so that caching, resilience, and telemetry can hook in — and specifically so that caching
can perform context-aware matching.

#### Acceptance Criteria
1. When handling a completion request, the Gateway service shall populate the shared request context with the selected provider, resolved model, request parameters, token usage, and latency.
2. When handling a completion request, the Gateway service shall surface the conversation message list into the shared request context, including the latest user message and the last AI (assistant) response, so that `dual-layer-caching` can perform topic-shift detection and context-chain verification.
3. The Gateway service shall expose the conversation context without interpreting it, and shall not itself perform any caching, topic-shift, or context-verification logic.
4. Where a downstream stage has not yet run, the Gateway service shall leave the corresponding request-context fields at their defined default values.
