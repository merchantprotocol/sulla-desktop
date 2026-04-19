import { TextDecoder, TextEncoder } from 'node:util';

import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import type { ChatMessage, NormalizedResponse } from '../BaseLanguageModel';

async function loadRemoteModule() {
  return import('../RemoteService');
}

describe('RemoteModelService fallback behavior', () => {
  const originalFetch = global.fetch;

  beforeAll(() => {
    (globalThis as any).TextEncoder = TextEncoder;
    (globalThis as any).TextDecoder = TextDecoder;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('switches to local model when remote retries fail and fallback uses Ollama', async() => {
    const { RemoteModelService } = await loadRemoteModule();

    const localResponse: NormalizedResponse = {
      content:  'local fallback ok',
      metadata: {
        tokens_used:       3,
        time_spent:        1,
        prompt_tokens:     1,
        completion_tokens: 2,
        finish_reason:     'stop' as any,
      },
    };

    const fallbackService = {
      initialize:  jest.fn(async() => true),
      isAvailable: jest.fn(() => true),
      getModel:    jest.fn(() => 'tinyllama:latest'),
      chat:        jest.fn(async() => localResponse),
    };

    global.fetch = jest.fn(async() => {
      throw new Error('remote unavailable');
    }) as typeof fetch;

    const service = new RemoteModelService({
      id:      'grok',
      name:    'grok',
      baseUrl: 'https://api.x.ai/v1',
      apiKey:  'test-key',
      model:   'grok-4-1-fast-reasoning',
    }) as any;
    service.getFallbackLocalService = jest.fn(async() => fallbackService);
    service.setRetryCount(0);

    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const raw = await service.sendRawRequest(messages, {
      model: 'grok-4-1-fast-reasoning',
    });

    expect(fallbackService.chat as any).toHaveBeenCalledWith(
      messages,
      expect.objectContaining({ model: 'tinyllama:latest' }),
    );
    expect(raw.model).toBe('tinyllama:latest');
    expect(raw.choices?.[0]?.message?.content).toBe('local fallback ok');
  });
});
