# Requirements Document

## Introduction

The Semantic Cache Gateway is a greenfield project with no application code yet. Every planned
feature (auth/tenancy, provider routing, dual-layer caching, resilience, telemetry, rate limiting)
needs a running service, typed configuration, structured logging, and access to Redis and
PostgreSQL with `pgvector`. Without a shared, reproducible foundation each spec would re-invent
this wiring and drift apart.

This spec establishes that baseline: a service scaffold with strict typing and environment-based
typed configuration loading; structured logging that redacts secrets; PostgreSQL (with the
`pgvector` extension) and Redis clients; a database migration runner with a baseline migration;
liveness and readiness endpoints that verify datastore connectivity; a Docker Compose environment
that brings the whole stack up with health-gated ordering; and a unit + integration test harness.
It also defines the shared request-context shape that later specs populate, and keeps that shape
extensible so dependent specs (for example, the conversation message list used by context-aware
caching) can add fields without changing the foundation.

The subject of the acceptance criteria below is the **Gateway service** at runtime, or a named
sub-component (the configuration loader, the migration runner, the Docker Compose environment)
where that is clearer.

## Boundary Context

- **In scope**: service bootstrap and lifecycle; typed configuration loading and validation;
  structured logging with secret redaction; PostgreSQL (`pgvector`) and Redis client wiring; a
  database migration runner and baseline migration; liveness/readiness endpoints; the shared
  request-context type; a Docker Compose environment for all backing services; strict-typing,
  lint/format tooling, and a unit + integration test harness.
- **Out of scope**: all business logic (authentication/tenancy, provider routing, caching,
  resilience, rate limiting); the Prometheus/Grafana observability layer (owned by
  `telemetry-analytics`); provider adapters; streaming; and production/Fly.io deployment hardening.
- **Adjacent expectations**: every later spec depends on this foundation and consumes its
  conventions — the shared request-context shape, the datastore clients, and the shared logger.
  This foundation does not populate business fields in the request context; it only defines and
  exposes the shape. `telemetry-analytics` (not this spec) owns metrics export and dashboards.

## Requirements

### Requirement 1: Service Bootstrap & Lifecycle

**Objective:** As a platform engineer, I want the gateway service to boot into a well-defined,
extensible application instance, so that every later domain module has a consistent host to
register routes and middleware into.

#### Acceptance Criteria
1. When the service process starts, the Gateway service shall load configuration, initialize the logger, and establish datastore clients before it begins listening for HTTP requests.
2. When all startup dependencies have initialized successfully, the Gateway service shall listen on the configured HTTP port and accept requests.
3. If any required startup dependency fails to initialize, then the Gateway service shall abort startup with a descriptive error and a non-zero exit code, rather than listening in a partially-initialized state.
4. When the service receives a termination signal, the Gateway service shall stop accepting new requests, close its datastore connections, and exit gracefully.
5. The Gateway service shall allow domain modules to register their own routes and middleware without modifying the foundation's bootstrap code.

### Requirement 2: Typed Configuration Loading & Validation

**Objective:** As an operator, I want all runtime configuration loaded from the environment and
validated at startup, so that misconfiguration is caught immediately rather than at first use.

#### Acceptance Criteria
1. When the service starts, the configuration loader shall read all required settings (HTTP port, PostgreSQL connection, Redis connection, Ollama endpoint, and log level) from environment variables.
2. If a required configuration value is missing or fails validation, then the configuration loader shall abort startup with an error that identifies the offending setting by name.
3. If a configuration value designated as sensitive is invalid, then the configuration loader shall report the error without printing the secret value.
4. Where an optional setting is absent, the configuration loader shall apply a documented default value.
5. The configuration loader shall expose configuration to the rest of the service as a single typed, read-only object.

### Requirement 3: Structured Logging & Secret Redaction

**Objective:** As an operator, I want structured, leveled logs that never leak secrets, so that I
can observe the service safely.

#### Acceptance Criteria
1. The Gateway service shall emit logs as structured records through a shared logger available to all modules.
2. When a log record includes a field designated as sensitive (provider credentials, gateway API keys, or encryption material), the logger shall redact that field's value before the record is written.
3. While the service is running, the Gateway service shall honor a configurable log level so that verbosity can be changed without code changes.
4. When the service handles an HTTP request, the Gateway service shall log request start and completion with correlating metadata (method, route, status code, and latency).

### Requirement 4: Datastore Clients & Connectivity

