# Research & Design Decisions

## Summary
- **Feature**: `auth-tenancy-credentials`
- **Discovery Scope**: Extension — a new `auth` domain module layered over `platform-foundation`; discovery focused on integration seams and the two security-sensitive decisions (gateway API-key storage, provider-credential encryption at rest).
- **Key Findings**:
  - Gateway API keys are high-entropy random tokens, so the correct storage is a **fast keyed hash (HMAC-SHA256 with a server-side pepper)** — constant-time compared and directly lookup-able — not a slow password hash (bcrypt/argon2), which would add per-request CPU cost and break O(1) lookup.
  - Provider credentials should be encrypted with **AES-256-GCM** using Node's built-in `crypto` (OpenSSL/AES-NI): a fresh 12-byte nonce per encryption, storing `iv‖authTag‖ciphertext`, with a **key-version marker** to enable key rotation without bulk re-encryption. No third-party crypto dependency is warranted.
  - All new state (tenants, hashed gateway keys, encrypted credentials) fits the two-datastore constraint: everything lives in the foundation's PostgreSQL via this spec's own migration; Redis is not needed here.
  - The module is upstream of `gateway-provider-routing`, so it defines the canonical `ProviderName` identifier and the `CredentialResolver` contract that routing (and failover) consume.

## Research Log

### Gateway API-key storage (hashing strategy)
- **Context**: Req 2.4 requires non-reversible storage; Req 2.1–2.3 require authenticating a presented key and resolving it to a tenant on every protected request.
- **Sources Consulted**: OWASP Password Storage Cheat Sheet; API-key vs password hashing analyses (see References).
- **Findings**: For 256-bit random tokens, security comes from entropy, not hash slowness. A per-key random salt would force a full-table scan on each auth (no direct lookup). The production-standard pattern is a deterministic keyed hash — HMAC-SHA256 with a global secret pepper from config — enabling a direct indexed lookup by hash while resisting DB-only compromise; comparison uses `crypto.timingSafeEqual`.
- **Implications**: Store `HMAC_SHA256(pepper, key)` (bytea, unique-indexed) plus a non-secret `key_prefix` for identification. Reject bcrypt/argon2 for gateway keys (retain them only if end-user passwords are ever added — out of scope here).

### Provider-credential encryption at rest
- **Context**: Req 3.1–3.5 require encryption at rest, `(tenant, provider)` scoping, decrypt-in-memory-only, and safe failure when key material is unavailable.
- **Sources Consulted**: Node.js `crypto` AES-256-GCM references; envelope-encryption/key-rotation guidance (see References).
- **Findings**: AES-256-GCM is authenticated encryption (confidentiality + integrity), hardware-accelerated via OpenSSL AES-NI in Node. A unique 12-byte nonce per message is mandatory (nonce reuse is catastrophic). Prepending a key-version/id lets new writes use the active key while old ciphertext still decrypts under prior keys — gradual rotation without bulk re-encryption.
- **Implications**: Encrypt with a config-provided keyring (version → 32-byte key, plus an active version). Persist `iv‖authTag‖ciphertext` (bytea) + `key_version` (smallint). On decrypt, select the key by stored version; a missing/invalid key or failed auth tag yields a typed error exposing no ciphertext or key material (Req 3.5).

### Integration with platform-foundation
- **Context**: This spec extends the foundation rather than re-wiring infrastructure.
- **Sources Consulted**: `platform-foundation/design.md` (this repo).
- **Findings**: The foundation exposes `app.pg`, `app.config`, the shared Pino logger (with redact paths for `authorization`, `*.apiKey`, `*.credential*`, `*.encryptionKey`), `RequestContext.tenantId`, and a migration-runner convention (one migration file per owning spec). Health routes are unauthenticated and must stay so.
- **Implications**: The auth module registers as a Fastify plugin, adds its own migration, validates its own env segment (encryption keyring, key pepper, admin token) at registration with fail-fast semantics, and writes only `tenantId` into the shared context — never any secret. Auth middleware is applied to protected gateway routes but must not cover the foundation's health endpoints.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Domain module as a Fastify plugin (services + repositories + crypto utils) | `src/modules/auth/` owns routes/middleware, services, data access, crypto helpers | Matches steering's domain-modular layering; clear seam; testable services | Requires disciplined layering to keep crypto/secret handling contained | **Selected** |
| Store credentials with `pgcrypto` (DB-side encryption) | Encrypt in SQL functions | Keeps key in DB session | Key travels to DB, appears in query logs; weaker separation | Rejected — application-level AES-GCM keeps keys in the app only |
| bcrypt/argon2 for gateway keys | Slow password hash | Familiar | Per-request CPU cost; no direct lookup; wrong tool for high-entropy tokens | Rejected |
| Envelope encryption with a cloud KMS | KEK/DEK via KMS | Strong rotation/audit | Adds an external dependency and network dependency to the credential path | Deferred — config keyring gives rotation without new infra (interview scope) |

