# Implementation Plan

> **Solo implementation note:** Work top-to-bottom; ignore `(P)` markers. Open `design.md`
> (File Structure Plan + Components) for the concrete interfaces, make the observable bullet true,
> then run the checks. This spec consumes auth's `CredentialResolver`/`ProviderName`/`ProviderSecret`
> and defines the shared `ProviderAdapter` — see `.kiro/steering/implementation-guide.md`.

- [x] 1. Foundation: contracts, config, validation, and mapping
- [x] 1.1 Define the gateway contracts and shared adapter interface
  - Define the provider-agnostic request type (full `messages` array, provider/model, common params), the normalized response type (content/role, token usage, resolved model, finish reason), the closed `FinishReason` union, the `ProviderAdapter` interface returning only the normalized response, and a `ProviderError` that carries no credential
  - Observable: the request/response/adapter/error contracts are exported, the adapter's only return type is the normalized response, and the supported provider set is exactly three
  - _File: src/modules/gateway/types.ts_
  - _Requirements: 1.4, 2.3, 3.1, 4.2, 4.4_
- [x] 1.2 (P) Implement the gateway config segment
  - Validate the gateway environment segment (provider base URLs, request timeout, default max tokens, anthropic version) with fail-fast, secret-safe semantics; Ollama's base URL reuses the foundation setting
  - Observable: an invalid or missing gateway setting fails plugin configuration naming the setting, and a valid environment yields a typed read-only gateway config
  - _File: src/modules/gateway/config.ts_
  - _Requirements: 3.4, 3.5_
  - _Boundary: Gateway Config_
- [x] 1.3 (P) Implement request and response schema validation
  - Author the boundary JSON Schema for the provider-agnostic request (conversation `messages` array, provider/model selection, generation params) and the normalized response, rejecting invalid input before any provider call
  - Observable: a valid payload passes while a missing `messages` array, an unknown provider, or an out-of-range param is rejected with a client error and no provider is called
  - _File: src/modules/gateway/schema.ts_
  - _Requirements: 1.2, 1.3, 1.4, 2.2, 3.5_
  - _Boundary: Request Schema_
  - _Depends: 1.1_
- [x] 1.4 (P) Implement finish-reason and token-usage mapping helpers
  - Provide shared helpers mapping each provider's finish reason into the `FinishReason` union (unknown → other) and computing normalized token usage, including summed totals where a provider reports none
  - Observable: the helpers map OpenAI/Anthropic/Ollama finish reasons correctly and produce prompt/completion/total token counts for each provider
  - _File: src/modules/gateway/providers/mapping.ts_
  - _Requirements: 4.1_
  - _Boundary: Mapping Helpers_
  - _Depends: 1.1_

- [x] 2. Provider adapters and selection
- [x] 2.1 (P) Implement the OpenAI adapter
  - Translate the agnostic request into an OpenAI chat completion call using the tenant key (SDK, `maxRetries: 0`, per-call timeout) and normalize the response (message, finish reason, usage) into the unified schema, throwing a credential-free `ProviderError` on upstream error/timeout
  - Observable: a stubbed OpenAI response normalizes to the unified schema with resolved model and token usage, and a simulated upstream error surfaces as a `ProviderError` carrying no credential
  - _File: src/modules/gateway/providers/openai-adapter.ts_
  - _Requirements: 3.1, 3.4, 3.5, 4.1, 4.2_
  - _Boundary: OpenAI Adapter_
  - _Depends: 1.1, 1.2, 1.4_
- [x] 2.2 (P) Implement the Anthropic adapter
  - Translate the agnostic request into an Anthropic Messages call: lift `system` messages into the top-level system parameter, supply the default max tokens when omitted, set the api-key and version headers; normalize the response by concatenating content text blocks, mapping the stop reason, and summing input/output tokens
  - Observable: a stubbed Anthropic response normalizes to the unified schema, system messages are sent as the system parameter, and total tokens equal input plus output
  - _File: src/modules/gateway/providers/anthropic-adapter.ts_
  - _Requirements: 3.1, 3.4, 3.5, 4.1, 4.2_
  - _Boundary: Anthropic Adapter_
  - _Depends: 1.1, 1.2, 1.4_
