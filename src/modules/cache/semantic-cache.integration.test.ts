import { Pool } from 'pg';
import { loadConfig } from '#src/platform/config/load-config.js';
import { runMigrations } from '#src/platform/db/migrate.js';
import { DefaultTenantRepository } from '#src/modules/auth/repositories/tenant-repository.js';
import type { NormalizedResponse } from '#src/modules/gateway/types.js';
import { PgSemanticCache } from './semantic-cache.js';
import type { SemanticEntry } from './types.js';

// Semantic layer behaviour against dockerized Postgres and pgvector (task 2.3):
// proves real cosine ranking, the threshold decision, tenant and scope
// isolation, expiry, originating-context persistence, and invalidation. The
// unit suite stubs the driver and cannot prove any of these — the SQL is the
// implementation here. Run with `docker compose up -d postgres` then
// `npm run test:integration`.
//
// Every candidate this suite observes is still only an observation: nothing in
// the layer authorizes serving one (Req 3.2). The orchestrator's tests are
// where "recorded but not served" is asserted.

// Migrations log verbosely; keep the suite output to the test results.
const silent = {
  info: () => {
    /* suppress migration progress */
  },
  warn: () => {
    /* suppress migration progress */
  },
  error: () => {
    /* suppress migration progress */
  },
};

const THRESHOLD = 0.83;
const DIMS = 768;
const MODEL = 'claude-sonnet-4-5-20250929';
const PARAMS = 'params-abc';
const TTL = 3600;

const RESPONSE: NormalizedResponse = {
  id: 'resp-1',
  provider: 'anthropic',
  model: MODEL,
  message: { role: 'assistant', content: 'A Postgres extension for vectors.' },
  usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
  finishReason: 'stop',
};

/**
 * A one-hot 768-vector. Two distinct axes are orthogonal (cosine 0) and an axis
 * with itself is 1, so a test states the similarity it wants structurally
 * instead of hand-tuning floats.
 */
function axis(index: number): number[] {
  const vector = new Array<number>(DIMS).fill(0);
  vector[index] = 1;
  return vector;
}

/** `axis(index)` tilted toward another axis: cosine 1/√1.04 ≈ 0.9806. */
function near(index: number, other: number): number[] {
  const vector = axis(index);
  vector[other] = 0.2;
  return vector;
}

let pool: Pool;
let cache: PgSemanticCache;
let tenantA: string;
let tenantB: string;

function entry(overrides: Partial<SemanticEntry> = {}): SemanticEntry {
  return {
    tenantId: tenantA,
    model: MODEL,
    paramsHash: PARAMS,
    promptText: 'What is pgvector?',
    promptEmbedding: axis(0),
    originatingContextEmbedding: null,
    response: RESPONSE,
    ttlSeconds: TTL,
    ...overrides,
  };
}

function scopeFor(tenantId: string): {
  tenantId: string;
  model: string;
  paramsHash: string;
} {
  return { tenantId, model: MODEL, paramsHash: PARAMS };
}

beforeAll(async () => {
  const config = loadConfig();
  await runMigrations(config, silent);
  pool = new Pool({ connectionString: config.postgres.url });
  cache = new PgSemanticCache(pool, THRESHOLD);

  const tenants = new DefaultTenantRepository(pool);
  tenantA = (await tenants.insert('cache-semantic-a')).id;
  tenantB = (await tenants.insert('cache-semantic-b')).id;
});

