// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { SULLA_CLOUD_HOST } from '../../../../services/sulla-vault/src/sullaCloudRelay';

export interface SharedCatalogModel {
  id: string; name: string; contextWindow?: number;
  aliases?: string[]; capabilities?: string[]; supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string; minimumClientVersion?: string;
  selectionMode?: 'exact' | 'alias' | 'automatic'; source?: Record<string, unknown>; revision?: string;
}
export const catalogProviderId = (id: string): string => (({ grok: 'xai', kimi: 'moonshot' } as Record<string, string>)[id] || id);
export const executionProviderId = (id: string): string => (({ xai: 'grok', moonshot: 'kimi' } as Record<string, string>)[id] || id);
export interface SharedCatalogProvider { id: string; name: string; tag?: string; models: SharedCatalogModel[] }
interface SharedCatalog { schemaVersion: 1; providers: SharedCatalogProvider[] }
const CACHE_SETTING = 'sharedModelCatalogCache';
const TTL_MS = 5 * 60_000;
const RETRY_BACKOFF_MS = 60_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const providerIdPattern = /^[A-Za-z][A-Za-z0-9._-]{0,99}$/;
const modelIdPattern = /^[@A-Za-z0-9][@A-Za-z0-9._:/-]{0,199}$/;

export class SharedModelCatalogClient {
  private flight?: Promise<SharedCatalogProvider[]>;
  private retryAfter = 0;
  private lastGood: { fetchedAt: number; providers: SharedCatalogProvider[] } | null = null;
  private status: { authority: 'shared-model-catalog'; state: 'fresh' | 'stale' | 'unavailable'; fetchedAt?: number } = { authority: 'shared-model-catalog', state: 'unavailable' };

  getStatus(): typeof this.status { return { ...this.status }; }

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly getCache = (key: string, fallback: unknown) => SullaSettingsModel.get(key, fallback),
    private readonly setCache = (key: string, value: unknown) => SullaSettingsModel.set(key, value, 'json'),
  ) {}

  async listProviders(): Promise<SharedCatalogProvider[]> {
    let cached: { fetchedAt: number; providers: SharedCatalogProvider[] } | null = null;
    try { cached = await this.readCache(); } catch { /* Keep startup resilient if settings storage is unavailable. */ }
    if (this.lastGood && (!cached || this.lastGood.fetchedAt > cached.fetchedAt)) cached = this.lastGood;
    if (cached) {
      this.status = { authority: 'shared-model-catalog', state: this.now() - cached.fetchedAt >= TTL_MS ? 'stale' : 'fresh', fetchedAt: cached.fetchedAt };
      if (this.now() - cached.fetchedAt >= TTL_MS) void this.refresh().catch(() => undefined);
      return cached.providers;
    }
    try { return await this.refresh(); }
    catch { this.status = { authority: 'shared-model-catalog', state: 'unavailable' }; return []; } // Offline first start: unavailable, never a competing seed.
  }

  async listModels(providerId: string): Promise<SharedCatalogModel[]> {
    return (await this.listProviders()).find(provider => catalogProviderId(provider.id) === catalogProviderId(providerId))?.models || [];
  }

  async refreshNow(): Promise<void> { this.retryAfter = 0; await this.refresh(); }

  private refresh(): Promise<SharedCatalogProvider[]> {
    if (this.flight) return this.flight;
    if (this.now() < this.retryAfter) return Promise.reject(new Error('Shared model catalog retry is deferred'));
    this.flight = (async() => {
      const response = await this.fetcher(`https://${ SULLA_CLOUD_HOST }/shared-model-catalog`, {
        method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Shared model catalog unavailable (${ response.status })`);
      const parsed = this.validate(await this.readBoundedJson(response));
      this.lastGood = { fetchedAt: this.now(), providers: parsed.providers };
      this.status = { authority: 'shared-model-catalog', state: 'fresh', fetchedAt: this.lastGood.fetchedAt };
      try { await this.setCache(CACHE_SETTING, { authority: 'shared-model-catalog', schemaVersion: 1, ...this.lastGood }); }
      catch { /* Validated Cloud data remains usable in memory if persistence is unavailable. */ }
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
    if (record.authority !== 'shared-model-catalog' || record.schemaVersion !== 1) return null;
    if (typeof record.fetchedAt !== 'number' || !Number.isFinite(record.fetchedAt) || record.fetchedAt < 0 || record.fetchedAt > this.now() + 60_000) return null;
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
      if (typeof p.id !== 'string' || !providerIdPattern.test(p.id) || seen.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || !Array.isArray(p.models) || p.models.length > 500) throw new Error('Invalid shared catalog provider');
      seen.add(p.id);
      const modelIds = new Set<string>();
      const models = p.models.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid shared catalog model');
        const m = entry as Record<string, unknown>;
        if (typeof m.id !== 'string' || !modelIdPattern.test(m.id) || modelIds.has(m.id) || typeof m.name !== 'string' || !m.name.trim() || (m.contextWindow !== undefined && (!Number.isInteger(m.contextWindow) || Number(m.contextWindow) < 1))) throw new Error('Invalid shared catalog model');
        modelIds.add(m.id);
        const metadata: Partial<SharedCatalogModel> = {};
        for (const key of ['aliases', 'capabilities', 'supportedReasoningEfforts'] as const) {
          if (m[key] === undefined) continue;
          if (!Array.isArray(m[key]) || m[key].length > 100 || !m[key].every((v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200)) throw new Error(`Invalid catalog ${ key }`);
          metadata[key] = [...m[key]];
        }
        for (const key of ['defaultReasoningEffort', 'minimumClientVersion', 'revision'] as const) {
          if (m[key] === undefined) continue;
          if (typeof m[key] !== 'string' || !m[key].trim() || m[key].length > 200) throw new Error(`Invalid catalog ${ key }`);
          metadata[key] = m[key];
        }
        if (metadata.defaultReasoningEffort && !metadata.supportedReasoningEfforts?.includes(metadata.defaultReasoningEffort)) throw new Error('Invalid catalog default effort');
        if (m.selectionMode !== undefined) {
          if (!['exact', 'alias', 'automatic'].includes(String(m.selectionMode))) throw new Error('Invalid selection mode');
          metadata.selectionMode = m.selectionMode as SharedCatalogModel['selectionMode'];
        }
        if (m.source !== undefined) {
          if (!m.source || typeof m.source !== 'object' || Array.isArray(m.source)) throw new Error('Invalid catalog source');
          // Public source receipts only. Never copy arbitrary account fields.
          metadata.source = {};
          for (const key of ['url', 'revision', 'release', 'fetchedAt', 'parserVersion', 'coverage', 'license', 'attribution']) {
            const value = (m.source as Record<string, unknown>)[key];
            if (typeof value === 'string' && value.length <= 2000) metadata.source[key] = value;
          }
        }
        return { id: m.id, name: m.name, ...(m.contextWindow ? { contextWindow: Number(m.contextWindow) } : {}), ...metadata };
      });
      providers.push({ id: p.id, name: p.name, ...(typeof p.tag === 'string' ? { tag: p.tag } : {}), models });
    }
    if (!providers.length) throw new Error('Empty shared catalog');
    return { schemaVersion: 1, providers };
  }
}

export const sharedModelCatalog = new SharedModelCatalogClient();