- [x] 2.3 (P) Implement the Ollama adapter
  - Translate the agnostic request into an Ollama `/api/chat` call with `stream:false` via HTTP with an abort timeout, and normalize the response (message content, done reason, summed prompt-eval and eval token counts) into the unified schema
  - Observable: a stubbed Ollama response normalizes to the unified schema with a single complete message and summed token counts
  - _File: src/modules/gateway/providers/ollama-adapter.ts_
  - _Requirements: 3.1, 3.4, 3.5, 4.1, 4.2_
  - _Boundary: Ollama Adapter_
  - _Depends: 1.1, 1.2, 1.4_
- [x] 2.4 Implement the provider registry
  - Register exactly the three adapters and resolve a provider name to its adapter, rejecting any unknown or unsupported provider
  - Observable: each of the three supported providers resolves to its adapter, an unsupported provider raises an unsupported-provider error, and no fourth provider is registrable
  - _File: src/modules/gateway/providers/provider-registry.ts_
  - _Requirements: 2.1, 2.2, 2.3_
  - _Boundary: Provider Registry_
  - _Depends: 2.1, 2.2, 2.3_

- [x] 3. Conversation context and orchestration
- [x] 3.1 (P) Extend and populate the shared request context
  - Extend the shared request context with the conversation message list and the derived latest user message and last assistant message (with defined defaults), and populate provider, resolved model, request params, and the conversation context without interpreting it
  - Observable: after population the context exposes the message list plus the derived latest-user and last-assistant messages, unset downstream fields keep their defaults, and no caching or topic-shift logic runs here
  - _File: src/modules/gateway/context.ts_
  - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - _Boundary: Context Extension_
  - _Depends: 1.1_
- [x] 3.2 Implement the completion orchestration service
  - Orchestrate a completion: resolve the tenant credential (per-request key or stored) via the auth resolver, select the adapter, populate the pre-call context, invoke the adapter, then record token usage and latency; map a missing credential to a missing-credential error without calling the provider
  - Observable: a completion resolves the BYOK key, invokes exactly one adapter, returns the normalized response with the resolved model, and records token usage and latency in the context; a missing credential yields an error and no provider call
  - _File: src/modules/gateway/completion-service.ts_
  - _Requirements: 2.1, 2.4, 3.2, 3.3, 5.1_
  - _Boundary: CompletionService_
  - _Depends: 2.4, 3.1_

- [ ] 4. Integration: endpoint and plugin wiring
- [ ] 4.1 Implement the completions endpoint under authentication
  - Add the `POST /v1/chat/completions` handler behind the auth middleware: validate the payload, pass any per-request provider key to the service, delegate to the completion service, and map provider errors/timeouts to a normalized error response that carries no credential
  - Observable: an authenticated valid request returns the normalized response, an invalid payload returns a client error with no provider call, a provider failure returns a normalized error without the credential, and an unauthenticated request is rejected
  - _File: src/modules/gateway/routes/completions-route.ts_
  - _Requirements: 1.1, 1.3, 4.3_
  - _Boundary: Completions Route_
  - _Depends: 1.3, 3.2_
- [ ] 4.2 Register the gateway plugin and expose downstream seams
  - Register the gateway module onto the foundation app after the auth plugin, expose the completion service and adapter interface for downstream specs, and document the gateway environment variables
  - Observable: the app boots with the completion endpoint registered behind authentication and the completion service exposed for downstream wrapping, while the foundation health endpoints remain unaffected
  - _File: src/modules/gateway/index.ts, src/app.ts_
  - _Requirements: 1.1_
  - _Depends: 4.1_

- [ ] 5. Validation: routing integration tests
- [ ] 5.1 Add integration tests for the completion flow
  - Exercise end-to-end flows against stubbed provider endpoints (and the Compose Ollama service): an authenticated request selects the provider, uses the BYOK key, and returns a normalized response with the resolved model and token usage; each of the three providers routes to its adapter; an unsupported provider and a missing credential are rejected without a provider call; and no provider-specific field leaks into the normalized response
  - Observable: the integration suite passes, proving provider selection, BYOK invocation, normalized responses across providers, missing-credential and unsupported-provider rejection, and absence of provider-specific leakage
  - _File: src/modules/gateway/gateway.integration.test.ts_
  - _Requirements: 1.1, 2.1, 2.2, 2.3, 2.4, 3.2, 3.3, 4.4_
  - _Depends: 4.2_

