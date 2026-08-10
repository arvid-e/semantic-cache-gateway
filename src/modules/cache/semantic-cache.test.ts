import type { NormalizedResponse } from '#src/modules/gateway/types.js';
import {
  PgSemanticCache,
  type SemanticCacheDb,
  type SemanticScope,
} from './semantic-cache.js';
import type { SemanticEntry } from './types.js';

// The app-side branches only: what the layer does with a row once Postgres has
// returned it. That the SQL selects the right row — real cosine distance, real
// tenant scoping, real expiry — is proved against pgvector in
// `semantic-cache.integration.test.ts`, which a stub cannot stand in for.

const THRESHOLD = 0.83;
const TENANT = '11111111-1111-4111-8111-111111111111';

const RESPONSE: NormalizedResponse = {
  id: 'resp-1',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
  message: { role: 'assistant', content: 'A Postgres extension for vectors.' },
  usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
  finishReason: 'stop',
};

const SCOPE: SemanticScope = {
  tenantId: TENANT,
  model: 'claude-sonnet-4-5-20250929',
  paramsHash: 'params-abc',
};

const QUERY = [0.1, 0.2, 0.3];

interface Call {
  sql: string;
  params: unknown[];
}

/**
 * Records what was sent and replays canned rows. `pg`'s `query` is heavily
 * overloaded, so the cast is what a hand-written stub costs; the shape this
 * layer actually uses is one method returning `{ rows }`.
 */
class FakeDb {
  readonly calls: Call[] = [];
  rows: Record<string, unknown>[] = [];

  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }> {
    this.calls.push({ sql, params });
    return Promise.resolve({ rows: this.rows });
  }

  get lastSql(): string {
    return this.calls.at(-1)?.sql ?? '';
  }

  get lastParams(): unknown[] {
    return this.calls.at(-1)?.params ?? [];
  }
}

function cacheWith(
  rows: Record<string, unknown>[] = [],
  threshold = THRESHOLD,
): { db: FakeDb; cache: PgSemanticCache } {
  const db = new FakeDb();
  db.rows = rows;
  return {
    db,
    cache: new PgSemanticCache(db as unknown as SemanticCacheDb, threshold),
  };
}

/** A row as Postgres returns it: snake_case, the vector column as a literal. */
function row(
  similarity: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    response_json: RESPONSE,
    originating_context_embedding: '[0.4,0.5,0.6]',
    similarity,
    ...overrides,
  };
}

describe('search — scoping and index use', () => {
  it('filters by tenant, model, params, and expiry', async () => {
    const { db, cache } = cacheWith();

    await cache.search(SCOPE, QUERY);

    // Isolation is the SQL's job (Req 4.2, 4.3): a foreign or expired entry
    // must not be a row at all, rather than a row rejected afterwards.
    expect(db.lastSql).toContain('tenant_id = $1');
    expect(db.lastSql).toContain('model = $2');
    expect(db.lastSql).toContain('params_hash = $3');
    expect(db.lastSql).toContain('expires_at > now()');
    expect(db.lastParams.slice(0, 3)).toEqual([
      TENANT,
      SCOPE.model,
      SCOPE.paramsHash,
    ]);
  });

  it('ranks with the cosine operator the HNSW index is built on', async () => {
    const { db, cache } = cacheWith();

    await cache.search(SCOPE, QUERY);

    // Any other operator silently drops to a sequential scan, and any other
    // opclass returns a neighbour the threshold was never calibrated against.
    expect(db.lastSql).toContain('ORDER BY prompt_embedding <=> $4::vector');
    expect(db.lastSql).toContain('LIMIT 1');
  });

  it('does not filter by the similarity threshold in SQL', async () => {
    const { db, cache } = cacheWith();

    await cache.search(SCOPE, QUERY);

    // The load-bearing one for shadow mode: filtering in SQL would discard the
    // sub-threshold similarities that are the distribution being collected
    // (Req 3.2). The threshold must never reach the database.
    expect(db.lastSql).not.toMatch(/similarity\s*>=/);
    expect(db.lastParams).not.toContain(THRESHOLD);
  });

  it('encodes the query embedding as a pgvector literal', async () => {
    const { db, cache } = cacheWith();

    await cache.search(SCOPE, QUERY);

    expect(db.lastParams[3]).toBe('[0.1,0.2,0.3]');
  });
});

