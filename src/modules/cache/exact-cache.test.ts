import type {
  ChatCompletionRequest,
  NormalizedResponse,
} from '#src/modules/gateway/types.js';
import { RedisExactCache, type ExactCacheRedis } from './exact-cache.js';
import { composeCacheKeys } from './key-composer.js';

const TTL = 3600;

const RESPONSE: NormalizedResponse = {
  id: 'resp-1',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
  message: { role: 'assistant', content: 'A Postgres extension for vectors.' },
  usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
  finishReason: 'stop',
};

const REQUEST: ChatCompletionRequest = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
  messages: [{ role: 'user', content: 'What is pgvector?' }],
};

/**
 * An in-memory stand-in for the six commands this layer uses, with a movable
 * clock so expiry is asserted rather than waited on. `SSCAN` pages for real, so
 * the invalidation loop is exercised instead of assumed.
 */
class FakeRedis {
  now = 0;
  readonly strings = new Map<string, { value: string; expiresAt: number }>();
  readonly sets = new Map<string, { members: string[]; expiresAt: number }>();

  advanceSeconds(seconds: number): void {
    this.now += seconds;
  }

  #live<T extends { expiresAt: number }>(
    map: Map<string, T>,
    key: string,
  ): T | undefined {
    const found = map.get(key);
    if (found === undefined) return undefined;
    if (found.expiresAt <= this.now) {
      map.delete(key);
      return undefined;
    }
    return found;
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.#live(this.strings, key)?.value ?? null);
  }

  set(
    key: string,
    value: string,
    _mode: 'EX',
    ttlSeconds: number,
  ): Promise<'OK'> {
    this.strings.set(key, { value, expiresAt: this.now + ttlSeconds });
    return Promise.resolve('OK');
  }

  sadd(key: string, ...members: string[]): Promise<number> {
    const existing = this.#live(this.sets, key) ?? {
      members: [],
      expiresAt: Number.POSITIVE_INFINITY,
    };
    const added = members.filter((m) => !existing.members.includes(m));
    existing.members.push(...added);
    this.sets.set(key, existing);
    return Promise.resolve(added.length);
  }

  expire(key: string, seconds: number): Promise<number> {
    const set = this.#live(this.sets, key);
    if (set !== undefined) {
      set.expiresAt = this.now + seconds;
      return Promise.resolve(1);
    }
    const str = this.#live(this.strings, key);
    if (str !== undefined) {
      str.expiresAt = this.now + seconds;
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  }

  sscan(
    key: string,
    cursor: string,
    _countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]> {
    const members = this.#live(this.sets, key)?.members ?? [];
    const start = Number(cursor);
    const page = members.slice(start, start + count);
    const next = start + count >= members.length ? '0' : String(start + count);
    return Promise.resolve([next, page]);
  }

  del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) removed += 1;
      if (this.sets.delete(key)) removed += 1;
    }
    return Promise.resolve(removed);
  }
}

/**
 * `ExactCacheRedis` is `Pick<Redis, …>`, whose signatures carry `ioredis`'
 * callback overloads and `RedisKey` unions. The fake implements the shapes the
 * layer actually calls; the cast bridges the rest.
 */
function newCache(): { cache: RedisExactCache; redis: FakeRedis } {
  const redis = new FakeRedis();
  return {
    cache: new RedisExactCache(redis as unknown as ExactCacheRedis),
    redis,
  };
}

describe('RedisExactCache — store and retrieve', () => {
  it('returns the stored response within TTL', async () => {
    const { cache } = newCache();
    const { exactKey } = composeCacheKeys('tenant-a', REQUEST);

    await cache.set('tenant-a', exactKey, RESPONSE, TTL);

    await expect(cache.get(exactKey)).resolves.toEqual(RESPONSE);
  });

  it('returns null for a key that was never written', async () => {
    const { cache } = newCache();

    await expect(cache.get('cache:exact:absent')).resolves.toBeNull();
  });

  it('does not serve an entry past its TTL', async () => {
    // Req 7.3. Redis' own `EX` is the mechanism, so there is no second expiry
    // check in the layer that could disagree with it.
    const { cache, redis } = newCache();
    const { exactKey } = composeCacheKeys('tenant-a', REQUEST);

    await cache.set('tenant-a', exactKey, RESPONSE, TTL);
    redis.advanceSeconds(TTL + 1);

    await expect(cache.get(exactKey)).resolves.toBeNull();
  });
});

describe('RedisExactCache — tenant isolation', () => {
  it("never serves one tenant's entry to another", async () => {
    // Req 4.2. The isolation is in the key, not in a filter here: the composer
    // folds the tenant into the hash, so tenant-b cannot name tenant-a's entry
    // even with an otherwise identical request.
    const { cache } = newCache();
    const a = composeCacheKeys('tenant-a', REQUEST);
    const b = composeCacheKeys('tenant-b', REQUEST);

    await cache.set('tenant-a', a.exactKey, RESPONSE, TTL);

    expect(b.exactKey).not.toBe(a.exactKey);
    await expect(cache.get(b.exactKey)).resolves.toBeNull();
  });
});

