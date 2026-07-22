import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { loadConfig } from '../config/load-config.js';
import { REDACTION_CENSOR } from '../logger/logger-options.js';
import type { Config } from '../config/schema.js';

/**
 * A migration this run applied. Declared here rather than imported:
 * node-pg-migrate types its return value but does not export that type from the
 * package entry, and callers should depend on the foundation's contract instead
 * of a library internal that a minor release could rename.
 */
export interface AppliedMigration {
  readonly name: string;
  readonly path: string;
  readonly timestamp: number;
}

/**
 * Thrown when a migration run does not complete. The message names the failing
 * migration when one was reached, and never echoes the connection URL, whose
 * credentials are sensitive (Req 2.3, 5.4).
 */
export class MigrationError extends Error {
  /** Name of the migration that failed, or `undefined` if none started. */
  readonly migration: string | undefined;

  constructor(
    message: string,
    migration: string | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MigrationError';
    this.migration = migration;
  }
}

/**
 * Table recording which migrations have already run. It lives in the same
 * database as the schema it describes, so "what state is this database in" is
 * answerable from the database alone rather than from deploy history.
 *
 * Changing this name orphans every existing record and would re-apply the whole
 * history against a live database — it is part of the runner's public contract.
 */
export const MIGRATIONS_TABLE = 'pgmigrations';

/**
 * Absolute path to the migration directory, resolved from this module rather
 * than from `process.cwd()` (node-pg-migrate's default), so the runner behaves
 * the same whether it is invoked from the repo root, from a test, or from the
 * container's workdir.
 *
 * `dist/` mirrors `src/`, so the same three levels reach the repo root from both
 * `src/platform/db/migrate.ts` and the compiled `dist/platform/db/migrate.js`.
 */
export const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../migrations', import.meta.url),
);

/**
 * Marker node-pg-migrate logs immediately before executing a migration's
 * statements. Capturing it is how we learn *which* migration a failure came
 * from: the library rethrows the raw driver error, which names the offending SQL
 * but not the file it came from.
 */
const MIGRATION_START_PATTERN = /^### MIGRATION (.+) \((?:UP|DOWN)\) ###$/;

/**
 * Minimal logging surface the runner needs. Matches node-pg-migrate's `Logger`
 * and is satisfied by both `console` and a Pino instance, so callers can pass
 * whichever they have — migrations run before the app (and therefore before
 * `app.log`) exists.
 */
export interface MigrationLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * Strip the Postgres URL — and the password inside it — out of a message before
 * it is attached to a thrown error.
 *
 * `pg-plugin.ts` can rely on `pg` never echoing the connection string, but the
 * migration runner surfaces errors from a third-party library whose message
 * shapes are not part of its API. Scrubbing at the boundary makes the
 * secret-safety guarantee structural rather than a bet on someone else's
 * formatting (Req 2.3).
 */
function withoutConnectionSecrets(detail: string, url: string): string {
  let safe = detail.replaceAll(url, REDACTION_CENSOR);

  try {
    const { password } = new URL(url);
    // Guard the empty case: `replaceAll('')` matches at every position.
    if (password) safe = safe.replaceAll(password, REDACTION_CENSOR);
  } catch {
    // Config validated this as a URL, so this is unreachable; if the shape ever
    // changes, the full-string replacement above is still in force.
  }

  return safe;
}

/**
 * Apply every pending migration, in filename order, inside a single transaction.
 *
 * Ordering is deterministic because migration filenames are prefixed with the
 * millisecond timestamp of their creation, and the recorded set in
 * {@link MIGRATIONS_TABLE} is what makes the run idempotent: already-applied
 * files are skipped, so a repeat run against an up-to-date database changes
 * nothing (Req 5.1, 5.2).
 *
 * Failure is all-or-nothing. node-pg-migrate wraps the batch in one transaction
 * and writes each tracking row in that same transaction, so a failing statement
 * rolls back both the schema change and its record — the database is never left
 * claiming a half-applied migration, and a re-run resumes cleanly (Req 5.4).
 *
 * @param config - Validated runtime config; supplies the Postgres URL.
 * @param logger - Where the run reports progress. Defaults to `console` for the
 * CLI path.
 * @returns The migrations applied by this run; empty when already up to date.
 * @throws {MigrationError} when a migration fails. `migration` names the file.
 */
export async function runMigrations(
  config: Config,
  logger: MigrationLogger = console,
): Promise<readonly AppliedMigration[]> {
  // Updated as the library announces each migration, so the catch below can
  // name the one that was in flight.
  let started: string | undefined;

  const trackingLogger: MigrationLogger = {
    info: (msg: string): void => {
      const match = MIGRATION_START_PATTERN.exec(msg);
      if (match?.[1] !== undefined) started = match[1];
      logger.info(msg);
    },
    warn: (msg: string): void => {
      logger.warn(msg);
    },
    error: (msg: string): void => {
      logger.error(msg);
    },
  };

  let applied: readonly AppliedMigration[];

  try {
    applied = await runner({
      databaseUrl: config.postgres.url,
      dir: MIGRATIONS_DIR,
      direction: 'up',
      migrationsTable: MIGRATIONS_TABLE,
      logger: trackingLogger,
    });
  } catch (cause) {
    // The detail carries the failing statement and driver context, which is the
    // useful half of the diagnosis; the connection string is scrubbed out of it
    // first. The original error rides along as `cause` for debugging.
    const raw = cause instanceof Error ? cause.message : String(cause);
    const detail = withoutConnectionSecrets(raw, config.postgres.url);

    throw new MigrationError(
      started === undefined
        ? `Migration run failed before any migration was applied: ${detail}`
        : `Migration failed: ${started}. The run was rolled back and this ` +
            `migration was not recorded as applied. Cause: ${detail}`,
      started,
      { cause },
    );
  }

  if (applied.length === 0) {
    logger.info('Database schema is up to date; no migrations applied.');
  } else {
    const names = applied.map((migration) => migration.name).join(', ');
    logger.info(`Applied ${String(applied.length)} migration(s): ${names}`);
  }

  return applied;
}

/**
 * CLI entry for `npm run migrate`, active only when this module is the process
 * entrypoint — importing it (from the server bootstrap or a test) runs nothing.
 *
 * Only the `up` direction is wired: rolling the schema forward is the operation
 * the service and its container entrypoint need, and an unattended `down`
 * against a real database is a footgun rather than a feature.
 */
const invokedAsScript =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  try {
    await runMigrations(loadConfig());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    // Non-zero exit so a container entrypoint or CI step stops here instead of
    // starting a service against a schema that never finished migrating.
    process.exitCode = 1;
  }
}
