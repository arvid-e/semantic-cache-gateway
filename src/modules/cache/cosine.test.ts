import { cosineSimilarity } from './cosine.js';

/** Production vectors are `nomic-embed-text`'s 768 dimensions. */
const DIMENSIONS = 768;

function filled(value: number, length = DIMENSIONS): number[] {
  return Array.from({ length }, () => value);
}

describe('cosineSimilarity', () => {
  it('scores a vector against itself as 1', () => {
    const v = [0.1, -0.4, 0.92, 0.33];

    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 12);
  });

  it('scores an opposed vector as -1 and an orthogonal one as 0', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 12);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
  });

  it('matches the hand-computed similarity for known vectors', () => {
    // dot = 32, |a| = sqrt(14), |b| = sqrt(77) -> 32 / sqrt(1078)
    expect(cosineSimilarity([1, 2, 3], [4, 5, 6])).toBeCloseTo(0.9746318, 7);
  });

  it('ignores magnitude, measuring direction only', () => {
    const a = [3, 1, 4];
    const scaled = a.map((n) => n * 17.5);

    // This is why a threshold can be compared against raw embeddings without
    // normalizing them first.
    expect(cosineSimilarity(a, scaled)).toBeCloseTo(1, 12);
  });

  it('works across the full 768 dimensions', () => {
    // Guards against a loop bound or fixed-size assumption that only shows up
    // at production width.
    const a = filled(0.5);
    const b = filled(0.5);
    b[767] = -0.5;

    const similarity = cosineSimilarity(a, b);

    expect(similarity).toBeLessThan(1);
    expect(similarity).toBeGreaterThan(0.99);
  });

  it('returns 0 when either vector has no magnitude', () => {
    // Cosine is undefined against a zero vector. 0 rather than NaN keeps the
    // caller's `>= threshold` comparison meaningful and biases to live.
    expect(cosineSimilarity(filled(0), filled(0.5))).toBe(0);
    expect(cosineSimilarity(filled(0.5), filled(0))).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('rejects vectors of different lengths', () => {
    // A 768-vs-1536 comparison means the embedding model changed under a
    // populated cache — a plausible number for an incomparable pair.
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow();
  });
});
