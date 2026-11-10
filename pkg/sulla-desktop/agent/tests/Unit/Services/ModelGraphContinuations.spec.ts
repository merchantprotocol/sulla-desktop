// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleService } from '../../../languagemodels/OpenAICompatibleService';
import { GrokService } from '../../../languagemodels/GrokService';
import { providerFetch } from '../../../languagemodels/providerBroker';
import type { ChatMessage } from '../../../languagemodels/BaseLanguageModel';

// Replace process/transport boundaries, not the adapter logic under test.
vi.mock('@pkg/main/cloud/byoUsageSync', () => ({ ByoUsageSync: class {} }));
vi.mock('../../../services/IntegrationService', () => ({ getIntegrationService: vi.fn() }));
vi.mock('@pkg/main/firstRun/firstRunTrace', () => ({ firstRunTrace: vi.fn() }));
vi.mock('../../../languagemodels/providerBroker', () => ({ providerFetch: vi.fn() }));

class ContinuationService extends OpenAICompatibleService {
  constructor() { super({ id: 'grok', model: 'fixture', baseUrl: 'https://example.invalid', apiKey: 'synthetic' }); }
  input(messages: ChatMessage[]): any[] { return this.transformToResponsesAPI(this.buildRequestBody(messages, {})).input; }
  request() { return this.sendRawRequest([{ role: 'user', content: 'fixture' }], {}); }
  stream() { return this.sendStreamRequest([{ role: 'user', content: 'fixture' }], {}); }
}
class SearchService extends GrokService {
  constructor() { super({ id: 'grok', model: 'fixture', baseUrl: 'https://example.invalid', apiKey: 'synthetic' }, false, true); this.setRetryCount(0); }
  stream() { return this.sendStreamRequest([{ role: 'user', content: 'fixture' }], {}); }
}
afterEach(() => vi.restoreAllMocks());

describe('model graph continuation integrity', () => {
  it('keeps complete call/output pairs across eight graph loops', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'fixture' }];
    const service = new ContinuationService();
    for (let i = 0; i < 8; i++) {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `call-${i}`, name: 'read', input: {} }] });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${i}`, content: 'ok' }] });
      const input = service.input(messages);
      expect(input.filter(x => x.type === 'function_call')).toHaveLength(i + 1);
      expect(input.filter(x => x.type === 'function_call_output').map(x => x.call_id)).toEqual(Array.from({ length: i + 1 }, (_, j) => `call-${j}`));
    }
  });
  it('keeps answered parallel calls without sending missing calls or orphan results', () => {
    const input = new ContinuationService().input([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'answered', name: 'read', input: {} }, { type: 'tool_use', id: 'interrupted', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'answered', content: 'ok' }, { type: 'tool_result', tool_use_id: 'orphan', content: 'stale' }] },
    ]);
    expect(input.map(x => [x.type, x.call_id])).toEqual([['function_call', 'answered'], ['function_call_output', 'answered']]);
  });
  it('opts into HTTP bodies so adapter recovery sees status and native-tool rejection', async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })));
    await new ContinuationService().request();
    expect(vi.mocked(providerFetch).mock.calls.at(-1)?.[4]).toMatchObject({ preserveHttpErrors: true });
  });
  it('refreshes once on a streaming 401 before retrying', async () => {
    const service = new ContinuationService();
    service.setRetryCount(1);
    vi.spyOn(service, 'refreshCredentials').mockResolvedValue(true);
    const success = new Response('fixture');
    vi.mocked(providerFetch).mockResolvedValueOnce(new Response('expired', { status: 401 })).mockResolvedValueOnce(success);
    expect(await service.stream()).toBe(success);
    expect(service.refreshCredentials).toHaveBeenCalledTimes(1);
  });
  it('retries streaming native-search rejection without unsupported search tools', async () => {
    const success = new Response('fixture');
    vi.mocked(providerFetch).mockResolvedValueOnce(new Response('unsupported web_search tool', { status: 400 })).mockResolvedValueOnce(success);
    expect(await new SearchService().stream()).toBe(success);
    const calls = vi.mocked(providerFetch).mock.calls.slice(-2);
    expect(JSON.parse(String(calls[0][2].body)).tools.some((x: any) => x.type === 'web_search')).toBe(true);
    expect(JSON.parse(String(calls[1][2].body)).tools ?? []).toEqual([]);
  });
});
