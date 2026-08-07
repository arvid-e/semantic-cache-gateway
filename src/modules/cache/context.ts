import type {
  CacheStatus,
  RequestContext,
} from '#src/platform/context/types.js';
import { DEFAULT_CACHE_OUTCOME, type CacheOutcome } from './types.js';

// `cacheStatus` is refined in place in the foundation instead: merging can add
// a field but cannot narrow one.
declare module '#src/platform/context/types.js' {
  interface RequestContext {
    /** `null` until the cache has run — distinguishable from every outcome. */
    cacheOutcome: CacheOutcome | null;
  }
}

/**
 * Lets a caller state only what it observed, so unmeasured fields keep their
 * "did not run" values instead of a plausible-looking zero.
 */
export function buildCacheOutcome(
  observed: Partial<CacheOutcome>,
): CacheOutcome {
  return { ...DEFAULT_CACHE_OUTCOME, ...observed };
}

/**
 * Both fields together: a status without its outcome is unexplainable, an
 * outcome without its status unattributable. A second call replaces the verdict
 * rather than appending, and the copy stops a caller rewriting what it recorded.
 */
export function recordCacheResult(
  ctx: RequestContext,
  status: CacheStatus,
  outcome: CacheOutcome,
): void {
  ctx.cacheStatus = status;
  ctx.cacheOutcome = { ...outcome };
}
