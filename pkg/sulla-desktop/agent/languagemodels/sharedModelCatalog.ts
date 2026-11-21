// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { SULLA_CLOUD_HOST } from '../../../../services/sulla-vault/src/sullaCloudRelay.js';

export interface SharedCatalogModel {
  id: string; name: string; contextWindow?: number;
  aliases?: string[];
  capabilities?: { task?: string; requestFormats?: string[]; inputModalities?: string[]; functionCalling?: boolean };
  supportedReasoningEfforts?: string[]; maxContextWindow?: number; maxOutputTokens?: number;
  provenance?: Record<string, string>;
  defaultReasoningEffort?: string; minimumClientVersion?: string;
  selectionMode?: 'exact' | 'alias' | 'auto' | 'policy'; source?: Record<string, unknown>; revision?: string;
}
export const catalogProviderId = (id: string): string => (({ grok: 'xai', kimi: 'moonshot' } as Record<string, string>)[id] || id);
export const executionProviderId = (id: string): string => (({ xai: 'grok', moonshot: 'kimi' } as Record<string, string>)[id] || id);
export interface SharedCatalogProvider { id: string; name: string; tag?: string; models: SharedCatalogModel[]; transport?: 'api' | 'workers-ai' | 'codex-cli' | 'claude-code'; aliases?: string[] }
interface SharedCatalog { schemaVersion: 1; providers: SharedCatalogProvider[] }
const CACHE_SETTING = 'sharedModelCatalogCache';
const TTL_MS = 5 * 60_000;
const RETRY_BACKOFF_MS = 60_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const providerIdPattern = /^[A-Za-z][A-Za-z0-9._-]{0,99}$/;
const modelIdPattern = /^[@A-Za-z0-9][@A-Za-z0-9._:/\[\]-]{0,199}$/;

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

  private providerAliases(raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.length > 100 || !raw.every(alias => typeof alias === 'string' && providerIdPattern.test(alias))) throw new Error('Invalid provider aliases');
    return [...raw];
  }

  private validate(raw: unknown): SharedCatalog {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid shared catalog');
    const value = raw as Record<string, unknown>;
    if (value.schemaVersion !== 1 || !Array.isArray(value.providers) || value.providers.length > 100) throw new Error('Invalid shared catalog');
    if (value.revision !== undefined && (typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision))) throw new Error('Invalid catalog revision');
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
        for (const key of ['aliases', 'supportedReasoningEfforts'] as const) {
          if (m[key] === undefined) continue;
          if (!Array.isArray(m[key]) || m[key].length > 100 || !m[key].every((v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200)) throw new Error(`Invalid catalog ${ key }`);
          metadata[key] = [...m[key]];
        }
        for (const key of ['defaultReasoningEffort', 'minimumClientVersion', 'revision'] as const) {
          if (m[key] === undefined) continue;
          if (typeof m[key] !== 'string' || !m[key].trim() || m[key].length > 200) throw new Error(`Invalid catalog ${ key }`);
          metadata[key] = m[key];
        }
        if (m.capabilities !== undefined) {
          if (!m.capabilities || typeof m.capabilities !== 'object' || Array.isArray(m.capabilities)) throw new Error('Invalid model capabilities');
          const caps = m.capabilities as Record<string, unknown>;
          metadata.capabilities = {};
          if (caps.task !== undefined) {
            if (typeof caps.task !== 'string' || caps.task.length > 200) throw new Error('Invalid capability task');
            metadata.capabilities.task = caps.task;
          }
          for (const key of ['requestFormats', 'inputModalities'] as const) {
            if (caps[key] === undefined) continue;
            if (!Array.isArray(caps[key]) || !caps[key].every((v: unknown) => typeof v === 'string' && v.length <= 200)) throw new Error('Invalid capability format');
            metadata.capabilities[key] = [...caps[key]];
          }
          if (caps.functionCalling !== undefined) {
            if (typeof caps.functionCalling !== 'boolean') throw new Error('Invalid function-calling capability');
            metadata.capabilities.functionCalling = caps.functionCalling;
          }
        }
        if (m.provenance !== undefined) {
          if (!m.provenance || typeof m.provenance !== 'object' || Array.isArray(m.provenance)) throw new Error('Invalid model provenance');
          metadata.provenance = {};
          for (const key of ['sourceId', 'upstreamModelId', 'upstreamProviderId', 'upstreamRecordId', 'status', 'reason', 'sourcePath']) {
            const field = (m.provenance as Record<string, unknown>)[key];
            if (field === undefined) continue;
            if (typeof field !== 'string' || !field || field.length > 2048) throw new Error('Invalid provenance field');
            metadata.provenance[key] = field;
          }
          if (!['verified', 'stale-unverified'].includes(metadata.provenance.status)) throw new Error('Invalid provenance status');
        }
        for (const key of ['maxContextWindow', 'maxOutputTokens'] as const) {
          if (m[key] !== undefined) {
            if (!Number.isSafeInteger(m[key]) || Number(m[key]) < 1) throw new Error('Invalid catalog context');
            metadata[key] = Number(m[key]);
          }
        }
        if (metadata.defaultReasoningEffort && !metadata.supportedReasoningEfforts?.includes(metadata.defaultReasoningEffort)) throw new Error('Invalid catalog default effort');
        if (m.selectionMode !== undefined) {
          if (!['exact', 'alias', 'auto', 'policy'].includes(String(m.selectionMode))) throw new Error('Invalid selection mode');
          metadata.selectionMode = m.selectionMode as SharedCatalogModel['selectionMode'];
        }
        const sourceReceipt = metadata.provenance && Array.isArray(value.sources)
          ? value.sources.find((source: unknown) => !!source && typeof source === 'object' && (source as Record<string, unknown>).id === metadata.provenance?.sourceId)
          : m.source;
        if (metadata.provenance && Array.isArray(value.sources) && !sourceReceipt) throw new Error('Missing catalog source receipt');
        if (sourceReceipt !== undefined) {
          if (!sourceReceipt || typeof sourceReceipt !== 'object' || Array.isArray(sourceReceipt)) throw new Error('Invalid catalog source');
          // Public source receipts only. Never copy arbitrary account fields.
          metadata.source = {};
          for (const key of ['id', 'url', 'revision', 'sha256', 'release', 'fetchedAt', 'parserVersion', 'coverage', 'license', 'attribution']) {
            const value = (sourceReceipt as Record<string, unknown>)[key];
            if (typeof value === 'string' && value.length <= 2000) metadata.source[key] = value;
          }
        }
        if (typeof value.revision === 'string') metadata.revision = value.revision;
        return { id: m.id, name: m.name, ...(m.contextWindow ? { contextWindow: Number(m.contextWindow) } : {}), ...metadata };
      });
      if (p.transport !== undefined && !['api', 'workers-ai', 'codex-cli', 'claude-code'].includes(String(p.transport))) throw new Error('Invalid provider transport');
      if (p.id === 'codex' && p.transport !== undefined && p.transport !== 'codex-cli') throw new Error('Codex transport mismatch');
      if (p.id === 'claude-code' && p.transport !== undefined && p.transport !== 'claude-code') throw new Error('Claude transport mismatch');
      const aliases = p.aliases === undefined ? undefined : this.providerAliases(p.aliases);
      providers.push({ ...(aliases ? { aliases } : {}), id: p.id, name: p.name, ...(p.transport ? { transport: p.transport as SharedCatalogProvider['transport'] } : {}), ...(typeof p.tag === 'string' ? { tag: p.tag } : {}), models });
    }
    if (!providers.length) throw new Error('Empty shared catalog');
    return { schemaVersion: 1, providers };
  }
}

export const sharedModelCatalog = new SharedModelCatalogClient();
