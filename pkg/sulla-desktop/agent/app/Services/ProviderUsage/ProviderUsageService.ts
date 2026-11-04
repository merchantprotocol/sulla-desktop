// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';

import type { ProviderUsageStore } from '../../Repositories/ProviderUsageRepository';
import { PricingCatalog } from './PricingCatalog';
import type { CliUsageRecord, DailyUsageSummary, ModelUsageSummary, NormalizedUsageRecord, ProviderUsageSummary, UsageAggregate, UsageLimitSnapshot, UsageProviderDefinition, UsageSummary } from './ProviderUsageTypes';
import { UsageRecordCodec } from './UsageRecordCodec';
import { MeterableUsageNormalizer, UsageSourceNormalizerRegistry } from './UsageSourceStrategies';
import { UsageWriteQueue } from './UsageWriteQueue';

const RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 10_000;
export class ProviderUsageService extends Service {
  constructor(private readonly repository: ProviderUsageStore, private readonly queue: UsageWriteQueue,
    private readonly sources: UsageSourceNormalizerRegistry, private readonly meterable: MeterableUsageNormalizer,
    private readonly pricing: PricingCatalog, private readonly codec: UsageRecordCodec,
    private readonly providers: Readonly<Record<string, UsageProviderDefinition>>, private readonly now: () => Date) { super() }

