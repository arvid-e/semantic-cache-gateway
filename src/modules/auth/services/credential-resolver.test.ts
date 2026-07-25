import type { CredentialService } from './credential-service.js';
import { DecryptionError, ProviderSecret } from '../types.js';
import { DefaultCredentialResolver } from './credential-resolver.js';

/** A credential service whose methods are spies, with sensible defaults. */
function fakeCredentialService(): CredentialService & {
  getDecrypted: ReturnType<typeof vi.fn>;
  attachOrRotate: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  return {
    getDecrypted: vi.fn().mockResolvedValue(null),
    attachOrRotate: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

describe('DefaultCredentialResolver', () => {
  it('resolves a per-request key without persisting or reading storage', async () => {
    const svc = fakeCredentialService();
    const resolver = new DefaultCredentialResolver(svc);

    const result = await resolver.resolveCredential({
      tenantId: 't1',
      provider: 'openai',
      perRequestKey: 'sk-byok-123',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') expect.fail('expected resolved');
    expect(result.source).toBe('per_request');
    expect(result.secret).toBeInstanceOf(ProviderSecret);
    expect(result.secret.reveal()).toBe('sk-byok-123');

    // Non-persistence: nothing was stored, and storage was not even consulted.
    expect(svc.attachOrRotate).not.toHaveBeenCalled();
    expect(svc.getDecrypted).not.toHaveBeenCalled();
  });

  it('falls back to the decrypted stored credential', async () => {
    const svc = fakeCredentialService();
    svc.getDecrypted.mockResolvedValue(new ProviderSecret('sk-stored'));
    const resolver = new DefaultCredentialResolver(svc);

    const result = await resolver.resolveCredential({
      tenantId: 't1',
      provider: 'openai',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') expect.fail('expected resolved');
    expect(result.source).toBe('stored');
    expect(result.secret.reveal()).toBe('sk-stored');
    expect(svc.getDecrypted).toHaveBeenCalledWith('t1', 'openai');
  });

  it('treats an empty per-request key as not supplied', async () => {
    const svc = fakeCredentialService();
    svc.getDecrypted.mockResolvedValue(new ProviderSecret('sk-stored'));
    const resolver = new DefaultCredentialResolver(svc);

    const result = await resolver.resolveCredential({
      tenantId: 't1',
      provider: 'openai',
      perRequestKey: '',
    });

    if (result.kind !== 'resolved') expect.fail('expected resolved');
    expect(result.source).toBe('stored');
  });

  it('returns missing when neither a per-request nor a stored key exists', async () => {
    const svc = fakeCredentialService(); // getDecrypted defaults to null
    const resolver = new DefaultCredentialResolver(svc);

    const result = await resolver.resolveCredential({
      tenantId: 't1',
      provider: 'anthropic',
    });

    expect(result.kind).toBe('missing');
  });

  it('returns decryption_failed when the stored credential cannot be decrypted', async () => {
    const svc = fakeCredentialService();
    svc.getDecrypted.mockRejectedValue(new DecryptionError(1));
    const resolver = new DefaultCredentialResolver(svc);

    const result = await resolver.resolveCredential({
      tenantId: 't1',
      provider: 'openai',
    });

    expect(result.kind).toBe('decryption_failed');
  });

  it('rethrows a non-decryption error (e.g. a datastore fault)', async () => {
    const svc = fakeCredentialService();
    svc.getDecrypted.mockRejectedValue(new Error('connection reset'));
    const resolver = new DefaultCredentialResolver(svc);

    await expect(
      resolver.resolveCredential({ tenantId: 't1', provider: 'openai' }),
    ).rejects.toThrow('connection reset');
  });
});
