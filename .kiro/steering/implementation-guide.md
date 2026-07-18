# Implementation Guide (manual / learning-oriented)

This project is being implemented **by hand for learning**, one task at a time, asking for help
when stuck. This guide is the map that the per-spec `tasks.md` and `design.md` files don't
individually give you. Specs live in `.kiro/specs/<name>/` — each has `requirements.md` (WHAT,
with numbered acceptance criteria), `design.md` (HOW — file paths, interfaces, contracts), and
`tasks.md` (the ordered checklist).

## How to work a task
1. Open the spec's `tasks.md` and take the next unchecked sub-task **top to bottom** (ignore `(P)`
   markers — those are only for parallel automation; `_Depends:_` is already satisfied by order).
2. Open that spec's `design.md` alongside it: the **File Structure Plan** gives the file(s), the
   **Components and Interfaces** section gives the exact types/signatures, and the task's `_File:_`
   hint points at the primary file.
3. Implement until the task's **observable "done" bullet** is literally true.
4. Jump to the acceptance criteria named in `_Requirements:_` (in `requirements.md`) and confirm you
   satisfied them.
5. Run the checks (see Verify loop). Check the box. Move on.

You lost the autonomous flow's automated reviewer; your substitutes are the observable bullet, the
Validation task at the end of each spec, and asking me to review a specific diff when unsure.
`/kiro-spec-status <spec>` shows progress anytime.

## Build order (dependency order — do specs in this sequence)
1. **platform-foundation** — get `docker compose up` → `GET /health/ready` green before anything else.
2. **auth-tenancy-credentials**
3. **gateway-provider-routing**
4. **rate-limiting**  *(only needs foundation + auth; can be done before or after routing)*
5. **dual-layer-caching**
6. **resilience-failover**
7. **telemetry-analytics**

Within a spec, tasks are ordered Foundation → Core → Integration → Validation.

## Verify loop (per task / per spec)
- `docker compose up -d postgres redis ollama` — bring up backing services (from platform-foundation).
- `npm run build` — strict type-check. `npm run lint` — style.
- `npm test` — unit suites. `npm run test:integration` — integration suites (need the docker services).
- The exact script names are fixed in **platform-foundation task 1.1**; update this line if they differ.

## Shared contracts cheat-sheet (the cross-spec seams)
These are the seams that span multiple specs — the thing most likely to trip you up. Keep them straight.

### The `RequestContext` (defined in platform-foundation, `src/platform/context/types.ts`)
One object per request, threaded through the pipeline; each stage writes its fields, telemetry reads them.
Extended by later specs via **TypeScript declaration merging** (never by editing the foundation type, with
one deliberate exception noted below).

| Field | Written by | Notes |
|-------|-----------|-------|
| `tenantId` | auth (`authenticate` middleware) | set once, never a secret |
| `provider`, `model`, `params` | gateway (CompletionService) | resolved values |
| `messages`, `latestUserMessage`, `lastAssistantMessage` | gateway | conversation context; caching **reads** these |
| `tokenUsage`, `latencyMs` | gateway (and cache on a hit) | |
| `cacheStatus`, `cacheOutcome` | caching | canonical values `cache_hit_exact`/`cache_hit_semantic`/`live_provider` |
| `failover`, `breakerState`, `breakerEvents` | resilience | |

### `ProviderAdapter` (defined in gateway-provider-routing, `src/modules/gateway/types.ts`)
`complete(request, credential, opts) => NormalizedResponse`. One adapter per provider; each owns request
translation AND response normalization. **Reused by resilience-failover** — keep it stable.

### `ProviderName` and the credential seam (defined in auth-tenancy-credentials)
`ProviderName = 'openai' | 'anthropic' | 'ollama'` and the `CredentialResolver` live in auth (it's upstream
of routing). Gateway and resilience import them from auth. `ProviderSecret.reveal()` is called **only** at
the provider HTTP boundary — never log the revealed value.

### The `complete()` composition order (the big one)
`CachedCompletionService`, `ResilientCompletionService`, and the raw `CompletionService` all implement the
same `complete(input)` contract. The completion route (wired in `src/app.ts`) calls the outermost, composed as:

```
route -> CachedCompletionService -> ResilientCompletionService -> CompletionService -> ProviderAdapter
         (cache: hit avoids all below)  (breaker gate + primary->secondary)  (adapter call)
```

You build them inner-first (gateway's `CompletionService` exists first), then each later spec wraps it. When
you implement caching and resilience, the final wiring in `src/app.ts` establishes this order.

## Cross-spec "remember when you get there" (flagged in the designs as revalidation points)
- **dual-layer-caching** refines the foundation's placeholder `CacheStatus` enum to the canonical
  `unknown | cache_hit_exact | cache_hit_semantic | live_provider`. This is the **one** deliberate edit to a
  foundation type (not declaration merging). When you implement platform-foundation task 3.4, you can either
  use a placeholder now and refine later, or set the canonical values up front.
- **telemetry-analytics** adds `prometheus` and `grafana` services to the foundation's `docker-compose.yml`
  and mounts versioned provisioning files. The foundation compose (task 5.2) doesn't include them yet.
- **rate-limiting** and **resilience-failover** both add atomic Redis **Lua** scripts via ioredis
  `defineCommand` — the reason the foundation chose ioredis over node-redis.
- **Migrations**: each of auth, caching, and telemetry adds its own migration file under `migrations/`
  (foundation only creates the baseline + enables `pgvector`).

## Where the genuinely hard parts are (expect to ask for help here)
- **dual-layer-caching task group 3** — the context-aware decision table (topic-shift → semantic search →
  candidate-only verification → safety-biased fallback). Split into checkpoints; get the exact+live skeleton
  green first, then layer in semantic, then verification.
- **resilience-failover task group 3** — breaker gating + primary→secondary failover, and the composition
  order above.
- **Atomic Lua** (rate-limiting 2.1, resilience 2.1) — getting refill/transition logic right under concurrency.
- **Anthropic adapter** (gateway 2.2) — system-message lifting, content-block concatenation, computed token totals.
