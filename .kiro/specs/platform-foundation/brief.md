# Brief: platform-foundation

## Problem
Every other feature (auth, routing, caching, resilience, telemetry, rate limiting) needs a
running Fastify service, configuration, structured logging, and access to Redis and Postgres
with `pgvector`. Without a shared, reproducible foundation, each spec would re-invent wiring
and drift apart.

## Current State
Greenfield repository — only `CLAUDE.md` and the Kiro tooling exist. No application code,
no build tooling, no infrastructure.

## Desired Outcome
A reproducible baseline that other specs build on: `docker compose up` brings up the gateway
plus Postgres (`pgvector` enabled), Redis, and Ollama; the service boots, loads typed config
from the environment, logs via Pino, runs DB migrations, and answers a health check.

## Approach
Fastify + TypeScript service scaffold with strict TypeScript config, environment-based typed
config loading, and Pino structured logging. A migration mechanism creates the `pgvector`
extension and a baseline schema hook. A `GET /health` (and readiness) endpoint verifies
Redis and Postgres connectivity. Docker Compose defines gateway, Postgres+`pgvector`, Redis,
and Ollama services with health-gated startup ordering.

## Scope
- **In**: Fastify app bootstrap; TypeScript + lint/format tooling; typed config loader;
  Pino logger setup; Postgres client + `pgvector` extension enablement; Redis client;
  migration runner + baseline migration; `/health` + readiness endpoints; Docker Compose
  for all backing services; a test harness (unit + integration scaffolding).
- **Out**: any business logic (auth, routing, caching, etc.); Prometheus/Grafana wiring
  (owned by telemetry-analytics); provider adapters; production/Fly.io deployment hardening.

## Boundary Candidates
- App bootstrap & plugin registration
- Config loading & validation
- Datastore clients (Postgres/`pgvector`, Redis) & migrations
- Health/readiness surface
- Local infra (Docker Compose)

## Out of Boundary
- Metrics export and dashboards (telemetry-analytics owns Prometheus/Grafana)
- Authentication and tenant modeling (auth-tenancy-credentials)

## Upstream / Downstream
- **Upstream**: none.
- **Downstream**: every other spec depends on this one.

## Existing Spec Touchpoints
- **Extends**: none (first spec).
- **Adjacent**: defines the shared request-context and datastore conventions all later specs consume.

## Constraints
- TypeScript + Fastify; Pino logging; Postgres + `pgvector` and Redis as the only datastores.
- Must run fully via Docker Compose for local reproducibility.
- Establish the shared request-context shape (tenant, provider, model, params, cache status,
  token usage, latency) that later specs populate.
