import {
  createDefaultContext,
  type RequestContext,
} from '#src/platform/context/types.js';
import { DEFAULT_CACHE_OUTCOME, type CacheOutcome } from './types.js';
import { buildCacheOutcome, recordCacheResult } from './context.js';

/** The six fields a cache outcome carries — nothing derived, nothing monetary. */
const OUTCOME_FIELDS = [
  'topicShift',
  'topicShiftSimilarity',
  'semanticCandidate',
  'candidateSimilarity',
  'verification',
  'fellBackToLive',
] as const;

const semanticHit: CacheOutcome = {
  topicShift: 'context_dependent',
  topicShiftSimilarity: 0.71,
  semanticCandidate: true,
  candidateSimilarity: 0.88,
  verification: 'passed',
  fellBackToLive: false,
};

describe('cache signal defaults', () => {
  it('starts unclassified, with no outcome', () => {
    const ctx = createDefaultContext();

    // `unknown` and `null` are distinguishable from every real result, so a
    // request that never reached the cache is never mistaken for a miss.
    expect(ctx.cacheStatus).toBe('unknown');
    expect(ctx.cacheOutcome).toBeNull();
  });

  it('describes an outcome with exactly the six decision-path fields', () => {
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
    const outcome = buildCacheOutcome({ fellBackToLive: true });

    expect(outcome).toEqual({ ...DEFAULT_CACHE_OUTCOME, fellBackToLive: true });
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
    const ctx = record('cache_hit_semantic', semanticHit);

    expect(ctx.cacheStatus).toBe('cache_hit_semantic');
    expect(ctx.cacheOutcome).toEqual(semanticHit);
  });

  it('keeps exactly one status and one outcome when called again', () => {
    const ctx = createDefaultContext();

    recordCacheResult(ctx, 'cache_hit_exact', DEFAULT_CACHE_OUTCOME);
    recordCacheResult(ctx, 'live_provider', semanticHit);

    // One request produces one verdict: a re-record replaces, never appends, so
    // telemetry reads a single status rather than a history it has to reduce.
    expect(ctx.cacheStatus).toBe('live_provider');
    expect(ctx.cacheOutcome).toEqual(semanticHit);
  });

  it('copies the outcome instead of storing the caller s object', () => {
    const outcome = { ...semanticHit };
    const ctx = createDefaultContext();

    recordCacheResult(ctx, 'cache_hit_semantic', outcome);
    outcome.fellBackToLive = true;

    expect(ctx.cacheOutcome?.fellBackToLive).toBe(false);
  });

  it('touches no other context field', () => {
    const before = createDefaultContext();
    const after = createDefaultContext();

    recordCacheResult(after, 'live_provider', semanticHit);

    // The cache owns two fields. Token usage and latency are the gateway's, and
    // a cache hit must not silently zero or invent them.
    expect(after.tokenUsage).toEqual(before.tokenUsage);
    expect(after.latencyMs).toBe(before.latencyMs);
    expect(after.messages).toEqual(before.messages);
    expect(after.tenantId).toBe(before.tenantId);
  });
});
