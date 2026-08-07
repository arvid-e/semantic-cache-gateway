/**
 * Cosine similarity over two embedding vectors, used by both context-aware
 * checks: topic-shift detection compares the latest user message against the
 * last AI response, and context-chain verification compares the current
 * conversation's last AI response against a candidate's originating context.
 *
 * In-app rather than in SQL because both comparisons run on vectors already in
 * memory — the pgvector `<=>` operator stays for the indexed nearest search,
 * where the ranking is the database's job.
 */

/**
 * Similarity in `[-1, 1]`: `1` is identical direction, `0` orthogonal, `-1`
 * opposed. Magnitude is divided out, so raw embeddings compare against a
 * threshold without being normalized first.
 *
 * @throws {RangeError} when the vectors differ in length — a mismatch means the
 * embedding model changed under a populated cache, and returning a number for
 * an incomparable pair would let a threshold silently accept it.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(
      `cosineSimilarity requires equal-length vectors; got ${String(a.length)} and ${String(b.length)}`,
    );
  }

  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (const [i, x] of a.entries()) {
    // `?? 0` satisfies `noUncheckedIndexedAccess`; the length check above means
    // it never fires for a dense pair, and a hole contributes nothing anyway.
    const y = b[i] ?? 0;

    dot += x * y;
    magnitudeA += x * x;
    magnitudeB += y * y;
  }

  // Cosine is undefined against a zero vector (an empty pair included). `0`
  // rather than `NaN` keeps the caller's `>= threshold` comparison meaningful:
  // NaN compares false against every threshold, which reads as a rejection only
  // by accident, whereas 0 rejects deliberately and biases to live (Req 6.6).
  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}
