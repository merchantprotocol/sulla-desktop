import { describe, expect, it, jest } from '@jest/globals';

import { SecretaryExtractor, type SecretaryAnalysis } from '../SecretaryExtractor';

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

describe('SecretaryExtractor', () => {
  it('enrichPrompt appends SECRETARY_MODE_PROMPT', () => {
    const onResult = jest.fn();
    const ext = new SecretaryExtractor(onResult);
    const result = ext.enrichPrompt('base prompt', makeCtx());

    expect(result).toContain('base prompt');
    expect(result.length).toBeGreaterThan('base prompt'.length);
  });

  it('processChunk is a pass-through', () => {
    const onResult = jest.fn();
    const ext = new SecretaryExtractor(onResult);
    const result = ext.processChunk('chunk', makeCtx());

    expect(result).toBe('chunk');
  });

  it('extracts secretary_analysis block and calls onResult', () => {
    const onResult = jest.fn();
    const ext = new SecretaryExtractor(onResult);
    const reply = makeReply(
      'Some text <secretary_analysis>' +
      '<actions>- Schedule meeting\n- Send email</actions>' +
      '<facts>- User mentioned deadline Friday\n- Budget is $10k</facts>' +
      '<conclusions>- Project is on track</conclusions>' +
      '</secretary_analysis> trailing text',
    );

    ext.processComplete(reply, makeCtx());

    expect(onResult).toHaveBeenCalledTimes(1);
    const result = onResult.mock.calls[0][0] as SecretaryAnalysis;

    expect(result.actions).toEqual(['Schedule meeting', 'Send email']);
    expect(result.facts).toEqual(['User mentioned deadline Friday', 'Budget is $10k']);
    expect(result.conclusions).toEqual(['Project is on track']);
  });

  it('handles missing sections gracefully', () => {
    const onResult = jest.fn();
    const ext = new SecretaryExtractor(onResult);
    const reply = makeReply(
      '<secretary_analysis>' +
      '<actions>- Do something</actions>' +
      '</secretary_analysis>',
    );

    ext.processComplete(reply, makeCtx());

    expect(onResult).toHaveBeenCalledTimes(1);
    const result = onResult.mock.calls[0][0] as SecretaryAnalysis;

    expect(result.actions).toEqual(['Do something']);
    expect(result.facts).toEqual([]);
    expect(result.conclusions).toEqual([]);
  });

  it('does not call onResult when no analysis block exists', () => {
    const onResult = jest.fn();
    const ext = new SecretaryExtractor(onResult);
    const reply = makeReply('Just a normal response without analysis');

    ext.processComplete(reply, makeCtx());

    expect(onResult).not.toHaveBeenCalled();
  });

  it('strips accidental <speak> tags', () => {
    const onResult = jest.fn();
    const ext = new SecretaryExtractor(onResult);
    const reply = makeReply('Response <speak>oops</speak> text');

    const cleaned = ext.processComplete(reply, makeCtx());

    expect(cleaned).toBe('Response  text');
    expect(reply.content).toBe('Response  text');
  });

  it('handles bullet styles: dash, asterisk, bullet', () => {
    const onResult = jest.fn();
    const ext = new SecretaryExtractor(onResult);
    const reply = makeReply(
      '<secretary_analysis>' +
      '<actions>- dash item\n* asterisk item\n• bullet item</actions>' +
      '</secretary_analysis>',
    );

    ext.processComplete(reply, makeCtx());

    const result = onResult.mock.calls[0][0] as SecretaryAnalysis;

    expect(result.actions).toEqual(['dash item', 'asterisk item', 'bullet item']);
  });

  it('reset is safe to call', () => {
    const onResult = jest.fn();
    const ext = new SecretaryExtractor(onResult);

    expect(() => ext.reset()).not.toThrow();
  });
});
