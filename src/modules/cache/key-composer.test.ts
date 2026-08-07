import type { ChatCompletionRequest } from '#src/modules/gateway/types.js';
import { composeCacheKeys } from './key-composer.js';

// Design pins the key format and the `(tenant_id, model, params_hash)` scope.
// These four are judgment calls to confirm before implementing:
//   1. One call returns both keys, off one canonicalization pass.
//   2. `paramsHash` covers generation params and provider only — never tenant,
//      model, or messages, which are separate columns or the prompt itself.
//   3. The provider is cache-relevant: two of them can answer to the same model
//      string, and their answers are not interchangeable.
//   4. Canonicalization trims message whitespace and sorts stop sequences, but
//      preserves case and interior whitespace.

const TENANT = 'tenant-a';

// Held apart from `base` because under `exactOptionalPropertyTypes`,
// `base.topP` reads as `number | undefined` and no longer goes back into the
// optional property.
const params = {
  temperature: 0.2,
  maxTokens: 256,
  topP: 0.9,
  stop: ['\n\n'],
};

const base: ChatCompletionRequest = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
  messages: [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'What is pgvector?' },
    { role: 'assistant', content: 'A Postgres extension for vectors.' },
    { role: 'user', content: 'And how do I index it?' },
  ],
  ...params,
};

function withRequest(overrides: Partial<ChatCompletionRequest>) {
  return composeCacheKeys(TENANT, { ...base, ...overrides });
}