  async record(providerId: string, record: Omit<CliUsageRecord, 'ts'> & { ts?: string }): Promise<void> {
    const provider = this.providers[providerId];
    const key = provider?.usageSource.kind === 'settings' ? provider.usageSource.key : `${ providerId }Usage`;
    await this.queue.enqueue(key, async() => {
      const records = this.codec.records(await this.repository.setting(key, '[]'));
      const entry = this.codec.sanitize({ ...record, ts: record.ts ?? this.now().toISOString() });
      const cutoff = this.now().getTime() - RETENTION_MS;
      const retained = [...records, entry].filter(item => Number.isFinite(Date.parse(item.ts)) && Date.parse(item.ts) >= cutoff).slice(-MAX_RECORDS);
      await this.repository.saveSetting(key, JSON.stringify(retained));
    });
  }
  async recordLimit(providerId: string, snapshot: UsageLimitSnapshot): Promise<void> {
    const key = this.providers[providerId]?.limitSource?.key ?? `${ providerId }LimitSnapshot`;
    await this.queue.enqueue(key, async() => {
      const current = this.codec.snapshot(await this.repository.setting(key, null)); const merged = new Map(current?.windows.map(window => [window.id, window]) ?? []);
      for (const window of snapshot.windows) merged.set(window.id, window);
      await this.repository.saveSetting(key, JSON.stringify({ providerId, capturedAt: snapshot.capturedAt, windows: [...merged.values()] } satisfies UsageLimitSnapshot));
    });
  }
  async summary(hours = 24, profileId = 'default', providerFilter?: string): Promise<UsageSummary> {
    const safeHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 31) : 24;
    const since = new Date(this.now().getTime() - safeHours * 60 * 60 * 1000);
    const definitions = Object.values(this.providers).filter(provider => !providerFilter || provider.id === providerFilter);
    const meterableRows = await this.repository.meterableRecords(profileId, since).catch(() => []);
    const records = (await Promise.all(definitions.map(provider => this.sources.normalize(provider, { since, meterable: meterableRows })))).flat();
    const known = new Set(definitions.flatMap(provider => provider.usageSource.kind === 'meterable' ? [provider.usageSource.providerId] : []));
    if (!providerFilter) for (const row of meterableRows) { const id = this.meterable.providerId(row); if (!id || known.has(id) || id === 'claude-code' || id === 'codex') continue; records.push(this.meterable.convert(row, { id, label: this.codec.humanize(id), usageSource: { kind: 'meterable', providerId: id } })) }
    const providers = definitions.map(provider => this.providerSummary(provider, records.filter(record => record.providerId === provider.id)));
    for (const id of [...new Set(records.map(record => record.providerId))].filter(id => !definitions.some(provider => provider.id === id))) { const group = records.filter(record => record.providerId === id); providers.push(this.providerSummary({ id, label: group[0]?.providerLabel ?? this.codec.humanize(id), usageSource: { kind: 'meterable', providerId: id } }, group)) }
    const limits: Record<string, UsageLimitSnapshot | null> = {};
    for (const provider of definitions) limits[provider.id] = provider.limitSource ? this.codec.snapshot(await this.repository.setting(provider.limitSource.key, null)) : null;
    return { generatedAt: this.now().toISOString(), windowHours: safeHours, profileId, totals: this.aggregate(records), providers, models: this.models(records), daily: this.daily(records, since), limits };
  }
  private providerSummary(provider: UsageProviderDefinition, records: NormalizedUsageRecord[]): ProviderUsageSummary { return { id: provider.id, label: provider.label, records: records.length, ...this.aggregate(records) } }
  private aggregate(records: CliUsageRecord[]): UsageAggregate {
    const result: UsageAggregate = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, cacheSavingsUsd: 0, pricedTokens: 0 };
    for (const record of records) { const input = this.codec.finite(record.input_tokens); const output = this.codec.finite(record.output_tokens); const cacheRead = this.codec.finite(record.cache_read_input_tokens ?? record.cached_input_tokens); const cacheWrite = this.codec.finite(record.cache_creation_input_tokens); const total = this.codec.finite(record.total_tokens) || input + output; const estimate = this.pricing.estimate(record, total, input, output, cacheRead, cacheWrite); result.totalTokens += total; result.inputTokens += input; result.outputTokens += output; result.cacheReadTokens += cacheRead; result.cacheWriteTokens += cacheWrite; result.estimatedCostUsd += estimate.cost; result.cacheSavingsUsd += estimate.cacheSavings; result.pricedTokens += estimate.priced ? total : 0 }
    return result;
  }
  private models(records: NormalizedUsageRecord[]): ModelUsageSummary[] {
    const groups = new Map<string, NormalizedUsageRecord[]>();
    for (const record of records) { const model = record.model || '(unknown model)'; const key = `${ record.providerId }\u0000${ model }`; const group = groups.get(key) ?? []; group.push(record); groups.set(key, group) }
    return [...groups.values()].map(group => { const aggregate = this.aggregate(group); const eligible = aggregate.inputTokens + aggregate.cacheReadTokens; return { providerId: group[0].providerId, providerLabel: group[0].providerLabel, model: group[0].model || '(unknown model)', records: group.length, ...aggregate, cacheHitRate: eligible > 0 ? aggregate.cacheReadTokens / eligible : 0, estimatedCostPerMillionTokens: aggregate.pricedTokens > 0 ? aggregate.estimatedCostUsd / aggregate.pricedTokens * 1_000_000 : null } }).sort((a, b) => b.totalTokens - a.totalTokens);
  }
  private daily(records: NormalizedUsageRecord[], since: Date): DailyUsageSummary[] {
    const days = new Map<string, NormalizedUsageRecord[]>(); const cursor = new Date(since); cursor.setHours(0, 0, 0, 0); const today = this.now(); today.setHours(0, 0, 0, 0);
    while (cursor <= today) { days.set(this.dateKey(cursor), []); cursor.setDate(cursor.getDate() + 1) }
    for (const record of records) { const key = this.dateKey(new Date(record.ts)); if (days.has(key)) days.get(key)!.push(record) }
    return [...days].map(([date, group]) => ({ date, ...this.aggregate(group), providers: [...new Set(group.map(record => record.providerId))].map(id => ({ id, label: group.find(record => record.providerId === id)?.providerLabel ?? this.codec.humanize(id), totalTokens: this.aggregate(group.filter(record => record.providerId === id)).totalTokens })).sort((a, b) => b.totalTokens - a.totalTokens) }));
  }
  private dateKey(date: Date): string { return `${ date.getFullYear() }-${ String(date.getMonth() + 1).padStart(2, '0') }-${ String(date.getDate()).padStart(2, '0') }` }
}
