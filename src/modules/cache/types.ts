import type { CacheStatus } from '#src/platform/context/types.js';
import type { NormalizedResponse } from '#src/modules/gateway/types.js';

// This module owns the cache vocabulary's values but not the `cacheStatus`
// declaration, so it re-exports rather than defining a second, drifting union.
// `cache_hit_semantic` is never written while the semantic layer is in shadow
// (Req 8.5); it stays in the union so promotion needs no telemetry change.
export type { CacheStatus };

/** `inconclusive` is a candidate stored without an originating context. */
export type VerificationResult = 'passed' | 'failed' | 'inconclusive';

/** A shadow observation that could not be completed. Never fails the request. */
export type ShadowError = 'embedding_unavailable' | 'search_failed';

/**
 * What the shadow path observed behind a {@link CacheStatus}. Observational
 * only, in the strong sense: no field here may be read to decide a response
 * (Req 1.5). Savings and hit rates are `telemetry-analytics`' to derive.
 */
export interface CacheOutcome {
  readonly semanticCandidate: boolean;
  /**
   * The best similarity the search saw, recorded even below the threshold: on
   * real traffic that distribution is what shadow mode contributes, since the
   * benchmark's fixtures are synthetic. `null` when no search ran.
   */
  readonly candidateSimilarity: number | null;
  /** Advisory (Req 6.5). `not_run` covers an exact hit and an empty search. */
  readonly verification: VerificationResult | 'not_run';
  readonly shadowError: ShadowError | null;
}

/** The shape of "the cache ran and observed nothing" — not of a failure. */
export const DEFAULT_CACHE_OUTCOME: CacheOutcome = Object.freeze({
  semanticCandidate: false,
  candidateSimilarity: null,
  verification: 'not_run',
  shadowError: null,
});

/** A row to be written to `semantic_cache_entries`. */
export interface SemanticEntry {
  readonly tenantId: string;
  readonly model: string;
  readonly paramsHash: string;
  /** Kept beside its embedding: an embedding cannot be read back. */
  readonly promptText: string;
  readonly promptEmbedding: number[];
  /** Embedded last AI response at write time; `null` on a first turn. */
  readonly originatingContextEmbedding: number[] | null;
  readonly response: NormalizedResponse;
  readonly ttlSeconds: number;
}

/** The nearest stored entry to a query. Recorded, never served (Req 3.2). */
export interface SemanticCandidate {
  readonly response: NormalizedResponse;
  readonly similarity: number;
  readonly originatingContext: number[] | null;
}

/**
 * The design's `SemanticCandidate | null` cannot say "nothing qualified, and
 * the nearest entry scored 0.71" — the two facts are independent, and shadow
 * mode needs both: `candidate` is the threshold decision, `bestSimilarity` is
 * the distribution the benchmark's synthetic fixtures cannot supply.
 *
 * `bestSimilarity` is `null` only when there was nothing in scope to compare
 * against, which is a different observation from a poor match.
 */
export interface SemanticSearchResult {
  readonly candidate: SemanticCandidate | null;
  readonly bestSimilarity: number | null;
}
