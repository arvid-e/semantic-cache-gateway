# Research & Design Decisions

## Summary
- **Feature**: `platform-foundation`
- **Discovery Scope**: New Feature (greenfield) — architecture pre-committed by steering; discovery focused on concrete library selection, versions, and wiring patterns.
- **Key Findings**:
  - The stack is fixed by steering (Fastify + TypeScript, Pino, Postgres/`pgvector`, Redis, Ollama). The open decisions were the config-validation approach, the migration tool, the Redis client, `pgvector` type registration, and the test harness.
  - `pgvector` ships as an official npm package (`pgvector`, v0.3.x) with a `registerTypes(client)` helper for `node-postgres`; the `pgvector/pgvector:pg17` Docker image bundles the extension, so no custom Postgres build is needed.
  - `node-pg-migrate` is Postgres-specific, supports SQL migrations, and records applied migrations in a `pgmigrations` table in deterministic (timestamp-ordered) order — a direct match for Requirement 5.
  - Fastify 5 (5.10.x) requires Node 20+ and runs on Node 24 LTS (chosen over 22 for a longer support runway into 2028); its native Pino integration and `onRequest`/`onResponse` hooks cover structured request logging (Req 3.4) and the request-context seam (Req 7) without extra frameworks.

## Research Log

### Config validation approach (Zod vs env-schema/`@fastify/env`)
- **Context**: Requirement 2 needs typed, validated env loading that fails fast, names the offending setting, redacts sensitive values, and exposes a single read-only typed object.
- **Sources Consulted**: Fastify TypeScript docs; Zod docs; `@fastify/env` (env-schema) README.
- **Findings**: `@fastify/env` validates env via JSON Schema/Ajv but yields weaker TS inference and is coupled to the app lifecycle. Zod parses `process.env` into a fully-inferred type before the app is built, throws a structured `ZodError` listing offending keys by name, and produces a natural read-only object via `Object.freeze`.
- **Implications**: Config must load **before** Fastify is constructed (the logger level/redaction come from config), so a lifecycle-independent loader (Zod) fits the bootstrap order in Req 1.1 better than a Fastify plugin. Route/body validation still uses Fastify's native JSON Schema at the HTTP boundary (steering).

### Migration tooling (`node-pg-migrate`)
- **Context**: Requirement 5 needs deterministic, recorded, resumable migrations, with a baseline that enables `pgvector`.
- **Sources Consulted**: `node-pg-migrate` GitHub/docs; npm-compare vs `umzug`/`db-migrate`.
- **Findings**: `node-pg-migrate` is purpose-built for Postgres, records applied migrations in a `pgmigrations` table, applies pending migrations in filename-timestamp order, and stops + reports on failure without recording the failed migration. It exposes both a CLI and a programmatic API. `umzug` is database-agnostic and more flexible but requires wiring a storage backend, which is unnecessary here.
- **Implications**: Adopt `node-pg-migrate`. Baseline migration issues `CREATE EXTENSION IF NOT EXISTS vector`. The runner is invoked as an explicit step (npm script + Docker entrypoint) rather than inside request handling.

### Redis client (`ioredis` vs `node-redis`)
- **Context**: Foundation only needs `PING`/basic connectivity, but downstream specs (`rate-limiting`, `resilience-failover`) need atomic Lua scripts and token-bucket operations.
- **Sources Consulted**: `ioredis` and `node-redis` docs.
- **Findings**: `ioredis` has first-class Lua scripting (`defineCommand`), pipelining, and a mature API widely used for token-bucket rate limiting. Choosing it now avoids a client swap when `rate-limiting` lands.
- **Implications**: Adopt `ioredis` at the foundation and expose it as a shared client so downstream specs reuse the same connection strategy (Req 4.4).

### `pgvector` type registration
- **Context**: Requirement 4.3 requires verifying the `pgvector` extension is available so later specs can store/query `vector(768)`.
- **Sources Consulted**: `pgvector/pgvector-node` README; `pgvector/pgvector` image docs.
- **Findings**: The `pgvector` npm package's `registerTypes(client)` sets up parsers so `vector` columns round-trip as JS arrays; it queries the DB for the vector type OID, which also serves as a runtime check that the extension is installed. The `pgvector/pgvector:pg17` image ships the extension.
- **Implications**: The Postgres plugin runs `registerTypes` on a startup connection and asserts the `vector` extension is present (`SELECT 1 FROM pg_extension WHERE extname = 'vector'`), failing startup with a clear error otherwise (Req 4.2, 4.3).

