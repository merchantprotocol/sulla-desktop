import { describe, expect, it, vi } from 'vitest';
import { SharedModelCatalogClient } from '../../../languagemodels/sharedModelCatalog';

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('shared model catalog', () => {
  it('rejects invalid schema and keeps the last-known-good metadata', async() => {
    let saved: any = { fetchedAt: 1, providers: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6-sol', name: 'GPT 6 Sol' }] }] };
    const client = new SharedModelCatalogClient(vi.fn().mockResolvedValue(jsonResponse({ schemaVersion: 99, providers: [] })) as any, () => 999999, async() => saved, async(_key, value) => { saved = value; });
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

  it('accepts Cloudflare model identifiers and rejects providers without models', async() => {
    const client = new SharedModelCatalogClient(vi.fn() as any, () => 1, async() => null, async() => undefined);
    expect((client as any).validate({ schemaVersion: 1, providers: [{ id: 'workers-ai', name: 'Cloudflare', models: [{ id: '@cf/openai/gpt-oss-120b', name: 'gpt-oss-120b' }] }] }).providers[0].models[0].id).toBe('@cf/openai/gpt-oss-120b');
    expect(() => (client as any).validate({ schemaVersion: 1, providers: [{ id: 'openai', name: 'OpenAI', models: [] }] })).toThrow();
  });

  it('returns bundled data if settings cache reads reject', async() => {
    const client = new SharedModelCatalogClient(vi.fn().mockRejectedValue(new Error('offline')) as any, () => 1, async() => { throw new Error('settings unavailable'); }, async() => undefined);
    expect((await client.listProviders()).some(provider => provider.id === 'openai')).toBe(true);
  });

  it('does not fetch for fresh cache reads', async() => {
    const fetcher = vi.fn();
    const cached = [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6-sol', name: 'GPT 6 Sol' }] }];
    const client = new SharedModelCatalogClient(fetcher as any, () => 200, async() => ({ fetchedAt: 100, providers: cached }), async() => undefined);
    expect(await client.listProviders()).toEqual(cached);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('coalesces refresh and sends only anonymous metadata requests', async() => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ schemaVersion: 1, providers: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6-sol', name: 'GPT 6 Sol' }] }] }));
    const client = new SharedModelCatalogClient(fetcher as any, () => 10, async() => null, async() => undefined);
    await Promise.all([client.listProviders(), client.listProviders()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0];
    expect(init).toEqual(expect.objectContaining({ method: 'GET', headers: { Accept: 'application/json' } }));
    expect(JSON.stringify(init)).not.toMatch(/authorization|api.?key|token|credential/i); // risk: credentials
  });

  it('stores metadata under its cache key without writing model selections', async() => {
    const setCache = vi.fn();
    const client = new SharedModelCatalogClient(vi.fn().mockResolvedValue(jsonResponse({ schemaVersion: 1, providers: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6-sol', name: 'GPT 6 Sol' }] }] })) as any, () => 11, async() => null, setCache);
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
