# Requirements Document

## Project Description (Input)

The gateway must authenticate callers, map them to isolated tenants, and route each request using
the customer's own provider key(s). Provider credentials are highly sensitive: if stored, they
must be encrypted at rest and never leak into logs, errors, or telemetry. There must also be a
way to provision tenants and attach/rotate their provider keys.

This spec establishes: a tenant model with per-tenant isolation; gateway API-key authentication
(issuance, non-reversible storage, and auth middleware) that maps each request to a tenant;
encrypted-at-rest storage of per-tenant provider credentials; a credential resolver that supplies
a provider key either from the request (per-request BYOK) or from encrypted storage; a minimal
admin/provisioning API to create tenants, issue gateway keys, and attach/rotate/remove provider
credentials; and redaction guarantees so secrets never appear in logs, errors, or telemetry.

Out of scope: rate limiting (`rate-limiting`), the actual provider calls/routing/normalization
(`gateway-provider-routing`), circuit breaking and failover (`resilience-failover`), an Admin UI
(stretch), and OAuth/SSO/end-user account management.

## Boundary Context

- **In scope**: the tenant model and per-tenant isolation; gateway API-key authentication
  (issuance, hashed storage, request authentication); encrypted-at-rest storage of per-tenant
  provider credentials; a credential resolver covering both BYOK modes (per-request header and
  stored credential); a minimal admin/provisioning API (create tenant, issue gateway key,
  attach/rotate/remove provider credentials); and secret redaction/non-exposure guarantees.
- **Out of scope**: rate limiting (`rate-limiting`); selecting, calling, or normalizing providers
  (`gateway-provider-routing`); retries, failover, and circuit breaking (`resilience-failover`);
  cache behavior (`dual-layer-caching`); an Admin UI (stretch); and OAuth/SSO/end-user accounts.
- **Adjacent expectations**: depends on `platform-foundation` for the running service, datastore
  clients, the shared logger, and the shared request-context shape (into which this spec writes
  tenant identity). Downstream, `gateway-provider-routing` consumes the tenant identity and the
  credential resolver, `rate-limiting` consumes the tenant identity, `resilience-failover` uses a
  tenant's secondary provider credential, and `dual-layer-caching` uses the tenant identity for
  cache isolation. This spec owns the credential secrets; it does not call providers itself.

## Requirements

### Requirement 1: Tenant Model & Isolation

**Objective:** As a gateway operator, I want each caller mapped to an isolated tenant, so that one
customer's identity and credentials never mix with another's.

#### Acceptance Criteria
1. The Gateway service shall represent each customer as a distinct tenant identified by a stable, unique identifier.
2. When a request is authenticated, the Gateway service shall associate the request with exactly one tenant and record that tenant identity in the shared request context.
3. The Gateway service shall scope every tenant-owned resource (gateway API keys and stored provider credentials) to its owning tenant.
4. If a request or operation attempts to access a resource owned by a different tenant, then the Gateway service shall deny access to that resource.

### Requirement 2: Gateway API-Key Authentication

**Objective:** As an operator, I want every gateway request authenticated by a gateway API key
mapped to a tenant, so that only provisioned callers reach gateway functionality and each is
correctly attributed.

#### Acceptance Criteria
1. When a request arrives at a protected gateway endpoint, the Gateway service shall require a gateway API key and authenticate it before the request proceeds to downstream processing.
2. If the gateway API key is missing, unknown, or invalid, then the Gateway service shall reject the request with an unauthorized error and shall not invoke downstream processing.
3. When a valid gateway API key is presented, the Gateway service shall resolve it to its owning tenant and continue processing the request as that tenant.
4. The Gateway service shall store gateway API keys only in a non-reversible (hashed) form and shall never persist them in plaintext.
5. The Gateway service shall treat gateway API keys as distinct from customer provider keys and shall never substitute one for the other.

### Requirement 3: Encrypted Provider-Credential Storage

**Objective:** As a security-conscious customer, I want my stored provider keys encrypted at rest,
so that my credentials are protected even if the datastore is exposed.

#### Acceptance Criteria
1. When a provider credential is stored for a tenant, the Gateway service shall encrypt the secret at rest before persisting it and shall never persist it in plaintext.
2. The Gateway service shall store each provider credential scoped to a specific `(tenant, provider)` pairing.
3. The Gateway service shall allow a single tenant to hold provider credentials for more than one provider, so that failover to a secondary provider is possible.
4. When a stored provider credential is needed, the Gateway service shall decrypt it in memory only for the duration of its use and shall not persist the decrypted value.
5. If the key material required to decrypt a stored credential is unavailable or invalid, then the Gateway service shall fail the operation with an error and shall not expose ciphertext or key material.

### Requirement 4: Credential Resolution (BYOK Modes)

**Objective:** As a developer integrating the gateway, I want to supply my provider key either
per-request or from secure storage, so that I control how my keys are used without changing my
integration.

#### Acceptance Criteria
1. When a request supplies a provider credential directly (per-request BYOK), the credential resolver shall use that credential for the request and shall not persist it.
2. When a request does not supply a provider credential, the credential resolver shall retrieve the tenant's stored credential for the selected provider.
3. If neither a per-request credential nor a stored credential is available for the selected `(tenant, provider)`, then the Gateway service shall reject the request with an error indicating a missing provider credential.
4. When a credential is resolved, the credential resolver shall make it available to downstream provider-calling logic through a defined interface without writing the secret to logs, errors, or telemetry.

### Requirement 5: Admin / Provisioning API

**Objective:** As an operator, I want a minimal admin API to provision tenants and manage their
keys, so that I can onboard customers and rotate credentials without direct datastore access.

#### Acceptance Criteria
1. When an authorized administrator requests tenant creation, the Admin API shall create a new tenant with a unique identifier.
2. When an authorized administrator requests a gateway API key for a tenant, the Admin API shall issue a new gateway API key, return its plaintext value exactly once at issuance, and store only its hashed form.
3. When an authorized administrator attaches, rotates, or removes a provider credential for a tenant, the Admin API shall update that tenant's encrypted credential store accordingly.
4. If a request to the Admin API lacks valid administrator authorization, then the Admin API shall reject it and make no change.
5. The Admin API shall never return stored secret material (provider credentials or previously issued gateway API keys) in any response.

### Requirement 6: Secret Redaction & Non-Exposure

**Objective:** As a customer, I want my secrets never to appear in logs, errors, or telemetry, so
that using the gateway does not create a new leakage path.

#### Acceptance Criteria
1. The Gateway service shall redact provider credentials, gateway API keys, and encryption key material from all log output.
2. If an error occurs while handling credentials, then the Gateway service shall produce an error message that contains no secret values.
3. The Gateway service shall exclude secret material from every telemetry record and from any shared request-context field consumed by other specs.
4. When a gateway API key is generated, the Gateway service shall expose its plaintext value only at the moment of issuance and never thereafter.
