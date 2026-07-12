# Requirements Document

## Project Description (Input)
The Semantic Cache Gateway is a greenfield project with no application code yet. Every planned
feature (auth/tenancy, provider routing, dual-layer caching, resilience, telemetry, rate
limiting) needs a running Fastify service, typed configuration, structured logging, and access
to Redis and PostgreSQL with `pgvector` — without a shared, reproducible foundation each spec
would re-invent this wiring and drift apart.

This spec establishes that baseline: a Fastify + TypeScript service scaffold with strict
TypeScript, environment-based typed config loading, and Pino structured logging; Postgres
(with the `pgvector` extension enabled) and Redis clients; a database migration runner with a
baseline migration; and `GET /health` plus readiness endpoints that verify Redis and Postgres
connectivity. A Docker Compose setup brings up the gateway alongside Postgres+`pgvector`,
Redis, and Ollama with health-gated startup ordering, and a unit + integration test harness is
scaffolded. This spec also defines the shared request-context shape (tenant, provider, model,
params, cache status, token usage, latency) that later specs populate.

Out of scope: all business logic (auth, routing, caching, resilience, rate limiting), the
Prometheus/Grafana observability layer (owned by `telemetry-analytics`), provider adapters, and
production/Fly.io deployment hardening.

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
