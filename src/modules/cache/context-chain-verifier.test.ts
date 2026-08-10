import { AdvisoryContextChainVerifier } from './context-chain-verifier.js';

/** Production vectors are `nomic-embed-text`'s 768 dimensions. */
const DIMENSIONS = 768;

function filled(value: number, length = DIMENSIONS): number[] {
  return Array.from({ length }, () => value);
}

function verifierAt(
  verificationThreshold: number,
): AdvisoryContextChainVerifier {
  return new AdvisoryContextChainVerifier({ verificationThreshold });
}

describe('AdvisoryContextChainVerifier', () => {
  it('passes an aligned context above the threshold', () => {
    const context = [0.1, -0.4, 0.92, 0.33];

    const verdict = verifierAt(0.85).verify(context, context);

    expect(verdict.result).toBe('passed');
    expect(verdict.similarity).toBeCloseTo(1, 12);
  });

  it('passes a similarity exactly equal to the threshold', () => {
    // `>=`, not `>`: the threshold is the lowest passing value. Both pairs are
    // exactly representable and asserted with `toBe`, so the case cannot drift
    // off the boundary. A `filled(0.5)` pair would not do — it accumulates to
    // 1.0000000000000002 over 768 terms, landing *above* a threshold of 1,
    // where `>` passes too and nothing is proven.
    const orthogonal = verifierAt(0).verify([1, 0], [0, 1]);
    const identical = verifierAt(1).verify([1, 0], [1, 0]);

    expect(orthogonal.similarity).toBe(0);
    expect(orthogonal.result).toBe('passed');
    expect(identical.similarity).toBe(1);
    expect(identical.result).toBe('passed');
  });

  it('fails a context below the threshold', () => {
    const current = [1, 0];
    const stored = [0, 1];

    const verdict = verifierAt(0.85).verify(current, stored);

    expect(verdict.result).toBe('failed');
    expect(verdict.similarity).toBeCloseTo(0, 12);
  });

  it('fails an opposed context and still reports its similarity', () => {
    // Recorded on every computed verdict, not only passing ones: the benchmark
    // reads the distribution, not just the outcome.
    const verdict = verifierAt(0.85).verify([1, 0], [-1, 0]);

    expect(verdict.result).toBe('failed');
    expect(verdict.similarity).toBeCloseTo(-1, 12);
  });

  it('reads the threshold from config rather than a constant', () => {
    const current = [1, 0];
    const stored = [0.6, 0.8]; // cosine 0.6

    expect(verifierAt(0.5).verify(current, stored).result).toBe('passed');
    expect(verifierAt(0.7).verify(current, stored).result).toBe('failed');
  });

  it('is inconclusive when the candidate has no stored originating context', () => {
    // Req 6.4: an entry written on a first turn has no context to chain to —
    // an absent comparison, not a failed one.
    const verdict = verifierAt(0.85).verify(filled(0.5), null);

    expect(verdict.result).toBe('inconclusive');
    expect(verdict.similarity).toBeNull();
  });

  it('is inconclusive when the current conversation has no last AI response', () => {
    // The mirror case: neither side alone can produce a similarity.
    const verdict = verifierAt(0.85).verify(null, filled(0.5));

    expect(verdict.result).toBe('inconclusive');
    expect(verdict.similarity).toBeNull();
  });

  it('is inconclusive when neither side has an embedding', () => {
    const verdict = verifierAt(0.85).verify(null, null);

    expect(verdict.result).toBe('inconclusive');
    expect(verdict.similarity).toBeNull();
  });

  it('computes the verdict without any external or keyed call', () => {
    // Req 6.3: the cache path stays key-free — arithmetic over vectors already
    // in memory, touching no transport.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    try {
      verifierAt(0.85).verify(filled(0.5), filled(0.5));
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces incomparable vectors rather than scoring them', () => {
    // A width mismatch means the embedding model changed under a populated
    // cache. `failed` would report a misalignment that was never measured.
    expect(() => verifierAt(0.85).verify([1, 2, 3], [1, 2])).toThrow(
      RangeError,
    );
  });
});
