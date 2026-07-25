import closeWithGrace from 'close-with-grace';
import { loadConfig } from '#src/platform/config/load-config.js';
import { runMigrations } from '#src/platform/db/migrate.js';
import { loadAuthConfig } from '#src/modules/auth/config.js';
import { buildApp } from '#src/app.js';

/**
 * Milliseconds a graceful shutdown may take before the process is forced down.
 * Long enough to drain in-flight requests and close the pool + Redis, short
 * enough that an orchestrator's kill timeout never has to escalate to SIGKILL.
 */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Interface every foundation datastore is reachable on. Binding `0.0.0.0`
 * rather than Fastify's default loopback is what makes the service reachable
 * from outside its container — the Compose healthcheck and other services dial
 * it across the container network (Req 8.3).
 */
const LISTEN_HOST = '0.0.0.0';

/**
 * Drive startup in a fixed order and never bind the port until every dependency
 * is up (Req 1.1, 1.2):
 *
 *   1. Load config — an invalid environment must fail before anything touches a
 *      database or opens a socket.
 *   2. Run migrations — the schema is brought current *before* the server binds,
 *      so traffic never hits a half-migrated database; the Postgres plugin's
 *      `vector`-extension check also assumes the baseline has already run.
 *   3. Build the app and `await ready()` — the datastore plugins connect during
 *      registration, so awaiting `ready()` is what actually dials Postgres and
 *      Redis. An unreachable datastore rejects here, before `listen()`, so the
 *      service never accepts a request while partially initialized (Req 1.3).
 *   4. Wire graceful shutdown, then listen.
 *
 * Any failure propagates out of this function to the fatal handler below, which
 * exits non-zero (Req 1.3).
 */
async function start(): Promise<void> {
  const config = loadConfig();
  // The auth module owns a separate env segment (keyring, pepper, admin token);
  // load and validate it here so a bad auth environment fails fast at startup,
  // before migrations or binding a port.
  const authConfig = loadAuthConfig();

  await runMigrations(config);

  const app = buildApp(config, authConfig);
  await app.ready();

  // Registered before `listen` so a signal arriving mid-boot is still handled.
  // On SIGTERM/SIGINT, `app.close()` stops accepting connections and runs the
  // plugins' `onClose` hooks — ending the Postgres pool and quitting Redis —
  // before the process exits (Req 1.4). `delay` caps the drain; past it the
  // process is forced down so a stuck close can't hang a redeploy.
  closeWithGrace({ delay: SHUTDOWN_GRACE_MS }, async ({ signal, err }) => {
    if (err) {
      app.log.error({ err }, 'shutting down after a fatal error');
    } else {
      app.log.info({ signal }, 'signal received, shutting down gracefully');
    }
    await app.close();
  });

  await app.listen({ port: config.httpPort, host: LISTEN_HOST });
}

start().catch((err: unknown) => {
  // Every startup failure — invalid config, a failed migration, an unreachable
  // datastore — is fatal and lands here. Each of those errors is already
  // secret-safe (config omits sensitive values, the migration runner scrubs the
  // connection string, the datastore plugins never echo it), so the message is
  // safe to print. Exit non-zero so an orchestrator restarts the service rather
  // than routing traffic to one that never came up (Req 1.3).
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: gateway failed to start: ${message}`);
  process.exitCode = 1;
});
