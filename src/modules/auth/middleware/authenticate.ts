import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiKeyService } from '../services/api-key-service.js';

/**
 * Authenticates the gateway API key on the `Authorization: Bearer <key>` header
 * and binds the request to its tenant via `request.ctx.tenantId`. Returning the
 * reply from the hook is what stops the lifecycle, so downstream processing
 * never sees an unauthenticated request.
 *
 * Only the resolved `tenantId` is written to the shared context; the key itself
 * never touches `request.ctx`, logs, or telemetry.
 *
 * Deliberately *not* registered globally — `gateway-provider-routing` applies it
 * to its protected chat endpoint, so the health endpoints stay unauthenticated.
 */

/** Resolves to the sent reply when rejecting, or `undefined` to proceed. */
export type AuthenticateHook = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<FastifyReply | undefined>;

/** `Bearer <token>` with a case-insensitive scheme and flexible spacing. */
const BEARER_SCHEME = /^Bearer\s+(.+)$/i;

function extractBearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const token = BEARER_SCHEME.exec(header.trim())?.[1]?.trim();
  return token !== undefined && token.length > 0 ? token : null;
}

/** A 401 that names no key material and advertises the scheme. */
function unauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .header('WWW-Authenticate', 'Bearer')
    .send({ error: 'Unauthorized' });
}

export function createAuthenticateHook(
  apiKeys: ApiKeyService,
): AuthenticateHook {
  return async function authenticate(request, reply) {
    const token = extractBearerToken(request.headers.authorization);
    // Reject a missing/malformed credential without a datastore lookup.
    if (token === null) return unauthorized(reply);

    const { tenantId } = await apiKeys.authenticate(token);
    if (tenantId === null) return unauthorized(reply);

    // Bind the request to its tenant; never write the key itself.
    request.ctx.tenantId = tenantId;
  };
}