### Test harness (Vitest + Docker Compose services)
- **Context**: Requirement 9 needs build/lint/format/test commands, strict typing, and integration tests against dockerized Postgres/Redis/Ollama, with at least one passing unit and integration test.
- **Sources Consulted**: Vitest docs; Fastify testing guide (`app.inject`).
- **Findings**: Vitest is TS/ESM-native and fast, with project separation for unit vs integration suites. Fastify's `inject()` exercises routes without binding a port. Foundation readiness only depends on Postgres + Redis, so integration tests target those two services from the Compose stack; spinning Ollama models inside the test path is unnecessary here.
- **Implications**: Integration tests run against `docker compose up -d postgres redis` (or the full stack) via env vars, keeping them deterministic and matching Req 9.4 without heavyweight per-test containers.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Fastify plugin/decorator composition | Each cross-cutting concern (config, db, redis, context, health) is a plugin that decorates the shared app instance | Native to Fastify; clean seams; parallel-safe; matches "domain modules register into a shared host" | Requires disciplined encapsulation to avoid plugins leaking internals | **Selected** — aligns with steering "domain-modular over a shared platform layer" |
| Manual DI container | Build a custom container that wires singletons | Framework-agnostic | Reinvents what Fastify decorators already provide; more boilerplate | Rejected — unnecessary indirection |
| Global singletons/module state | Export shared clients as module-level singletons | Simple to write | Hard to test, no lifecycle control, hidden coupling | Rejected — breaks graceful shutdown and test isolation |

## Design Decisions

### Decision: Config loads before the app is constructed
- **Context**: Req 1.1 mandates config → logger → datastores → listen; the Pino logger's level and redaction come from config.
- **Alternatives Considered**: 1) `@fastify/env` plugin (config available only after `app.ready()`); 2) Standalone `loadConfig()` invoked in the entrypoint before `buildApp(config)`.
- **Selected Approach**: Standalone `loadConfig()` returns a frozen typed `Config`; `buildApp(config)` receives it and derives Pino options from it.
- **Rationale**: Preserves the required startup ordering and keeps `buildApp` pure/testable (config injected, not read from the environment inside the app).
- **Trade-offs**: Config is not a Fastify plugin, but it is still exposed on the app via `app.config` decoration for downstream modules.

### Decision: Shared request context via `onRequest` hook + `request.ctx` decoration
- **Context**: Req 7 needs an extensible, request-scoped object readable/writable by all later stages, with defined defaults.
- **Alternatives Considered**: 1) Pass a context object explicitly through function calls; 2) `AsyncLocalStorage`; 3) Fastify `decorateRequest('ctx')` populated by an `onRequest` hook.
- **Selected Approach**: `decorateRequest('ctx', null)` + an `onRequest` hook that assigns a freshly-defaulted `RequestContext`. The type is extended by downstream specs via TypeScript declaration merging on `FastifyRequest`.
- **Rationale**: Zero-plumbing access in every handler/hook (Req 7.4), lifetime bound to the request (7.1), extensible without touching foundation code (7.3), and every field carries a default (7.5).
- **Trade-offs**: Relies on module augmentation discipline; documented as the single extension mechanism.

### Decision: Migrations run as an explicit step, not during request handling
- **Context**: Req 5 + Req 8 (Compose health-gated ordering).
- **Selected Approach**: A programmatic `runMigrations(config)` wrapper around `node-pg-migrate`, invoked by an npm script and by the gateway container entrypoint before the server starts listening.
- **Rationale**: Deterministic, operator-controlled schema state; keeps the request path free of schema mutation.
- **Trade-offs**: The entrypoint must sequence migrate → serve; documented in the Dockerfile/entrypoint and Compose dependency ordering.

## Risks & Mitigations
- **Startup ordering bugs** (listening before datastores ready) — Mitigation: connect datastores during plugin registration so `app.ready()` rejects on failure; only call `app.listen()` after `ready()` resolves (Req 1.3).
- **Secret leakage in logs/errors** — Mitigation: Pino `redact` paths for credential/key/encryption fields; config errors reference the setting **name** only, never the value (Req 2.3, 3.2, 6.3).
- **`pgvector` extension missing in a given environment** — Mitigation: explicit extension check at startup + baseline migration that enables it; fail fast with a clear message (Req 4.3, 5.3).
- **Request-context drift across specs** — Mitigation: single `RequestContext` type with defaults and a documented declaration-merging extension pattern; foundation never populates business fields (Req 7.2, 7.3).
- **Integration tests coupled to a developer's manual setup** — Mitigation: tests read connection settings from env supplied by the Compose stack; a single documented command brings dependencies up (Req 8.4, 9.4).

## References
- [Fastify LTS / v5](https://fastify.dev/docs/latest/Reference/LTS/) — Node 20+ support; v5.10.x current.
- [node-pg-migrate](https://github.com/salsita/node-pg-migrate) — Postgres migration runner, `pgmigrations` tracking table.
- [pgvector-node](https://github.com/pgvector/pgvector-node) — `registerTypes` for node-postgres; v0.3.x.
- [pgvector](https://github.com/pgvector/pgvector) — extension + `pgvector/pgvector` Docker images.
