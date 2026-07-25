import type { LoggerOptions } from 'pino';
import type { Config } from '../config/schema.js';

/**
 * Fields whose values are masked before any record is written. Covers the four
 * secret categories in Req 3.2 — authorization headers, gateway API keys,
 * provider credentials, and encryption material — at the top level and one
 * level of nesting, plus the request/response header locations.
 *
 * Keep this aligned with the config `SENSITIVE_KEYS` and any downstream secret
 * fields: a new secret shape means a new path here.
 */
export const REDACT_PATHS: readonly string[] = [
  // Authorization headers
  'authorization',
  '*.authorization',
  'req.headers.authorization',
  'res.headers.authorization',
  // Gateway API keys
  'apiKey',
  '*.apiKey',
  // Provider credentials
  'credential',
  'credentials',
  '*.credential',
  '*.credentials',
  // Encryption material
  'encryptionKey',
  '*.encryptionKey',
];

/** Value substituted in place of a redacted field. */
export const REDACTION_CENSOR = '[Redacted]';

/**
 * Build the Pino logger options from validated config: honor the configured log
 * level and redact sensitive fields before records are written. The result is a
 * plain Pino options object, which Fastify accepts directly as its `logger`
 * config when the app is assembled (task 4.2 also adds request/response
 * serializers for Req 3.4).
 *
 * Redaction applies to any emitted record regardless of level (Req 3.2), so a
 * secret is never written even at `trace`.
 */
export function buildLoggerOptions(config: Config): LoggerOptions {
  return {
    level: config.logLevel,
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACTION_CENSOR,
    },
  };
}
