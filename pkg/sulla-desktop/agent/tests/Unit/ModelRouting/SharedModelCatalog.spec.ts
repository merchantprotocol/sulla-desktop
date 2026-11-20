import { describe, expect, it, vi } from 'vitest';
import { SharedModelCatalogClient } from '../../../languagemodels/sharedModelCatalog';

describe('shared model catalog', () => {
  it('rejects invalid schema and keeps the last-known-good metadata', async() => {
    let saved: any = { fetchedAt: 1, providers: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6-sol', name: 'GPT 6 Sol' }] }] };
    const client = new SharedModelCatalogClient(vi.fn().mockResolvedValue({ ok: true, json: async() => ({ schemaVersion: 99, providers: [] }) }) as any, () => 999999, async() => saved, async(_key, value) => { saved = value; });
    expect(await client.listProviders()).toEqual(saved.providers);
  });

  it('serves persisted metadata offline instead of replacing it with an empty list', async() => {
    const prior = [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6-sol', name: 'GPT 6 Sol' }] }];
    const client = new SharedModelCatalogClient(vi.fn().mockRejectedValue(new Error('offline')) as any, () => 999999, async() => ({ fetchedAt: 1, providers: prior }), async() => undefined);
    expect(await client.listProviders()).toEqual(prior);
  });

  it('uses bundled verified metadata on a first-ever offline launch', async() => {
    const client = new SharedModelCatalogClient(vi.fn().mockRejectedValue(new Error('offline')) as any, () => 1, async() => null, async() => undefined);
    const providers = await client.listProviders();
    expect(providers.find(provider => provider.id === 'openai')?.models.map(model => model.id)).toContain('gpt-6-sol');
  });

  it('coalesces refresh and sends only anonymous metadata requests', async() => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async() => ({ schemaVersion: 1, providers: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6-sol', name: 'GPT 6 Sol' }] }] }) });
    const client = new SharedModelCatalogClient(fetcher as any, () => 10, async() => null, async() => undefined);
    await Promise.all([client.listProviders(), client.listProviders()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0];
    expect(init).toEqual(expect.objectContaining({ method: 'GET', headers: { Accept: 'application/json' } }));
    expect(JSON.stringify(init)).not.toMatch(/authorization|api.?key|token|credential/i); // risk: credentials
  });

  it('stores metadata under its cache key without writing model selections', async() => {
    const setCache = vi.fn();
    const client = new SharedModelCatalogClient(vi.fn().mockResolvedValue({ ok: true, json: async() => ({ schemaVersion: 1, providers: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6-sol', name: 'GPT 6 Sol' }] }] }) }) as any, () => 11, async() => null, setCache);
    await client.listProviders();
    expect(setCache).toHaveBeenCalledWith('sharedModelCatalogCache', expect.any(Object));
    expect(setCache.mock.calls.some(([key]) => /primaryProvider|activeModelId|modelDefaults/i.test(String(key)))).toBe(false);
  });

  it('rejects empty catalogs and duplicate model IDs', async() => {
    const client = new SharedModelCatalogClient(vi.fn() as any, () => 1, async() => null, async() => undefined);
    await expect((client as any).validate({ schemaVersion: 1, providers: [] })).toThrow();
    await expect((client as any).validate({ schemaVersion: 1, providers: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6-sol', name: 'one' }, { id: 'gpt-6-sol', name: 'two' }] }] })).toThrow();
  });
});