## Implementation Notes
- 3.2: `DefaultCompletionService` is a class, not a `create*` factory — see the class-over-factory
  rule in `structure.md`, which this task established. Its collaborators arrive as one
  `CompletionServiceDeps` object (four of them read badly positionally, and `now` stays optional
  without an argument gap). Tasks 2.1–2.4 were converted to match in the same pass:
  `OpenAiAdapter`, `AnthropicAdapter`, `OllamaAdapter`, `DefaultProviderRegistry`. Only the
  Fastify plugins/hooks and `createDefaultContext` remain functions, because Fastify requires a
  function value and a data factory has no behaviour to bind.
- 2.4: the registry's "no fourth provider is registrable" guarantee survived the class conversion
  as `Object.freeze(this)` in the constructor plus the adapter table in a `#private` field. The
  test now asserts the instance has no own enumerable properties and that `select` is the
  prototype's only method — `Object.keys()` on a class instance is `[]`, so the old
  object-literal assertion would have passed vacuously.
- 3.2: the resolver's third outcome, `decryption_failed`, gets its own
  `CredentialResolutionError` (in `completion-service.ts`) rather than being folded into auth's
  `MissingCredentialError` — the tenant *did* attach a key, so task 4.1 maps missing → 400 and this
  → a safe 5xx. It is a gateway type, not auth's `DecryptionError`: nothing in the gateway attempts
  a decrypt, and re-throwing that type would point a stack reader at a call that never happened.
