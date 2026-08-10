import { createHash } from 'node:crypto';
import type { ChatCompletionRequest, ChatMessage } from '../gateway/types.js';

interface CacheKey {
  exactKey: string;
  paramsHash: string;
}

function sha256(input: string) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function canonicalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.trim(),
  }));
}

/**
 * Make sure the order of the object is always the same.
 * 
 * @param req 
 * @returns 
 */
function canonicalizeParams(req: ChatCompletionRequest) {
  return [
    req.provider,
    req.temperature ?? null,
    req.maxTokens ?? null,
    req.topP ?? null,
    req.stop ? [...req.stop].sort() : null,
  ];
}

/**
 * Generate cache keys for exact cache and semantic cache.
 * 
 * exactKey is a hash of the whole request.
 * paramsHash is a hash of the configs.
 * 
 * @param tenant 
 * @param req 
 * @returns {CacheKey} - exactKey and paramsHash
 */
export const composeCacheKeys = (
  tenant: string,
  req: ChatCompletionRequest,
): CacheKey => {
  const paramsHash = sha256(JSON.stringify(canonicalizeParams(req)));

  const exactKey = sha256(
    JSON.stringify([
      tenant,
      req.model,
      paramsHash,
      canonicalizeMessages(req.messages),
    ]),
  );

  const cacheKey: CacheKey = {
    exactKey: `cache:exact:${exactKey}`,
    paramsHash,
  };

  return cacheKey;
};
