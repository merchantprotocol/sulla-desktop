import { TextDecoder, TextEncoder } from 'node:util';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';

let ConversationSummaryServiceClass: any;

describe('ConversationSummaryService overflow summarization', () => {
  beforeAll(async() => {
    (globalThis as any).TextEncoder = TextEncoder;
    (globalThis as any).TextDecoder = TextDecoder;

    jest.unstable_mockModule('../JsonParseService', () => ({
      parseJson: (input: string) => {
        try {
          return JSON.parse(input);
        } catch {
          return null;
        }
      },
    }));

    const mod = await import('../ConversationSummaryService');
    ConversationSummaryServiceClass = mod.ConversationSummaryService;
  });

  it('prioritizes older messages with higher age score', () => {
    const service = new ConversationSummaryServiceClass();
    const total = 100;

    const olderScore = service.calculateAgeScore(0, total, { role: 'assistant', content: 'old' });
    const newerScore = service.calculateAgeScore(total - 1, total, { role: 'assistant', content: 'new' });

    expect(olderScore).toBeGreaterThan(newerScore);
  });

  it('always summarizes enough overflow messages and includes tool/user/assistant roles', async() => {
    const service = new ConversationSummaryServiceClass();

    const messages: any[] = [{ role: 'system', content: 'system prompt' }];

    for (let i = 0; i < 109; i++) {
      if (i % 3 === 0) {
        messages.push({ role: 'user', content: `user ${ i }` });
      } else if (i % 3 === 1) {
        messages.push({ role: 'assistant', content: `assistant ${ i }` });
      } else {
        messages.push({ role: 'tool', content: `tool ${ i }` });
      }
    }

    const state: any = {
      messages,
      metadata: {
        threadId: 'thread-overflow',
        llmLocal: false,
        llmModel: 'claude-3-haiku',
      },
    };

    let capturedBatch: any[] = [];
    service.summarizeBatch = async(_state: any, batch: any[]) => {
      capturedBatch = batch;
      return [{ priority: '🟡', content: 'compressed summary observation' }];
    };

    await service.performSummarization(state);

    // From 110 messages with no existing summary, service should remove at least 91
    // to bring conversation back within 20 after inserting the summary message.
    expect(capturedBatch.length).toBeGreaterThanOrEqual(91);

    const roles = new Set(capturedBatch.map(m => m.role));
    expect(roles.has('user')).toBe(true);
    expect(roles.has('assistant')).toBe(true);
    expect(roles.has('tool')).toBe(true);

    expect(state.messages.length).toBeLessThanOrEqual(20);
  });

  it('force-trims to max window even when summarizer returns no observations', async() => {
    const service = new ConversationSummaryServiceClass();

    const messages: any[] = [{ role: 'system', content: 'system prompt' }];
    for (let i = 0; i < 40; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${ i }` });
    }

    const state: any = {
      messages,
      metadata: {
        threadId: 'thread-overflow-no-observations',
        llmLocal: false,
        llmModel: 'claude-3-haiku',
      },
    };

    service.summarizeBatch = async() => [];

    await service.performSummarization(state);

    expect(state.messages.length).toBeLessThanOrEqual(20);
    expect(Array.isArray(state.metadata.conversationSummaries)).toBe(true);
    expect(state.metadata.conversationSummaries.length).toBeGreaterThan(0);
    expect((state.messages[0]?.metadata)?._conversationSummary).toBe(true);
  });
});
