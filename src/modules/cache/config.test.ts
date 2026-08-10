import { CacheConfigError, loadCacheConfig } from './config.js';

/** A complete, valid cache environment; each test perturbs one setting. */
const VALID: NodeJS.ProcessEnv = {
  CACHE_SIMILARITY_THRESHOLD: '0.83',
  CACHE_VERIFICATION_THRESHOLD: '0.75',
  CACHE_EXACT_TTL_SECONDS: '3600',
  CACHE_SEMANTIC_TTL_SECONDS: '86400',
  CACHE_EMBEDDING_MODEL: 'nomic-embed-text',
};

function envWith(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...VALID, ...overrides };
}

function envWithout(key: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(VALID).filter(([name]) => name !== key),
  );
}

const THRESHOLDS = [
  'CACHE_SIMILARITY_THRESHOLD',
  'CACHE_VERIFICATION_THRESHOLD',
] as const;

const TTLS = ['CACHE_EXACT_TTL_SECONDS', 'CACHE_SEMANTIC_TTL_SECONDS'] as const;

describe('loadCacheConfig — valid environment', () => {
  it('exposes the two thresholds, the two TTLs, and the embedding model', () => {
    const config = loadCacheConfig(VALID);

    // No topic-shift threshold: Req 5 is withdrawn, and a setting that
    // configures nothing is a trap for the next reader.
    expect(config).toEqual({
      similarityThreshold: 0.83,
      verificationThreshold: 0.75,
      exactTtlSeconds: 3600,
      semanticTtlSeconds: 86400,
      embeddingModel: 'nomic-embed-text',
    });
  });

  it('freezes the result', () => {
    // Thresholds are read on every request; a caller that could mutate them
    // would change matching behaviour mid-process.
    expect(Object.isFrozen(loadCacheConfig(VALID))).toBe(true);
  });

  it('accepts the threshold boundaries', () => {
    const config = loadCacheConfig(
      envWith({
        CACHE_SIMILARITY_THRESHOLD: '0',
        CACHE_VERIFICATION_THRESHOLD: '1',
      }),
    );

    expect(config.similarityThreshold).toBe(0);
    expect(config.verificationThreshold).toBe(1);
  });
});

describe('loadCacheConfig — missing settings', () => {
  it.each([...THRESHOLDS, ...TTLS, 'CACHE_EMBEDDING_MODEL'])(
    'fails naming %s when it is absent',
    (key) => {
      // All required: a default threshold would be a silent product decision.
      expect(() => loadCacheConfig(envWithout(key))).toThrow(CacheConfigError);
      expect(() => loadCacheConfig(envWithout(key))).toThrow(new RegExp(key));
    },
  );

  it('names every offending setting in one error', () => {
    const env = { CACHE_EMBEDDING_MODEL: 'nomic-embed-text' };

    try {
      loadCacheConfig(env);
      expect.unreachable('expected a CacheConfigError');
    } catch (error) {
      const message = (error as Error).message;
      // Fail-fast means one boot, one complete list — not five restarts.
      for (const key of [...THRESHOLDS, ...TTLS]) {
        expect(message).toContain(key);
      }
    }
  });
});

describe('loadCacheConfig — invalid settings', () => {
  it.each(THRESHOLDS)('rejects %s above 1', (key) => {
    // Cosine similarity cannot exceed 1, so a threshold above it can never be
    // met: the layer would silently never hit.
    expect(() => loadCacheConfig(envWith({ [key]: '1.01' }))).toThrow(
      new RegExp(key),
    );
  });

  it.each(THRESHOLDS)('rejects %s below 0', (key) => {
    expect(() => loadCacheConfig(envWith({ [key]: '-0.1' }))).toThrow(
      new RegExp(key),
    );
  });

  it.each(THRESHOLDS)('rejects a non-numeric %s', (key) => {
    expect(() => loadCacheConfig(envWith({ [key]: 'high' }))).toThrow(
      new RegExp(key),
    );
  });

  it.each(TTLS)('rejects a non-positive %s', (key) => {
    expect(() => loadCacheConfig(envWith({ [key]: '0' }))).toThrow(
      new RegExp(key),
    );
    expect(() => loadCacheConfig(envWith({ [key]: '-60' }))).toThrow(
      new RegExp(key),
    );
  });

  it.each(TTLS)('rejects a fractional %s', (key) => {
    // Both stores take whole seconds (Redis `EX`, an interval in Postgres).
    expect(() => loadCacheConfig(envWith({ [key]: '1.5' }))).toThrow(
      new RegExp(key),
    );
  });

  it.each([...THRESHOLDS, ...TTLS])('rejects an empty %s', (key) => {
    // Coercion reads `''` as 0, which for a threshold means "accept every
    // candidate" — the worst possible reading of a line left blank.
    expect(() => loadCacheConfig(envWith({ [key]: '' }))).toThrow(
      new RegExp(key),
    );
    expect(() => loadCacheConfig(envWith({ [key]: '  ' }))).toThrow(
      new RegExp(key),
    );
  });

  it('rejects an empty embedding model', () => {
    expect(() =>
      loadCacheConfig(envWith({ CACHE_EMBEDDING_MODEL: '   ' })),
    ).toThrow(/CACHE_EMBEDDING_MODEL/);
  });
});
