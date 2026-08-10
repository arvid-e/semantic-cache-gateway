import {
  createDefaultContext,
  type RequestContext,
} from '#src/platform/context/types.js';
import { DEFAULT_CACHE_OUTCOME, type CacheOutcome } from './types.js';
import { buildCacheOutcome, recordCacheResult } from './context.js';

/** The four fields a cache outcome carries — nothing derived, nothing monetary. */
const OUTCOME_FIELDS = [
  'semanticCandidate',
  'candidateSimilarity',
  'verification',
  'shadowError',
] as const;

/**
 * The tempting case: a candidate found, its context verified. In shadow mode
 * this still accompanies `live_provider` — the observation the layer *would*
 * have served on, recorded beside proof that it did not.
 */
const shadowObservation: CacheOutcome = {
  semanticCandidate: true,
  candidateSimilarity: 0.88,
  verification: 'passed',
  shadowError: null,
};

describe('cache signal defaults', () => {
  it('starts unclassified, with no outcome', () => {
    const ctx = createDefaultContext();

    // `unknown` and `null` are distinguishable from every real result, so a
    // request that never reached the cache is never mistaken for a miss.
    expect(ctx.cacheStatus).toBe('unknown');
    expect(ctx.cacheOutcome).toBeNull();
  });

  it('describes an outcome with exactly the four observation fields', () => {
    // Savings, hit rates, and cost belong to `telemetry-analytics`, which
    // derives them from these signals (Req 8.4). Nothing here computes them.
    expect(Object.keys(DEFAULT_CACHE_OUTCOME).sort()).toEqual(
      [...OUTCOME_FIELDS].sort(),
    );
  });

  it('freezes the default outcome', () => {
    expect(Object.isFrozen(DEFAULT_CACHE_OUTCOME)).toBe(true);
  });
});

describe('buildCacheOutcome', () => {
  it('fills every unstated field from the default', () => {
    const outcome = buildCacheOutcome({ semanticCandidate: true });

    expect(outcome).toEqual({
      ...DEFAULT_CACHE_OUTCOME,
      semanticCandidate: true,
    });
  });

  it('returns a fresh object each time', () => {
    // A shared object would let one request's outcome mutate another's.
    const first = buildCacheOutcome({});
    const second = buildCacheOutcome({});

    expect(first).not.toBe(second);
    expect(first).not.toBe(DEFAULT_CACHE_OUTCOME);
  });
});

describe('recordCacheResult', () => {
  function record(
    status: RequestContext['cacheStatus'],
    outcome: CacheOutcome,
  ): RequestContext {
    const ctx = createDefaultContext();
    recordCacheResult(ctx, status, outcome);
    return ctx;
  }

  it('writes the status and the outcome together', () => {
    // A verified candidate at high similarity still reports `live_provider`:
    // in shadow mode the observation never changes the status (Req 8.5).
    const ctx = record('live_provider', shadowObservation);

    expect(ctx.cacheStatus).toBe('live_provider');
    expect(ctx.cacheOutcome).toEqual(shadowObservation);
  });

  it('keeps exactly one status and one outcome when called again', () => {
    const ctx = createDefaultContext();

    recordCacheResult(ctx, 'cache_hit_exact', DEFAULT_CACHE_OUTCOME);
    recordCacheResult(ctx, 'live_provider', shadowObservation);

    // One request produces one verdict: a re-record replaces, never appends, so
    // telemetry reads a single status rather than a history it has to reduce.
    expect(ctx.cacheStatus).toBe('live_provider');
    expect(ctx.cacheOutcome).toEqual(shadowObservation);
  });

  it('copies the outcome instead of storing the caller s object', () => {
    const outcome = { ...shadowObservation };
    const ctx = createDefaultContext();

    recordCacheResult(ctx, 'live_provider', outcome);
    outcome.shadowError = 'search_failed';

    expect(ctx.cacheOutcome?.shadowError).toBeNull();
  });

  it('touches no other context field', () => {
    const before = createDefaultContext();
    const after = createDefaultContext();

    recordCacheResult(after, 'live_provider', shadowObservation);

    // The cache owns two fields. Token usage and latency are the gateway's, and
    // a cache hit must not silently zero or invent them.
    expect(after.tokenUsage).toEqual(before.tokenUsage);
    expect(after.latencyMs).toBe(before.latencyMs);
    expect(after.messages).toEqual(before.messages);
    expect(after.tenantId).toBe(before.tenantId);
  });
});
