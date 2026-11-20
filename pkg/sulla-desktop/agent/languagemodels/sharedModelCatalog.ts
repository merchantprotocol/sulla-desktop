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
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

// First-launch/offline seed copied only from the maintained shared catalog
// source in sulla-workers/src/config/model-catalog.ts. Update alongside its
// schema/source; online responses remain authoritative after validation.
const BUNDLED_FALLBACK: SharedCatalogProvider[] = [
  { id: 'anthropic', name: 'Anthropic', models: ['claude-opus-5.5', 'claude-sonnet-5.5', 'claude-haiku-5.5'].map(id => ({ id, name: id })) },
  { id: 'openai', name: 'OpenAI', models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5'].map(id => ({ id, name: id })) },
  { id: 'google', name: 'Google', models: ['gemini-3.1-pro', 'gemini-3.8-flash', 'gemini-2.5-pro'].map(id => ({ id, name: id })) },
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
    const cached = await this.readCache();
    if (cached) {
      if (this.now() - cached.fetchedAt >= TTL_MS) void this.refresh().catch(() => undefined);
      return cached.providers;
    }
    try { return await this.refresh(); }
    catch { return cached?.providers ?? BUNDLED_FALLBACK; }
  }

  private refresh(): Promise<SharedCatalogProvider[]> {
    if (this.flight) return this.flight;
    if (this.now() < this.retryAfter) return Promise.reject(new Error('Shared model catalog retry is deferred'));
    this.flight = (async() => {
      const response = await this.fetcher(`https://${ SULLA_CLOUD_HOST }/shared-model-catalog`, {
        method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Shared model catalog unavailable (${ response.status })`);
      const parsed = this.validate(await response.json());
      await this.setCache(CACHE_SETTING, { fetchedAt: this.now(), providers: parsed.providers });
      this.retryAfter = 0;
      return parsed.providers;
    })().catch(error => {
      this.retryAfter = this.now() + RETRY_BACKOFF_MS;
      throw error;
    }).finally(() => { this.flight = undefined; });
    return this.flight;
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
      if (typeof p.id !== 'string' || !idPattern.test(p.id) || seen.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || !Array.isArray(p.models) || p.models.length > 500) throw new Error('Invalid shared catalog provider');
      seen.add(p.id);
      const modelIds = new Set<string>();
      const models = p.models.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid shared catalog model');
        const m = entry as Record<string, unknown>;
        if (typeof m.id !== 'string' || !idPattern.test(m.id) || modelIds.has(m.id) || typeof m.name !== 'string' || !m.name.trim() || (m.contextWindow !== undefined && (!Number.isInteger(m.contextWindow) || Number(m.contextWindow) < 1))) throw new Error('Invalid shared catalog model');
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
