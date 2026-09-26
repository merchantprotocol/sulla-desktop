import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { OllamaModels } from '../OllamaModels';
import { getSelectBoxProvider } from '../index';

const ctx = (formValues: Record<string, string>) => ({ integrationId: 'ollama', accountId: 'default', formValues });

describe('OllamaModels', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('is registered under the id the Ollama integration form uses', () => {
    expect(getSelectBoxProvider('ollama_models')).toBeInstanceOf(OllamaModels);
  });

  it('lists the models reported by the user-configured server', async() => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
      ok:   true,
      json: () => Promise.resolve({ data: [{ id: 'llama3.2:latest' }, { id: 'qwen3:8b' }] }),
    } as unknown as Response);
    global.fetch = fetchMock;

    const options = await new OllamaModels().getOptions(ctx({ base_url: 'http://10.0.0.5:11434/v1/' }));

    expect(fetchMock).toHaveBeenCalledWith('http://10.0.0.5:11434/v1/models', { headers: {} });
    expect(options).toEqual([
      { value: 'llama3.2:latest', label: 'llama3.2:latest' },
      { value: 'qwen3:8b', label: 'qwen3:8b' },
    ]);
  });

  it('returns nothing (no invented models) without a base URL or when the server is unreachable', async() => {
    expect(await new OllamaModels().getOptions(ctx({}))).toEqual([]);

    global.fetch = jest.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await new OllamaModels().getOptions(ctx({ base_url: 'http://localhost:11434/v1' }))).toEqual([]);
  });
});
