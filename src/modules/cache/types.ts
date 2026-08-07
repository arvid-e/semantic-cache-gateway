import type { CacheStatus } from '#src/platform/context/types.js';
import type { NormalizedResponse } from '#src/modules/gateway/types.js';

// This module owns the cache vocabulary's values but not the `cacheStatus`
// declaration, so it re-exports rather than defining a second, drifting union.
export type { CacheStatus };

/** `no_prior_ai` is a first turn: nothing to compare, not compared-and-unlike. */
export type TopicShiftDecision =
  'standalone' | 'context_dependent' | 'no_prior_ai';

/** `inconclusive` is a candidate stored without an originating context. */
export type VerificationResult = 'passed' | 'failed' | 'inconclusive';

/**
 * The decision path behind a {@link CacheStatus}. Observational only — savings
 * and hit rates are `telemetry-analytics`' to derive.
 */
export interface CacheOutcome {
  readonly topicShift: TopicShiftDecision;
  /** `null` when detection did not run. */
  readonly topicShiftSimilarity: number | null;
  readonly semanticCandidate: boolean;
  /** `null` when the search found none. */
  readonly candidateSimilarity: number | null;
  /** `not_run` covers an exact hit and a semantic miss alike. */
  readonly verification: VerificationResult | 'not_run';
  readonly fellBackToLive: boolean;
}

/** `topicShift` uses `no_prior_ai` for lack of a `not_run` in the design's union. */
export const DEFAULT_CACHE_OUTCOME: CacheOutcome = Object.freeze({
  topicShift: 'no_prior_ai',
  topicShiftSimilarity: null,
  semanticCandidate: false,
  candidateSimilarity: null,
  verification: 'not_run',
  fellBackToLive: false,
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

/** The nearest stored entry to a query, before verification decides on it. */
export interface SemanticCandidate {
  readonly response: NormalizedResponse;
  readonly similarity: number;
  readonly originatingContext: number[] | null;
}
