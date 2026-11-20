// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { SULLA_CLOUD_HOST } from '../../../../services/sulla-vault/src/sullaCloudRelay';

export interface SharedCatalogModel { id: string; name: string; contextWindow?: number }
export interface SharedCatalogProvider { id: string; name: string; tag?: string; models: SharedCatalogModel[] }
interface SharedCatalog { schemaVersion: 1; providers: SharedCatalogProvider[] }
const CACHE_SETTING = 'sharedModelCatalogCache';
const TTL_MS = 5 * 60_000;
const RETRY_BACKOFF_MS = 60_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const providerIdPattern = /^[A-Za-z][A-Za-z0-9._-]{0,99}$/;
const modelIdPattern = /^[@A-Za-z0-9][@A-Za-z0-9._:/-]{0,199}$/;

// First-launch/offline seed copied only from the maintained shared catalog
// source in sulla-workers/src/config/model-catalog.ts. Update alongside its
// schema/source; online responses remain authoritative after validation.
const BUNDLED_FALLBACK: SharedCatalogProvider[] = [
  { id: 'anthropic', name: 'Anthropic', models: ['claude-fable-5.1', 'claude-fable-5', 'claude-opus-5.5', 'claude-opus-5', 'claude-opus-4.8', 'claude-opus-4.7', 'claude-sonnet-5.5', 'claude-sonnet-5', 'claude-sonnet-4.6', 'claude-haiku-5.5', 'claude-haiku-4.5'].map(id => ({ id, name: id })) },
  { id: 'openai', name: 'OpenAI', models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5-pro', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5-nano', 'o4-mini', 'o3'].map(id => ({ id, name: id })) },
  { id: 'google', name: 'Google', models: ['gemini-3.1-pro', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'].map(id => ({ id, name: id })) },
  { id: 'xai', name: 'xAI', models: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.20-multi-agent-0309'].map((id, index) => ({ id, name: id, ...(index === 3 ? { contextWindow: 2_000_000 } : {}) })) },
  { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }] },
  { id: 'moonshot', name: 'Moonshot AI', models: [{ id: 'kimi-k3', name: 'kimi-k3' }] },
  { id: 'alibaba', name: 'Alibaba', models: ['qwen3.8-max', 'qwen3.7-plus'].map(id => ({ id, name: id })) },
  { id: 'meta', name: 'Meta', models: ['muse-spark-1.3', 'muse-wonder-1.0'].map(id => ({ id, name: id })) },
  { id: 'minimax', name: 'MiniMax', models: [{ id: 'm3', name: 'm3' }] },
  { id: 'workers-ai', name: 'Cloudflare Workers AI', tag: 'open models', models: [
    { id: '@cf/openai/gpt-oss-120b', name: 'gpt-oss-120b', contextWindow: 128_000 },
    { id: '@cf/openai/gpt-oss-20b', name: 'gpt-oss-20b', contextWindow: 128_000 },
    { id: '@cf/moonshotai/kimi-k2.6', name: 'kimi-k2.6', contextWindow: 262_144 },
    { id: '@cf/moonshotai/kimi-k2.7-code', name: 'kimi-k2.7-code', contextWindow: 262_144 },
    { id: '@cf/zai-org/glm-5.3', name: 'glm-5.3', contextWindow: 1_310_720 },
    { id: '@cf/zai-org/glm-5.3-flash', name: 'glm-5.3-flash', contextWindow: 1_310_720 },
    { id: '@cf/deepseek-ai/deepseek-v4-pro-0813', name: 'deepseek-v4-pro-0813', contextWindow: 1_048_576 },
    { id: '@cf/deepseek-ai/deepseek-v4-flash-0731', name: 'deepseek-v4-flash-0731', contextWindow: 1_310_720 },
    { id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'llama-4-scout-17b-16e-instruct', contextWindow: 131_000 },
    { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'llama-3.3-70b-instruct-fp8-fast', contextWindow: 24_000 },
    { id: '@cf/qwen/qwen3.8-27b', name: 'qwen3.8-27b', contextWindow: 262_144 },
    { id: '@cf/qwen/qwen2.5-coder-32b-instruct', name: 'qwen2.5-coder-32b-instruct', contextWindow: 32_768 },
    { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', name: 'mistral-small-3.1-24b-instruct', contextWindow: 128_000 },
    { id: '@cf/nvidia/nemotron-3-120b-a12b', name: 'nemotron-3-120b-a12b', contextWindow: 256_000 },
    { id: '@cf/google/gemma-4-26b-a4b-it', name: 'gemma-4-26b-a4b-it', contextWindow: 256_000 },
    { id: '@cf/ibm-granite/granite-4.0-h-micro', name: 'granite-4.0-h-micro', contextWindow: 131_000 },
  ] },
];

export class SharedModelCatalogClient {
  private flight?: Promise<SharedCatalogProvider[]>;
  private retryAfter = 0;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly getCache = (key: string, fallback: unknown) => SullaSettingsModel.get(key, fallback),
    private readonly setCache = (key: string, value: unknown) => SullaSettingsModel.set(key, value, 'json'),
  ) {}

  async listProviders(): Promise<SharedCatalogProvider[]> {
    let cached: { fetchedAt: number; providers: SharedCatalogProvider[] } | null = null;
    try { cached = await this.readCache(); } catch { /* Keep startup resilient if settings storage is unavailable. */ }
    if (cached) {
      if (this.now() - cached.fetchedAt >= TTL_MS) void this.refresh().catch(() => undefined);
      return cached.providers;
    }
    try { return await this.refresh(); }
    catch { return BUNDLED_FALLBACK; }
  }

  getBundledProvider(providerId: string): SharedCatalogProvider | undefined {
    return BUNDLED_FALLBACK.find(provider => provider.id === providerId);
  }

  private refresh(): Promise<SharedCatalogProvider[]> {
    if (this.flight) return this.flight;
    if (this.now() < this.retryAfter) return Promise.reject(new Error('Shared model catalog retry is deferred'));
    this.flight = (async() => {
      const response = await this.fetcher(`https://${ SULLA_CLOUD_HOST }/shared-model-catalog`, {
        method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Shared model catalog unavailable (${ response.status })`);
      const parsed = this.validate(await this.readBoundedJson(response));
      await this.setCache(CACHE_SETTING, { fetchedAt: this.now(), providers: parsed.providers });
      this.retryAfter = 0;
      return parsed.providers;
    })().catch(error => {
      this.retryAfter = this.now() + RETRY_BACKOFF_MS;
      throw error;
    }).finally(() => { this.flight = undefined; });
    return this.flight;
  }

  private async readBoundedJson(response: Response): Promise<unknown> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error('Shared model catalog response is too large');
    if (!response.body) throw new Error('Shared model catalog response has no body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error('Shared model catalog response is too large');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  }

  private async readCache(): Promise<{ fetchedAt: number; providers: SharedCatalogProvider[] } | null> {
    const raw = await this.getCache(CACHE_SETTING, null) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (typeof record.fetchedAt !== 'number' || !Number.isFinite(record.fetchedAt)) return null;
    try { return { fetchedAt: record.fetchedAt, providers: this.validate({ schemaVersion: 1, providers: record.providers }).providers }; }
    catch { return null; }
  }

  private validate(raw: unknown): SharedCatalog {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid shared catalog');
    const value = raw as Record<string, unknown>;
    if (value.schemaVersion !== 1 || !Array.isArray(value.providers) || value.providers.length > 100) throw new Error('Invalid shared catalog');
    const providers: SharedCatalogProvider[] = [];
    const seen = new Set<string>();
    for (const item of value.providers) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid shared catalog provider');
      const p = item as Record<string, unknown>;
      if (typeof p.id !== 'string' || !providerIdPattern.test(p.id) || seen.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || !Array.isArray(p.models) || p.models.length === 0 || p.models.length > 500) throw new Error('Invalid shared catalog provider');
      seen.add(p.id);
      const modelIds = new Set<string>();
      const models = p.models.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid shared catalog model');
        const m = entry as Record<string, unknown>;
        if (typeof m.id !== 'string' || !modelIdPattern.test(m.id) || modelIds.has(m.id) || typeof m.name !== 'string' || !m.name.trim() || (m.contextWindow !== undefined && (!Number.isInteger(m.contextWindow) || Number(m.contextWindow) < 1))) throw new Error('Invalid shared catalog model');
        modelIds.add(m.id);
        return { id: m.id, name: m.name, ...(m.contextWindow ? { contextWindow: Number(m.contextWindow) } : {}) };
      });
      providers.push({ id: p.id, name: p.name, ...(typeof p.tag === 'string' ? { tag: p.tag } : {}), models });
    }
    if (!providers.length) throw new Error('Empty shared catalog');
    return { schemaVersion: 1, providers };
  }
}

export const sharedModelCatalog = new SharedModelCatalogClient();
