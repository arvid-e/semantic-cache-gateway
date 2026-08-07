import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Integration setup only. The unit suite must keep failing when it depends on
// an unset variable, so it does not load this.
const envFile = fileURLToPath(new URL('.env', import.meta.url));

// Absent in CI, where the environment is supplied directly; `loadEnvFile`
// throws ENOENT rather than shrugging.
if (existsSync(envFile)) {
  // Already-set variables win, so an exported value still overrides the file.
  process.loadEnvFile(envFile);
}

/** The suite boots real Fastify apps; export LOG_LEVEL to see their logs. */
process.env.LOG_LEVEL ??= 'fatal';
