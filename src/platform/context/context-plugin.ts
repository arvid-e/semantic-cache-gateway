import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { createDefaultContext } from './types.js';

/**
 * Attach a fresh {@link RequestContext} to every request as `request.ctx`.
 *
 * The two steps are deliberate and must stay in this order:
 *
 * 1. `decorateRequest('ctx')` reserves the field on the shared request object
 *    shape without a value. Fastify v5 forbids decorating a request with a
 *    reference-type default precisely because that one object would be shared
 *    across every request; reserving the empty slot keeps the request object's
 *    hidden class stable (a V8 optimisation) while leaving the value to...
 * 2. ...the `onRequest` hook, which assigns a brand-new context per request.
 *    The factory call here is what guarantees each request is isolated: writes
 *    by one request's handler can never bleed into the next (Req 7.1, 7.5).
 *
 * `onRequest` is the earliest request lifecycle hook, so `ctx` is present before
 * any other hook, middleware, or handler runs and is therefore never
 * `undefined` in practice despite its non-optional type (Req 7.4).
 */
function requestContextPlugin(
  app: FastifyInstance,
  _opts: unknown,
  done: (err?: Error) => void,
): void {
  app.decorateRequest('ctx');

  app.addHook('onRequest', (request, _reply, hookDone) => {
    request.ctx = createDefaultContext();
    hookDone();
  });

  done();
}

/**
 * Wrapped with `fastify-plugin` so the decoration and `onRequest` hook escape
 * this plugin's encapsulation and apply to every route in the application —
 * including routes registered by sibling and domain plugins. Without `fp` the
 * hook would fire only for routes defined inside this plugin's own scope, and
 * handlers elsewhere would see `request.ctx === undefined`.
 */
export const contextPlugin = fp(requestContextPlugin, {
  name: 'platform-context',
});
