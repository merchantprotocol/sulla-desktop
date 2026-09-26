import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { modelDiscoveryService } from '../ModelDiscoveryService';

describe('ModelDiscoveryService — Ollama (user-run server)', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('does not invent models when the user\'s Ollama server is unreachable', async() => {
    global.fetch = jest.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'));

    const models = await modelDiscoveryService.fetchModelsForProvider('ollama', 'ollama-unreachable');

    expect(models).toEqual([]);
  });

  it('lists only the models the server reports', async() => {
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
      ok:   true,
      json: () => Promise.resolve({ data: [{ id: 'qwen3:8b' }] }),
    } as unknown as Response);

    const models = await modelDiscoveryService.fetchModelsForProvider('ollama', 'ollama-reachable');

    expect(models).toEqual([{ id: 'qwen3:8b', name: 'qwen3:8b', provider: 'ollama' }]);
  });
});
