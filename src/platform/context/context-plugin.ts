import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { createDefaultContext } from './types.js';

/**
 * Attach a fresh `RequestContext` to every request as `request.ctx`. The two
 * steps must stay in this order:
 *
 * 1. `decorateRequest('ctx')` reserves the field without a value. Fastify v5
 *    forbids decorating a request with a reference-type default precisely
 *    because that one object would be shared across every request; reserving an
 *    empty slot keeps the request object's hidden class stable (a V8
 *    optimisation) while leaving the value to...
 * 2. ...the `onRequest` hook, which assigns a brand-new context per request.
 *
 * `onRequest` is the earliest lifecycle hook, so `ctx` is present before any
 * other hook, middleware, or handler runs — which is why its type is
 * non-optional.
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
 * `fastify-plugin` lets the decoration and hook escape this plugin's
 * encapsulation and apply to every route in the application. Without `fp` the
 * hook would fire only for routes defined inside this plugin's own scope, and
 * handlers elsewhere would see `request.ctx === undefined`.
 */
export const contextPlugin = fp(requestContextPlugin, {
  name: 'platform-context',
});
