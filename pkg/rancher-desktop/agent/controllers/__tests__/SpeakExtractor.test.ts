import { describe, expect, it, jest, beforeEach } from '@jest/globals';

import { SpeakExtractor } from '../SpeakExtractor';

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

describe('SpeakExtractor', () => {
  let dispatch: jest.Mock;
  let voiceLog: jest.Mock;
  let ext: SpeakExtractor;

  beforeEach(() => {
    dispatch = jest.fn(async() => true);
    voiceLog = jest.fn();
    ext = new SpeakExtractor(dispatch as any, voiceLog as any);
  });

  // ── enrichPrompt ──

  it('enrichPrompt appends VOICE_MODE_PROMPT', () => {
    const result = ext.enrichPrompt('base', makeCtx());

    expect(result).toContain('base');
    expect(result.length).toBeGreaterThan('base'.length);
  });

  // ── processChunk: pass-through when no speak tags ──

  it('processChunk passes through text without speak tags', () => {
    const result = ext.processChunk('hello world', makeCtx());

    expect(result).toBe('hello world');
  });

  // ── processChunk: detects <speak> tags ──

  it('processChunk detects <speak> opening and suppresses output', () => {
    const ctx = makeCtx();
    const r1 = ext.processChunk('before <speak>hello', ctx);

    // Text before the tag passes through; speak content is suppressed
    expect(r1).toBe('before ');
    expect(ext.processChunk(' world', ctx)).toBe('');
  });

  it('processChunk dispatches on </speak> close', () => {
    const ctx = makeCtx();

    ext.processChunk('<speak>Hello world', ctx);
    ext.processChunk('</speak>', ctx);

    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      'speak_dispatch',
      expect.objectContaining({ text: 'Hello world' }),
    );
  });

  it('processChunk handles complete speak tag in single chunk', () => {
    const ctx = makeCtx();

    ext.processChunk('<speak>One sentence.</speak>', ctx);

    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      'speak_dispatch',
      expect.objectContaining({ text: 'One sentence.' }),
    );
  });

  // ── processChunk: sentence splitting ──

  it('dispatches complete sentences during streaming', () => {
    const ctx = makeCtx();

    // Feed a long sentence that ends with ". " followed by more text
    ext.processChunk('<speak>This is a complete sentence that is long enough. And here is more text', ctx);

    // Should have dispatched the first sentence
    const speakCalls = dispatch.mock.calls.filter(
      (c: any) => c[1] === 'speak_dispatch',
    );

    expect(speakCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── Regressions: every spoken sentence is dispatched exactly once ──

  function spoken(): string[] {
    return dispatch.mock.calls.filter((c: any) => c[1] === 'speak_dispatch').map((c: any) => c[2].text);
  }

  function stream(text: string, ctx: StreamContext, size = 3): string {
    let out = '';

    for (let i = 0; i < text.length; i += size) out += ext.processChunk(text.slice(i, i + size), ctx);

    return out;
  }

  it('does not re-speak sentences already dispatched when </speak> closes', () => {
    const ctx = makeCtx();

    stream('<speak>This first sentence is long enough. And this is the second one.</speak>', ctx);

    expect(spoken()).toEqual(['This first sentence is long enough.', 'And this is the second one.']);
  });

  it('does not re-open a closed block on later tokens', () => {
    const ctx = makeCtx();
    const out = stream('<speak>Short reply here.</speak> Then a long written explanation follows in the chat.', ctx);

    expect(spoken()).toEqual(['Short reply here.']);
    expect(out).toBe(' Then a long written explanation follows in the chat.');
  });

  it('speaks each of several speak blocks once, in order', () => {
    const ctx = makeCtx();

    stream('<speak>On it, checking now.</speak> details <speak>Found it in the logs.</speak>', ctx, 2);

    expect(spoken()).toEqual(['On it, checking now.', 'Found it in the logs.']);
  });

  it('detects tags split across tokens', () => {
    const ctx = makeCtx();

    ['<sp', 'eak>Hello th', 'ere</spe', 'ak>'].forEach(c => ext.processChunk(c, ctx));

    expect(spoken()).toEqual(['Hello there']);
  });

  it('flushes an unclosed block once at completion', () => {
    const ctx = makeCtx();

    stream('<speak>This first sentence is long enough. Trailing words', ctx);
    ext.processComplete(makeReply('<speak>This first sentence is long enough. Trailing words'), ctx);

    expect(spoken()).toEqual(['This first sentence is long enough.', 'Trailing words']);
  });

  // ── processComplete: strips speak tags from final content ──

  it('processComplete strips <speak> tags from reply content', () => {
    const reply = makeReply('Before <speak>spoken text</speak> After');

    const cleaned = ext.processComplete(reply, makeCtx());

    expect(cleaned).toBe('Before  After');
    expect(reply.content).toBe('Before  After');
  });

  it('processComplete flushes remaining buffer', () => {
    const ctx = makeCtx();

    // Start a speak tag without closing it during streaming
    ext.processChunk('<speak>buffered text', ctx);
    // processComplete should flush what's left
    const reply = makeReply('<speak>buffered text</speak>');

    ext.processComplete(reply, ctx);

    // Should have dispatched the buffered text
    const speakCalls = dispatch.mock.calls.filter(
      (c: any) => c[1] === 'speak_dispatch',
    );

    expect(speakCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── extractAndDispatchFromComplete ──

  it('extractAndDispatchFromComplete extracts speak tags from completed response', () => {
    const reply = makeReply('Text <speak>spoken part</speak> more text');

    ext.extractAndDispatchFromComplete(reply, makeCtx());

    expect(reply.content).toBe('Text  more text');
    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      'speak_dispatch',
      expect.objectContaining({ text: 'spoken part' }),
    );
  });

  it('extractAndDispatchFromComplete does nothing when no speak tags', () => {
    const reply = makeReply('Plain text response');

    ext.extractAndDispatchFromComplete(reply, makeCtx());

    expect(reply.content).toBe('Plain text response');
    expect(dispatch).not.toHaveBeenCalled();
  });

  // ── reset ──

  it('reset clears internal state', () => {
    const ctx = makeCtx();

    // Build up some internal state
    ext.processChunk('<speak>partial', ctx);
    ext.reset();

    // After reset, should behave as fresh — pass through text
    const result = ext.processChunk('normal text', makeCtx());

    expect(result).toBe('normal text');
  });
});
