import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Admin authorization guard for the provisioning API (Req 5.4).
 *
 * A Fastify hook that authorizes admin requests by comparing the presented
 * `Authorization: Bearer <token>` against the configured admin token. Because it
 * runs as a route hook before any handler, a failed check rejects with 401 and
 * the handler never runs — so an unauthorized request makes no change.
 *
 * The comparison is constant-time: both sides are SHA-256'd to a fixed 32-byte
 * digest and compared with `timingSafeEqual`, so neither the token's value nor
 * its length leaks through timing, and the compare never throws on a length
 * mismatch.
 */

/** A Fastify hook: resolves to the sent reply when rejecting, else `undefined`. */
export type AdminGuardHook = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<FastifyReply | undefined>;

const BEARER_SCHEME = /^Bearer\s+(.+)$/i;

function extractBearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const token = BEARER_SCHEME.exec(header.trim())?.[1]?.trim();
  return token !== undefined && token.length > 0 ? token : null;
}

/** Constant-time equality over fixed-length digests of the two tokens. */
function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Build the admin guard hook bound to the configured admin token.
 *
 * @param adminToken - `AuthConfig.adminToken`; held in the closure.
 */
export function createAdminGuard(adminToken: string): AdminGuardHook {
  // Async so Fastify treats a sent 401 as terminal and skips the route handler.
  return async function adminGuard(request, reply) {
    const token = extractBearerToken(request.headers.authorization);
    if (token === null || !tokensMatch(token, adminToken)) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ error: 'Unauthorized' });
    }
    return undefined;
  };
}
