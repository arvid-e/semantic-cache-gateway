# Research & Design Decisions

## Summary
- **Feature**: `gateway-provider-routing`
- **Discovery Scope**: Extension — a new `gateway` domain module over `platform-foundation`, consuming `auth-tenancy-credentials`; discovery focused on the three providers' current request/response shapes (to build correct adapters and a stable normalized schema) and on the seams shared with downstream specs.
- **Key Findings**:
  - The three providers differ in three normalization-critical ways: **system-prompt placement** (OpenAI/Ollama accept a `system` role in `messages`; Anthropic takes a top-level `system` param), **response content shape** (OpenAI/Ollama return a plain string; Anthropic returns a `content[]` block array to concatenate), and **token-usage field names** (OpenAI gives a `total`; Anthropic `input_tokens`/`output_tokens` and Ollama `prompt_eval_count`/`eval_count` have no total and must be summed).
  - Anthropic **requires `max_tokens`**; the gateway must supply a configured default when the client omits it.
  - Provider SDK-internal retries must be disabled (`maxRetries: 0`) so `resilience-failover` owns retry/failover policy — otherwise retries would be duplicated across layers.
  - The `ProviderAdapter` contract should return the **normalized schema directly**, which structurally prevents provider-specific fields from leaking into the client contract (Req 4.2) and makes normalization non-skippable — so a separate normalizer component is unnecessary.

## Research Log

