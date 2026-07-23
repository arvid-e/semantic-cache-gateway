import Fastify from 'fastify';
import type { ClientBase, PoolConfig } from 'pg';
import type { Config } from '../config/schema.js';
import { PostgresPluginError, pgPlugin } from './pg-plugin.js';

// `pg` and `pgvector` are mocked so the plugin's startup gate can be exercised
// without a live database; the real wiring is covered by the integration suite.
const mocks = vi.hoisted(() => {
  const endPool = vi.fn<() => Promise<void>>();
  return {
    connect: vi.fn<() => Promise<void>>(),
    query: vi.fn<() => Promise<{ rowCount: number }>>(),
    endClient: vi.fn<() => Promise<void>>(),
    endPool,
    registerTypes: vi.fn<() => Promise<void>>(),
    // Function expressions, not arrows: the plugin calls these with `new`.
    Pool: vi.fn(function (_config: PoolConfig) {
      return { end: endPool };
    }),
  };
});

vi.mock('pg', () => ({
  Client: vi.fn(function () {
    return {
      connect: mocks.connect,
      query: mocks.query,
      end: mocks.endClient,
    };
  }),
  Pool: mocks.Pool,
}));

vi.mock('pgvector/pg', () => ({ registerTypes: mocks.registerTypes }));

const POSTGRES_URL = 'postgres://user:hunter2@localhost:5432/gateway';

function configWith(poolMax = 10): Config {
  return Object.freeze({
    httpPort: 3000,
    logLevel: 'info',
    postgres: Object.freeze({ url: POSTGRES_URL, poolMax }),
    redis: Object.freeze({ url: 'redis://localhost:6379' }),
    ollama: Object.freeze({ url: 'http://localhost:11434' }),
    nodeEnv: 'test',
  });
}

async function buildApp(config: Config = configWith()) {
  const app = Fastify({ logger: false });
  await app.register(pgPlugin, { config });
  await app.ready();
  return app;
}

/** Options the plugin handed to the `Pool` constructor. */
function poolConfig(): PoolConfig {
  const [config] = mocks.Pool.mock.calls[0] ?? [];
  if (!config) expect.fail('expected the plugin to construct a Pool');
  return config;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Healthy database by default; individual tests break one step.
  mocks.connect.mockResolvedValue();
  mocks.query.mockResolvedValue({ rowCount: 1 });
  mocks.endClient.mockResolvedValue();
  mocks.endPool.mockResolvedValue();
  mocks.registerTypes.mockResolvedValue();
});

describe('pgPlugin', () => {
  it('aborts startup with an error naming PostgreSQL when unreachable', async () => {
    mocks.connect.mockRejectedValue(new Error('getaddrinfo ENOTFOUND db'));

    await expect(buildApp()).rejects.toThrow(PostgresPluginError);
    await expect(buildApp()).rejects.toThrow(/PostgreSQL unreachable/);
  });

  it('keeps the connection string out of the unreachable error', async () => {
    mocks.connect.mockRejectedValue(new Error('getaddrinfo ENOTFOUND db'));

    try {
      await buildApp();
      expect.fail('expected startup to fail');
    } catch (err) {
      const { message } = err as Error;
      expect(message).toContain('PostgreSQL'); // names the dependency
      expect(message).not.toContain('hunter2'); // but never the password
    }
  });

  it('aborts startup naming the extension when pgvector is not installed', async () => {
    mocks.query.mockResolvedValue({ rowCount: 0 });

    await expect(buildApp()).rejects.toThrow(PostgresPluginError);
    await expect(buildApp()).rejects.toThrow(/vector/);
  });

  it('releases the preflight connection once the checks pass', async () => {
    const app = await buildApp();

    expect(mocks.endClient).toHaveBeenCalledOnce();

    await app.close();
  });

  it('exposes the shared pool as app.pg and sizes it from config', async () => {
    const app = await buildApp(configWith(25));

    expect(app.pg).toBeDefined();
    expect(poolConfig().max).toBe(25);

    await app.close();
  });

  it('registers vector types on every new pooled connection', async () => {
    const app = await buildApp();
    const client = {} as ClientBase;

    // pg keeps type parsers per client, so the hook — not a one-off startup
    // call — is what makes vectors decode on all pooled connections.
    const onConnect = poolConfig().onConnect as
      | ((client: ClientBase) => Promise<void>)
      | undefined;
    await onConnect?.(client);

    expect(mocks.registerTypes).toHaveBeenCalledWith(client);

    await app.close();
  });

  it('ends the pool when the app closes', async () => {
    const app = await buildApp();

    await app.close();

    expect(mocks.endPool).toHaveBeenCalledOnce();
  });
});
