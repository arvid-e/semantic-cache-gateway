-- Baseline migration for the semantic cache gateway (Req 5.3).
--
-- The `-- Up Migration` / `-- Down Migration` markers are how node-pg-migrate
-- splits a plain .sql file into its two directions; everything between a marker
-- and the next one is sent to Postgres as one statement batch.
--
-- Scope note: the foundation owns no business tables. `platform-foundation`
-- provides infrastructure only, and its boundary reserves every real table for
-- the spec that owns that data (tenants/credentials, cache entries, and so on),
-- each of which ships its own migration. So the foundation's baseline schema is
-- exactly the database capability the platform itself depends on: the `vector`
-- type, which `pg-plugin.ts` asserts is present before the service will boot.

-- Up Migration

-- pgvector ships as an extension, not as a built-in type: the image has the
-- shared library on disk, but a freshly-created database has not loaded it.
-- Until this runs there is no `vector` type, so no later migration can declare
-- an embedding column. IF NOT EXISTS keeps a re-run harmless on a database that
-- already has it (e.g. one restored from a dump).
CREATE EXTENSION IF NOT EXISTS vector;

-- Down Migration

-- Dropping the extension would cascade into any column using the `vector` type,
-- so this only ever succeeds on a database whose feature migrations have already
-- been rolled back — which is the correct order for undoing the baseline.
DROP EXTENSION IF EXISTS vector;
