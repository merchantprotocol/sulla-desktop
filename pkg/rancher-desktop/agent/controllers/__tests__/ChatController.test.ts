import { describe, expect, it, jest, beforeEach } from '@jest/globals';

import { ChatController, type ChatControllerConfig } from '../ChatController';

import type { NormalizedResponse } from '../../languagemodels/BaseLanguageModel';
import type { StreamContext } from '../Extractor';

function makeConfig(): ChatControllerConfig {
  return {
    dispatch:          jest.fn(async() => true) as any,
    sendChatMessage:   jest.fn(async() => true) as any,
    voiceLog:          jest.fn() as any,
    onSecretaryResult: jest.fn(),
  };
}

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

describe('ChatController', () => {
  let config: ChatControllerConfig;
  let ctrl: ChatController;

  beforeEach(() => {
    config = makeConfig();
    ctrl = new ChatController(config);
  });

  // ── Mode management ──

  it('defaults to text mode', () => {
    expect(ctrl.getMode()).toBe('text');
  });

  it('setMode changes mode and extractors', () => {
    ctrl.setMode('voice');
    expect(ctrl.getMode()).toBe('voice');

    const names = ctrl.getExtractors().map(e => e.name);

    expect(names).toContain('thinking');
    expect(names).toContain('speak');
  });

  it('text mode has only ThinkingExtractor', () => {
    ctrl.setMode('text');
    const names = ctrl.getExtractors().map(e => e.name);

    expect(names).toEqual(['thinking']);
  });

  it('voice mode has ThinkingExtractor and SpeakExtractor', () => {
    ctrl.setMode('voice');
    const names = ctrl.getExtractors().map(e => e.name);

    expect(names).toEqual(['thinking', 'speak']);
  });

  it('secretary mode has ThinkingExtractor and SecretaryExtractor', () => {
    ctrl.setMode('secretary');
    const names = ctrl.getExtractors().map(e => e.name);

    expect(names).toEqual(['thinking', 'secretary']);
  });

  it('intake mode has ThinkingExtractor and IntakeExtractor', () => {
    ctrl.setMode('intake');
    const names = ctrl.getExtractors().map(e => e.name);

    expect(names).toEqual(['thinking', 'intake']);
  });

  it('setMode is idempotent', () => {
    ctrl.setMode('voice');
    const extractors1 = ctrl.getExtractors();

    ctrl.setMode('voice');
    const extractors2 = ctrl.getExtractors();

    expect(extractors1).toBe(extractors2); // Same array reference
  });

  // ── enrichPrompt ──

  it('enrichPrompt in text mode returns prompt unchanged (thinking is no-op)', () => {
    ctrl.setMode('text');
    const result = ctrl.enrichPrompt('base', makeCtx());

    expect(result).toBe('base');
  });

  it('enrichPrompt in voice mode appends voice prompt', () => {
    ctrl.setMode('voice');
    const result = ctrl.enrichPrompt('base', makeCtx());

    expect(result).toContain('base');
    expect(result.length).toBeGreaterThan('base'.length);
  });

  it('enrichPrompt in secretary mode appends secretary prompt', () => {
    ctrl.setMode('secretary');
    const result = ctrl.enrichPrompt('base', makeCtx());

    expect(result.length).toBeGreaterThan('base'.length);
  });

  it('enrichPrompt in intake mode appends intake prompt', () => {
    ctrl.setMode('intake');
    const result = ctrl.enrichPrompt('base', makeCtx());

    expect(result.length).toBeGreaterThan('base'.length);
  });

  // ── processChunk ──

  it('processChunk in text mode passes through', () => {
    ctrl.setMode('text');
    const result = ctrl.processChunk('hello', makeCtx());

    expect(result).toBe('hello');
  });

  // ── processComplete ──

  it('processComplete in text mode extracts thinking tags', () => {
    ctrl.setMode('text');
    const reply = makeReply('<thinking>internal</thinking> visible text');

    const cleaned = ctrl.processComplete(reply, makeCtx());

    expect(cleaned).toBe('visible text');
    expect(config.sendChatMessage).toHaveBeenCalledWith(
      expect.anything(),
      'internal',
      'assistant',
      'thinking',
    );
  });

  it('processComplete in voice mode extracts thinking and speak tags', () => {
    ctrl.setMode('voice');
    const reply = makeReply('<thinking>reason</thinking> <speak>spoken</speak> text');

    const cleaned = ctrl.processComplete(reply, makeCtx());

    // ThinkingExtractor strips <thinking>, SpeakExtractor strips <speak>
    expect(cleaned).not.toContain('<thinking>');
    expect(cleaned).not.toContain('<speak>');
    expect(config.sendChatMessage).toHaveBeenCalled(); // thinking dispatched
  });

  it('processComplete in secretary mode strips speak tags and extracts analysis', () => {
    ctrl.setMode('secretary');
    const reply = makeReply(
      '<secretary_analysis><actions>- Test action</actions></secretary_analysis> ' +
      '<speak>accidental</speak> text',
    );

    const cleaned = ctrl.processComplete(reply, makeCtx());

    expect(cleaned).not.toContain('<speak>');
    expect(config.onSecretaryResult).toHaveBeenCalledWith(
      expect.objectContaining({ actions: ['Test action'] }),
    );
  });

  // ── processNonVoiceSpeak ──

  it('processNonVoiceSpeak extracts speak tags from non-voice response', () => {
    ctrl.setMode('text');
    const reply = makeReply('Text <speak>spoken</speak> rest');

    ctrl.processNonVoiceSpeak(reply, makeCtx());

    expect(reply.content).toBe('Text  rest');
    expect(config.dispatch).toHaveBeenCalledWith(
      expect.anything(),
      'speak_dispatch',
      expect.objectContaining({ text: 'spoken' }),
    );
  });

  // ── reset ──

  it('reset does not throw', () => {
    ctrl.setMode('voice');

    expect(() => ctrl.reset()).not.toThrow();
  });

  // ── buildContext ──

  it('buildContext creates context from state', () => {
    const state = {
      messages: [],
      metadata: { threadId: 'thread-123', wsChannel: 'chan-456' },
    } as any;

    const ctx = ctrl.buildContext(state);

    expect(ctx.state).toBe(state);
    expect(ctx.threadId).toBe('thread-123');
    expect(ctx.channel).toBe('chan-456');
  });

  it('buildContext defaults channel to workbench', () => {
    const state = {
      messages: [],
      metadata: { threadId: 'thread-123' },
    } as any;

    const ctx = ctrl.buildContext(state);

    expect(ctx.channel).toBe('workbench');
  });
});
