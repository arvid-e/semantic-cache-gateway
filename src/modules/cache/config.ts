import { z } from 'zod';

// The cache module's own env segment, like auth's and the gateway's. Nothing
// here is secret, so invalid values are echoed rather than only named.

/** No defaults: a default threshold would be a silent product decision. */
const cacheConfigSchema = z.object({
  CACHE_SIMILARITY_THRESHOLD: threshold(),
  CACHE_VERIFICATION_THRESHOLD: threshold(),
  CACHE_EXACT_TTL_SECONDS: ttlSeconds(),
  CACHE_SEMANTIC_TTL_SECONDS: ttlSeconds(),
  CACHE_EMBEDDING_MODEL: z
    .string('is required')
    .trim()
    .min(1, 'must name an embedding model'),
});

/**
 * Coercion reads `''` as 0, so a blanked-out threshold would parse as the value
 * that accepts every candidate. Blank has to mean absent.
 */
function required(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

/**
 * Below 0 accepts opposed vectors; above 1 can never be met, so the layer would
 * silently never hit. Both ends are inclusive and coherent, if extreme.
 */
function threshold() {
  return z.preprocess(
    required,
    z.coerce
      .number('must be a number between 0 and 1')
      .min(0, 'must be at least 0')
      .max(1, 'must be at most 1'),
  );
}

/** Whole seconds: Redis `EX` and the Postgres interval both take integers. */
function ttlSeconds() {
  return z.preprocess(
    required,
    z.coerce
      .number('must be a number of seconds')
      .int('must be a whole number of seconds')
      .positive('must be a positive number of seconds'),
  );
}

/** Read by the cache layers and the verifier — never `process.env`. */
export interface CacheConfig {
  /**
   * Minimum cosine similarity for a stored entry to be *recorded* as a
   * candidate. It authorizes nothing: no threshold value causes a semantic
   * response to be served (Req 3.2). Configurable so the recorded boundary can
   * be varied for measurement without a code change (Req 3.5).
   */
  readonly similarityThreshold: number;
  /** Bound on the advisory verdict, which likewise gates nothing (Req 6.5). */
  readonly verificationThreshold: number;
  readonly exactTtlSeconds: number;
  readonly semanticTtlSeconds: number;
  /** Must emit the 768 dims the schema declares. */
  readonly embeddingModel: string;
}

/** Mirrors `GatewayConfigError`, so a bad environment fails registration alike. */
export class CacheConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheConfigError';
  }
}

/**
 * Call during cache-plugin registration.
 *
 * @throws {CacheConfigError} naming every offending setting, so one boot
 * produces one complete list rather than one restart per mistake.
 */
export function loadCacheConfig(
  env: NodeJS.ProcessEnv = process.env,
): CacheConfig {
  const result = cacheConfigSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues.map((issue) => {
      const key = String(issue.path[0] ?? '(unknown)');
      return `${key} (${issue.message})`;
    });
    throw new CacheConfigError(
      `Invalid cache configuration for: ${details.join(', ')}`,
    );
  }

  const parsed = result.data;

  return Object.freeze({
    similarityThreshold: parsed.CACHE_SIMILARITY_THRESHOLD,
    verificationThreshold: parsed.CACHE_VERIFICATION_THRESHOLD,
    exactTtlSeconds: parsed.CACHE_EXACT_TTL_SECONDS,
    semanticTtlSeconds: parsed.CACHE_SEMANTIC_TTL_SECONDS,
    embeddingModel: parsed.CACHE_EMBEDDING_MODEL,
  });
}
