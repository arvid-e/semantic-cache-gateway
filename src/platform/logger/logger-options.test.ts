import { pino, type Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { REDACTION_CENSOR, buildLoggerOptions } from './logger-options.js';

function configWith(logLevel: Config['logLevel']): Config {
  return Object.freeze({
    httpPort: 3000,
    logLevel,
    postgres: Object.freeze({ url: 'postgres://x', poolMax: 10 }),
    redis: Object.freeze({ url: 'redis://x' }),
    ollama: Object.freeze({ url: 'http://x' }),
    nodeEnv: 'test',
  });
}

// Build a logger writing to an in-memory buffer so emitted records can be read.
function capture(config: Config): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = {
    write(chunk: string): void {
      lines.push(chunk);
    },
  };
  const logger = pino(buildLoggerOptions(config), stream);
  return { logger, lines };
}

describe('buildLoggerOptions', () => {
  it('sets the log level from config', () => {
    expect(buildLoggerOptions(configWith('debug')).level).toBe('debug');
    expect(buildLoggerOptions(configWith('warn')).level).toBe('warn');
  });

  it('masks a sensitive field even at the most verbose level', () => {
    const { logger, lines } = capture(configWith('trace'));
    const secret = 'sk-super-secret-123';

    logger.trace({ apiKey: secret }, 'outbound provider call');

    expect(lines).toHaveLength(1);
    const [line = ''] = lines;
    const record = JSON.parse(line) as { apiKey: string };
    expect(record.apiKey).toBe(REDACTION_CENSOR);
    expect(line).not.toContain(secret);
  });

  it('redacts an authorization header on the request record', () => {
    const { logger, lines } = capture(configWith('info'));
    const token = 'Bearer abc.def.ghi';

    logger.info({ req: { headers: { authorization: token } } }, 'request');

    const [line = ''] = lines;
    const record = JSON.parse(line) as {
      req: { headers: { authorization: string } };
    };
    expect(record.req.headers.authorization).toBe(REDACTION_CENSOR);
    expect(line).not.toContain(token);
  });
});
