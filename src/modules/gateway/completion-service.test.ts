import type { CredentialResolver } from '#src/modules/auth/services/credential-resolver.js';
import {
  MissingCredentialError,
  ProviderSecret,
  type ProviderName,
} from '#src/modules/auth/types.js';
import {
  createDefaultContext,
  type RequestContext,
} from '#src/platform/context/types.js';
import {
  CredentialResolutionError,
  DefaultCompletionService,
  type CompletionService,
} from './completion-service.js';
import type { GatewayConfig } from './config.js';
import {
  UnsupportedProviderError,
  type ProviderRegistry,
} from './providers/provider-registry.js';
import {
  ProviderError,
  type ChatCompletionRequest,
  type NormalizedResponse,
  type ProviderAdapter,
  type ProviderCallOptions,
} from './types.js';

/** Gateway config fixture; only the two per-call knobs matter to the service. */
const config: GatewayConfig = {
  requestTimeoutMs: 5_000,
  defaultMaxTokens: 512,
  providers: {
    openai: { baseUrl: 'https://api.openai.com/v1' },
    anthropic: { baseUrl: 'https://api.anthropic.com', version: '2023-06-01' },
    ollama: { baseUrl: 'http://localhost:11434' },
  },
};

const request: ChatCompletionRequest = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'What is pgvector?' },
    { role: 'assistant', content: 'A Postgres extension for vectors.' },
    { role: 'user', content: 'And how do I index it?' },
  ],
  temperature: 0.2,
  maxTokens: 256,
};

/** What a healthy adapter returns; the resolved model differs from the alias. */
const response: NormalizedResponse = {
  id: 'cmpl-1',
  provider: 'openai',
  model: 'gpt-4o-mini-2024-07-18',
  message: { role: 'assistant', content: 'Use an HNSW index.' },
  usage: { promptTokens: 31, completionTokens: 9, totalTokens: 40 },
  finishReason: 'stop',
};

/** Everything one `complete` call saw, captured for assertions. */
interface AdapterCall {
  readonly request: ChatCompletionRequest;
  readonly credential: ProviderSecret;
  readonly opts: ProviderCallOptions;
  /** Snapshot of the context as it stood when the adapter was entered. */
  readonly ctxAtCall: RequestContext | null;
}

type FakeAdapter = ProviderAdapter & {
  readonly calls: AdapterCall[];
  /** Fail the next call with this error instead of answering. */
  failWith?: Error;
};

/**
 * An adapter that records its calls. `ctx` is passed in only so the recorded
 * call can prove the context was already populated before the provider ran.
 */
function fakeAdapter(
  name: ProviderName,
  reply: NormalizedResponse = response,
  ctx: RequestContext | null = null,
): FakeAdapter {
  const calls: AdapterCall[] = [];
  const adapter: FakeAdapter = {
    name,
    calls,
    complete(req, credential, opts) {
      calls.push({
        request: req,
        credential,
        opts,
        ctxAtCall: ctx === null ? null : structuredClone(ctx),
      });
      if (adapter.failWith !== undefined) {
        return Promise.reject(adapter.failWith);
      }
      return Promise.resolve({ ...reply, provider: name });
    },
  };
  return adapter;
}

/** The real registry behaviour over stub adapters, unknown names included. */
function fakeRegistry(
  adapters: Partial<Record<ProviderName, ProviderAdapter>>,
): ProviderRegistry {
  return {
    select(provider) {
      const adapter = adapters[provider];
      if (adapter === undefined) throw new UnsupportedProviderError(provider);
      return adapter;
    },
  };
}

/** A resolver whose single method is a spy, resolving a BYOK key by default. */
function fakeResolver(): CredentialResolver & {
  resolveCredential: ReturnType<typeof vi.fn>;
} {
  return {
    resolveCredential: vi.fn().mockResolvedValue({
      kind: 'resolved',
      secret: new ProviderSecret('sk-byok-123'),
      source: 'per_request',
    }),
  };
}

/** A clock that advances 42.4ms across the two readings the service takes. */
function fakeClock(): () => number {
  return vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_042.4);
}

interface Harness {
  readonly service: CompletionService;
  readonly ctx: RequestContext;
  readonly resolver: ReturnType<typeof fakeResolver>;
  readonly adapters: Record<ProviderName, FakeAdapter>;
}

