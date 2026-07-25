import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiKeyService } from '../services/api-key-service.js';

/**
 * Gateway authentication middleware (Req 1.2, 2.1, 2.2, 2.3, 6.3).
 *
 * A Fastify hook that authenticates the gateway API key on the
 * `Authorization: Bearer <key>` header and binds the request to its tenant by
 * writing `request.ctx.tenantId`. A missing, malformed, unknown, or revoked key
 * is rejected with 401 before the route handler runs — returning the reply from
 * the hook is what stops the lifecycle, so downstream processing never sees an
 * unauthenticated request (Req 2.1, 2.2).
 *
 * Only the resolved `tenantId` is written to the shared context; the key itself
 * never touches `request.ctx`, logs, or telemetry (Req 6.3).
 *
 * This is exported as a seam: `gateway-provider-routing` applies it to its
 * protected chat endpoint. It is deliberately *not* registered globally, so the
 * foundation's health endpoints stay unauthenticated.
 */

/**
 * A Fastify hook: resolves to the sent reply when rejecting, or to `undefined`
 * to let the request proceed to the route handler.
 */
export type AuthenticateHook = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<FastifyReply | undefined>;

/** `Bearer <token>` with a case-insensitive scheme and flexible spacing. */
const BEARER_SCHEME = /^Bearer\s+(.+)$/i;

/**
 * Pull the bearer token out of an `Authorization` header, or `null` when the
 * header is absent or not a non-empty `Bearer` credential.
 */
function extractBearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const token = BEARER_SCHEME.exec(header.trim())?.[1]?.trim();
  return token !== undefined && token.length > 0 ? token : null;
}

/** Send a 401 that names no key material and advertises the scheme. */
function unauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .header('WWW-Authenticate', 'Bearer')
    .send({ error: 'Unauthorized' });
}

/**
 * Build the authentication hook over an {@link ApiKeyService}.
 *
 * @param apiKeys - Resolves a presented key to its owning tenant.
 */
export function createAuthenticateHook(
  apiKeys: ApiKeyService,
): AuthenticateHook {
  return async function authenticate(request, reply) {
    const token = extractBearerToken(request.headers.authorization);
    // Reject a missing/malformed credential without a datastore lookup.
    if (token === null) return unauthorized(reply);

    const { tenantId } = await apiKeys.authenticate(token);
    if (tenantId === null) return unauthorized(reply);

    // Bind the request to its tenant; never write the key itself (Req 6.3).
    request.ctx.tenantId = tenantId;
  };
}
