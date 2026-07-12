# Brief: auth-tenancy-credentials

## Problem
The gateway must authenticate callers, map them to isolated tenants, and route each request
using the customer's own provider key(s). Provider credentials are highly sensitive: if
stored, they must be encrypted at rest and never leak into logs, errors, or telemetry. There
must also be a way to provision tenants and attach/rotate their provider keys.

## Current State
Only the `platform-foundation` scaffold exists (Fastify, config, Postgres/`pgvector`, Redis,
migrations, health). No notion of tenants, gateway keys, or credentials.

## Desired Outcome
Requests to gateway endpoints are authenticated by a gateway API key mapped to a specific
tenant. Each tenant can supply provider keys either per-request (header) or via securely
stored, encrypted-at-rest credentials. A minimal admin/provisioning API creates tenants,
issues gateway API keys, and attaches/rotates provider credentials — without ever exposing
secret material.

## Approach
Postgres tables for tenants, gateway API keys (hashed), and per-tenant provider credentials
stored in encrypted columns (application-level envelope/symmetric encryption via a key from
config). Fastify auth middleware validates the gateway API key and injects tenant identity
into the request context. A credential resolver returns the provider key for a given
`(tenant, provider)` from the request header or decrypted storage. A minimal admin API
(protected by an admin credential) performs provisioning. Secrets are redacted everywhere.

## Scope
- **In**: tenant model; gateway API-key issuance + hashed storage + auth middleware;
  per-tenant provider credential storage with encryption at rest; credential resolver
  (header-or-stored); minimal admin/provisioning API (create tenant, issue gateway key,
  attach/rotate/remove provider keys); redaction guarantees for logs/errors/telemetry.
- **Out**: rate limiting (rate-limiting spec); the actual provider calls/routing
  (gateway-provider-routing); Admin UI (stretch); OAuth/SSO/user accounts.

## Boundary Candidates
- Tenant & gateway-key model + auth middleware
- Encrypted provider-credential storage + resolver
- Admin/provisioning API
- Secret redaction policy

## Out of Boundary
- Enforcing request quotas / token buckets (rate-limiting)
- Selecting and calling providers (gateway-provider-routing, resilience-failover)

## Upstream / Downstream
- **Upstream**: platform-foundation.
- **Downstream**: gateway-provider-routing (tenant + provider key), rate-limiting (tenant id),
  resilience-failover (secondary provider key), dual-layer-caching (tenant for isolation).

## Existing Spec Touchpoints
- **Extends**: platform-foundation (adds auth plugin + tenant context to the shared request context).
- **Adjacent**: rate-limiting also consumes tenant identity; keep the tenant-context contract shared.

## Constraints
- Provider credentials encrypted at rest; never logged in plaintext; never surfaced in errors/telemetry.
- Support both BYOK modes: per-request header and stored per-tenant credential.
- Gateway API keys are distinct from customer provider keys.
- Failover requires a tenant to attach more than one provider key.
