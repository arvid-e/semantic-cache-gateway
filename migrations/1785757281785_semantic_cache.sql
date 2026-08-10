-- Semantic cache schema for the dual-layer-caching spec (Req 4.1, 7.2).
--
-- The `-- Up Migration` / `-- Down Migration` markers are how node-pg-migrate
-- splits a plain .sql file into its two directions.
--
-- Only the semantic layer has a table; the exact layer lives entirely in Redis.
-- The `vector` type comes from the foundation's baseline migration.

-- Up Migration

-- `prompt_text` sits beside its embedding because an embedding is not
-- reversible, and a stored answer no one can trace back to a question is
-- unauditable. `originating_context_embedding` is the conversation state the
-- answer was produced under — what verification compares a later request
-- against — and is nullable because a first turn has no prior AI response.
CREATE TABLE semantic_cache_entries (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  model                         text NOT NULL,
  params_hash                   text NOT NULL,
  prompt_text                   text NOT NULL,
  prompt_embedding              vector(768) NOT NULL,
  originating_context_embedding vector(768),
  response_json                 jsonb NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  expires_at                    timestamptz NOT NULL
);

-- Cosine specifically: the threshold is calibrated against cosine distance, so
-- another opclass would return a neighbour it was never tuned for. HNSW is
-- approximate — a recall miss only costs one live call.
CREATE INDEX semantic_cache_entries_prompt_embedding_hnsw
  ON semantic_cache_entries USING hnsw (prompt_embedding vector_cosine_ops);

-- Every search filters this triple before ranking by distance.
CREATE INDEX semantic_cache_entries_scope
  ON semantic_cache_entries (tenant_id, model, params_hash);

-- Read on every lookup (`expires_at > now()`) and swept by.
CREATE INDEX semantic_cache_entries_expires_at
  ON semantic_cache_entries (expires_at);

-- Down Migration

-- Dropping the table takes its indexes with it.
DROP TABLE IF EXISTS semantic_cache_entries;
