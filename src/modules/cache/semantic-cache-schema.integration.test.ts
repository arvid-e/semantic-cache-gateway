import { Pool } from 'pg';
import { loadConfig } from '#src/platform/config/load-config.js';
import { runMigrations } from '#src/platform/db/migrate.js';

// The semantic-cache migration against dockerized Postgres (task 1.1): proves
// the table, both embedding columns, the HNSW cosine index, the scope and
// expiry indexes, and the tenant foreign key exist on the real schema. Run with
// `docker compose up -d postgres` then `npm run test:integration`.

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

const TABLE = 'semantic_cache_entries';

let pool: Pool;

beforeAll(async () => {
  const config = loadConfig();
  await runMigrations(config, silent);
  pool = new Pool({ connectionString: config.postgres.url });
});

afterAll(async () => {
  await pool.end();
});

/** `format_type` renders the typmod, which is where a vector's width lives. */
async function columnType(column: string): Promise<string | null> {
  const { rows } = await pool.query<{ type: string }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attname = $2 AND a.attnum > 0`,
    [TABLE, column],
  );
  return rows[0]?.type ?? null;
}

async function isNotNull(column: string): Promise<boolean> {
  const { rows } = await pool.query<{ notnull: boolean }>(
    `SELECT a.attnotnull AS notnull
       FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attname = $2 AND a.attnum > 0`,
    [TABLE, column],
  );
  return rows[0]?.notnull ?? false;
}

async function indexDefinitions(): Promise<string[]> {
  const { rows } = await pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE tablename = $1`,
    [TABLE],
  );
  return rows.map((r) => r.indexdef);
}

describe('semantic_cache_entries schema', () => {
  it('creates the table', async () => {
    const { rows } = await pool.query<{ exists: string | null }>(
      `SELECT to_regclass($1) AS exists`,
      [TABLE],
    );

    expect(rows[0]?.exists).toBe(TABLE);
  });

  it('stores both embeddings as vector(768)', async () => {
    // The width is load-bearing: Postgres rejects an insert of any other, so a
    // wrong typmod fails at write time rather than degrading silently.
    expect(await columnType('prompt_embedding')).toBe('vector(768)');
    expect(await columnType('originating_context_embedding')).toBe(
      'vector(768)',
    );
  });

  it('requires the prompt embedding but allows a null originating context', async () => {
    // A first turn has no prior AI response to embed; the verifier reads that
    // null as `inconclusive` rather than as a match.
    expect(await isNotNull('prompt_embedding')).toBe(true);
    expect(await isNotNull('originating_context_embedding')).toBe(false);
  });

  it('stores the normalized response and its expiry', async () => {
    expect(await columnType('response_json')).toBe('jsonb');
    expect(await isNotNull('response_json')).toBe(true);
    expect(await columnType('expires_at')).toBe('timestamp with time zone');
    expect(await isNotNull('expires_at')).toBe(true);
  });

  it('indexes the prompt embedding with HNSW under cosine ops', async () => {
    const definitions = await indexDefinitions();

    // Cosine specifically: another opclass would return a neighbour the
    // similarity threshold was never calibrated against.
    expect(
      definitions.some(
        (d) => /USING hnsw/i.test(d) && d.includes('vector_cosine_ops'),
      ),
    ).toBe(true);
  });

  it('indexes the lookup scope and the expiry sweep', async () => {
    const definitions = await indexDefinitions();

    expect(
      definitions.some((d) => d.includes('(tenant_id, model, params_hash)')),
    ).toBe(true);
    expect(definitions.some((d) => d.includes('(expires_at)'))).toBe(true);
  });
});

describe('semantic_cache_entries tenant ownership', () => {
  const embedding = `[${Array.from({ length: 768 }, () => 0.1).join(',')}]`;

  async function createTenant(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('cache-schema-test') RETURNING id`,
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('tenant insert returned no id');
    return id;
  }

  async function insertEntry(tenantId: string): Promise<void> {
    await pool.query(
      `INSERT INTO ${TABLE}
         (tenant_id, model, params_hash, prompt_text, prompt_embedding,
          response_json, expires_at)
       VALUES ($1, 'gpt-5', 'params-hash', 'hello', $2::vector,
               '{"id":"r1"}'::jsonb, now() + interval '1 hour')`,
      [tenantId, embedding],
    );
  }

  it('rejects an entry whose tenant does not exist', async () => {
    // Req 4.1: an entry with no owning tenant could never be scoped to one on
    // read, so the foreign key refuses it at write time.
    await expect(
      insertEntry('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow();
  });

  it('deletes a tenant s entries with the tenant', async () => {
    const tenantId = await createTenant();
    await insertEntry(tenantId);

    await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${TABLE} WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows[0]?.count).toBe('0');
  });
});
