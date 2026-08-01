import type { LoggerOptions } from 'pino';
import type { Config } from '../config/schema.js';

/**
 * Fields masked before any record is written, at the top level and one level of
 * nesting. Keep aligned with the config `SENSITIVE_KEYS`: a new secret shape
 * means a new path here.
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

export const REDACTION_CENSOR = '[Redacted]';

/**
 * A plain Pino options object, which Fastify accepts directly as its `logger`
 * config. Redaction applies to any emitted record regardless of level, so a
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
