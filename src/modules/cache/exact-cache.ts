import type { Redis } from 'ioredis';
import { FINISH_REASONS, type NormalizedResponse } from '../gateway/types.js';

/**
 * The exact layer: byte-identical repeats, served from Redis without touching
 * the provider (Req 2.2). Keys arrive already composed by `key-composer.ts` —
 * this owns storage and expiry, not keying.
 *
 * Per-tenant isolation (Req 4.2) is inherent rather than enforced here: the
 * tenant is inside the hash, so one tenant cannot construct another's key.
 */

/**
 * Invalidation by tenant (Req 7.4) is the one thing the key format cannot
 * answer on its own. `cache:exact:{sha256}` is opaque — a hash cannot be read
 * back to the tenant that produced it, and Redis cannot pattern-match what is
 * not in the key. So each write also records its key in a per-tenant set, and
 * invalidation walks that set.
 *
 * The `tenant:` infix keeps the index out of the entries' own namespace: an
 * entry key is `cache:exact:` followed by 64 hex characters, which can never
 * collide with this.
 */
function tenantIndexKey(tenantId: string): string {
  return `cache:exact:tenant:${tenantId}`;
}

/** How many members one `SSCAN` round trip pulls back during invalidation. */
const SCAN_BATCH = 500;

/**
 * The commands this layer uses, narrowed from `ioredis` so a test can stub them
 * without standing up a Redis. A real `Redis` satisfies it.
 */
export type ExactCacheRedis = Pick<
  Redis,
  'get' | 'set' | 'sadd' | 'expire' | 'sscan' | 'del'
>;

export interface ExactCache {
  get(key: string): Promise<NormalizedResponse | null>;
  /**
   * `tenantId` is not in the design's original three-argument signature, but
   * invalidation cannot work without it — see {@link tenantIndexKey}. It is the
   * tenant whose key was composed, never a caller-chosen value.
   */
  set(
    tenantId: string,
    key: string,
    value: NormalizedResponse,
    ttlSeconds: number,
  ): Promise<void>;
  invalidate(tenantId: string): Promise<void>;
}

export class RedisExactCache implements ExactCache {
  readonly #redis: ExactCacheRedis;

  constructor(redis: ExactCacheRedis) {
    this.#redis = redis;
  }

  /**
   * A miss and an unreadable entry are both `null`. Redis' own `EX` handles
   * expiry, so an expired entry is simply gone (Req 7.3) — there is no second
   * expiry check to get wrong.
   */
  async get(key: string): Promise<NormalizedResponse | null> {
    const raw = await this.#redis.get(key);
    if (raw === null) return null;

    return parseEntry(raw);
  }

  /**
   * The index write is deliberately not atomic with the entry write. If the
   * `SADD` fails after the `SET`, the entry is live but unindexed — it serves
   * hits and expires on its own TTL, and only invalidation would miss it. The
   * reverse order would risk an indexed key that was never written, which costs
   * a pointless `DEL`. Both are cheaper than a transaction on the hot write
   * path, and neither can serve a wrong answer.
   */
  async set(
    tenantId: string,
    key: string,
    value: NormalizedResponse,
    ttlSeconds: number,
  ): Promise<void> {
    const index = tenantIndexKey(tenantId);

    await this.#redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    await this.#redis.sadd(index, key);
    // Refreshed on every write, so the index always outlives its newest member:
    // any unexpired entry was written within the last `ttlSeconds`, and that
    // write pushed the index out at least as far. Without this the index would
    // be the one key in the layer that never expires.
    await this.#redis.expire(index, ttlSeconds);
  }

  /**
   * `SSCAN` rather than `SMEMBERS`: a busy tenant's index can hold many
   * thousands of keys, and pulling them all into one reply to delete them is a
   * memory spike on both sides for no benefit.
   *
   * Members whose entries already expired are deleted too — `DEL` on an absent
   * key is a no-op, so the stale names cost one argument slot each rather than
   * needing their own cleanup pass.
   */
  async invalidate(tenantId: string): Promise<void> {
    const index = tenantIndexKey(tenantId);
    let cursor = '0';

    do {
      const [next, members] = await this.#redis.sscan(
        index,
        cursor,
        'COUNT',
        SCAN_BATCH,
      );
      cursor = next;

      if (members.length > 0) {
        await this.#redis.del(...members);
      }
      // `SSCAN` returns '0' when the cursor has wrapped; the set is not being
      // mutated during the walk, so one pass sees every member.
    } while (cursor !== '0');

    await this.#redis.del(index);
  }
}

/**
 * A stored entry that will not parse is treated as a miss, not an error. It can
 * only come from a corrupted write or a response shape that changed under a
 * populated cache; either way the request is still answerable by going live,
 * and throwing would turn one bad entry into a permanently failing request that
 * its own TTL would eventually have cleared.
 *
 * Redis *transport* failures are deliberately not caught here — an unreachable
 * cache is the orchestrator's call to make (Req 6.6), not something this layer
 * should quietly convert into a miss.
 */
function parseEntry(raw: string): NormalizedResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return isNormalizedResponse(parsed) ? parsed : null;
}

function isNormalizedResponse(value: unknown): value is NormalizedResponse {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<NormalizedResponse>;

  const message: unknown = entry.message;
  const usage: unknown = entry.usage;

  return (
    typeof entry.id === 'string' &&
    typeof entry.provider === 'string' &&
    typeof entry.model === 'string' &&
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { content?: unknown }).content === 'string' &&
    typeof usage === 'object' &&
    usage !== null &&
    isUsage(usage) &&
    typeof entry.finishReason === 'string' &&
    (FINISH_REASONS as readonly string[]).includes(entry.finishReason)
  );
}

function isUsage(value: object): boolean {
  const usage = value as Record<string, unknown>;
  return (
    typeof usage.promptTokens === 'number' &&
    typeof usage.completionTokens === 'number' &&
    typeof usage.totalTokens === 'number'
  );
}
