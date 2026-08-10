import { FINISH_REASONS, type NormalizedResponse } from '../gateway/types.js';

/**
 * Structural check on a response coming back *out* of a cache store, shared by
 * both layers: Redis hands back a string it never validated, and `jsonb` hands
 * back whatever shape was written. Neither store knows the response type, so
 * the check belongs here rather than in either one.
 *
 * A stored entry that fails this is treated as a miss rather than an error —
 * it can only come from a corrupted write or a response shape that changed
 * under a populated cache, and both are answerable by going live. Throwing
 * would turn one bad row into a permanently failing request that its own TTL
 * would eventually have cleared.
 */
export function isNormalizedResponse(
  value: unknown,
): value is NormalizedResponse {
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
