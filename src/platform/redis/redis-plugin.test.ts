import Fastify from 'fastify';
import type { RedisOptions } from 'ioredis';
import type { Config } from '../config/schema.js';
import { RedisPluginError, redisPlugin } from './redis-plugin.js';

// `ioredis` is mocked so the plugin's startup gate can be exercised without a
// live Redis; the real wiring is covered by the integration suite.
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (arg: never) => void>();
  const client = {
    ping: vi.fn<() => Promise<string>>(),
    quit: vi.fn<() => Promise<string>>(),
    disconnect: vi.fn<() => void>(),
    on: vi.fn((event: string, handler: (arg: never) => void) => {
      handlers.set(event, handler);
    }),
    once: vi.fn((event: string, handler: (arg: never) => void) => {
      handlers.set(event, handler);
    }),
  };
  return {
    client,
    handlers,
    // Function expression, not an arrow: the plugin calls this with `new`.
    Redis: vi.fn(function (_url: string, _options: RedisOptions) {
      return client;
    }),
  };
});

vi.mock('ioredis', () => ({ Redis: mocks.Redis }));

const REDIS_URL = 'redis://default:hunter2@localhost:6379';

function configWith(url = REDIS_URL): Config {
  return Object.freeze({
    httpPort: 3000,
    logLevel: 'info',
    postgres: Object.freeze({
      url: 'postgres://user:pw@localhost:5432/gateway',
      poolMax: 10,
    }),
    redis: Object.freeze({ url }),
    ollama: Object.freeze({ url: 'http://localhost:11434' }),
    nodeEnv: 'test',
  });
}

async function buildApp(config: Config = configWith()) {
  const app = Fastify({ logger: false });
  await app.register(redisPlugin, { config });
  await app.ready();
  return app;
}

/** Options the plugin handed to the `Redis` constructor. */
function redisOptions(): RedisOptions {
  const [, options] = mocks.Redis.mock.calls[0] ?? [];
  if (!options) expect.fail('expected the plugin to construct a Redis client');
  return options;
}

/** The bounded-retry policy the plugin installs, as ioredis would call it. */
function retryStrategy(): NonNullable<RedisOptions['retryStrategy']> {
  const { retryStrategy: strategy } = redisOptions();
  if (typeof strategy !== 'function') {
    expect.fail('expected the plugin to install a retryStrategy');
  }
  return strategy;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  // Healthy Redis by default; individual tests break one step.
  mocks.client.ping.mockResolvedValue('PONG');
  mocks.client.quit.mockResolvedValue('OK');
});

describe('redisPlugin', () => {
  it('aborts startup with an error naming Redis when unreachable', async () => {
    mocks.client.ping.mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:6379'),
    );

    await expect(buildApp()).rejects.toThrow(RedisPluginError);
    await expect(buildApp()).rejects.toThrow(/Redis unreachable/);
  });

  it('keeps the connection string out of the unreachable error', async () => {
    mocks.client.ping.mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:6379'),
    );

    try {
      await buildApp();
      expect.fail('expected startup to fail');
    } catch (err) {
      const { message } = err as Error;
      expect(message).toContain('Redis'); // names the dependency
      expect(message).not.toContain('hunter2'); // but never the password
    }
  });

  it('tears the socket down when the startup check fails', async () => {
    mocks.client.ping.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(buildApp()).rejects.toThrow(RedisPluginError);

    // Otherwise the bounded retry loop would keep the process alive after the
    // boot it was supposed to abort.
    expect(mocks.client.disconnect).toHaveBeenCalledOnce();
  });

  it('exposes the shared client as app.redis, built from config', async () => {
    const app = await buildApp(configWith('redis://elsewhere:6380'));

    expect(app.redis).toBeDefined();
    expect(mocks.Redis.mock.calls[0]?.[0]).toBe('redis://elsewhere:6380');
    expect(mocks.client.ping).toHaveBeenCalledOnce();

    await app.close();
  });

  it('gives up reconnecting during startup so an outage aborts the boot', async () => {
    const app = await buildApp();
    const strategy = retryStrategy();

    expect(strategy(1)).toBeTypeOf('number'); // a few attempts are allowed
    expect(strategy(4)).toBeNull(); // then it stops, failing the pending ping

    await app.close();
  });

  it('reconnects indefinitely once the client has been ready', async () => {
    const app = await buildApp();
    const strategy = retryStrategy();

    mocks.handlers.get('ready')?.(undefined as never);

    // A blip on a running gateway must not become a permanent disconnect.
    expect(strategy(4)).toBeTypeOf('number');
    expect(strategy(500)).toBeLessThanOrEqual(2000); // backoff stays capped

    await app.close();
  });

  it('subscribes to error events so ioredis cannot crash the process', async () => {
    const app = await buildApp();

    expect(mocks.client.on).toHaveBeenCalledWith('error', expect.any(Function));

    await app.close();
  });

  it('quits the client when the app closes', async () => {
    const app = await buildApp();

    await app.close();

    expect(mocks.client.quit).toHaveBeenCalledOnce();
    expect(mocks.client.disconnect).not.toHaveBeenCalled();
  });

  it('forces the connection down when a graceful quit rejects', async () => {
    const app = await buildApp();
    mocks.client.quit.mockRejectedValue(new Error('Connection is closed.'));

    // Shutdown must still complete: `quit()` rejects on an already-closed or
    // reconnecting client.
    await expect(app.close()).resolves.toBeUndefined();
    expect(mocks.client.disconnect).toHaveBeenCalledOnce();
  });
});
