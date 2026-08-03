import closeWithGrace from 'close-with-grace';
import { loadConfig } from '#src/platform/config/load-config.js';
import { runMigrations } from '#src/platform/db/migrate.js';
import { loadAuthConfig } from '#src/modules/auth/config.js';
import { buildApp } from '#src/app.js';

/**
 * Long enough to drain in-flight requests and close the pool + Redis, short
 * enough that an orchestrator's kill timeout never has to escalate to SIGKILL.
 */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Binding `0.0.0.0` rather than Fastify's default loopback is what makes the
 * service reachable from outside its container.
 */
const LISTEN_HOST = '0.0.0.0';

/**
 * Startup runs in a fixed order and never binds the port until every dependency
 * is up:
 *
 *   1. Load config — an invalid environment must fail before anything touches a
 *      database or opens a socket.
 *   2. Run migrations — the schema is brought current *before* the server binds,
 *      so traffic never hits a half-migrated database; the Postgres plugin's
 *      `vector`-extension check also assumes the baseline has already run.
 *   3. Build the app and `await ready()` — the datastore plugins connect during
 *      registration, so awaiting `ready()` is what actually dials Postgres and
 *      Redis, and an unreachable one rejects here rather than after `listen()`.
 *   4. Wire graceful shutdown, then listen.
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
  // `app.close()` stops accepting connections and runs the plugins' `onClose`
  // hooks — ending the Postgres pool and quitting Redis — before the process
  // exits. `delay` caps the drain so a stuck close can't hang a redeploy.
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
  // Every startup failure lands here. Each is already secret-safe (config omits
  // sensitive values, the migration runner scrubs the connection string, the
  // datastore plugins never echo it), so the message is safe to print. Exit
  // non-zero so an orchestrator restarts the service rather than routing traffic
  // to one that never came up.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: gateway failed to start: ${message}`);
  process.exitCode = 1;
});