describe('search — the threshold decision', () => {
  it('returns a candidate above the threshold', async () => {
    const { cache } = cacheWith([row(0.91)]);

    const result = await cache.search(SCOPE, QUERY);

    expect(result.candidate).toEqual({
      response: RESPONSE,
      similarity: 0.91,
      originatingContext: [0.4, 0.5, 0.6],
    });
    expect(result.bestSimilarity).toBe(0.91);
  });

  it('treats the threshold itself as qualifying', async () => {
    const { cache } = cacheWith([row(THRESHOLD)]);

    // "at or above" (Req 3.2) — the boundary belongs to the candidate side.
    expect((await cache.search(SCOPE, QUERY)).candidate).not.toBeNull();
  });

  it('reports the similarity of a sub-threshold nearest entry', async () => {
    const { cache } = cacheWith([row(0.71)]);

    const result = await cache.search(SCOPE, QUERY);

    // No candidate, but the measurement survives: this is the distribution
    // shadow mode contributes and the synthetic fixtures cannot.
    expect(result.candidate).toBeNull();
    expect(result.bestSimilarity).toBe(0.71);
  });

  it('distinguishes an empty scope from a poor match', async () => {
    const { cache } = cacheWith([]);

    const result = await cache.search(SCOPE, QUERY);

    // `null` similarity means nothing was compared. A poor match reports its
    // number; conflating the two would put a phantom 0 in the distribution.
    expect(result).toEqual({ candidate: null, bestSimilarity: null });
  });
});

describe('search — degraded rows', () => {
  it('rejects an unreadable response but keeps its similarity', async () => {
    const { cache } = cacheWith([row(0.95, { response_json: { id: 'partial' } })]);

    const result = await cache.search(SCOPE, QUERY);

    // A response shape that changed under a populated cache is answerable by
    // going live; the embedding distance it was found at is still a real
    // measurement of the vector space.
    expect(result.candidate).toBeNull();
    expect(result.bestSimilarity).toBe(0.95);
  });

  it('carries a first-turn entry with no originating context', async () => {
    const { cache } = cacheWith([
      row(0.9, { originating_context_embedding: null }),
    ]);

    const result = await cache.search(SCOPE, QUERY);

    // Not a rejection: a first turn has no prior AI response, which the
    // verifier reads as inconclusive rather than as a mismatch.
    expect(result.candidate?.originatingContext).toBeNull();
  });

  it('reads an unparseable context vector as absent', async () => {
    const { cache } = cacheWith([
      row(0.9, { originating_context_embedding: 'not-a-vector' }),
    ]);

    const result = await cache.search(SCOPE, QUERY);

    expect(result.candidate?.originatingContext).toBeNull();
    expect(result.candidate?.response).toEqual(RESPONSE);
  });
});

describe('store', () => {
  const entry: SemanticEntry = {
    tenantId: TENANT,
    model: SCOPE.model,
    paramsHash: SCOPE.paramsHash,
    promptText: 'What is pgvector?',
    promptEmbedding: QUERY,
    originatingContextEmbedding: [0.4, 0.5, 0.6],
    response: RESPONSE,
    ttlSeconds: 86400,
  };

  it('writes the prompt, both vectors, the response, and the TTL', async () => {
    const { db, cache } = cacheWith();

    await cache.store(entry);

    expect(db.lastParams).toEqual([
      TENANT,
      SCOPE.model,
      SCOPE.paramsHash,
      'What is pgvector?',
      '[0.1,0.2,0.3]',
      '[0.4,0.5,0.6]',
      RESPONSE,
      86400,
    ]);
  });

  it('lets Postgres compute the expiry from its own clock', async () => {
    const { db, cache } = cacheWith();

    await cache.store(entry);

    // A timestamp computed in Node would be measured against a different clock
    // than the search's `now()`, so a skewed app server could write entries
    // that are already expired or that outlive their TTL.
    expect(db.lastSql).toContain('now() + make_interval');
    expect(db.lastParams).not.toContainEqual(expect.any(Date));
  });

  it('stores a first turn with a null originating context', async () => {
    const { db, cache } = cacheWith();

    await cache.store({ ...entry, originatingContextEmbedding: null });

    expect(db.lastParams[5]).toBeNull();
  });
});

describe('invalidate', () => {
  it('deletes only the given tenant s entries', async () => {
    const { db, cache } = cacheWith();

    await cache.invalidate(TENANT);

    expect(db.lastSql).toContain('DELETE FROM semantic_cache_entries');
    expect(db.lastSql).toContain('WHERE tenant_id = $1');
    expect(db.lastParams).toEqual([TENANT]);
  });
});
