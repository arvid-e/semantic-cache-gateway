import { FINISH_REASONS, type FinishReason } from '../types.js';
import {
  mapAnthropicStopReason,
  mapAnthropicUsage,
  mapOllamaDoneReason,
  mapOllamaUsage,
  mapOpenAiFinishReason,
  mapOpenAiUsage,
} from './mapping.js';

/** Every provider mapper narrows an arbitrary wire string to the closed union. */
const MAPPERS = [
  mapOpenAiFinishReason,
  mapAnthropicStopReason,
  mapOllamaDoneReason,
] as const;

describe('finish-reason mapping', () => {
  describe('OpenAI', () => {
    it.each([
      ['stop', 'stop'],
      ['length', 'length'],
      ['content_filter', 'content_filter'],
      ['tool_calls', 'tool_use'],
      // Deprecated but still emitted by older deployments.
      ['function_call', 'tool_use'],
    ])('maps %s to %s', (wire, expected) => {
      expect(mapOpenAiFinishReason(wire)).toBe(expected);
    });
  });

  describe('Anthropic', () => {
    it.each([
      ['end_turn', 'stop'],
      // A stop sequence is a normal completion, not a truncation.
      ['stop_sequence', 'stop'],
      ['max_tokens', 'length'],
      ['model_context_window_exceeded', 'length'],
      ['tool_use', 'tool_use'],
      ['refusal', 'content_filter'],
      // Server-tool pause: neither a completion nor a truncation.
      ['pause_turn', 'other'],
    ])('maps %s to %s', (wire, expected) => {
      expect(mapAnthropicStopReason(wire)).toBe(expected);
    });
  });

  describe('Ollama', () => {
    it.each([
      ['stop', 'stop'],
      ['length', 'length'],
      // Model lifecycle reasons carry no completion meaning.
      ['load', 'other'],
      ['unload', 'other'],
    ])('maps %s to %s', (wire, expected) => {
      expect(mapOllamaDoneReason(wire)).toBe(expected);
    });
  });

  it('falls back to other for an unrecognized reason', () => {
    for (const map of MAPPERS) {
      expect(map('a_reason_invented_next_year')).toBe('other');
      expect(map('')).toBe('other');
    }
  });

  it('falls back to other when a provider reports no reason', () => {
    for (const map of MAPPERS) {
      expect(map(null)).toBe('other');
      expect(map(undefined)).toBe('other');
    }
  });

  it('only ever produces a member of the closed union', () => {
    const wireValues = [
      'stop',
      'length',
      'content_filter',
      'tool_calls',
      'function_call',
      'end_turn',
      'stop_sequence',
      'max_tokens',
      'model_context_window_exceeded',
      'tool_use',
      'refusal',
      'pause_turn',
      'load',
      'unload',
      'something_unknown',
    ];

    for (const map of MAPPERS) {
      for (const wire of wireValues) {
        const reason: FinishReason = map(wire);
        expect(FINISH_REASONS).toContain(reason);
      }
    }
  });
});

describe('token-usage mapping', () => {
  describe('OpenAI', () => {
    it('takes the counts the provider reports, including its own total', () => {
      expect(
        mapOpenAiUsage({
          prompt_tokens: 12,
          completion_tokens: 5,
          total_tokens: 17,
        }),
      ).toEqual({ promptTokens: 12, completionTokens: 5, totalTokens: 17 });
    });

    it('sums when the provider omits the total', () => {
      expect(
        mapOpenAiUsage({ prompt_tokens: 12, completion_tokens: 5 }),
      ).toEqual({ promptTokens: 12, completionTokens: 5, totalTokens: 17 });
    });

    it('preserves a reported total that disagrees with the parts', () => {
      // The provider is authoritative for its own billing; a total is only
      // computed where none was reported.
      expect(
        mapOpenAiUsage({
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 20,
        }),
      ).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 20 });
    });
  });

  describe('Anthropic', () => {
    it('sums input and output, which the provider never totals', () => {
      expect(
        mapAnthropicUsage({ input_tokens: 100, output_tokens: 37 }),
      ).toEqual({ promptTokens: 100, completionTokens: 37, totalTokens: 137 });
    });
  });

  describe('Ollama', () => {
    it('sums the prompt-eval and eval counts', () => {
      expect(
        mapOllamaUsage({ prompt_eval_count: 26, eval_count: 298 }),
      ).toEqual({ promptTokens: 26, completionTokens: 298, totalTokens: 324 });
    });
  });

  it('reports zeros rather than undefined when usage is absent', () => {
    // A normalized response always carries numeric counts, so a provider that
    // omits usage yields zeros instead of holes in the client contract.
    const zero = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    expect(mapOpenAiUsage(undefined)).toEqual(zero);
    expect(mapOpenAiUsage(null)).toEqual(zero);
    expect(mapOpenAiUsage({})).toEqual(zero);
    expect(mapAnthropicUsage(undefined)).toEqual(zero);
    expect(mapAnthropicUsage({})).toEqual(zero);
    expect(mapOllamaUsage(undefined)).toEqual(zero);
    expect(mapOllamaUsage({})).toEqual(zero);
  });

  it('treats a partially reported usage as zero for the missing side', () => {
    expect(mapAnthropicUsage({ input_tokens: 40 })).toEqual({
      promptTokens: 40,
      completionTokens: 0,
      totalTokens: 40,
    });
    expect(mapOllamaUsage({ eval_count: 12 })).toEqual({
      promptTokens: 0,
      completionTokens: 12,
      totalTokens: 12,
    });
  });
});
