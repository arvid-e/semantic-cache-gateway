import { z } from 'zod';

/**
 * Environment-variable contract for the gateway. This schema is the single
 * source of truth for runtime settings: `z.infer` derives the parsed shape and
 * `loadConfig` reshapes it into the frozen, nested `Config` object.
 *
 * Env vars arrive as strings, so numeric settings use `z.coerce`. Optional
 * settings carry a `.default(...)`; settings without a default are required and
 * fail validation when absent.
 */
export const configSchema = z.object({
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  POSTGRES_URL: z.url(), // required — sensitive
  POSTGRES_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.url(), // required — sensitive
  OLLAMA_URL: z.url(), // required
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

/** Flat, fully-typed shape produced by parsing `process.env`. */
export type RawConfig = z.infer<typeof configSchema>;

/**
 * Public, nested, read-only runtime configuration. Downstream modules read this
 * object (via `app.config`) — never `process.env` directly.
 */
export interface Config {
  readonly httpPort: number;
  readonly logLevel: RawConfig['LOG_LEVEL'];
  readonly postgres: {
    readonly url: string; // sensitive
    readonly poolMax: number;
  };
  readonly redis: {
    readonly url: string; // sensitive
  };
  readonly ollama: {
    readonly url: string;
  };
  readonly nodeEnv: RawConfig['NODE_ENV'];
}

/**
 * Env keys whose values must never appear in thrown errors or logs. Keep this
 * authoritative: adding a secret to the schema means adding its key here too.
 */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'POSTGRES_URL',
  'REDIS_URL',
]);
