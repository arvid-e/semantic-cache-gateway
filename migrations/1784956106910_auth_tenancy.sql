-- Auth, tenancy, and credential schema for the auth-tenancy-credentials spec
-- (Req 1.1, 1.3, 2.4, 3.2, 3.3).
--
-- The `-- Up Migration` / `-- Down Migration` markers are how node-pg-migrate
-- splits a plain .sql file into its two directions; everything between a marker
-- and the next one is sent to Postgres as one statement batch.
--
-- Scope note: `platform-foundation` reserves every real table for the spec that
-- owns its data, so this is the migration that introduces the tenant identity
-- and secret-storage tables. Two secret-safety invariants are structural here:
-- gateway keys are stored only as non-reversible keyed hashes, and provider
-- credentials only as AES-256-GCM ciphertext — no table has a plaintext secret
-- column (Req 2.4, 3.1).

-- Up Migration

-- A tenant is the isolation boundary: gateway keys and provider credentials both
-- hang off a tenant, and every gateway-path query filters on the resolved
-- tenant. `gen_random_uuid()` is built into PostgreSQL 17, so no extension is
-- needed for the surrogate key.
CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Gateway API keys authenticate an inbound request to its owning tenant. Only
-- the keyed hash of the presented key is stored (HMAC-SHA256 under the configured
-- pepper), never the key itself (Req 2.4). `key_hash` is UNIQUE so authentication
-- is a single indexed lookup, and `key_prefix` is a non-secret identifier shown
-- in admin listings. `revoked_at` NULL means active; setting it revokes the key
-- without deleting its row. ON DELETE CASCADE ties key lifetime to the tenant.
CREATE TABLE gateway_api_keys (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash   bytea NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL
);

-- Index the foreign key so listing/revoking a tenant's keys, and the cascade on
-- tenant deletion, do not sequentially scan the table. (Postgres does not create
-- an index for a REFERENCES constraint automatically.)
CREATE INDEX gateway_api_keys_tenant_id_idx ON gateway_api_keys (tenant_id);

-- Provider credentials store each tenant's per-provider secret encrypted at rest.
-- `ciphertext` holds the AES-256-GCM envelope (`iv || authTag || ciphertext`) and
-- `key_version` selects the keyring entry used to encrypt it, so the active key
-- can rotate without re-encrypting older rows (Req 3.1, 3.4). The CHECK pins
-- `provider` to the canonical ProviderName set this spec owns; the UNIQUE
-- `(tenant_id, provider)` allows one stored credential per provider while still
-- letting a tenant hold credentials for several providers (Req 3.2, 3.3).
CREATE TABLE provider_credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'ollama')),
  ciphertext  bytea NOT NULL,
  key_version smallint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

-- Down Migration

-- Drop in reverse dependency order. The foreign keys would let the child tables
-- fall to a CASCADE on `tenants`, but dropping them explicitly keeps the rollback
-- symmetric with the Up direction and independent of cascade behavior.
DROP TABLE IF EXISTS provider_credentials;
DROP TABLE IF EXISTS gateway_api_keys;
DROP TABLE IF EXISTS tenants;
