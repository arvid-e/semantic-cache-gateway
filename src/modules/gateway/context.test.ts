import {
  createDefaultContext,
  type RequestContext,
} from '#src/platform/context/types.js';
import { populateCompletionContext } from './context.js';
import type { ChatCompletionRequest, ChatMessage } from './types.js';

/** A multi-turn conversation: two user turns around one assistant reply. */
const conversation: ChatCompletionRequest = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
  messages: [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'What is pgvector?' },
    { role: 'assistant', content: 'A Postgres extension for vectors.' },
    { role: 'user', content: 'And how do I index it?' },
  ],
  temperature: 0.2,
  maxTokens: 256,
  topP: 0.9,
  stop: ['\n\n'],
};

/** The request shape at its minimum: no optional generation parameters. */
const minimal: ChatCompletionRequest = {
  provider: 'ollama',
  model: 'llama3.1',
  messages: [{ role: 'user', content: 'hi' }],
};

function populate(request: ChatCompletionRequest): RequestContext {
  const ctx = createDefaultContext();
  populateCompletionContext(ctx, request);
  return ctx;
}

describe('conversation context defaults', () => {
  it('starts at defined defaults, never undefined', () => {
    const ctx = createDefaultContext();

    // The fields exist on a fresh context because the foundation's factory
    // defaults them; a stage reading before population gets a zero value, not
    // `undefined`.
    expect(ctx.messages).toEqual([]);
    expect(ctx.latestUserMessage).toBeNull();
    expect(ctx.lastAssistantMessage).toBeNull();
  });

  it('gives each context its own message list', () => {
    const first = createDefaultContext();
    const second = createDefaultContext();

    first.messages.push({ role: 'user', content: 'leaked?' });

    expect(second.messages).toEqual([]);
  });
});

describe('populateCompletionContext', () => {
  it('records the routing decision', () => {
    const ctx = populate(conversation);

    expect(ctx.provider).toBe('anthropic');
    expect(ctx.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('records the generation parameters in the agnostic vocabulary', () => {
    const ctx = populate(conversation);

    expect(ctx.params).toEqual({
      temperature: 0.2,
      maxTokens: 256,
      topP: 0.9,
      stop: ['\n\n'],
    });
  });

  it('omits parameters the client did not send', () => {
    const ctx = populate(minimal);

    // Absent rather than present-and-undefined, so a reader can tell the
    // difference between "not sent" and "sent as undefined".
    expect(ctx.params).toEqual({});
    expect(Object.keys(ctx.params)).toHaveLength(0);
  });

  it('surfaces the full conversation in order', () => {
    const ctx = populate(conversation);

    // The whole message list, not just the latest turn.
    expect(ctx.messages).toEqual(conversation.messages);
    expect(ctx.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });

  it('derives the latest user turn, not the first', () => {
    const ctx = populate(conversation);

    expect(ctx.latestUserMessage).toEqual<ChatMessage>({
      role: 'user',
      content: 'And how do I index it?',
    });
  });

  it('derives the last assistant turn', () => {
    const ctx = populate(conversation);

    expect(ctx.lastAssistantMessage).toEqual<ChatMessage>({
      role: 'assistant',
      content: 'A Postgres extension for vectors.',
    });
  });

  it('derives the last assistant turn from several', () => {
    const ctx = populate({
      ...conversation,
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'first reply' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'second reply' },
        { role: 'user', content: 'three' },
      ],
    });

    expect(ctx.latestUserMessage?.content).toBe('three');
    expect(ctx.lastAssistantMessage?.content).toBe('second reply');
  });

  it('leaves a first-turn conversation without a previous assistant reply', () => {
    const ctx = populate(minimal);

    expect(ctx.latestUserMessage).toEqual<ChatMessage>({
      role: 'user',
      content: 'hi',
    });
    // Null, not a fabricated empty turn: caching must be able to tell that
    // there is no prior response to verify a context chain against.
    expect(ctx.lastAssistantMessage).toBeNull();
  });

  it('leaves both derived turns null when the conversation has neither role', () => {
    const ctx = populate({
      ...conversation,
      messages: [{ role: 'system', content: 'You are terse.' }],
    });

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.latestUserMessage).toBeNull();
    expect(ctx.lastAssistantMessage).toBeNull();
  });

  it('leaves fields owned by later stages at their defaults', () => {
    const ctx = populate(conversation);
    const fresh = createDefaultContext();

    // Population happens before the provider call and before any cache,
    // resilience, or telemetry stage runs, so their fields must be untouched
    //. Token usage and latency are set by the completion service only
    // after the provider answers.
    expect(ctx.tokenUsage).toEqual(fresh.tokenUsage);
    expect(ctx.latencyMs).toBeNull();
    expect(ctx.cacheStatus).toBe('unknown');
    expect(ctx.failover).toEqual(fresh.failover);
    expect(ctx.breakerState).toBe('closed');
  });

  it('does not touch the tenant auth already resolved', () => {
    const ctx = createDefaultContext();
    ctx.tenantId = 'tenant-a';

    populateCompletionContext(ctx, conversation);

    expect(ctx.tenantId).toBe('tenant-a');
  });

  it('exposes the conversation without interpreting it', () => {
    const repetitive: ChatMessage[] = [
      { role: 'user', content: 'same' },
      { role: 'user', content: 'same' },
      { role: 'user', content: 'totally different topic' },
    ];

    const ctx = populate({ ...conversation, messages: repetitive });

    // No deduplication, truncation, summarization, or topic-shift verdict: the
    // list is passed through verbatim and cacheStatus stays unclassified, since
    // `dual-layer-caching` owns every such decision.
    expect(ctx.messages).toEqual(repetitive);
    expect(ctx.cacheStatus).toBe('unknown');
  });

  it('detaches the context from the request body', () => {
    const request: ChatCompletionRequest = {
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      stop: ['\n'],
    };

    const ctx = populate(request);
    ctx.messages.push({ role: 'assistant', content: 'appended later' });
    (ctx.params.stop as string[]).push('###');

    // The context outlives the handler that owns the body; a later stage
    // mutating what it read must not rewrite the request.
    expect(request.messages).toHaveLength(1);
    expect(request.stop).toEqual(['\n']);
  });

  it('writes nothing beyond the context fields it owns', () => {
    const before = Object.keys(createDefaultContext()).sort();
    const ctx = populate(conversation);

    expect(Object.keys(ctx).sort()).toEqual(before);
  });
});
