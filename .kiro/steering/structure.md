# Project Structure

## Organization Philosophy

**Domain-modular over a shared platform layer.** Each roadmap spec maps to a self-contained
domain module (auth, routing, caching, resilience, telemetry, rate limiting) layered over a
common foundation (config, logging, datastore clients, request context). Modules depend on the
foundation and on each other only through explicit shared contracts — never by reaching into
another module's internals.

> Greenfield note: the exact tree is established by `platform-foundation`. The patterns below are
> the intended conventions; refine this file as real code lands, don't pre-catalog files.

## Directory Patterns

### Platform foundation
**Location**: `src/platform/` (or `src/core/`)
**Purpose**: cross-cutting infrastructure — config loading, Pino logger, Postgres/`pgvector` and
Redis clients, migrations, health/readiness, and the shared **request-context** type.
**Example**: `config`, `db`, `redis`, `logger`, `context`.

### Domain modules
**Location**: `src/modules/<domain>/`
**Purpose**: one bounded concern per roadmap spec; owns its routes/middleware, services, and
data access. Example domains: `auth`, `gateway` (routing), `cache`, `resilience`, `telemetry`,
`rate-limiting`.
**Example**: a module exposes a small public surface (a Fastify plugin and/or service functions);
internals stay private to the module.

### Provider adapters
**Location**: `src/modules/gateway/providers/`
**Purpose**: one adapter per provider (`openai`, `anthropic`, `ollama`) behind a shared
`ProviderAdapter` interface. This interface is reused by `resilience` — design it for reuse.

### Infra & ops
**Location**: repo root — `docker-compose.yml`, `migrations/`, Grafana dashboards-as-code.

## Naming Conventions

- **Files/directories**: `kebab-case` (e.g. `rate-limiter.ts`, `circuit-breaker.ts`).
- **Types/interfaces/classes**: `PascalCase` (e.g. `ProviderAdapter`, `RequestContext`).
- **Functions/variables**: `camelCase`.
- **Constants/env keys**: `UPPER_SNAKE_CASE`.

## Import Organization

```typescript
import { RequestContext } from '@/platform/context'   // absolute for cross-module/shared
import { normalizeResponse } from './normalizer'       // relative within a module
```

**Path Aliases**:
- `@/`: maps to `src/`.

## Code Organization Principles

- **Two datastores only** — Redis and Postgres/`pgvector`. Do not introduce a third store.
- **Shared request context is the integration seam** — stages read/write its fields; they do not
  call into each other's internals to pass data.
- **Providers hide behind `ProviderAdapter`** — provider-specific shapes never leak into the
  normalized client contract.
- **Cache-key namespace** is `(tenant, model, key params, prompt)` — caching depends on auth
  (tenant) and routing (model/params); reuse those contracts, don't duplicate them.
- **Secrets never leave their module in plaintext** — credentials are redacted from logs, errors,
  and telemetry everywhere.
- **Dependency direction**: domain modules depend on the platform foundation, never the reverse.

---
_Document patterns, not file trees. New files following these patterns shouldn't require updates.
See `.kiro/steering/roadmap.md` for the module/spec dependency order._
