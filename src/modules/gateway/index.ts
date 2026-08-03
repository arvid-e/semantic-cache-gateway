import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import {
  DefaultCompletionService,
  type CompletionService,
} from './completion-service.js';
import { loadGatewayConfig, type GatewayConfig } from './config.js';
import { DefaultProviderRegistry } from './providers/provider-registry.js';
import { createCompletionsRoutes } from './routes/completions-route.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * The *raw* provider-calling service — what a wrapper wraps. Stays the
     * innermost implementation no matter what is installed over it.
     */
    readonly completionService: CompletionService;
    /**
     * Install the outermost service the route should call.
     * `dual-layer-caching` and `resilience-failover` compose through this from
     * `src/app.ts` rather than editing this module.
     */
    useCompletionService(service: CompletionService): void;
  }
}

export interface GatewayPluginOptions {
  /** Overrides the environment-derived config; for tests. */
  readonly gatewayConfig?: GatewayConfig;
}

async function gatewayModule(
  app: FastifyInstance,
  { gatewayConfig }: GatewayPluginOptions,
): Promise<void> {
  // Loaded here rather than at bootstrap because every gateway setting has a
  // code-owned default: the module boots on an empty gateway environment, and
  // only an *invalid* value fails registration.
  const config = gatewayConfig ?? loadGatewayConfig(app.config);

  const registry = new DefaultProviderRegistry(config);
  const completionService = new DefaultCompletionService({
    registry,
    credentials: app.credentialResolver,
    config,
  });

  /**
   * The route is bound to a forwarder, not to an instance, so the service it
   * calls is resolved per request. That is what lets a later spec install a
   * wrapper without this module or the route file changing — the composition
   * order (cache → resilience → completion) is established in `src/app.ts`.
   */
  let outermost: CompletionService = completionService;
  const forwarder: CompletionService = {
    complete: (input) => outermost.complete(input),
  };

  app.decorate('completionService', completionService);
  app.decorate('useCompletionService', (service: CompletionService): void => {
    outermost = service;
  });

  await app.register(
    createCompletionsRoutes({
      completionService: forwarder,
      authenticate: app.authenticate,
    }),
  );
}

/**
 * `fastify-plugin` so the decorations reach sibling plugins. `dependencies`
 * makes the ordering requirement enforced rather than conventional: this module
 * reads `app.credentialResolver` and `app.authenticate`, both owned by auth.
 */
export const gatewayPlugin = fp(gatewayModule, {
  name: 'gateway',
  dependencies: ['auth'],
});