function harness(): Harness {
  const ctx = createDefaultContext();
  const adapters: Record<ProviderName, FakeAdapter> = {
    openai: fakeAdapter('openai', response, ctx),
    anthropic: fakeAdapter('anthropic', response, ctx),
    ollama: fakeAdapter('ollama', response, ctx),
  };
  const resolver = fakeResolver();
  const service = new DefaultCompletionService({
    registry: fakeRegistry(adapters),
    credentials: resolver,
    config,
    now: fakeClock(),
  });
  return { service, ctx, resolver, adapters };
}

describe('DefaultCompletionService', () => {
  it('returns the normalized response with the model the provider served', async () => {
    const { service, ctx } = harness();

    const result = await service.complete({ tenantId: 't1', request, ctx });

    expect(result).toEqual(response);
    // The resolved model, not the alias the client asked for (Req 2.4).
    expect(result.model).toBe('gpt-4o-mini-2024-07-18');
  });

  it('invokes exactly one adapter — the requested provider’s', async () => {
    const { service, ctx, adapters } = harness();

    await service.complete({ tenantId: 't1', request, ctx });

    expect(adapters.openai.calls).toHaveLength(1);
    expect(adapters.anthropic.calls).toHaveLength(0);
    expect(adapters.ollama.calls).toHaveLength(0);
  });

  it('routes each supported provider to its own adapter', async () => {
    for (const provider of ['openai', 'anthropic', 'ollama'] as const) {
      const { service, ctx, adapters } = harness();

      const result = await service.complete({
        tenantId: 't1',
        request: { ...request, provider },
        ctx,
      });

      expect(adapters[provider].calls).toHaveLength(1);
      expect(result.provider).toBe(provider);
    }
  });

  it('passes the per-request BYOK key through to the adapter', async () => {
    const { service, ctx, resolver, adapters } = harness();

    await service.complete({
      tenantId: 't1',
      request,
      perRequestKey: 'sk-byok-123',
      ctx,
    });

    expect(resolver.resolveCredential).toHaveBeenCalledWith({
      tenantId: 't1',
      provider: 'openai',
      perRequestKey: 'sk-byok-123',
    });
    // The gateway holds no provider account: the only key the adapter sees is
    // the one the resolver returned for this tenant (Req 3.2).
    const [call] = adapters.openai.calls;
    expect(call?.credential).toBeInstanceOf(ProviderSecret);
    expect(call?.credential.reveal()).toBe('sk-byok-123');
  });

  it('asks for the stored credential when no per-request key is supplied', async () => {
    const { service, ctx, resolver } = harness();

    await service.complete({ tenantId: 't1', request, ctx });

    // Absent, not present-and-undefined: the resolver decides BYOK-vs-stored by
    // reading the property.
    expect(resolver.resolveCredential).toHaveBeenCalledWith({
      tenantId: 't1',
      provider: 'openai',
    });
    const [input] = resolver.resolveCredential.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect('perRequestKey' in input).toBe(false);
  });

  it('hands the adapter the configured per-call options', async () => {
    const { service, ctx, adapters } = harness();

    await service.complete({ tenantId: 't1', request, ctx });

    expect(adapters.openai.calls[0]?.opts).toEqual({
      timeoutMs: 5_000,
      defaultMaxTokens: 512,
    });
  });

  it('records token usage and latency in the context', async () => {
    const { service, ctx } = harness();

    await service.complete({ tenantId: 't1', request, ctx });

    // Mapped onto the foundation's field names, not assigned across (Req 5.1).
    expect(ctx.tokenUsage).toEqual({ prompt: 31, completion: 9, total: 40 });
    expect(ctx.latencyMs).toBe(42);
  });

  it('populates provider, model, params, and the conversation', async () => {
    const { service, ctx } = harness();

    await service.complete({ tenantId: 't1', request, ctx });

    expect(ctx.provider).toBe('openai');
    expect(ctx.params).toEqual({ temperature: 0.2, maxTokens: 256 });
    expect(ctx.messages).toEqual(request.messages);
    expect(ctx.latestUserMessage?.content).toBe('And how do I index it?');
    expect(ctx.lastAssistantMessage?.content).toBe(
      'A Postgres extension for vectors.',
    );
  });

  it('populates the context before the provider is called', async () => {
    const { service, ctx, adapters } = harness();

    await service.complete({ tenantId: 't1', request, ctx });

    // Read as the adapter was entered: a stage that only runs on a failed call
    // can still see what was attempted (Req 5.2).
    const seen = adapters.openai.calls[0]?.ctxAtCall;
    expect(seen?.provider).toBe('openai');
    expect(seen?.model).toBe('gpt-4o-mini');
    expect(seen?.messages).toEqual(request.messages);
    // …and the post-call fields are not yet written.
    expect(seen?.latencyMs).toBeNull();
    expect(seen?.tokenUsage).toEqual({ prompt: 0, completion: 0, total: 0 });
  });

  it('leaves fields owned by later stages at their defaults', async () => {
    const { service, ctx } = harness();
    const fresh = createDefaultContext();

    await service.complete({ tenantId: 't1', request, ctx });

    // No caching, topic-shift, or resilience logic runs here (Req 5.3, 5.4).
    expect(ctx.cacheStatus).toBe('unknown');
    expect(ctx.failover).toEqual(fresh.failover);
    expect(ctx.breakerState).toBe('closed');
  });

  it('writes no credential into the context', async () => {
    const { service, ctx } = harness();

    await service.complete({
      tenantId: 't1',
      request,
      perRequestKey: 'sk-byok-123',
      ctx,
    });

    // The context is logged and read by telemetry, so the secret must not be
    // reachable from it in any form (Req 3.2, 4.3).
    expect(JSON.stringify(ctx)).not.toContain('sk-byok-123');
  });
});

