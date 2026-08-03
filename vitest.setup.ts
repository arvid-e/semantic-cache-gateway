import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Integration setup only (wired in vitest.config.ts). The unit suite must keep
// failing when it depends on an unset variable, so it does not load this.
//
// `loadConfig` reads POSTGRES_URL / REDIS_URL / OLLAMA_URL straight off
// `process.env` and throws ConfigValidationError when they are missing. Nothing
// in the runtime loads `.env` — the deployed gateway gets its environment from
// Compose — so without this the suite only ran if every variable had been
// exported by hand first.
const envFile = fileURLToPath(new URL('.env', import.meta.url));

// Absent in CI, where the environment is supplied directly; `loadEnvFile`
// throws ENOENT rather than shrugging.
if (existsSync(envFile)) {
  // Already-set variables win, so an exported shell value still overrides the
  // file for a one-off run against a different database.
  process.loadEnvFile(envFile);
}

// The suite boots real Fastify apps, which would otherwise stream request logs
// at the level a developer picked for `npm run dev`. Export LOG_LEVEL to see
// them.
process.env.LOG_LEVEL ??= 'fatal';
