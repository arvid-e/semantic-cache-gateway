import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
} from 'fastify';
import { MissingCredentialError } from '#src/modules/auth/types.js';
import type { AuthenticateHook } from '#src/modules/auth/middleware/authenticate.js';
import {
  CredentialResolutionError,
  type CompletionService,
} from '../completion-service.js';
import { UnsupportedProviderError } from '../providers/provider-registry.js';
import { completionsRouteSchema } from '../schema.js';
import { ProviderError, type ChatCompletionRequest } from '../types.js';

/**
 * `POST /v1/chat/completions`. The handler owns nothing beyond the HTTP
 * boundary: it reads the tenant and optional BYOK key off the request,
 * delegates to the {@link CompletionService}, and maps typed failures onto
 * status codes.
 *
 * Encapsulated (not `fastify-plugin`), so the authentication hook it installs
 * covers this route only — the health endpoints stay reachable without a
 * credential.
 */

/**
 * Separate from `Authorization`, which already carries the *gateway* key — one
 * header cannot hold two credentials with different audiences.
 */
const PROVIDER_KEY_HEADER = 'x-provider-key';

const BAD_GATEWAY = 502;
const GATEWAY_TIMEOUT = 504;

export interface CompletionsRoutesDeps {
  readonly completionService: CompletionService;
  /** Auth's gateway API-key hook, decorated onto the app as `authenticate`. */
  readonly authenticate: AuthenticateHook;
}

/**
 * A duplicated header is ambiguous, and guessing which key was meant is the
 * wrong move for a credential — so it is a client error, not a silent
 * first-wins. An absent header is *not* an error: it means "use the stored
 * credential".
 *
 * Node joins repeated headers into one comma-separated string rather than the
 * `string[]` the type admits (only `set-cookie` stays an array), so a comma is
 * what a duplicate actually looks like. Rejecting on it is safe — none of the
 * three providers issue keys containing one.
 */
function readProviderKey(
  header: string | string[] | undefined,
): { ok: true; key: string | undefined } | { ok: false } {
  if (header === undefined) return { ok: true, key: undefined };
  if (Array.isArray(header) || header.includes(',')) return { ok: false };
  const key = header.trim();
  return { ok: true, key: key.length > 0 ? key : undefined };
}

/**
 * Map a typed failure onto its status and a body carrying no credential.
 *
 * `CredentialResolutionError` is a gateway-side fault — the tenant's stored key
 * is there but unusable — so it is a 500 rather than a 4xx blaming the caller
 * for something they cannot correct.
 */
function toErrorResponse(
  error: unknown,
  reply: FastifyReply,
): FastifyReply | null {
  if (error instanceof UnsupportedProviderError) {
    return reply.code(400).send({ error: 'Unsupported provider' });
  }
  if (error instanceof MissingCredentialError) {
    return reply.code(400).send({ error: 'Missing provider credential' });
  }
  if (error instanceof CredentialResolutionError) {
    return reply.code(500).send({ error: 'Could not resolve credential' });
  }
  if (error instanceof ProviderError) {
    const status = error.kind === 'timeout' ? GATEWAY_TIMEOUT : BAD_GATEWAY;
    return reply.code(status).send({ error: 'Provider request failed' });
  }
  // Not ours to translate; let Fastify's handler log and return a 500.
  return null;
}

export function createCompletionsRoutes(
  deps: CompletionsRoutesDeps,
): FastifyPluginAsync {
  return function completionsRoutes(app: FastifyInstance): Promise<void> {
    app.addHook('onRequest', deps.authenticate);

    app.post<{ Body: ChatCompletionRequest }>(
      '/v1/chat/completions',
      { schema: completionsRouteSchema },
      async (request, reply) => {
        const providerKey = readProviderKey(
          request.headers[PROVIDER_KEY_HEADER],
        );
        if (!providerKey.ok) {
          return reply
            .code(400)
            .send({ error: `Duplicate ${PROVIDER_KEY_HEADER} header` });
        }

        // The hook rejects an unauthenticated request before the handler runs,
        // so this is narrowing rather than a real branch.
        const { tenantId } = request.ctx;
        if (tenantId === null) {
          return reply.code(401).send({ error: 'Unauthorized' });
        }

        try {
          return await deps.completionService.complete({
            tenantId,
            request: request.body,
            ctx: request.ctx,
            // Spread rather than assigned: under `exactOptionalPropertyTypes`
            // an explicit `undefined` is not an absent property, and the
            // resolver's "was a BYOK key supplied?" test reads the property.
            ...(providerKey.key === undefined
              ? {}
              : { perRequestKey: providerKey.key }),
          });
        } catch (error) {
          const mapped = toErrorResponse(error, reply);
          if (mapped === null) throw error;
          return mapped;
        }
      },
    );

    return Promise.resolve();
  };
}