describe('DefaultCompletionService credential failures', () => {
  it('rejects a missing credential without calling the provider', async () => {
    const { service, ctx, resolver, adapters } = harness();
    resolver.resolveCredential.mockResolvedValue({ kind: 'missing' });

    await expect(
      service.complete({ tenantId: 't1', request, ctx }),
    ).rejects.toBeInstanceOf(MissingCredentialError);

    expect(adapters.openai.calls).toHaveLength(0);
    // Nothing was attempted, so the timing and usage fields keep their defaults.
    expect(ctx.latencyMs).toBeNull();
    expect(ctx.tokenUsage).toEqual({ prompt: 0, completion: 0, total: 0 });
  });

  it('names the provider on the missing-credential error', async () => {
    const { service, ctx, resolver } = harness();
    resolver.resolveCredential.mockResolvedValue({ kind: 'missing' });

    await expect(
      service.complete({
        tenantId: 't1',
        request: { ...request, provider: 'anthropic' },
        ctx,
      }),
    ).rejects.toMatchObject({ provider: 'anthropic' });
  });

  it('maps an undecryptable stored credential to its own error', async () => {
    const { service, ctx, resolver, adapters } = harness();
    resolver.resolveCredential.mockResolvedValue({ kind: 'decryption_failed' });

    // Distinct from "missing": the tenant did attach a key, so this is a
    // gateway-side fault the route maps to a safe 5xx, not a client error.
    await expect(
      service.complete({ tenantId: 't1', request, ctx }),
    ).rejects.toBeInstanceOf(CredentialResolutionError);
    expect(adapters.openai.calls).toHaveLength(0);
  });

  it('rejects an unsupported provider before resolving any credential', async () => {
    const ctx = createDefaultContext();
    const resolver = fakeResolver();
    const service = new DefaultCompletionService({
      // A registry serving no provider stands in for a name with no adapter.
      registry: fakeRegistry({}),
      credentials: resolver,
      config,
      now: fakeClock(),
    });

    await expect(
      service.complete({ tenantId: 't1', request, ctx }),
    ).rejects.toBeInstanceOf(UnsupportedProviderError);

    // No credential lookup for a request that can never be served (Req 2.2).
    expect(resolver.resolveCredential).not.toHaveBeenCalled();
    expect(ctx.provider).toBeNull();
  });
});

describe('DefaultCompletionService provider failures', () => {
  it('propagates the adapter’s ProviderError unchanged', async () => {
    const { service, ctx, adapters } = harness();
    adapters.openai.failWith = new ProviderError('OpenAI request failed', {
      provider: 'openai',
      kind: 'upstream_error',
      status: 503,
    });

    await expect(
      service.complete({ tenantId: 't1', request, ctx }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('records the latency of a failed call but no token usage', async () => {
    const { service, ctx, adapters } = harness();
    adapters.openai.failWith = new ProviderError('OpenAI request timed out', {
      provider: 'openai',
      kind: 'timeout',
    });

    await expect(
      service.complete({ tenantId: 't1', request, ctx }),
    ).rejects.toThrow(ProviderError);

    // A provider was attempted, so how long it took is known and worth keeping;
    // what it would have cost is not.
    expect(ctx.latencyMs).toBe(42);
    expect(ctx.tokenUsage).toEqual({ prompt: 0, completion: 0, total: 0 });
    // The requested model stands: no provider reported serving anything.
    expect(ctx.model).toBe('gpt-4o-mini');
  });
});
