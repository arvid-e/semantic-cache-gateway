import { inspect } from 'node:util';
import {
  DecryptionError,
  MissingCredentialError,
  PROVIDER_NAMES,
  ProviderSecret,
  isProviderName,
  type CredentialResolution,
} from './types.js';

const RAW = 'sk-super-secret-provider-key';

describe('ProviderSecret', () => {
  it('reveals the raw value only through reveal()', () => {
    const secret = new ProviderSecret(RAW);
    expect(secret.reveal()).toBe(RAW);
  });

  it('serializes as [REDACTED] via toJSON and toString', () => {
    const secret = new ProviderSecret(RAW);
    expect(secret.toJSON()).toBe('[REDACTED]');
    expect(secret.toString()).toBe('[REDACTED]');
    // Deliberately exercise the template-literal coercion path (a common
    // accidental-log shape); the lint rule guards against unintended coercion.
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    expect(`${secret}`).toBe('[REDACTED]');
  });

  it('never exposes the raw value through JSON.stringify', () => {
    const payload = JSON.stringify({ apiKey: new ProviderSecret(RAW) });
    expect(payload).toBe('{"apiKey":"[REDACTED]"}');
    expect(payload).not.toContain(RAW);
  });

  it('never exposes the raw value through console/util.inspect', () => {
    const rendered = inspect({ apiKey: new ProviderSecret(RAW) });
    expect(rendered).toContain('[REDACTED]');
    expect(rendered).not.toContain(RAW);
  });
});

describe('ProviderName', () => {
  it('narrows only the known providers', () => {
    for (const name of PROVIDER_NAMES) {
      expect(isProviderName(name)).toBe(true);
    }
    expect(isProviderName('cohere')).toBe(false);
    expect(isProviderName('')).toBe(false);
  });
});

describe('CredentialResolution', () => {
  it('carries a wrapped secret on the resolved branch', () => {
    // Built behind a function returning the union so the discriminant is not
    // narrowed to a single literal at the call site — mirroring how routing
    // receives an opaque resolution it must discriminate.
    const resolve = (): CredentialResolution => ({
      kind: 'resolved',
      secret: new ProviderSecret(RAW),
      source: 'per_request',
    });
    const resolution = resolve();

    // Exhaustive discrimination is what routing relies on.
    if (resolution.kind === 'resolved') {
      expect(resolution.secret).toBeInstanceOf(ProviderSecret);
      expect(resolution.source).toBe('per_request');
    } else {
      expect.fail('expected a resolved resolution');
    }
  });
});

describe('credential error types', () => {
  it('DecryptionError is an Error carrying no secret and an optional version', () => {
    const err = new DecryptionError(3);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DecryptionError');
    expect(err.keyVersion).toBe(3);
    expect(err.message).not.toContain(RAW);
  });

  it('MissingCredentialError names the non-secret provider', () => {
    const err = new MissingCredentialError('anthropic');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MissingCredentialError');
    expect(err.provider).toBe('anthropic');
    expect(err.message).toContain('anthropic');
  });
});
