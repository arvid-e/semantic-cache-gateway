import type { CacheConfig } from './config.js';
import { cosineSimilarity } from './cosine.js';
import type { VerificationResult } from './types.js';

/**
 * Does a recorded candidate's originating conversation line up with the
 * conversation asking now?
 *
 * **This gates nothing** (Req 6.5). The original design accepted a candidate
 * only on a passing verdict; measurement retired that path (`research.md` →
 * E1–E4) and the verdict survives as an instrument. It is written to
 * `cacheOutcome` and read by no branch — which is why nothing here returns a
 * boolean, the shape an `if` reaches for.
 */

/** `similarity` is `null` exactly when no comparison was possible. */
export interface AdvisoryVerdict {
  readonly result: VerificationResult;
  readonly similarity: number | null;
}

const INCONCLUSIVE: AdvisoryVerdict = Object.freeze({
  result: 'inconclusive',
  similarity: null,
});

export interface ContextChainVerifier {
  /**
   * ADVISORY ONLY (Req 6.5). Callers record this and must not branch on it.
   *
   * @throws {RangeError} on embeddings of differing width — see the
   * implementation for why that is not scored as a failure.
   */
  verify(
    currentLastAiEmbedding: number[] | null,
    candidateOriginatingContext: number[] | null,
  ): AdvisoryVerdict;
}

/** The verdict's only input beyond the two vectors (Req 6.3: never keyed). */
export type ContextChainVerifierConfig = Pick<
  CacheConfig,
  'verificationThreshold'
>;

export class AdvisoryContextChainVerifier implements ContextChainVerifier {
  readonly #verificationThreshold: number;

  constructor(config: ContextChainVerifierConfig) {
    this.#verificationThreshold = config.verificationThreshold;
  }

  verify(
    currentLastAiEmbedding: number[] | null,
    candidateOriginatingContext: number[] | null,
  ): AdvisoryVerdict {
    // Req 6.4 names the stored side — an entry written on a first turn has no
    // context to chain to. A null current side is the same absence from the
    // other end. Either way there is no pair to compare.
    if (
      currentLastAiEmbedding === null ||
      candidateOriginatingContext === null
    ) {
      return INCONCLUSIVE;
    }

    // Unguarded on purpose: `cosineSimilarity` throws on a width mismatch,
    // meaning the embedding model changed under a populated cache. Catching it
    // would report `failed` — a misalignment that was never measured. The
    // shadow path records the throw and goes live regardless (Req 3.6).
    const similarity = cosineSimilarity(
      currentLastAiEmbedding,
      candidateOriginatingContext,
    );

    return Object.freeze({
      // `>=`: the configured threshold is the lowest passing value.
      result: similarity >= this.#verificationThreshold ? 'passed' : 'failed',
      similarity,
    });
  }
}
