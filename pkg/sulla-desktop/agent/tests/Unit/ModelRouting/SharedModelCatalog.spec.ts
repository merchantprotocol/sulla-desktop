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
    const model = { id: 'official-model', name: 'Official', aliases: ['family'], capabilities: { task: 'Text Generation', functionCalling: true }, supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', minimumClientVersion: '1.2.3', selectionMode: 'exact', source: { revision: 'release-sha', url: 'https://example.org/official' } };
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

  it('preserves canonical Cloud source receipts, transports, policy modes and per-model capabilities', async() => {
    // risk: schema drift / cross-transport catalog rejection
    const source = { id: 'official-release', url: 'https://example.org/source', revision: 'release-sha', sha256: 'b'.repeat(64), fetchedAt: '2026-11-20T00:00:00Z', parserVersion: '1', license: 'Apache-2.0', attribution: 'Official source', coverage: 'General support, not entitlement' };
    const provenance = { sourceId: source.id, upstreamModelId: 'sonnet[1m]', status: 'verified' };
    let saved: unknown = null;
    const client = new SharedModelCatalogClient(vi.fn().mockResolvedValue(jsonResponse({ schemaVersion: 1, revision: 'a'.repeat(64), sources: [source], providers: [{ id: 'claude-code', name: 'Claude Code', transport: 'claude-code', aliases: [], models: [
      { id: 'sonnet[1m]', name: 'Sonnet 1M', capabilities: { task: 'Text Generation', requestFormats: ['messages'], functionCalling: true }, supportedReasoningEfforts: [], aliases: [], selectionMode: 'alias', provenance },
      { id: 'default', name: 'Account default', capabilities: {}, aliases: [], supportedReasoningEfforts: [], selectionMode: 'auto', provenance: { ...provenance, upstreamModelId: 'default' } },
      { id: 'opusplan', name: 'Plan policy', capabilities: {}, aliases: [], supportedReasoningEfforts: [], selectionMode: 'policy', provenance: { ...provenance, upstreamModelId: 'opusplan' } },
    ] }] })) as any, () => 1, async() => saved, async(_key, value) => { saved = value; });
    const models = await client.listModels('claude-code');
    expect(models[0]).toMatchObject({ id: 'sonnet[1m]', provenance, source, revision: 'a'.repeat(64), capabilities: { functionCalling: true } });
    expect(models.map(model => model.selectionMode)).toEqual(['alias', 'auto', 'policy']);
    expect(await client.listModels('claude-code')).toEqual(models); // persisted Cloud metadata survives revalidation
  });

});
