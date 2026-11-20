// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { SharedModelCatalogClient } from '../../../languagemodels/sharedModelCatalog';

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('shared model catalog', () => {
  it('rejects invalid schema and keeps the last-known-good metadata', async() => {
    let saved: any = { authority: 'shared-model-catalog', schemaVersion: 1, fetchedAt: 1, providers: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6-sol', name: 'GPT 6 Sol' }] }] };
    const client = new SharedModelCatalogClient(vi.fn().mockResolvedValue(jsonResponse({ schemaVersion: 99, providers: [] })) as any, () => 999999, async() => saved, async(_key, value) => { saved = value; });
    expect(await client.listProviders()).toEqual(saved.providers);
  });

  it('serves persisted metadata offline instead of replacing it with an empty list', async() => {
    const prior = [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6-sol', name: 'GPT 6 Sol' }] }];
    const client = new SharedModelCatalogClient(vi.fn().mockRejectedValue(new Error('offline')) as any, () => 999999, async() => ({ authority: 'shared-model-catalog', schemaVersion: 1, fetchedAt: 1, providers: prior }), async() => undefined);
    expect(await client.listProviders()).toEqual(prior);
  });

  it('reports unavailable on first offline launch instead of inventing a model', async() => {
    // risk: explicit selection / unverified catalog
    const client = new SharedModelCatalogClient(vi.fn().mockRejectedValue(new Error('offline')) as any, () => 1, async() => null, async() => undefined);
    expect(await client.listProviders()).toEqual([]);
  });

  it('returns persisted cache immediately and attempts stale refresh without losing it on failure', async() => {
    const prior = [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }] }];
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const client = new SharedModelCatalogClient(fetcher as any, () => 999999, async() => ({ authority: 'shared-model-catalog', schemaVersion: 1, fetchedAt: 1, providers: prior }), async() => undefined);
    expect(await client.listProviders()).toEqual(prior);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized catalog response bodies and reports unavailable', async() => {
    const oversized = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(512 * 1024 + 1)); controller.close(); } }), { status: 200 });
    const client = new SharedModelCatalogClient(vi.fn().mockResolvedValue(oversized) as any, () => 1, async() => null, async() => undefined);
    expect(await client.listProviders()).toEqual([]);
  });

  it('accepts Cloudflare model identifiers and preserves explicit empty providers', async() => {
    const client = new SharedModelCatalogClient(vi.fn() as any, () => 1, async() => null, async() => undefined);
    expect((client as any).validate({ schemaVersion: 1, providers: [{ id: 'workers-ai', name: 'Cloudflare', models: [{ id: '@cf/openai/gpt-oss-120b', name: 'gpt-oss-120b' }] }] }).providers[0].models[0].id).toBe('@cf/openai/gpt-oss-120b');
    expect((client as any).validate({ schemaVersion: 1, providers: [{ id: 'openai', name: 'OpenAI', models: [] }] }).providers[0].models).toEqual([]);
  });

  it('reports unavailable if settings and network both fail', async() => {
    const client = new SharedModelCatalogClient(vi.fn().mockRejectedValue(new Error('offline')) as any, () => 1, async() => { throw new Error('settings unavailable'); }, async() => undefined);
    expect(await client.listProviders()).toEqual([]);
  });

  it('does not fetch for fresh cache reads', async() => {
    const fetcher = vi.fn();
    const cached = [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6-sol', name: 'GPT 6 Sol' }] }];
    const client = new SharedModelCatalogClient(fetcher as any, () => 200, async() => ({ authority: 'shared-model-catalog', schemaVersion: 1, fetchedAt: 100, providers: cached }), async() => undefined);
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
    expect(() => (client as any).validate({ schemaVersion: 1, providers: [] })).toThrow();
    expect(() => (client as any).validate({ schemaVersion: 1, providers: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6-sol', name: 'one' }, { id: 'gpt-6-sol', name: 'two' }] }] })).toThrow();
  });
  it('does not trust legacy unmarked caches and does not cross-promote CLI/API identities', async() => {
    // risk: authority / account isolation
    const client = new SharedModelCatalogClient(vi.fn().mockRejectedValue(new Error('offline')) as any, () => 1,
      async() => ({ fetchedAt: 1, providers: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'api-only', name: 'API' }] }] }), async() => undefined);
    expect(await client.listModels('codex')).toEqual([]);
    expect(await client.listModels('openai')).toEqual([]);
  });

  it('preserves Cloud CLI metadata and explicit aliases without substituting missing providers', async() => {
    // risk: execution compatibility / exact model selection
    const model = { id: 'official-model', name: 'Official', aliases: ['family'], capabilities: ['tools'], supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', minimumClientVersion: '1.2.3', selectionMode: 'exact', source: { revision: 'release-sha', url: 'https://example.org/official' } };
    const providers = [{ id: 'codex', name: 'Codex', models: [model] }, { id: 'xai', name: 'xAI', models: [{ id: 'grok-test', name: 'Grok' }] }, { id: 'moonshot', name: 'Moonshot', models: [] }];
    let saved: unknown = null;
    const client = new SharedModelCatalogClient(vi.fn().mockResolvedValue(jsonResponse({ schemaVersion: 1, providers })) as any, () => 1, async() => saved, async(_key, value) => { saved = value; });
    expect(await client.listModels('codex')).toEqual([model]);
    expect(await client.listModels('grok')).toEqual(providers[1].models);
    expect(await client.listModels('kimi')).toEqual([]);
    expect(await client.listModels('claude-code')).toEqual([]);
  });

  it('rejects invalid effort defaults without poisoning the previous Cloud revision', async() => {
    // risk: unsupported CLI flags
    const prior = [{ id: 'codex', name: 'Codex', models: [{ id: 'official-model', name: 'Official' }] }];
    const client = new SharedModelCatalogClient(vi.fn().mockResolvedValue(jsonResponse({ schemaVersion: 1, providers: [{ id: 'codex', name: 'Codex', models: [{ id: 'bad', name: 'Bad', supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'ultra' }] }] })) as any,
      () => 999999, async() => ({ authority: 'shared-model-catalog', schemaVersion: 1, fetchedAt: 1, providers: prior }), async() => { throw new Error('must not overwrite'); });
    expect(await client.listModels('codex')).toEqual(prior[0].models);
    await expect(client.refreshNow()).rejects.toThrow();
  });

});
