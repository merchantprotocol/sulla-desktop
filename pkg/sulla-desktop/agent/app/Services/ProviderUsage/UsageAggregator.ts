// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';
import { PricingCatalog } from './PricingCatalog';
import type {
  CliUsageRecord,
  DailyUsageSummary,
  ModelUsageSummary,
  NormalizedUsageRecord,
  ProviderUsageSummary,
  UsageAggregate,
  UsageProviderDefinition,
} from './ProviderUsageTypes';
import { UsageRecordCodec } from './UsageRecordCodec';

export class UsageAggregator extends Service {
  constructor(
    private readonly pricing: PricingCatalog,
    private readonly codec: UsageRecordCodec,
    private readonly now: () => Date,
  ) {
    super();
  }

  provider(provider: UsageProviderDefinition, records: NormalizedUsageRecord[]): ProviderUsageSummary {
    return { id: provider.id, label: provider.label, records: records.length, ...this.aggregate(records) };
  }

  aggregate(records: CliUsageRecord[]): UsageAggregate {
    const result: UsageAggregate = {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
      cacheSavingsUsd: 0,
      pricedTokens: 0,
    };
    for (const record of records) {
      const input = this.codec.finite(record.input_tokens);
      const output = this.codec.finite(record.output_tokens);
      const cacheRead = this.codec.finite(record.cache_read_input_tokens ?? record.cached_input_tokens);
      const cacheWrite = this.codec.finite(record.cache_creation_input_tokens);
      const total = this.codec.finite(record.total_tokens);
      const estimate = this.pricing.estimate(record, total, input, output, cacheRead, cacheWrite);
      result.totalTokens += total;
      result.inputTokens += input;
      result.outputTokens += output;
      result.cacheReadTokens += cacheRead;
      result.cacheWriteTokens += cacheWrite;
      result.estimatedCostUsd += estimate.cost;
      result.cacheSavingsUsd += estimate.cacheSavings;
      result.pricedTokens += estimate.priced ? total : 0;
    }
    return result;
  }

  models(records: NormalizedUsageRecord[]): ModelUsageSummary[] {
    const groups = new Map<string, NormalizedUsageRecord[]>();
    for (const record of records) {
      const model = record.model || '(unknown model)';
      const key = `${record.providerId}\u0000${model}`;
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }
    return [...groups.values()]
      .map((group) => {
        const aggregate = this.aggregate(group);
        const eligible = aggregate.inputTokens + aggregate.cacheReadTokens;
        return {
          providerId: group[0].providerId,
          providerLabel: group[0].providerLabel,
          model: group[0].model || '(unknown model)',
          records: group.length,
          ...aggregate,
          cacheHitRate: eligible > 0 ? aggregate.cacheReadTokens / eligible : 0,
          estimatedCostPerMillionTokens:
            aggregate.pricedTokens > 0 ? (aggregate.estimatedCostUsd / aggregate.pricedTokens) * 1_000_000 : null,
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);
  }

  daily(records: NormalizedUsageRecord[], since: Date): DailyUsageSummary[] {
    const days = this.daysSince(since);
    for (const record of records) {
      days.get(this.dateKey(new Date(record.ts)))?.push(record);
    }
    return [...days].map(([date, group]) => ({
      date,
      ...this.aggregate(group),
      providers: this.dailyProviders(group),
    }));
  }

  private daysSince(since: Date): Map<string, NormalizedUsageRecord[]> {
    const days = new Map<string, NormalizedUsageRecord[]>();
    const cursor = new Date(since);
    cursor.setHours(0, 0, 0, 0);
    const today = this.now();
    today.setHours(0, 0, 0, 0);
    while (cursor <= today) {
      days.set(this.dateKey(cursor), []);
      cursor.setDate(cursor.getDate() + 1);
    }
    return days;
  }

  private dailyProviders(records: NormalizedUsageRecord[]) {
    return [...new Set(records.map((record) => record.providerId))]
      .map((id) => ({
        id,
        label: records.find((record) => record.providerId === id)?.providerLabel ?? this.codec.humanize(id),
        totalTokens: this.aggregate(records.filter((record) => record.providerId === id)).totalTokens,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
  }

  private dateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}
