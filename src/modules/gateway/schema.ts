import { PROVIDER_NAMES } from '#src/modules/auth/types.js';
import { FINISH_REASONS } from './types.js';

/**
 * Boundary JSON Schema for `POST /v1/chat/completions`.
 *
 * Fastify compiles these with Ajv and enforces them *before* the handler runs,
 * which is what makes an invalid payload a client error with no provider call
 * (Req 1.2, 1.3). Keeping the schemas in their own module lets them be exercised
 * on a bare route in tests and keeps the route file (task 4.1) to wiring.
 *
 * The schemas are the runtime mirror of the compile-time contracts in
 * `types.ts`: the request mirrors `ChatCompletionRequest` and the response
 * mirrors `NormalizedResponse`. The enumerations are derived from the same
 * constants those types are derived from — `PROVIDER_NAMES` from auth and
 * `FINISH_REASONS` — so the wire contract cannot drift from the type contract.
 */

/**
 * Upper bound for `temperature`. The three providers differ (OpenAI accepts up
 * to 2, Anthropic up to 1), so the boundary admits the widest supported range
 * and each adapter is responsible for what its own provider will accept.
 */
const MAX_TEMPERATURE = 2;

/** Most providers cap the stop-sequence list at four entries. */
const MAX_STOP_SEQUENCES = 4;

/**
 * One conversation turn. `additionalProperties: false` is what keeps a
 * provider-specific field (`function_call`, `tool_calls`, `name`, …) out of the
 * agnostic request: the gateway accepts one shape, not each provider's.
 */
const chatMessageSchema = {
  type: 'object',
  required: ['role', 'content'],
  additionalProperties: false,
  properties: {
    role: { type: 'string', enum: ['system', 'user', 'assistant'] },
    // Empty content is permitted: a replayed assistant turn can legitimately be
    // empty, and rejecting it would break otherwise valid conversation history.
    content: { type: 'string' },
  },
} as const;

/**
 * The provider-agnostic request body.
 *
 * `messages` is required and non-empty, so the full conversation — not just the
 * latest user turn — is what the endpoint accepts (Req 1.4). `provider` is an
 * enum of exactly the three supported providers, so an unknown provider is
 * rejected at the boundary before selection or any provider call (Req 2.2, 2.3).
 *
 * Note what `additionalProperties: false` does here: Fastify compiles schemas
 * with Ajv's `removeAdditional: true`, so an undeclared field is *stripped*, not
 * rejected. That is the behaviour this endpoint wants — a client's leftover
 * provider-specific field (`seed`, `function_call`, `logit_bias`, …) is removed
 * at the boundary and provably cannot reach an adapter — but it means silence,
 * not an error. `stream` is therefore declared explicitly rather than left to be
 * stripped: v1 returns a single complete response (Req 3.5), so `stream: false`
 * is accepted as a no-op and `stream: true` is a loud 400 instead of a request
 * that quietly returns something other than what was asked for.
 */
export const chatCompletionRequestSchema = {
  type: 'object',
  required: ['provider', 'model', 'messages'],
  additionalProperties: false,
  properties: {
    provider: { type: 'string', enum: [...PROVIDER_NAMES] },
    model: { type: 'string', minLength: 1 },
    messages: {
      type: 'array',
      minItems: 1,
      items: chatMessageSchema,
    },
    temperature: { type: 'number', minimum: 0, maximum: MAX_TEMPERATURE },
    maxTokens: { type: 'integer', minimum: 1 },
    topP: { type: 'number', minimum: 0, maximum: 1 },
    stop: {
      type: 'array',
      maxItems: MAX_STOP_SEQUENCES,
      items: { type: 'string', minLength: 1 },
    },
    // Declared only so asking for a stream fails loudly; see the note above.
    stream: { type: 'boolean', const: false },
  },
} as const;

/**
 * The normalized response body.
 *
 * Fastify uses a response schema to *serialize*, emitting only the declared
 * properties. That makes this the last line of defence for Req 4.2: even if an
 * adapter returned a provider-specific field, it would be stripped before
 * reaching the client, so the schema stays stable across all three providers
 * (Req 4.4).
 */
export const normalizedResponseSchema = {
  type: 'object',
  required: ['id', 'provider', 'model', 'message', 'usage', 'finishReason'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    provider: { type: 'string', enum: [...PROVIDER_NAMES] },
    model: { type: 'string' },
    message: {
      type: 'object',
      required: ['role', 'content'],
      additionalProperties: false,
      properties: {
        role: { type: 'string', enum: ['assistant'] },
        content: { type: 'string' },
      },
    },
    usage: {
      type: 'object',
      required: ['promptTokens', 'completionTokens', 'totalTokens'],
      additionalProperties: false,
      properties: {
        promptTokens: { type: 'integer', minimum: 0 },
        completionTokens: { type: 'integer', minimum: 0 },
        totalTokens: { type: 'integer', minimum: 0 },
      },
    },
    finishReason: { type: 'string', enum: [...FINISH_REASONS] },
  },
} as const;

/**
 * The route schema for the completions endpoint, ready to hand to Fastify. The
 * route (task 4.1) supplies this as its `schema` so validation and serialization
 * are declared in one place rather than assembled at the call site.
 */
export const completionsRouteSchema = {
  body: chatCompletionRequestSchema,
  response: { 200: normalizedResponseSchema },
} as const;
