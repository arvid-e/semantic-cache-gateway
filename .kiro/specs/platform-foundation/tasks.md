# Implementation Plan

> **Solo implementation note:** Work top-to-bottom; ignore `(P)` markers (they're for parallel
> automation). For each task, open `design.md` (File Structure Plan + Components) for the concrete
> interfaces, make the task's observable bullet true, then run the checks. See
> `.kiro/steering/implementation-guide.md` for the build order and shared-contract seams.

- [x] 1. Foundation: project scaffold and tooling
- [x] 1.1 Initialize TypeScript service scaffold with strict typing and dev tooling
  - Create the Node.js 24 project with strict TypeScript (ESM, `#src/` → `src/` subpath import via package.json `"imports"`) and ESLint + Prettier configuration
  - Add `package.json` scripts for build, dev (watch), start, lint, format, and test
  - Observable: `npm run build` type-checks under strict mode and exits non-zero on a type error; `npm run lint` and `npm run format` report violations and exit non-zero when rules are broken
  - _File: package.json, tsconfig.json, eslint.config.js, .prettierrc_
  - _Requirements: 9.1, 9.2, 9.3_
- [x] 1.2 Configure the Vitest test harness with co-located unit and integration suites
  - Wire Vitest with distinct `test` (unit) and `test:integration` commands that select suites by filename suffix, not directory: unit matches co-located `**/*.test.ts` (excluding integration), integration matches co-located `**/*.integration.test.ts`; the integration suite reads datastore connection settings from the environment
  - Tests live beside the file under test — no `test/` tree; add placeholder tests in place (e.g. `src/**/placeholder.test.ts` and `src/**/placeholder.integration.test.ts`)
  - Observable: `npm test` runs only the unit suite and `npm run test:integration` runs only the integration suite; a co-located placeholder test in each suite passes and neither command picks up the other's files
  - _File: vitest.config.ts_
  - _Requirements: 9.1, 9.4_

- [x] 2. Foundation: configuration and logging
- [x] 2.1 Implement the typed configuration loader with validation and secret-safe errors
  - Read all required settings (HTTP port, PostgreSQL, Redis, Ollama endpoint, log level) from the environment; apply documented defaults for optional settings; expose a single frozen, typed, read-only config object
  - Fail startup on missing/invalid values with an error naming the offending setting; for settings marked sensitive, report the error without printing the value
  - Add a unit test covering a missing required variable (named), an invalid sensitive value (value not printed), default application, and the object being read-only
  - Observable: constructing config from an invalid environment throws an error naming the setting (and omitting any secret value); a valid environment yields a frozen typed object; the unit test passes
  - _File: src/platform/config/schema.ts, src/platform/config/load-config.ts, src/platform/config/config.test.ts_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.3, 8.4, 9.5_
- [x] 2.2 Implement shared logger configuration with secret redaction
  - Produce Pino logger options driven by config: honor the configured log level and redact sensitive fields (provider credentials, gateway API keys, encryption material, authorization headers) before records are written
  - Add a unit test asserting a record containing a redact-path field is masked regardless of level
  - Observable: a log record carrying a sensitive field is emitted with that value masked; the unit test passes
  - _File: src/platform/logger/logger-options.ts_
  - _Requirements: 3.1, 3.2, 3.3_
  - _Depends: 2.1_

- [ ] 3. Core platform plugins
- [x] 3.1 (P) Implement the shared PostgreSQL client plugin with pgvector support
  - Establish a pooled Postgres client from config, register pgvector types on a startup connection, and assert the `vector` extension is available; expose the client on the shared app instance and close the pool on shutdown
  - Fail plugin startup with an error naming PostgreSQL when unreachable, or naming the missing extension when `vector` is absent
  - Observable: on boot the app exposes a ready shared Postgres client with vector types registered; an unreachable database or missing extension aborts startup with the corresponding named error
  - _File: src/platform/db/pg-plugin.ts_
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 1.3_
  - _Boundary: Postgres Plugin_
  - _Depends: 2.1_
- [x] 3.2 (P) Implement the shared Redis client plugin
  - Establish a Redis client from config, verify connectivity at startup, expose it on the shared app instance, and quit the client on shutdown
  - Fail plugin startup with an error naming Redis when unreachable
  - Observable: on boot the app exposes a ready shared Redis client; an unreachable Redis aborts startup with a Redis-named error
  - _File: src/platform/redis/redis-plugin.ts_
  - _Requirements: 4.1, 4.2, 4.4, 1.3_
  - _Boundary: Redis Plugin_
  - _Depends: 2.1_