**Objective:** As a platform engineer, I want ready-to-use PostgreSQL (with `pgvector`) and Redis
clients wired at startup, so that domain modules share one connection strategy instead of each
opening its own.

#### Acceptance Criteria
1. When the service starts, the Gateway service shall establish a connection to PostgreSQL and a connection to Redis using the loaded configuration.
2. If either datastore is unreachable at startup, then the Gateway service shall fail startup with an error identifying which datastore could not be reached.
3. The Gateway service shall verify that the `pgvector` extension is available so that later specs can store and query vector-typed data.
4. The Gateway service shall expose the datastore clients to domain modules through the shared application instance rather than requiring modules to open their own connections.
5. The Gateway service shall rely on only these two datastores (PostgreSQL and Redis) and shall not introduce a third store.

### Requirement 5: Database Migrations

**Objective:** As an operator, I want database schema changes applied through a repeatable
migration mechanism, so that any environment reaches a known schema state deterministically.

#### Acceptance Criteria
1. When migrations are executed, the migration runner shall apply all pending migrations in deterministic order and record which migrations have been applied.
2. When migrations are executed and no migrations are pending, the migration runner shall make no changes and report the schema as up to date.
3. When the baseline migration runs, the migration runner shall enable the `pgvector` extension and create the baseline schema the foundation requires.
4. If a migration fails, then the migration runner shall stop, report the failing migration, and not record the failed migration as applied.

### Requirement 6: Health & Readiness Endpoints

**Objective:** As an operator or orchestrator, I want liveness and readiness endpoints, so that
startup ordering and monitoring can tell whether the service and its dependencies are healthy.

#### Acceptance Criteria
1. When a client requests the liveness endpoint, the Gateway service shall respond with a success status once the HTTP server is accepting requests.
2. When a client requests the readiness endpoint, the Gateway service shall check connectivity to both PostgreSQL and Redis and respond with a success status only if both are reachable.
3. If a readiness check finds a required dependency unreachable, then the Gateway service shall respond with a failure status and indicate which dependency is unhealthy, without exposing secret connection details.
4. The Gateway service shall serve the liveness and readiness endpoints without requiring authentication, and shall continue to do so after authentication is introduced by a later spec.

### Requirement 7: Shared Request Context

**Objective:** As a platform engineer, I want a well-defined, extensible request-scoped context
object, so that later pipeline stages (auth, routing, caching, resilience, telemetry) read and
write shared fields instead of calling into each other's internals.

#### Acceptance Criteria
1. When the service begins handling a request, the Gateway service shall create a request-scoped context object that is available for the lifetime of that request.
2. The shared request context shall define fields for tenant identity, selected provider, model, request parameters, cache status, token usage, latency, and failover/breaker state, so that later specs populate them.
3. The shared request context shall be extensible so that dependent specs can add fields (for example, the conversation message list used for context-aware caching) without changing the foundation's structure.
4. The Gateway service shall make the shared request context accessible to route handlers and middleware without reconstructing it per stage.
5. Where a later stage has not yet populated a context field, that field shall carry a defined default value rather than being undefined.

### Requirement 8: Local Environment via Docker Compose

**Objective:** As a developer, I want a single command to bring up the whole local stack, so that
the service is reproducible without manual setup.

#### Acceptance Criteria
1. When an operator brings up the Docker Compose stack, the Docker Compose environment shall start the gateway service alongside PostgreSQL (with `pgvector`), Redis, and Ollama.
2. While the stack is starting, the Docker Compose environment shall gate the gateway service's startup on the backing services reporting healthy, so the gateway does not start before its dependencies are ready.
3. When the stack is running, the operator shall be able to reach the gateway's readiness endpoint and receive a healthy response without additional manual configuration.
4. The Docker Compose environment shall supply the service the configuration it needs to connect to each backing service.

### Requirement 9: Development Tooling & Test Harness

**Objective:** As a developer, I want strict typing, lint/format tooling, and a test harness for
unit and integration tests, so that later specs can add tests against real backing services from
day one.

#### Acceptance Criteria
1. The project shall provide commands to build, lint, format, and test the codebase.
2. When the project is built, the build shall enforce strict type checking and fail if type errors are present.
3. When code violates the configured lint or formatting rules, the tooling shall report the violations and exit with a non-zero status.
4. When the test harness runs integration tests, it shall execute them against the dockerized PostgreSQL, Redis, and Ollama dependencies.
5. The project shall include at least one passing unit test and one passing integration test that exercise the foundation (for example, configuration loading and a readiness check) to prove the harness works.
