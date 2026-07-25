# Implementation Plan

> **Solo implementation note:** Work top-to-bottom; ignore `(P)` markers. Open `design.md`
> (File Structure Plan + Components) for the concrete interfaces, make the observable bullet true,
> then run the checks. This spec defines the canonical `ProviderName`, `CredentialResolver`, and
> `ProviderSecret` consumed downstream — see `.kiro/steering/implementation-guide.md`.

- [ ] 1. Foundation: schema, config, and shared contracts
- [ ] 1.1 Author the auth database migration
  - Add this spec's migration creating `tenants`, `gateway_api_keys` (unique `key_hash`, non-secret `key_prefix`, nullable `revoked_at`), and `provider_credentials` (encrypted `ciphertext`, `key_version`, unique `(tenant_id, provider)`, provider check constraint), with tenant foreign keys and indexes
  - Observable: running migrations creates the three tables with the tenant foreign keys, the unique `key_hash` and `(tenant_id, provider)` constraints, and no plaintext secret column in any table
  - _File: migrations/{timestamp}_auth_tenancy.sql_
  - _Requirements: 1.1, 1.3, 2.4, 3.2, 3.3_
- [ ] 1.2 (P) Implement the auth config segment
  - Validate the auth environment segment (encryption keyring with an active version, gateway-key pepper, admin token) with fail-fast, secret-safe semantics consistent with the foundation loader
  - Observable: an invalid or missing auth setting fails plugin configuration with an error naming the setting and never printing its value; a valid environment yields a typed read-only auth config
  - _File: src/modules/auth/config.ts_
  - _Requirements: 5.4, 6.1, 6.2_
  - _Boundary: Auth Config_
- [ ] 1.3 (P) Define shared auth types and the redacting secret wrapper
  - Define `ProviderName`, the tenant/key/credential entity types, `CredentialResolution`, the credential error types, and the `ProviderSecret` wrapper that reveals its value only via an explicit call
  - Observable: `ProviderSecret` serializes as `[REDACTED]` from `toJSON`/`toString` while `reveal()` returns the raw value; `ProviderName` and the resolver result types are exported for downstream specs
  - _File: src/modules/auth/types.ts_
  - _Requirements: 2.5, 4.4, 6.3_
  - _Boundary: Auth types, ProviderSecret_

- [ ] 2. Cryptographic primitives
- [ ] 2.1 (P) Implement gateway API-key hashing and generation
  - Generate high-entropy `scg_`-prefixed keys, derive a non-secret prefix, compute the keyed hash from the configured pepper, and compare candidates in constant time
  - Observable: the same key and pepper always produce the same hash, a wrong key does not match, comparison is constant-time, and a generated key carries the expected prefix
  - _File: src/modules/auth/crypto/key-hash.ts_
  - _Requirements: 2.4, 6.4_
  - _Boundary: Key Hash Util_
  - _Depends: 1.2_
- [ ] 2.2 (P) Implement provider-credential envelope encryption
  - Encrypt secrets with AES-256-GCM using the active keyring version and a fresh per-message nonce, encode `iv‖authTag‖ciphertext`, and decrypt by selecting the key for the stored version
  - Observable: encrypt→decrypt round-trips a secret; a tampered ciphertext or auth tag fails; an unknown or invalid key version raises a typed error whose message contains no ciphertext or key material
  - _File: src/modules/auth/crypto/envelope-encryption.ts_
  - _Requirements: 3.1, 3.4, 3.5, 6.2_
  - _Boundary: Envelope Encryption Util_
  - _Depends: 1.2_

- [ ] 3. Data access
- [ ] 3.1 Implement tenant-scoped auth repositories
  - Implement tenant, gateway-key, and provider-credential repositories over the shared Postgres client: insert/lookup tenants, insert/lookup-by-hash/revoke gateway keys, and upsert/get/delete credentials by `(tenant, provider)`; every query is scoped by tenant
  - Observable: a gateway-key lookup by hash returns the owning tenant, a credential upsert respects the `(tenant, provider)` uniqueness, and a lookup scoped to one tenant never returns another tenant's row
  - _File: src/modules/auth/repositories/tenant-repository.ts, api-key-repository.ts, credential-repository.ts_
  - _Requirements: 1.1, 1.3, 1.4, 2.4, 3.2_
  - _Boundary: Auth Repositories_
  - _Depends: 1.1_

- [ ] 4. Services and credential resolution
- [ ] 4.1 (P) Implement the tenant service
  - Create tenants with a stable unique identifier
  - Observable: creating a tenant persists a row with a unique id returned to the caller
  - _File: src/modules/auth/services/tenant-service.ts_
  - _Requirements: 1.1_
  - _Boundary: TenantService_
  - _Depends: 3.1_
