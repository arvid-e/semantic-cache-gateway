/**
 * The request-scoped context shared by every pipeline stage.
 *
 * The foundation defines the *shape* and its defaults only; it never populates
 * business fields. Later specs read and write these as a request moves through
 * them, and extend the shape with their own fields via declaration merging.
 */

/**
 * `unknown` is the pre-cache default: no stage has classified the request yet.
 *
 * Refined in place by `dual-layer-caching` — the one deliberate edit to this
 * type, since declaration merging can add a field but cannot narrow one. The
 * values name what served the request, so `live_provider` is exactly the set
 * that reached a provider.
 */
export type CacheStatus =
  'unknown' | 'cache_hit_exact' | 'cache_hit_semantic' | 'live_provider';

/** `closed` is the healthy default (traffic flows). */
export type BreakerState = 'closed' | 'open' | 'half_open';

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

/** `attempted` stays false until the resilience stage fails over. */
export interface FailoverState {
  attempted: boolean;
  from: string | null;
  to: string | null;
}

/**
 * Mutated in place by pipeline stages over a request's whole lifetime. Every
 * field has a defined default (see {@link createDefaultContext}) so a handler
 * that reads an unset field gets a meaningful zero value, never `undefined`.
 *
 * Declared as an `interface`, not a `type`, so downstream specs can add fields
 * without editing this file.
 */
export interface RequestContext {
  /** Resolved tenant, once auth has identified the caller. */
  tenantId: string | null;
  provider: string | null;
  model: string | null;
  /** Provider request parameters (temperature, max tokens, …). */
  params: Record<string, unknown>;
  cacheStatus: CacheStatus;
  tokenUsage: TokenUsage;
  /** End-to-end handling time in milliseconds, set at request completion. */
  latencyMs: number | null;
  failover: FailoverState;
  breakerState: BreakerState;
}

/**
 * Returns a brand-new object — including new nested `params`, `tokenUsage`, and
 * `failover` objects — on every call, so mutating one request's context can
 * never leak into another's.
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
    // Declared by `src/modules/gateway/context.ts` via declaration merging;
    // their defaults belong here with every other field's, because this factory
    // is what makes "no field is ever `undefined`" true. Written as literals so
    // the foundation still imports nothing from a domain module.
    messages: [],
    latestUserMessage: null,
    lastAssistantMessage: null,
    // Declared by `src/modules/cache/context.ts`, defaulted here for the same
    // reason: `null` means the cache has not run, which no real outcome can be
    // mistaken for.
    cacheOutcome: null,
  };
}
