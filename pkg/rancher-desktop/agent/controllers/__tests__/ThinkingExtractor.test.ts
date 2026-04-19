import { describe, expect, it, jest } from '@jest/globals';

import { ThinkingExtractor } from '../ThinkingExtractor';

import type { NormalizedResponse } from '../../languagemodels/BaseLanguageModel';
import type { StreamContext } from '../Extractor';

function makeCtx(): StreamContext {
  return {
    state:    { messages: [], metadata: { threadId: 't1', wsChannel: 'test' } } as any,
    threadId: 't1',
    channel:  'test',
  };
}

function makeReply(content: string, reasoning?: string): NormalizedResponse {
  return {
    content,
    metadata: { reasoning: reasoning ?? '' },
  } as NormalizedResponse;
}

describe('ThinkingExtractor', () => {
  it('enrichPrompt is a no-op', () => {
    const send = jest.fn(async() => true) as any;
    const ext = new ThinkingExtractor(send);
    const result = ext.enrichPrompt('system prompt', makeCtx());

    expect(result).toBe('system prompt');
  });

  it('processChunk is a pass-through', () => {
    const send = jest.fn(async() => true) as any;
    const ext = new ThinkingExtractor(send);
    const result = ext.processChunk('hello', makeCtx());

    expect(result).toBe('hello');
  });

  it('extracts <thinking> tags and dispatches as thinking message', () => {
    const send = jest.fn(async() => true) as any;
    const ext = new ThinkingExtractor(send);
    const reply = makeReply('Before <thinking>internal reasoning here</thinking> After');

    const cleaned = ext.processComplete(reply, makeCtx());

    expect(cleaned).toBe('Before  After');
    expect(reply.content).toBe('Before  After');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      'internal reasoning here',
      'assistant',
      'thinking',
    );
  });

  it('extracts Anthropic reasoning metadata', () => {
    const send = jest.fn(async() => true) as any;
    const ext = new ThinkingExtractor(send);
    const reply = makeReply('Clean response', 'Model reasoning text');

    ext.processComplete(reply, makeCtx());

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      'Model reasoning text',
      'assistant',
      'thinking',
    );
  });

  it('combines reasoning metadata and <thinking> tags', () => {
    const send = jest.fn(async() => true) as any;
    const ext = new ThinkingExtractor(send);
    const reply = makeReply(
      'Content <thinking>tag reasoning</thinking> more',
      'metadata reasoning',
    );

    const cleaned = ext.processComplete(reply, makeCtx());

    expect(cleaned).toBe('Content  more');
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      'metadata reasoning\ntag reasoning',
      'assistant',
      'thinking',
    );
  });

  it('does nothing when no thinking content is present', () => {
    const send = jest.fn(async() => true) as any;
    const ext = new ThinkingExtractor(send);
    const reply = makeReply('Just a normal response');

    const cleaned = ext.processComplete(reply, makeCtx());

    expect(cleaned).toBe('Just a normal response');
    expect(send).not.toHaveBeenCalled();
  });

  it('handles multiple <thinking> tags', () => {
    const send = jest.fn(async() => true) as any;
    const ext = new ThinkingExtractor(send);
    const reply = makeReply('<thinking>first</thinking> middle <thinking>second</thinking> end');

    const cleaned = ext.processComplete(reply, makeCtx());

    expect(cleaned).toBe('middle  end');
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      'first\nsecond',
      'assistant',
      'thinking',
    );
  });

  it('reset is safe to call', () => {
    const send = jest.fn(async() => true) as any;
    const ext = new ThinkingExtractor(send);

    expect(() => ext.reset()).not.toThrow();
  });
});