- 3.2: adapter selection runs *before* credential resolution (as in the design's flow diagram), so
  an unsupported provider costs no datastore round-trip. Pinned by a test asserting the resolver was
  never called.
- 3.2: `latencyMs` is written in a `finally` around the adapter call, measured from service entry,
  so a *failed* provider call is timed too — a timeout's duration is exactly what an investigation
  needs. Requests rejected before the call (unsupported provider, missing credential) never reach
  the `finally` and keep the default `null`, which therefore reads as "no provider was called"
  (Req 5.4). `tokenUsage` is written only on success.
- 3.2: `perRequestKey` is spread into `ResolveCredentialInput` only when present — under
  `exactOptionalPropertyTypes` an explicit `undefined` is not an absent property, and the resolver
  decides BYOK-vs-stored by reading that property.
- 3.1: declaration merging adds *required* fields, so the design's "(no foundation edit)" could only
  hold for the `RequestContext` interface — not for `createDefaultContext()`, which stops
  type-checking the moment a merged field has no default (that is exactly what the foundation's
  `DEFAULTS` literal in `context-plugin.test.ts` was built to force). The three defaults therefore
  live in `src/platform/context/types.ts` as literals (`[]`, `null`, `null`), which needs no import
  from the gateway module, so the foundation still depends on nothing downstream. The alternative —
  declaring the fields optional — would have handed every reader in `dual-layer-caching` a
  `| undefined` and broken the foundation's never-`undefined` invariant (Req 5.4).
- 3.1: `populateCompletionContext` sets `ctx.model` to the *requested* model; task 3.2 overwrites it
  with the model the provider reports serving (Req 2.4). It deliberately takes no credential
  argument, so there is no way to write a secret into a context that telemetry reads.
- 3.1: `params` records only the parameters the client actually sent, under the agnostic names
  (`maxTokens`, never `max_tokens`/`num_predict`), and copies `stop`/`messages` rather than aliasing
  the request body. `tokenUsage`/`latencyMs` are *not* touched here — they are unknown until the
  provider answers (task 3.2).
- 1.1: the normalized usage type is `NormalizedUsage` (`promptTokens`/`completionTokens`/`totalTokens`), deliberately distinct from the foundation's `TokenUsage` (`prompt`/`completion`/`total`) — task 3.2 must map between them, not assign across.
- 1.4: `mapping.ts` owns every provider's wire vocabulary — add a new stop reason there, never to the `FinishReason` union in `types.ts`. Adapters (2.1–2.3) should call these rather than mapping inline.
- 1.4: OpenAI's reported `total_tokens` is preserved even when it disagrees with prompt+completion; only Anthropic and Ollama get a computed total. Pinned by a test — don't "fix" it into a recomputation.
- 1.3: Fastify compiles schemas with Ajv `removeAdditional: true`, so `additionalProperties: false` *strips* undeclared fields instead of rejecting them. Any field that must fail loudly has to be declared explicitly — that is why `stream` is in the request schema as `const: false`.
- 1.3: the request schema admits `temperature` 0–2 (OpenAI's range, the widest of the three). Anthropic caps at 1, so task 2.2 must clamp or reject rather than pass a value through.
- 1.3: the 200 response schema strips undeclared fields on serialization, so it is a real backstop for Req 4.2 — but only on routes that actually declare it; task 4.1 must use `completionsRouteSchema`, not just the body schema.
- 1.2: `loadGatewayConfig(foundation, env)` takes a `Pick<Config, 'ollama'>` slice — the gateway never re-reads `OLLAMA_URL`. Task 4.2's plugin passes `app.config`, and 4.2 still owns documenting the five gateway vars in `.env.example`.
- 1.2: every gateway setting is optional with a code-owned default, so the plugin boots on an empty gateway environment; only an *invalid* value fails registration.
- 2.4: `UnsupportedProviderError` lives in `provider-registry.ts`, deliberately *not* in `types.ts` — it is not a `ProviderError`. Nothing was called, so task 4.1 maps it onto a client error (400), not an upstream one.
- 2.4: adapters are looked up through a `Map`, not by indexing the record. A plain-object lookup resolves inherited keys (`constructor`, `toString`) to something truthy, and `noUncheckedIndexedAccess` does not add `| undefined` to a finite-union `Record`, so the guard would also lint as unreachable. The record literal still exists for its compile-time exhaustiveness (Req 2.3).
- 2.4: the registry is built once at plugin registration, not per request — adapters are stateless and hold only deployment config; the credential and per-call opts arrive on each `complete` call.
- 2.3: no SDK, so the adapter owns the timeout itself — an `AbortController` armed for `timeoutMs` and cleared only after the body is read, so a slow body counts against the same budget. Whether a failure was a timeout is read from `controller.signal.aborted`, *not* the rejection's `name` (`AbortError` vs `TimeoutError` has varied across Node releases).
- 2.3: an Ollama error body is never read into the `ProviderError` — only the status. Unlike the two SDKs, which mask keys in their own messages, whatever fronts an Ollama server can echo the credential in its 401 body (Req 4.3). Pinned by a test; don't "improve" the error by attaching the body.
- 2.3: Ollama returns no completion id, so the adapter mints `ollama-<uuid>` — that is what `NormalizedResponse.id` being "the adapter supplies a stable value" is for. Its generation params also live under `options` (and max-tokens is `num_predict`), and it takes `system` turns inline, so nothing is lifted the way 2.2 must.
- 2.2: `temperature` is *clamped* to Anthropic's max of 1, not rejected — resilience-failover retries the same agnostic request against a different provider, so a hard rejection here would break failover. `@anthropic-ai/sdk` additionally deprecates `temperature`/`top_p` (post-Opus-4.6 models accept only `1.0` / `>= 0.99`); the adapter still forwards a client-set value rather than dropping it, since the per-model rule is not knowable here. That is the one `eslint-disable` in the file — don't "fix" it by removing the params.
- 2.2: a conversation of only `system` turns leaves Anthropic's `messages` empty and gets a 400, surfacing as `upstream_error`. Deliberate: the three `ProviderErrorKind`s describe provider outcomes, and adding a client-validation kind would widen the shared seam from task 1.1.
- 1.1: `ProviderError` takes `(message, { provider, kind, status?, cause? })`; `status` is typed `number | undefined` rather than optional because `exactOptionalPropertyTypes` is on. Adapters (2.1–2.3) must pass only a non-secret `cause` — a provider SDK error can carry the request headers.
