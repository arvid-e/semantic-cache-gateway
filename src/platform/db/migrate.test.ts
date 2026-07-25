import type { Config } from '../config/schema.js';
import {
  MIGRATIONS_DIR,
  MIGRATIONS_TABLE,
  MigrationError,
  runMigrations,
  type AppliedMigration,
  type MigrationLogger,
} from './migrate.js';

// `node-pg-migrate` is mocked so the wrapper's contract — options handed to the
// runner, up-to-date reporting, and failure attribution — can be exercised
// without a live database; the real run is covered by the integration suite.
const mocks = vi.hoisted(() => ({
  runner:
    vi.fn<(options: Record<string, unknown>) => Promise<AppliedMigration[]>>(),
}));

vi.mock('node-pg-migrate', () => ({ runner: mocks.runner }));

const POSTGRES_URL = 'postgres://user:hunter2@localhost:5432/gateway';

const config: Config = Object.freeze({
  httpPort: 3000,
  logLevel: 'info',
  postgres: Object.freeze({ url: POSTGRES_URL, poolMax: 10 }),
  redis: Object.freeze({ url: 'redis://localhost:6379' }),
  ollama: Object.freeze({ url: 'http://localhost:11434' }),
  nodeEnv: 'test',
});

function migration(name: string): AppliedMigration {
  return { name, path: `${MIGRATIONS_DIR}/${name}.sql`, timestamp: 1 };
}

/** Collects every message the runner reports, in order. */
function recordingLogger(): MigrationLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info: (msg) => messages.push(msg),
    warn: (msg) => messages.push(msg),
    error: (msg) => messages.push(msg),
  };
}

/** Options the wrapper handed to `runner`. */
function runnerOptions(): Record<string, unknown> {
  const [options] = mocks.runner.mock.calls[0] ?? [];
  if (!options) expect.fail('expected the wrapper to invoke the runner');
  return options;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runner.mockResolvedValue([]);
});

describe('runMigrations', () => {
  it('runs the repo migration directory forward against the configured database', async () => {
    await runMigrations(config, recordingLogger());

    expect(runnerOptions()).toMatchObject({
      databaseUrl: POSTGRES_URL,
      dir: MIGRATIONS_DIR,
      direction: 'up',
      migrationsTable: MIGRATIONS_TABLE,
    });
  });

  it('resolves the migration directory independently of the working directory', () => {
    // node-pg-migrate resolves a relative `dir` from cwd(), which would make the
    // run depend on where node was launched from.
    expect(MIGRATIONS_DIR).toMatch(/^\//);
    expect(MIGRATIONS_DIR).toMatch(/migrations$/);
  });

  it('reports and returns the migrations it applied', async () => {
    mocks.runner.mockResolvedValue([migration('1_baseline')]);
    const logger = recordingLogger();

    const applied = await runMigrations(config, logger);

    expect(applied).toEqual([migration('1_baseline')]);
    expect(logger.messages.join('\n')).toContain('1_baseline');
  });

  it('reports the schema as up to date and changes nothing when none are pending', async () => {
    mocks.runner.mockResolvedValue([]);
    const logger = recordingLogger();

    const applied = await runMigrations(config, logger);

    expect(applied).toEqual([]);
    expect(logger.messages.join('\n')).toMatch(/up to date/i);
  });

  it('names the failing migration when one fails', async () => {
    // The runner announces a migration, then its SQL fails — the library
    // rethrows the raw driver error, which does not name the file.
    mocks.runner.mockImplementation((options) => {
      const logger = options.logger as MigrationLogger;
      logger.info('### MIGRATION 1784686968609_baseline (UP) ###');
      throw new Error('syntax error at or near "CREAT"');
    });

    await expect(runMigrations(config, recordingLogger())).rejects.toThrow(
      MigrationError,
    );
    await expect(runMigrations(config, recordingLogger())).rejects.toThrow(
      /1784686968609_baseline/,
    );
  });

  it('states that a failed migration was not recorded as applied', async () => {
    mocks.runner.mockImplementation((options) => {
      const logger = options.logger as MigrationLogger;
      logger.info('### MIGRATION 1784686968609_baseline (UP) ###');
      throw new Error('relation "tenants" does not exist');
    });

    try {
      await runMigrations(config, recordingLogger());
      expect.fail('expected the migration run to fail');
    } catch (err) {
      const error = err as MigrationError;
      expect(error.migration).toBe('1784686968609_baseline');
      expect(error.message).toMatch(/not recorded/i);
      expect(error.cause).toBeInstanceOf(Error);
    }
  });

  it('keeps the connection string out of a failure that never reached a migration', async () => {
    mocks.runner.mockRejectedValue(
      new Error(`could not connect to postgres: ${POSTGRES_URL}`),
    );

    try {
      await runMigrations(config, recordingLogger());
      expect.fail('expected the migration run to fail');
    } catch (err) {
      const error = err as MigrationError;
      expect(error.migration).toBeUndefined();
      expect(error.message).not.toContain('hunter2'); // never the password
    }
  });

  it('forwards the library’s progress messages to the caller’s logger', async () => {
    mocks.runner.mockImplementation((options) => {
      const logger = options.logger as MigrationLogger;
      logger.info('> Migrating files:');
      logger.warn('> Rolling back attempted migration ...');
      return Promise.resolve([]);
    });
    const logger = recordingLogger();

    await runMigrations(config, logger);

    expect(logger.messages).toContain('> Migrating files:');
    expect(logger.messages).toContain('> Rolling back attempted migration ...');
  });
});