describe('RedisExactCache — invalidation', () => {
  it("removes the tenant's entries and leaves other tenants alone", async () => {
    // Req 7.4.
    const { cache } = newCache();
    const a1 = composeCacheKeys('tenant-a', REQUEST).exactKey;
    const a2 = composeCacheKeys('tenant-a', {
      ...REQUEST,
      messages: [{ role: 'user', content: 'And how do I index it?' }],
    }).exactKey;
    const b1 = composeCacheKeys('tenant-b', REQUEST).exactKey;

    await cache.set('tenant-a', a1, RESPONSE, TTL);
    await cache.set('tenant-a', a2, RESPONSE, TTL);
    await cache.set('tenant-b', b1, RESPONSE, TTL);

    await cache.invalidate('tenant-a');

    await expect(cache.get(a1)).resolves.toBeNull();
    await expect(cache.get(a2)).resolves.toBeNull();
    await expect(cache.get(b1)).resolves.toEqual(RESPONSE);
  });

  it('walks an index larger than one scan batch', async () => {
    // SCAN_BATCH is 500; a busy tenant exceeds it, and a single-page assumption
    // would silently leave the remainder cached after an invalidation.
    const { cache } = newCache();
    const keys = Array.from(
      { length: 1200 },
      (_, i) => `cache:exact:${String(i)}`,
    );

    for (const key of keys) {
      await cache.set('tenant-a', key, RESPONSE, TTL);
    }

    await cache.invalidate('tenant-a');

    const survivors = await Promise.all(keys.map((key) => cache.get(key)));
    expect(survivors.every((entry) => entry === null)).toBe(true);
  });

  it('is a no-op for a tenant that has cached nothing', async () => {
    const { cache } = newCache();

    await expect(cache.invalidate('tenant-unknown')).resolves.toBeUndefined();
  });

  it('drops the index itself, not just its members', async () => {
    // Left behind, the index would keep naming deleted keys and grow forever.
    const { cache, redis } = newCache();
    const { exactKey } = composeCacheKeys('tenant-a', REQUEST);

    await cache.set('tenant-a', exactKey, RESPONSE, TTL);
    await cache.invalidate('tenant-a');

    expect(redis.sets.has('cache:exact:tenant:tenant-a')).toBe(false);
  });

  it('keeps the index alive at least as long as its newest member', async () => {
    // The index carries a TTL so it cannot outlive the layer, but refreshing it
    // on each write is what stops an early member's expiry from orphaning a
    // later one.
    const { cache, redis } = newCache();
    const early = composeCacheKeys('tenant-a', REQUEST).exactKey;
    const late = composeCacheKeys('tenant-a', {
      ...REQUEST,
      messages: [{ role: 'user', content: 'later question' }],
    }).exactKey;

    await cache.set('tenant-a', early, RESPONSE, TTL);
    redis.advanceSeconds(TTL - 1);
    await cache.set('tenant-a', late, RESPONSE, TTL);
    redis.advanceSeconds(2);

    // `early` has expired on its own; `late` must still be invalidatable.
    await cache.invalidate('tenant-a');
    await expect(cache.get(late)).resolves.toBeNull();
  });
});

describe('RedisExactCache — unreadable entries', () => {
  it('treats a non-JSON entry as a miss', async () => {
    const { cache, redis } = newCache();
    redis.strings.set('cache:exact:poisoned', {
      value: 'not json',
      expiresAt: Number.POSITIVE_INFINITY,
    });

    await expect(cache.get('cache:exact:poisoned')).resolves.toBeNull();
  });

  it('treats a well-formed but wrong-shaped entry as a miss', async () => {
    // A response shape that changed under a populated cache. Going live is
    // always available; throwing would make the request fail until the TTL
    // cleared an entry nobody is looking at.
    const { cache, redis } = newCache();
    redis.strings.set('cache:exact:stale-shape', {
      value: JSON.stringify({ id: 'r', provider: 'anthropic' }),
      expiresAt: Number.POSITIVE_INFINITY,
    });

    await expect(cache.get('cache:exact:stale-shape')).resolves.toBeNull();
  });

  it('rejects an entry whose finish reason is not in the contract', async () => {
    const { cache, redis } = newCache();
    redis.strings.set('cache:exact:bad-reason', {
      value: JSON.stringify({ ...RESPONSE, finishReason: 'invented' }),
      expiresAt: Number.POSITIVE_INFINITY,
    });

    await expect(cache.get('cache:exact:bad-reason')).resolves.toBeNull();
  });
});