afterAll(async () => {
  // Cascades to `semantic_cache_entries`, so the suite leaves no rows behind.
  await pool.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [
    [tenantA, tenantB],
  ]);
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM semantic_cache_entries WHERE tenant_id = ANY($1::uuid[])`, [
    [tenantA, tenantB],
  ]);
});

describe('nearest-neighbour search', () => {
  it('returns a stored entry as a candidate above the threshold', async () => {
    await cache.store(entry());

    const result = await cache.search(scopeFor(tenantA), near(0, 1));

    expect(result.candidate?.response).toEqual(RESPONSE);
    expect(result.candidate?.similarity).toBeCloseTo(0.9806, 3);
    expect(result.bestSimilarity).toBeCloseTo(0.9806, 3);
  });

  it('reports the similarity of a sub-threshold nearest entry', async () => {
    await cache.store(entry());

    // Orthogonal: a real cosine of ~0, far under the threshold.
    const result = await cache.search(scopeFor(tenantA), axis(5));

    expect(result.candidate).toBeNull();
    expect(result.bestSimilarity).toBeCloseTo(0, 6);
  });

  it('distinguishes an empty scope from a poor match', async () => {
    const result = await cache.search(scopeFor(tenantA), axis(0));

    expect(result).toEqual({ candidate: null, bestSimilarity: null });
  });

  it('ranks the nearest of several entries', async () => {
    await cache.store(entry({ promptEmbedding: axis(3) }));
    await cache.store(entry({ promptEmbedding: axis(0), promptText: 'nearest' }));

    const result = await cache.search(scopeFor(tenantA), axis(0));

    expect(result.candidate?.similarity).toBeCloseTo(1, 6);
  });
});

describe('isolation', () => {
  it('never returns another tenant s entry', async () => {
    await cache.store(entry({ tenantId: tenantA }));

    // An identical embedding: only `tenant_id` separates them, which is the
    // whole point — a perfect match must still be invisible across tenants
    // (Req 4.3).
    const result = await cache.search(scopeFor(tenantB), axis(0));

    expect(result).toEqual({ candidate: null, bestSimilarity: null });
  });

  it('never returns an entry stored under a different model or params', async () => {
    await cache.store(entry({ model: 'gpt-4o' }));
    await cache.store(entry({ paramsHash: 'other-params' }));

    const result = await cache.search(scopeFor(tenantA), axis(0));

    expect(result).toEqual({ candidate: null, bestSimilarity: null });
  });
});

describe('expiry and invalidation', () => {
  it('never returns an expired entry', async () => {
    // A negative TTL writes an `expires_at` already in the past, which is the
    // direct way to age an entry without sleeping or editing the row behind
    // the layer's back.
    await cache.store(entry({ ttlSeconds: -1 }));

    const result = await cache.search(scopeFor(tenantA), axis(0));

    // Not even a sub-threshold observation: an expired entry is not a row.
    expect(result).toEqual({ candidate: null, bestSimilarity: null });
  });

  it('keeps an entry inside its TTL', async () => {
    await cache.store(entry({ ttlSeconds: TTL }));

    expect((await cache.search(scopeFor(tenantA), axis(0))).candidate).not.toBeNull();
  });

  it('removes one tenant s entries and leaves the other s', async () => {
    await cache.store(entry({ tenantId: tenantA }));
    await cache.store(entry({ tenantId: tenantB }));

    await cache.invalidate(tenantA);

    expect(await cache.search(scopeFor(tenantA), axis(0))).toEqual({
      candidate: null,
      bestSimilarity: null,
    });
    expect((await cache.search(scopeFor(tenantB), axis(0))).candidate).not.toBeNull();
  });
});

describe('originating context', () => {
  it('persists and returns the context an answer was produced under', async () => {
    await cache.store(entry({ originatingContextEmbedding: axis(7) }));

    const result = await cache.search(scopeFor(tenantA), axis(0));

    // Round-trips through `vector` as a literal and back to numbers — this is
    // the input the advisory verdict (task 2.5) compares against.
    expect(result.candidate?.originatingContext).toHaveLength(DIMS);
    expect(result.candidate?.originatingContext?.[7]).toBe(1);
  });

  it('returns null for a first-turn entry', async () => {
    await cache.store(entry({ originatingContextEmbedding: null }));

    const result = await cache.search(scopeFor(tenantA), axis(0));

    expect(result.candidate).not.toBeNull();
    expect(result.candidate?.originatingContext).toBeNull();
  });
});