## Design Decisions

### Decision: HMAC-SHA256(pepper) for gateway API keys
- **Context**: Req 2.1–2.4.
- **Alternatives Considered**: 1) bcrypt/argon2 per key; 2) plain SHA-256; 3) HMAC-SHA256 with a config pepper.
- **Selected Approach**: Generate `scg_<base64url(32 random bytes)>`; store `HMAC_SHA256(pepper, key)` (unique-indexed) + `key_prefix`; authenticate by hashing the presented key and looking it up, comparing with `timingSafeEqual`.
- **Rationale**: Deterministic → O(1) indexed lookup; peppered → DB dump alone cannot forge keys; fast → no per-request bottleneck.
- **Trade-offs**: Pepper is a single secret to protect (in config, redacted, rotated by re-issuing keys). Documented as a revalidation trigger.

### Decision: AES-256-GCM keyring for provider credentials
- **Context**: Req 3.1–3.5.
- **Alternatives Considered**: 1) `pgcrypto`; 2) AES-256-CBC + HMAC; 3) AES-256-GCM with a versioned keyring.
- **Selected Approach**: Encrypt with the active key; persist `iv‖authTag‖ciphertext` + `key_version`; decrypt by selecting the key for the stored version; secrets exist decrypted only transiently during a request.
- **Rationale**: Authenticated encryption in one primitive; hardware-accelerated; rotation-ready via version marker; no external dependency.
- **Trade-offs**: Application must guard nonce uniqueness (use `crypto.randomBytes(12)` per encryption) and never log plaintext (enforced by a redacting secret wrapper).

### Decision: `ProviderSecret` redacting value object
- **Context**: Req 4.4, 6.1–6.3 — resolved credentials must reach provider-calling code without leaking to logs/errors/telemetry.
- **Selected Approach**: Wrap every resolved secret in a `ProviderSecret` whose `toJSON`/`toString`/`util.inspect` return `[REDACTED]`, exposing the raw value only via an explicit `reveal()` call at the provider boundary.
- **Rationale**: Makes accidental serialization safe by default across logs, error objects, and telemetry records.
- **Trade-offs**: Downstream must call `reveal()` deliberately; documented in the resolver contract consumed by routing.

### Decision: Auth module validates its own config segment
- **Context**: New sensitive settings (encryption keyring, key pepper, admin token) are auth-specific.
- **Selected Approach**: The module validates its env segment at registration (same fail-fast/secret-safe semantics as the foundation loader) rather than editing the foundation's `Config`.
- **Rationale**: Keeps the foundation closed for modification and the module self-contained.
- **Trade-offs**: Two config schemas exist; acceptable and aligned with domain-modular boundaries.

## Risks & Mitigations
- **Pepper/keyring leakage** — Mitigation: both are sensitive config, in Pino redact paths, never in errors/telemetry; rotation paths documented (re-issue keys; add new key version).
- **Nonce reuse in AES-GCM** — Mitigation: fresh `randomBytes(12)` per encryption; never derive nonce from data.
- **Cross-tenant resource access** (Req 1.4) — Mitigation: every gateway-path query is scoped by the resolved `tenantId`; admin operations validate the resource's `tenant_id` against the path tenant.
- **Secret leakage via serialization** — Mitigation: `ProviderSecret` wrapper + typed errors carrying no secret values + only `tenantId` written to the shared context.
- **Ollama keyless provider** — Note: whether a provider requires a key is `gateway-provider-routing`'s decision; the resolver reports `missing` and routing maps the response. This spec does not call providers.

## References
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) — hashing guidance; API keys vs passwords.
- [SHA-256 vs bcrypt for API keys](https://mojoauth.com/compare-hashing-algorithms/sha-256-vs-bcrypt) — fast hash appropriate for high-entropy tokens.
- [Node.js AES-256-GCM guide](https://shattered.io/aes-256-encryption-nodejs/) — GCM usage, nonce handling.
- [AES-256-GCM with random IV example](https://gist.github.com/AndiDittrich/4629e7db04819244e843) — iv/tag/ciphertext layout.
