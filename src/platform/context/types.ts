/**
 * The request-scoped context shared by every pipeline stage.
 *
 * This foundation defines the *shape* and its defaults only; it never populates
 * business fields. Later specs (auth, routing, caching, resilience, telemetry)
 * read and write these fields as a request moves through them, and extend the
 * shape with their own fields via TypeScript declaration merging — see the note
 * on {@link RequestContext} (Req 7.2, 7.3).
 */

/**
 * How the cache treated a request. `unknown` is the pre-cache default: no stage
 * has classified the request yet. Populated by the caching spec.
 */
export type CacheStatus =
  'unknown' | 'miss' | 'exact_hit' | 'semantic_hit' | 'bypassed';

/**
 * Circuit-breaker state for the provider a request is routed to. `closed` is the
 * healthy default (traffic flows). Populated by the resilience spec.
 */
export type BreakerState = 'closed' | 'open' | 'half_open';

/** Token counts for a request, filled in once a provider response is seen. */
export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

/**
 * Whether the request was retried against a fallback provider, and between which
 * providers. `attempted` stays false until the resilience stage fails over.
 */
export interface FailoverState {
  attempted: boolean;
  from: string | null;
  to: string | null;
}

/**
 * Request-scoped state carried for a request's whole lifetime and mutated in
 * place by pipeline stages. Every field has a defined default (see
 * {@link createDefaultContext}) so a handler that reads an unset field gets a
 * meaningful zero value, never `undefined` (Req 7.5).
 *
 * Declared as an `interface`, not a `type`, so downstream specs can add fields
 * without editing this file (Req 7.3).
 *
 */
export interface RequestContext {
  /** Resolved tenant, once auth has identified the caller. */
  tenantId: string | null;
  /** Upstream provider selected for this request (e.g. `openai`, `ollama`). */
  provider: string | null;
  /** Model selected for this request. */
  model: string | null;
  /** Provider request parameters (temperature, max tokens, …). */
  params: Record<string, unknown>;
  /** How the cache handled this request. */
  cacheStatus: CacheStatus;
  /** Token counts, filled in from the provider response. */
  tokenUsage: TokenUsage;
  /** End-to-end handling time in milliseconds, set at request completion. */
  latencyMs: number | null;
  /** Failover bookkeeping for the resilience stage. */
  failover: FailoverState;
  /** Circuit-breaker state for the routed provider. */
  breakerState: BreakerState;
}

/**
 * Build a fresh {@link RequestContext} with every field at its default.
 *
 * Returns a brand-new object — including new nested `params`, `tokenUsage`, and
 * `failover` objects — on every call, so that mutating one request's context can
 * never leak into another's. The context plugin calls this once per request
 * (Req 7.1, 7.5).
 */
export function createDefaultContext(): RequestContext {
  return {
    tenantId: null,
    provider: null,
    model: null,
    params: {},
    cacheStatus: 'unknown',
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    latencyMs: null,
    failover: { attempted: false, from: null, to: null },
    breakerState: 'closed',
  };
}
