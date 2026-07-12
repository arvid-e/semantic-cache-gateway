# Technology Stack

## Architecture

A single Fastify (TypeScript) service fronts three provider adapters. Requests flow through a
pipeline: **auth → rate limit → cache lookup → (on miss) provider call with resilience →
normalize → telemetry**. State lives in exactly **two datastores** — Redis and PostgreSQL — to
keep moving parts minimal. Everything runs locally via Docker Compose.

A shared **request-context object** (tenant, provider, model, params, cache status, token usage,
latency, failover/breaker state) is threaded through the pipeline; each stage populates its
fields and telemetry reads them at the end.

## Core Technologies

- **Language**: TypeScript (strict mode)
- **Framework**: Fastify (schema-validated routes)
- **Runtime**: Node.js (LTS)
- **Datastores**: Redis (exact cache, rate-limit buckets, circuit-breaker state) and PostgreSQL
  with the `pgvector` extension (tenants, encrypted credentials, semantic vectors, telemetry)
- **Local inference**: Ollama — serves the local chat model **and** generates embeddings via
  `nomic-embed-text` (768-dim → `vector(768)`)

## Key Libraries

Only libraries that shape patterns:
- **Pino** — structured logging (must redact secrets)
- **Prometheus client + Grafana** — metrics export and dashboards (owned by `telemetry-analytics`)
- **BullMQ** *(optional)* — offload telemetry writes so logging never blocks the request path
- Provider SDKs/HTTP clients for OpenAI and Anthropic; plain HTTP for Ollama

## Development Standards

### Type Safety
TypeScript strict mode; avoid `any`. Validate all external I/O (requests, provider responses,
config) with Fastify/JSON schemas at the boundary.

### Code Quality
ESLint + Prettier. Keep provider-specific shapes behind the `ProviderAdapter` interface so they
never leak into the normalized client contract.

### Testing
Unit tests per module plus integration tests against Dockerized Redis/Postgres/Ollama.
Interview-grade: cover cache hit/miss paths, failover, circuit-breaker transitions, and rate-limit
atomicity.

## Development Environment

### Required Tools
Docker + Docker Compose (Postgres+`pgvector`, Redis, Ollama, gateway), Node.js LTS.

### Common Commands
```bash
# Infra + service (local): docker compose up
# Dev:   (defined by platform-foundation, e.g. npm run dev)
# Build: (e.g. npm run build)
# Test:  (e.g. npm test)
```
_Exact scripts are established by the `platform-foundation` spec; update here once fixed._

## Key Technical Decisions

- **`pgvector` over Qdrant** — reuse the Postgres already needed for logging; no third datastore.
- **Local Ollama embeddings over an embedding API** — keeps the cache path key-free, offline, and
  zero-cost, reinforcing "cache hit = no provider key called."
- **Prometheus + Grafana over a custom `/stats` UI** — a polished client UI is out of scope.
- **Encrypted Postgres columns for provider credentials** — encrypted at rest; never logged in
  plaintext; never surfaced in errors or telemetry.
- **Non-streaming v1** — clean cache semantics; streaming is a stretch goal.
- **Estimated savings only** — computed from a static in-repo pricing table; no live pricing, no billing.

---
_Document standards and patterns, not every dependency._