### Provider request/response shapes
- **Context**: Req 3.4 (translate to each provider's shape) and Req 4.1 (normalize into one schema) require accurate per-provider field mappings.
- **Sources Consulted**: OpenAI Chat Completions reference; Anthropic Messages API reference; Ollama `/api/chat` docs (see References).
- **Findings**:
  - **OpenAI** `POST {base}/chat/completions`, `Authorization: Bearer <key>`. Response: `choices[0].message.{role,content}`, `choices[0].finish_reason` ∈ {stop, length, content_filter, tool_calls, function_call}, `usage.{prompt_tokens, completion_tokens, total_tokens}`, `model`, `id`.
  - **Anthropic** `POST {base}/messages`, `x-api-key: <key>`, `anthropic-version: 2023-06-01`. Request: `model`, `max_tokens` (required), `messages[{role, content}]`, top-level `system`, `temperature`, `top_p`. Response: `content[]` blocks (concatenate `type:"text"` `.text`), `role`, `stop_reason` ∈ {end_turn, max_tokens, stop_sequence, tool_use}, `usage.{input_tokens, output_tokens}` (no total), `model`, `id`.
  - **Ollama** `POST {base}/api/chat` with `stream:false`. Response: `message.{role, content}`, `done`, `done_reason` ∈ {stop, length}, `prompt_eval_count`, `eval_count`, `model`, `created_at`.
- **Implications**: Normalized mappings —
  - **content**: OpenAI/Ollama pass through; Anthropic concatenate text blocks.
  - **usage**: OpenAI direct; Anthropic `total = input_tokens + output_tokens`; Ollama `promptTokens = prompt_eval_count`, `completionTokens = eval_count`, `total = sum`.
  - **finishReason**: OpenAI stop→stop, length→length, content_filter→content_filter, tool_calls/function_call→tool_use; Anthropic end_turn/stop_sequence→stop, max_tokens→length, tool_use→tool_use; Ollama stop→stop, length→length; unknown→other.
  - **system messages**: OpenAI/Ollama keep `system` entries in `messages`; Anthropic extract and concatenate them into the top-level `system` param, sending only user/assistant turns.

### HTTP clients and retry ownership
- **Context**: Steering prescribes provider SDKs for OpenAI/Anthropic and plain HTTP for Ollama; `resilience-failover` will wrap provider calls.
- **Sources Consulted**: steering `tech.md`; OpenAI/Anthropic SDK options.
- **Findings**: The official SDKs accept a per-instance API key and `maxRetries`/`timeout` options and are lightweight enough to instantiate per request for BYOK. Ollama has no auth and a simple JSON API, well served by Node's built-in `fetch` with an `AbortController` timeout.
- **Implications**: Instantiate the OpenAI/Anthropic SDK client per request with the resolved tenant key and `maxRetries: 0` + a configured `timeout`; call Ollama via `fetch` with an abort timeout. This keeps retry/failover policy solely in `resilience-failover`.

### Integration with upstream specs
- **Context**: This module extends the foundation and consumes auth.
- **Sources Consulted**: `platform-foundation/design.md`, `auth-tenancy-credentials/design.md` (this repo).
- **Findings**: The foundation exposes the Fastify app, `app.config`, the shared logger, and the extensible `RequestContext` (base fields include `provider`, `model`, `params`, `tokenUsage`, `latencyMs`). Auth exposes the `authenticate` middleware, `CredentialResolver`, `ProviderName`, and the `ProviderSecret` redacting wrapper.
- **Implications**: The route applies auth's `authenticate` middleware; the flow calls `resolveCredential(tenantId, provider, perRequestKey?)`, maps `missing` → a missing-credential client error (Req 3.3), and calls `reveal()` only at the provider HTTP boundary. This module **extends `RequestContext`** (via declaration merging) with the conversation context (`messages`, derived `latestUserMessage`, `lastAssistantMessage`) — it owns that contract, which `dual-layer-caching` consumes.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Adapter pattern behind a `ProviderAdapter` interface | One adapter per provider, each owning request translation + response normalization, returning the unified schema | Hides provider quirks; shared by `resilience-failover`; parallel-safe per adapter | Requires disciplined interface stability | **Selected** — matches steering |
| Single normalizer + provider clients | Separate normalizer component post-processing raw responses | Central mapping | Leaks raw provider shapes into the flow; normalization becomes skippable | Rejected — merged normalization into the adapter contract |
| One SDK client shared across tenants | Reuse a process-wide client | Fewer allocations | Incompatible with BYOK per-request keys | Rejected — BYOK requires per-request key |

## Design Decisions

### Decision: `ProviderAdapter` returns the normalized schema
- **Context**: Req 3.1, 4.1, 4.2.
- **Selected Approach**: `complete(request, credential, opts) → NormalizedResponse`. Each adapter translates the agnostic request into its provider shape and maps the provider response into `NormalizedResponse`; provider-specific types never escape the adapter.
- **Rationale**: Makes normalization structural (non-skippable) and prevents leakage without a separate component.
- **Trade-offs**: Mapping logic is duplicated per adapter (inherent — the shapes differ); shared helpers cover finish-reason/usage.

### Decision: Completion flow is a wrappable service
- **Context**: Req 5.3 + downstream `dual-layer-caching` "wraps the completion flow"; `resilience-failover` "wraps provider calls."
- **Selected Approach**: The route delegates to a `CompletionService.complete(ctx)` that selects the adapter, resolves the credential, invokes the adapter, normalizes, and populates the request context. Caching later wraps `CompletionService`; failover later wraps the adapter call.
- **Rationale**: Provides clean seams for both downstream specs without this spec implementing their logic (Req 5.3).
- **Trade-offs**: The seam contract (service signature, adapter interface) becomes a revalidation trigger.

### Decision: This module owns the conversation context in `RequestContext`
- **Context**: Req 5.2, 5.3.
- **Selected Approach**: Extend `RequestContext` with `messages: ChatMessage[]`, `latestUserMessage: ChatMessage | null`, `lastAssistantMessage: ChatMessage | null`; populate them from the validated request without interpreting them.
- **Rationale**: The completion flow is the first stage that has the messages; exposing (not interpreting) them is the seam `dual-layer-caching` consumes.
- **Trade-offs**: Adding/removing these fields is a documented revalidation trigger for caching.

## Risks & Mitigations
- **Provider credential leakage in errors** — Mitigation: adapters throw a typed `ProviderError` carrying provider/status/kind but never the credential; `ProviderSecret.reveal()` is used only at the HTTP call site (Req 4.3).
- **Anthropic `max_tokens` omitted** — Mitigation: supply a configured default `max_tokens` when the client omits it.
- **Double retries across layers** — Mitigation: SDK `maxRetries: 0`; retry/failover owned by `resilience-failover`.
- **Provider shape drift leaking into client contract** — Mitigation: the normalized schema is the only return type; an integration test asserts no provider-specific fields appear.
- **Timeouts hanging the request path** — Mitigation: per-call timeout via SDK `timeout` / `AbortController`; timeout surfaces as a normalized error.

## References
- [OpenAI Chat Completions reference](https://developers.openai.com/api/reference/chat-completions/overview) — response/usage/finish_reason schema.
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages) — system param, content blocks, usage, stop_reason, version header.
- [Ollama API docs](https://github.com/ollama/ollama/blob/main/docs/api.md) — `/api/chat` request/response fields with `stream:false`.