- [ ] 4.2 (P) Implement the gateway API-key service
  - Issue keys (persist only the hash and prefix, return the plaintext exactly once) and authenticate a presented key to its owning tenant, keeping gateway keys distinct from provider keys
  - Observable: issuing a key returns the plaintext once while storage holds only the hash; authenticating a valid key resolves to exactly one tenant and an unknown key resolves to no tenant
  - _File: src/modules/auth/services/api-key-service.ts_
  - _Requirements: 2.1, 2.3, 2.4, 5.2, 6.4_
  - _Boundary: ApiKeyService_
  - _Depends: 2.1, 3.1_
- [ ] 4.3 (P) Implement the credential service
  - Attach/rotate (encrypt then upsert), remove, and decrypt-in-memory provider credentials scoped to `(tenant, provider)`, supporting multiple providers per tenant
  - Observable: attaching a credential stores ciphertext only, retrieval decrypts back to the original secret, rotation replaces it, removal deletes it, and a tenant can hold credentials for two providers at once
  - _File: src/modules/auth/services/credential-service.ts_
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 5.3_
  - _Boundary: CredentialService_
  - _Depends: 2.2, 3.1_
- [ ] 4.4 Implement the BYOK credential resolver
  - Resolve a provider credential from a per-request key (used without persisting) or, absent that, from decrypted storage; return a typed missing result when neither exists and a typed decryption-failure result on decrypt error; wrap resolved secrets in the redacting wrapper
  - Observable: a per-request key resolves without being persisted, a stored credential resolves decrypted, absence returns `missing`, a decrypt failure returns `decryption_failed`, and the resolved secret is a `ProviderSecret`
  - _File: src/modules/auth/services/credential-resolver.ts_
  - _Requirements: 3.5, 4.1, 4.2, 4.3, 4.4_
  - _Boundary: CredentialResolver_
  - _Depends: 4.3, 1.3_

- [ ] 5. Integration: middleware, admin API, and plugin wiring
- [ ] 5.1 Implement the gateway authentication middleware
  - Extract and authenticate the gateway API key, set the tenant identity in the shared request context, and reject missing/unknown/invalid keys before any downstream processing; never write the key to the context
  - Observable: a valid key sets the request-context tenant identity and allows the request to proceed, while a missing or invalid key returns unauthorized without invoking downstream processing
  - _File: src/modules/auth/middleware/authenticate.ts_
  - _Requirements: 1.2, 2.1, 2.2, 2.3, 6.3_
  - _Boundary: Auth Middleware_
  - _Depends: 4.2_
- [ ] 5.2 Implement admin authorization and tenant/key provisioning routes
  - Add the admin authorization guard (constant-time token check that rejects and makes no change on failure) and the routes to create a tenant and to issue and revoke a gateway key, returning the issued key plaintext only once
  - Observable: a request without valid admin authorization is rejected and makes no change; creating a tenant and issuing a key succeed; the issue-key response exposes the plaintext exactly once and stores only the hash
  - _File: src/modules/auth/middleware/admin-guard.ts, src/modules/auth/routes/admin-routes.ts_
  - _Requirements: 5.1, 5.2, 5.4, 6.4_
  - _Boundary: Admin Guard, Admin Routes_
  - _Depends: 4.1, 4.2, 1.2_
- [ ] 5.3 Implement provider-credential provisioning routes
  - Add the admin routes to attach, rotate, and remove a tenant's provider credential, never returning stored secret material in any response
  - Observable: attach/rotate/remove update the tenant's encrypted credential store, and no response returns a stored provider credential or previously issued key
  - _File: src/modules/auth/routes/admin-routes.ts_
  - _Requirements: 5.3, 5.5_
  - _Boundary: Admin Routes_
  - _Depends: 4.3, 5.2_
- [ ] 5.4 Register the auth plugin and confirm redaction and endpoint scoping
  - Register the auth module onto the foundation app, expose the credential resolver and authentication middleware for downstream specs, keep the foundation health endpoints unauthenticated, and confirm the shared logger redacts the auth secret fields
  - Observable: the app boots with the auth plugin registered and the resolver exposed, the health endpoints remain reachable without authentication, and log output contains no gateway keys, provider credentials, pepper, or encryption key material
  - _File: src/modules/auth/index.ts, src/app.ts_
  - _Requirements: 6.1, 6.3_
  - _Depends: 5.1, 5.2, 5.3_

- [ ] 6. Validation: auth integration tests
- [ ] 6.1 Add integration tests against dockerized PostgreSQL
  - Exercise the end-to-end flows: provision a tenant, issue a key, authenticate a request (tenant context set) and reject an unknown key; attach/resolve/rotate/remove a credential; verify cross-tenant access is denied, a tenant can hold two providers, and no admin response or persisted row exposes a plaintext secret
  - Observable: the integration suite passes, proving authentication, tenant isolation, credential encryption-at-rest and lifecycle, multi-provider storage, and secret non-exposure against the dockerized database
  - _File: src/modules/auth/auth.integration.test.ts_
  - _Requirements: 1.2, 1.4, 2.1, 2.2, 3.1, 3.3, 5.1, 5.5_
  - _Depends: 5.4_
