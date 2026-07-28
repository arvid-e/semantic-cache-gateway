import type { FinishReason, NormalizedUsage } from '../types.js';

/**
 * Shared normalization helpers for the provider adapters.
 *
 * Each provider names its stop reason and token counts differently, and two of
 * the three report no total at all. These helpers hold that per-provider wire
 * knowledge in one place so the adapters stay thin translators and the same
 * `finish_reason` never means two things in the client contract (Req 4.1).
 *
 * Every mapper is total and closed: any unrecognized, empty, or absent reason
 * becomes `'other'`, so a provider adding a stop reason can never widen the
 * `FinishReason` union or throw inside an adapter. This is the module to edit
 * when a provider introduces a new reason — not the union in `types.ts`.
 */

/**
 * OpenAI chat-completion `finish_reason` values. `function_call` is the
 * deprecated predecessor of `tool_calls` and still appears from older
 * deployments; both mean the model stopped to call something.
 */
const OPENAI_FINISH_REASONS: Readonly<Record<string, FinishReason>> = {
  stop: 'stop',
  length: 'length',
  content_filter: 'content_filter',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
};

/**
 * Anthropic Messages `stop_reason` values.
 *
 * `stop_sequence` is a *normal* completion — the model emitted a configured
 * stop string — so it maps to `stop`, not to a truncation.
 * `model_context_window_exceeded` is a length limit like `max_tokens`, just hit
 * against the context window rather than the output cap. `refusal` is the
 * closest thing Anthropic has to a content filter. `pause_turn` means a
 * server-side tool loop paused mid-turn: neither finished nor truncated, so it
 * falls to `other` rather than being misreported as a completion.
 */
const ANTHROPIC_STOP_REASONS: Readonly<Record<string, FinishReason>> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  tool_use: 'tool_use',
  refusal: 'content_filter',
  pause_turn: 'other',
};

/**
 * Ollama `/api/chat` `done_reason` values. `load` and `unload` report model
 * lifecycle events rather than why generation ended, so they carry no
 * completion meaning and map to `other`.
 */
const OLLAMA_DONE_REASONS: Readonly<Record<string, FinishReason>> = {
  stop: 'stop',
  length: 'length',
  load: 'other',
  unload: 'other',
};

/** Look a wire value up in a provider's table, defaulting to `other`. */
function lookup(
  table: Readonly<Record<string, FinishReason>>,
  reason: string | null | undefined,
): FinishReason {
  if (reason === null || reason === undefined) return 'other';
  return table[reason] ?? 'other';
}

/** Map an OpenAI `finish_reason` onto the normalized union. */
export function mapOpenAiFinishReason(
  reason: string | null | undefined,
): FinishReason {
  return lookup(OPENAI_FINISH_REASONS, reason);
}

/** Map an Anthropic `stop_reason` onto the normalized union. */
export function mapAnthropicStopReason(
  reason: string | null | undefined,
): FinishReason {
  return lookup(ANTHROPIC_STOP_REASONS, reason);
}

/** Map an Ollama `done_reason` onto the normalized union. */
export function mapOllamaDoneReason(
  reason: string | null | undefined,
): FinishReason {
  return lookup(OLLAMA_DONE_REASONS, reason);
}

/** A count a provider may omit or report as null. */
type ReportedCount = number | null | undefined;

/** Absent counts become `0`, so the normalized usage is always numeric. */
function count(value: ReportedCount): number {
  return value ?? 0;
}

/**
 * Assemble normalized usage, computing the total only when the provider
 * reported none. A provider that does report a total keeps it even if it
 * disagrees with the parts — it is authoritative for its own accounting.
 */
function toUsage(
  promptTokens: number,
  completionTokens: number,
  reportedTotal: ReportedCount,
): NormalizedUsage {
  return {
    promptTokens,
    completionTokens,
    totalTokens: reportedTotal ?? promptTokens + completionTokens,
  };
}

/** Normalize OpenAI's `usage`, the one provider that reports its own total. */
export function mapOpenAiUsage(
  usage:
    | {
        prompt_tokens?: ReportedCount;
        completion_tokens?: ReportedCount;
        total_tokens?: ReportedCount;
      }
    | null
    | undefined,
): NormalizedUsage {
  return toUsage(
    count(usage?.prompt_tokens),
    count(usage?.completion_tokens),
    usage?.total_tokens,
  );
}

/** Normalize Anthropic's `usage`; it reports no total, so one is computed. */
export function mapAnthropicUsage(
  usage:
    | { input_tokens?: ReportedCount; output_tokens?: ReportedCount }
    | null
    | undefined,
): NormalizedUsage {
  return toUsage(count(usage?.input_tokens), count(usage?.output_tokens), null);
}

/**
 * Normalize Ollama's counts. They sit on the response itself rather than in a
 * `usage` object, and there is no total, so one is computed.
 */
export function mapOllamaUsage(
  response:
    | { prompt_eval_count?: ReportedCount; eval_count?: ReportedCount }
    | null
    | undefined,
): NormalizedUsage {
  return toUsage(
    count(response?.prompt_eval_count),
    count(response?.eval_count),
    null,
  );
}
