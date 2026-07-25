import { randomBytes, randomUUID } from 'node:crypto';
import { createKeyHashUtil } from '../crypto/key-hash.js';
import type {
  ApiKeyRepository,
  InsertApiKeyParams,
} from '../repositories/api-key-repository.js';
import type { GatewayApiKey } from '../types.js';
import { createApiKeyService } from './api-key-service.js';

/**
 * In-memory api-key repository keyed by hash. Captures inserted params so a test
 * can assert storage never sees the plaintext.
 */
function fakeApiKeyRepository(): ApiKeyRepository & {
  readonly inserted: InsertApiKeyParams[];
} {
  const byHash = new Map<string, GatewayApiKey>();
  const inserted: InsertApiKeyParams[] = [];

  return {
    inserted,
    insert(params: InsertApiKeyParams): Promise<GatewayApiKey> {
      inserted.push(params);
      const row: GatewayApiKey = {
        id: randomUUID(),
        tenantId: params.tenantId,
        keyHash: params.keyHash,
        keyPrefix: params.keyPrefix,
        createdAt: new Date(),
        revokedAt: null,
      };
      byHash.set(params.keyHash.toString('hex'), row);
      return Promise.resolve(row);
    },
    findByHash(keyHash: Buffer): Promise<GatewayApiKey | null> {
      return Promise.resolve(byHash.get(keyHash.toString('hex')) ?? null);
    },
    revoke({ tenantId, id }): Promise<boolean> {
      for (const [hash, row] of byHash) {
        if (row.id === id && row.tenantId === tenantId && !row.revokedAt) {
          byHash.set(hash, { ...row, revokedAt: new Date() });
          return Promise.resolve(true);
        }
      }
      return Promise.resolve(false);
    },
  };
}

const PEPPER = randomBytes(32);

function makeService(repo = fakeApiKeyRepository()) {
  return {
    service: createApiKeyService(createKeyHashUtil(PEPPER), repo),
    repo,
  };
}

describe('createApiKeyService', () => {
  it('issues a key returning the plaintext once while storing only the hash', async () => {
    const { service, repo } = makeService();

    const issued = await service.issueKey('tenant-1');

    expect(issued.plaintext.startsWith('scg_')).toBe(true);
    expect(issued.prefix.startsWith('scg_')).toBe(true);
    expect(issued.id).toBeTruthy();

    // Storage received a hash + prefix, never the plaintext.
    expect(repo.inserted).toHaveLength(1);
    const stored = repo.inserted[0];
    expect(stored?.keyHash).toBeInstanceOf(Buffer);
    expect(JSON.stringify(stored)).not.toContain(issued.plaintext);
    expect(createKeyHashUtil(PEPPER).hash(issued.plaintext)).toEqual(
      stored?.keyHash,
    );
  });

  it('authenticates a valid key to exactly its owning tenant', async () => {
    const { service } = makeService();
    const issued = await service.issueKey('tenant-42');

    const result = await service.authenticate(issued.plaintext);
    expect(result.tenantId).toBe('tenant-42');
  });

  it('resolves an unknown key to no tenant', async () => {
    const { service } = makeService();
    await service.issueKey('tenant-1');

    expect(
      (await service.authenticate('scg_not-a-real-key')).tenantId,
    ).toBeNull();
    // A raw provider-style key is not a gateway key and never matches (Req 2.5).
    expect(
      (await service.authenticate('sk-openai-style-key')).tenantId,
    ).toBeNull();
  });

  it('rejects a revoked key', async () => {
    const { service, repo } = makeService();
    const issued = await service.issueKey('tenant-7');

    // Revoke via the repository, then re-authenticate.
    const stored = repo.inserted[0];
    if (!stored) expect.fail('expected an inserted key');
    const found = await repo.findByHash(stored.keyHash);
    if (!found) expect.fail('expected to find the stored key');
    expect(await repo.revoke({ tenantId: 'tenant-7', id: found.id })).toBe(
      true,
    );

    expect((await service.authenticate(issued.plaintext)).tenantId).toBeNull();
  });
});