describe('composeCacheKeys — shape', () => {
  it('returns a prefixed sha256 exact key and a hash of its own', () => {
    const keys = composeCacheKeys(TENANT, base);

    expect(keys.exactKey).toMatch(/^cache:exact:[0-9a-f]{64}$/);
    expect(keys.paramsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic across calls', () => {
    const first = composeCacheKeys(TENANT, base);
    const second = composeCacheKeys(TENANT, structuredClone(base));

    expect(second).toEqual(first);
  });
});

describe('composeCacheKeys — what changes the exact key', () => {
  const baseline = composeCacheKeys(TENANT, base).exactKey;

  it('changes with the tenant', () => {
    // Req 4.1/4.2: with the tenant in the key, one tenant can never address
    // another's entry even when every other input is identical.
    expect(composeCacheKeys('tenant-b', base).exactKey).not.toBe(baseline);
  });

  it('changes with the model', () => {
    expect(withRequest({ model: 'claude-opus-4-1' }).exactKey).not.toBe(
      baseline,
    );
  });

  it('changes with the provider', () => {
    expect(withRequest({ provider: 'openai' }).exactKey).not.toBe(baseline);
  });

  it('changes with each generation parameter independently', () => {
    const variants = [
      withRequest({ temperature: 0.7 }).exactKey,
      withRequest({ maxTokens: 512 }).exactKey,
      withRequest({ topP: 0.5 }).exactKey,
      withRequest({ stop: ['STOP'] }).exactKey,
    ];

    expect(new Set([baseline, ...variants]).size).toBe(variants.length + 1);
  });

  it('changes when a parameter goes from set to absent', () => {
    const withoutTemperature: ChatCompletionRequest = {
      provider: base.provider,
      model: base.model,
      messages: base.messages,
      maxTokens: params.maxTokens,
      topP: params.topP,
      stop: params.stop,
    };

    expect(composeCacheKeys(TENANT, withoutTemperature).exactKey).not.toBe(
      baseline,
    );
  });

  it('changes with message content, role, or order', () => {
    const edited = base.messages.map((m, i) =>
      i === 1 ? { ...m, content: 'What is HNSW?' } : m,
    );
    const rerolled = base.messages.map((m, i) =>
      i === 0 ? { ...m, role: 'user' as const } : m,
    );
    const reordered = [...base.messages].reverse();

    const variants = [
      withRequest({ messages: edited }).exactKey,
      withRequest({ messages: rerolled }).exactKey,
      withRequest({ messages: reordered }).exactKey,
    ];

    expect(new Set([baseline, ...variants]).size).toBe(variants.length + 1);
  });

  it('separates message boundaries from message content', () => {
    // Naive concatenation lets one turn's text impersonate a turn boundary, so
    // two different conversations would share a key.
    const split = withRequest({
      messages: [
        { role: 'user', content: 'alpha' },
        { role: 'user', content: 'beta' },
      ],
    }).exactKey;
    const joined = withRequest({
      messages: [{ role: 'user', content: 'alpha\nuser:beta' }],
    }).exactKey;

    expect(split).not.toBe(joined);
  });

  it('separates the tenant from the model across the field delimiter', () => {
    // Same reasoning one level up: `tenant|model` must not be forgeable by a
    // tenant id that carries the delimiter.
    const forged = composeCacheKeys('tenant-a|claude-sonnet-4-5-20250929', {
      ...base,
      model: '',
    }).exactKey;

    expect(forged).not.toBe(baseline);
  });
});

describe('composeCacheKeys — canonicalization', () => {
  const baseline = composeCacheKeys(TENANT, base).exactKey;

  it('ignores whitespace around message content', () => {
    const padded = base.messages.map((m) => ({
      ...m,
      content: `  ${m.content}\n`,
    }));

    expect(withRequest({ messages: padded }).exactKey).toBe(baseline);
  });

  it('preserves interior whitespace and case', () => {
    const collapsed = base.messages.map((m, i) =>
      i === 1 ? { ...m, content: m.content.replace(' ', '  ') } : m,
    );
    const lowered = base.messages.map((m, i) =>
      i === 1 ? { ...m, content: m.content.toLowerCase() } : m,
    );

    expect(withRequest({ messages: collapsed }).exactKey).not.toBe(baseline);
    expect(withRequest({ messages: lowered }).exactKey).not.toBe(baseline);
  });

  it('ignores stop-sequence order', () => {
    // A provider treats stop sequences as a set, so the client's ordering is
    // not a behavioral difference.
    const forward = withRequest({ stop: ['END', 'STOP'] }).exactKey;
    const reversed = withRequest({ stop: ['STOP', 'END'] }).exactKey;

    expect(forward).toBe(reversed);
  });

  it('ignores the order the request object was built in', () => {
    const reordered: ChatCompletionRequest = {
      stop: params.stop,
      topP: params.topP,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
      messages: base.messages,
      model: base.model,
      provider: base.provider,
    };

    expect(composeCacheKeys(TENANT, reordered).exactKey).toBe(baseline);
  });
});

describe('composeCacheKeys — params hash scope', () => {
  const baseline = composeCacheKeys(TENANT, base).paramsHash;

  it('is independent of tenant, model, and messages', () => {
    // Tenant and model are their own columns; folding them in would make the
    // scope filter redundant. Folding the prompt in would match nothing but an
    // exact repeat, which is the other layer's job.
    expect(composeCacheKeys('tenant-b', base).paramsHash).toBe(baseline);
    expect(withRequest({ model: 'gpt-5' }).paramsHash).toBe(baseline);
    expect(
      withRequest({ messages: [{ role: 'user', content: 'unrelated' }] })
        .paramsHash,
    ).toBe(baseline);
  });

  it('changes with each generation parameter and with the provider', () => {
    const variants = [
      withRequest({ temperature: 0.7 }).paramsHash,
      withRequest({ maxTokens: 512 }).paramsHash,
      withRequest({ topP: 0.5 }).paramsHash,
      withRequest({ stop: ['STOP'] }).paramsHash,
      withRequest({ provider: 'openai' }).paramsHash,
    ];

    expect(new Set([baseline, ...variants]).size).toBe(variants.length + 1);
  });

  it('treats a request with no generation parameters as its own scope', () => {
    const minimal: ChatCompletionRequest = {
      provider: base.provider,
      model: base.model,
      messages: base.messages,
    };

    expect(composeCacheKeys(TENANT, minimal).paramsHash).not.toBe(baseline);
    // ...and still stable, so defaults-only requests share one scope.
    expect(composeCacheKeys('tenant-b', minimal).paramsHash).toBe(
      composeCacheKeys(TENANT, minimal).paramsHash,
    );
  });
});
