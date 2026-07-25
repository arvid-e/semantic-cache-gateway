import { configSchema, SENSITIVE_KEYS, type Config } from './schema.js';

/**
 * Thrown when the environment fails validation. The message names each
 * offending setting and never contains the value of a sensitive setting.
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Parse and validate `process.env` into a frozen, typed `Config`. Call once
 * during bootstrap, before the app is built.
 *
 * @throws {ConfigValidationError} when a required setting is missing or any
 * setting is invalid. The message names each offending setting and omits the
 * value of any sensitive setting.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues.map((issue) => {
      const key = String(issue.path[0] ?? '(unknown)');
      // For sensitive settings report only the name, never Zod's message
      return SENSITIVE_KEYS.has(key) ? key : `${key} (${issue.message})`;
    });
    throw new ConfigValidationError(
      `Invalid configuration for: ${details.join(', ')}`,
    );
  }

  const parsed = result.data;

  return Object.freeze({
    httpPort: parsed.HTTP_PORT,
    logLevel: parsed.LOG_LEVEL,
    postgres: Object.freeze({
      url: parsed.POSTGRES_URL,
      poolMax: parsed.POSTGRES_POOL_MAX,
    }),
    redis: Object.freeze({
      url: parsed.REDIS_URL,
    }),
    ollama: Object.freeze({
      url: parsed.OLLAMA_URL,
    }),
    nodeEnv: parsed.NODE_ENV,
  });
}
