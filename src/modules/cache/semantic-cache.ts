import type { Pool } from 'pg';
import { isNormalizedResponse } from './normalized-response.js';
import type {
  SemanticCandidate,
  SemanticEntry,
  SemanticSearchResult,
} from './types.js';

/**
 * The semantic layer: nearest-neighbour search over stored prompt embeddings,
 * scoped to one tenant, model, and params triple (Req 3.1, 4.2).
 *
 * **This layer runs in shadow.** Its mechanics are unchanged by the 2026-08-08
 * revision — storing, searching, and invalidating were never what failed. What
 * changed is downstream: a returned candidate is an *observation*, not an
 * authorization to serve it (Req 3.2). Measurement showed that similarity above
 * any threshold is not evidence the cached answer is correct for the new
 * prompt, so the orchestrator records what this returns and calls the provider
 * regardless. See `.kiro/specs/dual-layer-caching/research.md`, Measurement Log.
 *
 * Nothing here enforces that; a store cannot stop its caller serving what it
 * returns. The guarantee lives in the orchestrator, which never lets a
 * candidate reach the expression that produces the response (Req 1.5).
 */

/** The triple every search filters on before ranking by distance. */
export interface SemanticScope {
  readonly tenantId: string;
  readonly model: string;
  readonly paramsHash: string;
}

export interface SemanticCache {
  /**
   * The nearest unexpired in-scope entry, with the threshold decision and the
   * raw similarity reported separately — see {@link SemanticSearchResult}.
   */
  search(
    scope: SemanticScope,
    queryEmbedding: number[],
  ): Promise<SemanticSearchResult>;
  store(entry: SemanticEntry): Promise<void>;
  invalidate(tenantId: string): Promise<void>;
}

/**
 * Minimal query surface, satisfied by both `app.pg` and a `PoolClient` — the
 * same shape the auth repositories take. Exported so a test can stub the
 * app-side branches without standing up Postgres; the SQL itself is proved
 * against the real database in the integration suite.
 */
export type SemanticCacheDb = Pick<Pool, 'query'>;

/** Nothing in scope to compare against: not a poor match, an empty search. */
const NOTHING_IN_SCOPE: SemanticSearchResult = Object.freeze({
  candidate: null,
  bestSimilarity: null,
});

interface SearchRow {
  response_json: unknown;
  originating_context_embedding: string | null;
  similarity: number;
}

export class PgSemanticCache implements SemanticCache {
  readonly #db: SemanticCacheDb;
  readonly #similarityThreshold: number;

  constructor(db: SemanticCacheDb, similarityThreshold: number) {
    this.#db = db;
    this.#similarityThreshold = similarityThreshold;
  }

  /**
   * One row, ordered by `<=>` so the HNSW cosine index does the ranking — any
   * other operator would drop to a sequential scan, and any other opclass would
   * return a neighbour the threshold was never calibrated against.
   *
   * The threshold is applied *here* rather than in the `WHERE` clause. Filtering
   * in SQL would discard exactly the information shadow mode exists to collect:
   * a sub-threshold nearest neighbour still reports its similarity, and only the
   * `candidate` field reflects the threshold (Req 3.2).
   */
  async search(
    scope: SemanticScope,
    queryEmbedding: number[],
  ): Promise<SemanticSearchResult> {
    const { rows } = await this.#db.query<SearchRow>(
      `SELECT response_json,
              originating_context_embedding,
              1 - (prompt_embedding <=> $4::vector) AS similarity
         FROM semantic_cache_entries
        WHERE tenant_id = $1
          AND model = $2
          AND params_hash = $3
          AND expires_at > now()
        ORDER BY prompt_embedding <=> $4::vector
        LIMIT 1`,
      [scope.tenantId, scope.model, scope.paramsHash, toVector(queryEmbedding)],
    );

    const row = rows[0];
    if (row === undefined) return NOTHING_IN_SCOPE;

    // Every filter that could admit a wrong tenant's row is in the SQL above:
    // the scope triple (Req 4.2, 4.3) and `expires_at > now()` (Req 7.3). An
    // expired or foreign entry is not a low-similarity candidate here — it is
    // not a row at all, so it cannot even skew the recorded distribution.
    const { similarity } = row;
    const response: unknown = row.response_json;

    if (similarity < this.#similarityThreshold) {
      return { candidate: null, bestSimilarity: similarity };
    }

    // A row that no longer parses is not a candidate, but its similarity is
    // still a real measurement of the embedding space and is still recorded.
    if (!isNormalizedResponse(response)) {
      return { candidate: null, bestSimilarity: similarity };
    }

    const candidate: SemanticCandidate = {
      response,
      similarity,
      originatingContext: parseVector(row.originating_context_embedding),
    };

    return { candidate, bestSimilarity: similarity };
  }

  /**
   * Population on a live response (Req 7.1, 7.2). `expires_at` is computed by
   * Postgres rather than in Node so the TTL is measured against the same clock
   * the search's `now()` reads — a skewed app server would otherwise write
   * entries that are already expired, or ones that outlive their TTL.
   *
   * Entries are inserted, never upserted: two prompts that embed identically
   * are still two observations, and collapsing them would understate how often
   * the layer sees a near-duplicate.
   */
  async store(entry: SemanticEntry): Promise<void> {
    await this.#db.query(
      `INSERT INTO semantic_cache_entries
         (tenant_id, model, params_hash, prompt_text, prompt_embedding,
          originating_context_embedding, response_json, expires_at)
       VALUES ($1, $2, $3, $4, $5::vector, $6::vector, $7,
               now() + make_interval(secs => $8::double precision))`,
      [
        entry.tenantId,
        entry.model,
        entry.paramsHash,
        entry.promptText,
        toVector(entry.promptEmbedding),
        // Null on a first turn: no prior AI response to have been produced
        // under. The verifier reads that as `inconclusive` rather than as a
        // failure, which is the honest reading of "there was no context".
        entry.originatingContextEmbedding === null
          ? null
          : toVector(entry.originatingContextEmbedding),
        entry.response,
        entry.ttlSeconds,
      ],
    );
  }

  /**
   * Invalidation by tenant (Req 7.4). Unlike the exact layer, no side index is
   * needed — `tenant_id` is a column, and the scope index covers the delete.
   */
  async invalidate(tenantId: string): Promise<void> {
    await this.#db.query(
      `DELETE FROM semantic_cache_entries WHERE tenant_id = $1`,
      [tenantId],
    );
  }
}

/**
 * pgvector's text form is a JSON-shaped array literal, so `JSON.stringify` is
 * the exact encoding it wants. The `::vector` cast at each call site is what
 * makes Postgres read it as a vector rather than as text.
 */
function toVector(embedding: number[]): string {
  return JSON.stringify(embedding);
}

/**
 * `vector` is an extension type with a dynamic OID, so `pg` has no parser for
 * it and hands back the literal. A value that will not parse yields `null`, the
 * same as a genuinely absent context: both mean "no context to verify against",
 * and the verifier treats that as inconclusive rather than as a mismatch.
 */
function parseVector(raw: string | null): number[] | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;

  return parsed.every((n): n is number => typeof n === 'number')
    ? parsed
    : null;
}