- [x] 3.3 (P) Implement the migration runner and baseline migration
  - Provide a runner that applies pending migrations in deterministic order, records applied migrations, no-ops when up to date, and on failure stops, reports the failing migration, and does not record it
  - Author the baseline migration that enables the `pgvector` extension and creates the foundation baseline schema
  - Observable: running migrations against a fresh database enables the `vector` extension and records the baseline; re-running reports the schema as up to date and changes nothing
  - _File: src/platform/db/migrate.ts, migrations/{timestamp}_baseline.sql_
  - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - _Boundary: Migration Runner_
  - _Depends: 2.1_
- [ ] 3.4 (P) Implement the extensible shared request context
  - Define the request-context shape with fields for tenant identity, provider, model, params, cache status, token usage, latency, and failover/breaker state, each with a defined default; attach a freshly-defaulted context to every request for its lifetime and make it accessible to handlers and middleware
  - Ensure the shape is extensible by later specs without changing foundation code, and add a unit test asserting a new request's context carries all defaults
  - Observable: every handled request exposes a context object whose unset fields hold defined defaults (never undefined); the unit test passes
  - _File: src/platform/context/types.ts, src/platform/context/context-plugin.ts_
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 9.5_
  - _Boundary: Request Context_

- [ ] 4. Integration: health endpoints and application assembly
- [ ] 4.1 Implement liveness and readiness endpoints
  - Serve a liveness endpoint returning success once the server accepts requests (no datastore checks) and a readiness endpoint that checks both Postgres and Redis, succeeding only when both are reachable
  - On a failed readiness check, respond with a failure status that names the unhealthy dependency without exposing connection secrets; keep both endpoints unauthenticated
  - Observable: liveness returns success independent of datastore state; readiness returns success when both datastores are up and a failure naming the down dependency (no secrets) when one is unreachable
  - _File: src/platform/health/health-plugin.ts_
  - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - _Boundary: Health Plugin_
  - _Depends: 3.1, 3.2_
- [ ] 4.2 Assemble the application host with shared plugins and request logging
  - Build the Fastify application from config with the shared logger, registering the configuration, Postgres, Redis, request-context, and health plugins so that only the two datastores' clients are wired and domain modules can later register their own routes/middleware without editing the bootstrap
  - Emit structured request start/completion logs with method, route, status code, and latency
  - Observable: the assembled app boots with all foundation plugins registered, logs each request's lifecycle with the correlating metadata, and accepts registration of an additional plugin without bootstrap changes
  - _File: src/app.ts, src/types/fastify.d.ts_
  - _Requirements: 1.1, 1.5, 3.1, 3.4, 4.5_
  - _Depends: 2.2, 3.1, 3.2, 3.4, 4.1_
- [ ] 4.3 Implement the entrypoint bootstrap sequence and graceful shutdown
  - Drive startup in order — load config, run migrations, build the app, and begin listening only after all startup dependencies initialize successfully; abort with a descriptive error and non-zero exit if any step fails
  - On a termination signal, stop accepting new requests, close datastore connections, and exit gracefully
  - Observable: the service listens only after config, migrations, and datastore connections succeed; a failed dependency exits non-zero; a termination signal drains and closes connections before exit
  - _File: src/index.ts_
  - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - _Depends: 3.3, 4.2_

- [ ] 5. Local environment via Docker Compose
- [ ] 5.1 Containerize the gateway with a migrate-then-serve entrypoint
  - Author the image build and container entrypoint that runs database migrations before starting the server
  - Observable: building and running the container applies migrations and then starts the listening service
  - _File: Dockerfile_
  - _Requirements: 8.2_
  - _Depends: 4.3_
- [ ] 5.2 Define the Docker Compose stack with health-gated startup
  - Compose the gateway alongside PostgreSQL (`pgvector`), Redis, and Ollama with healthchecks; gate the gateway's startup on the backing services reporting healthy and supply it the configuration to reach each one
  - Observable: `docker compose up` starts all four services, the gateway starts only after dependencies are healthy, and its readiness endpoint responds healthy with no manual configuration
  - _File: docker-compose.yml_
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 4.5_
  - _Depends: 5.1_

- [ ] 6. Validation: foundation integration tests
- [ ] 6.1 Add integration tests proving the foundation against dockerized dependencies
  - Boot the application against dockerized Postgres and Redis and assert: readiness returns success when both are up; readiness returns a failure naming the dependency (no secrets) when one is unreachable; liveness succeeds independent of datastore state; and the `vector` extension is present after migrations
  - Observable: the integration suite passes against the dockerized dependencies, exercising readiness success/failure, liveness, and pgvector availability
  - _File: src/platform/health/readiness.integration.test.ts_
  - _Requirements: 6.1, 6.2, 6.3, 8.3, 4.3, 5.3, 9.4, 9.5_
  - _Depends: 4.3, 5.2_
