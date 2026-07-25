import { randomBytes, randomUUID } from 'node:crypto';
import type { AuthConfig } from '../config.js';
import { DefaultEnvelopeEncryption } from '../crypto/envelope-encryption.js';
import type {
  CredentialKey,
  CredentialRepository,
  UpsertCredentialParams,
} from '../repositories/credential-repository.js';
import { DecryptionError, type ProviderCredential } from '../types.js';
import { DefaultCredentialService } from './credential-service.js';

/** In-memory credential repository keyed by `${tenantId}|${provider}`. */
function fakeCredentialRepository(): CredentialRepository & {
  raw(key: CredentialKey): ProviderCredential | undefined;
} {
  const rows = new Map<string, ProviderCredential>();
  const id = (k: CredentialKey) => `${k.tenantId}|${k.provider}`;

  return {
    raw: (key) => rows.get(id(key)),
    upsert(params: UpsertCredentialParams): Promise<void> {
      rows.set(id(params), {
        id: randomUUID(),
        tenantId: params.tenantId,
        provider: params.provider,
        ciphertext: params.ciphertext,
        keyVersion: params.keyVersion,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return Promise.resolve();
    },
    find(key: CredentialKey): Promise<ProviderCredential | null> {
      return Promise.resolve(rows.get(id(key)) ?? null);
    },
    delete(key: CredentialKey): Promise<boolean> {
      return Promise.resolve(rows.delete(id(key)));
    },
  };
}

const encryptionConfig: AuthConfig['encryption'] = {
  activeKeyVersion: 1,
  keyring: new Map([[1, randomBytes(32)]]),
};

function makeService(repo = fakeCredentialRepository()) {
  const encryption = new DefaultEnvelopeEncryption(encryptionConfig);
  return { service: new DefaultCredentialService(encryption, repo), repo };
}

const SECRET = 'sk-openai-abc123';

describe('DefaultCredentialService', () => {
  it('stores only ciphertext and decrypts back to the original secret', async () => {
    const { service, repo } = makeService();

    await service.attachOrRotate('t1', 'openai', SECRET);

    // Storage holds ciphertext, never the plaintext.
    const stored = repo.raw({ tenantId: 't1', provider: 'openai' });
    expect(stored?.ciphertext.toString('utf8')).not.toContain(SECRET);

    const secret = await service.getDecrypted('t1', 'openai');
    expect(secret?.reveal()).toBe(SECRET);
    expect(secret?.toString()).toBe('[REDACTED]');
  });

  it('rotates the stored credential in place', async () => {
    const { service } = makeService();
    await service.attachOrRotate('t1', 'openai', SECRET);
    await service.attachOrRotate('t1', 'openai', 'sk-openai-rotated');

    const secret = await service.getDecrypted('t1', 'openai');
    expect(secret?.reveal()).toBe('sk-openai-rotated');
  });

  it('removes a credential so retrieval yields null', async () => {
    const { service } = makeService();
    await service.attachOrRotate('t1', 'openai', SECRET);

    await service.remove('t1', 'openai');
    expect(await service.getDecrypted('t1', 'openai')).toBeNull();
  });

  it('returns null when no credential is stored', async () => {
    const { service } = makeService();
    expect(await service.getDecrypted('t1', 'anthropic')).toBeNull();
  });

  it('lets one tenant hold credentials for two providers at once', async () => {
    const { service } = makeService();
    await service.attachOrRotate('t1', 'openai', 'sk-openai');
    await service.attachOrRotate('t1', 'anthropic', 'sk-anthropic');

    expect((await service.getDecrypted('t1', 'openai'))?.reveal()).toBe(
      'sk-openai',
    );
    expect((await service.getDecrypted('t1', 'anthropic'))?.reveal()).toBe(
      'sk-anthropic',
    );
  });

  it('propagates DecryptionError when the stored ciphertext is corrupt', async () => {
    const { service, repo } = makeService();
    await service.attachOrRotate('t1', 'openai', SECRET);

    // Tamper with the stored ciphertext so the auth tag fails.
    const stored = repo.raw({ tenantId: 't1', provider: 'openai' });
    if (!stored) expect.fail('expected a stored credential');
    stored.ciphertext[stored.ciphertext.length - 1] ^= 0xff;

    await expect(service.getDecrypted('t1', 'openai')).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });
});
