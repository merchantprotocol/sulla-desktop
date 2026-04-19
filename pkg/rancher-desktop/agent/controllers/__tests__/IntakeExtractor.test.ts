import { describe, expect, it } from '@jest/globals';

import { IntakeExtractor } from '../IntakeExtractor';

import type { NormalizedResponse } from '../../languagemodels/BaseLanguageModel';
import type { StreamContext } from '../Extractor';

function makeCtx(): StreamContext {
  return {
    state:    { messages: [], metadata: { threadId: 't1', wsChannel: 'test' } } as any,
    threadId: 't1',
    channel:  'test',
  };
}

function makeReply(content: string): NormalizedResponse {
  return { content, metadata: {} } as NormalizedResponse;
}

describe('IntakeExtractor', () => {
  it('enrichPrompt appends INTAKE_MODE_PROMPT', () => {
    const ext = new IntakeExtractor();
    const result = ext.enrichPrompt('base prompt', makeCtx());

    expect(result).toContain('base prompt');
    expect(result.length).toBeGreaterThan('base prompt'.length);
  });

  it('processChunk is a pass-through', () => {
    const ext = new IntakeExtractor();
    const result = ext.processChunk('hello', makeCtx());

    expect(result).toBe('hello');
  });

  it('strips accidental <speak> tags from content', () => {
    const ext = new IntakeExtractor();
    const reply = makeReply('Response <speak>should not speak</speak> rest');

    const cleaned = ext.processComplete(reply, makeCtx());

    expect(cleaned).toBe('Response  rest');
    expect(reply.content).toBe('Response  rest');
  });

  it('leaves content unchanged when no speak tags', () => {
    const ext = new IntakeExtractor();
    const reply = makeReply('Normal response text');

    const cleaned = ext.processComplete(reply, makeCtx());

    expect(cleaned).toBe('Normal response text');
  });

  it('handles multiple speak tags', () => {
    const ext = new IntakeExtractor();
    const reply = makeReply('<speak>a</speak> middle <speak>b</speak>');

    const cleaned = ext.processComplete(reply, makeCtx());

    expect(cleaned).toBe('middle');
  });

  it('reset is safe to call', () => {
    const ext = new IntakeExtractor();

    expect(() => ext.reset()).not.toThrow();
  });
});
