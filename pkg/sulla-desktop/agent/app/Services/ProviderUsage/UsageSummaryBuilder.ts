// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';
import type { ProviderUsageStore } from '../../Repositories/ProviderUsageRepository';
import type {
  MeterableUsageRow,
  NormalizedUsageRecord,
  ProviderUsageSummary,
  UsageLimitSnapshot,
  UsageProviderDefinition,
  UsageSummary,
} from './ProviderUsageTypes';
import { UsageAggregator } from './UsageAggregator';
import { UsageRecordCodec } from './UsageRecordCodec';
import { MeterableUsageNormalizer, UsageSourceNormalizerRegistry } from './UsageSourceStrategies';

export class UsageSummaryBuilder extends Service {
  constructor(
    private readonly repository: ProviderUsageStore,
    private readonly sources: UsageSourceNormalizerRegistry,
    private readonly meterable: MeterableUsageNormalizer,
    private readonly aggregator: UsageAggregator,
    private readonly codec: UsageRecordCodec,
    private readonly providers: Readonly<Record<string, UsageProviderDefinition>>,
    private readonly now: () => Date,
  ) {
    super();
  }

  async build(hours = 24, profileId = 'default', providerFilter?: string): Promise<UsageSummary> {
    const safeHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 31) : 24;
    const since = new Date(this.now().getTime() - safeHours * 60 * 60 * 1000);
    const definitions = Object.values(this.providers).filter(
      (provider) => !providerFilter || provider.id === providerFilter,
    );
    const meterableRows = await this.repository.meterableRecords(profileId, since).catch(() => []);
    const records = (
      await Promise.all(
        definitions.map((provider) =>
          this.sources.normalize(provider, {
            since,
            meterable: meterableRows,
          }),
        ),
      )
    ).flat();
    if (!providerFilter) {
      this.appendUnregisteredMeterableRecords(records, meterableRows);
    }
    return {
      generatedAt: this.now().toISOString(),
      windowHours: safeHours,
      profileId,
      totals: this.aggregator.aggregate(records),
      providers: this.providerSummaries(definitions, records),
      models: this.aggregator.models(records),
      daily: this.aggregator.daily(records, since),
      limits: await this.limits(definitions),
    };
  }

  private appendUnregisteredMeterableRecords(
    records: NormalizedUsageRecord[],
    meterableRows: MeterableUsageRow[],
  ): void {
    const registeredMeterableIds = new Set(
      Object.values(this.providers).flatMap((provider) =>
        provider.usageSource.kind === 'meterable' ? [provider.usageSource.providerId] : [],
      ),
    );
    const dedicatedSourceIds = new Set(
      Object.values(this.providers).flatMap((provider) =>
        provider.usageSource.kind === 'settings' ? [] : [],
      ),
    );
    for (const row of meterableRows) {
      const id = this.meterable.providerId(row);
      if (!id || registeredMeterableIds.has(id) || dedicatedSourceIds.has(id)) {
        continue;
      }
      records.push(
        this.meterable.convert(row, {
          id,
          label: this.codec.humanize(id),
          usageSource: { kind: 'meterable', providerId: id },
        }),
      );
    }
  }

  private providerSummaries(
    definitions: UsageProviderDefinition[],
    records: NormalizedUsageRecord[],
  ): ProviderUsageSummary[] {
    const summaries = definitions.map((provider) =>
      this.aggregator.provider(
        provider,
        records.filter((record) => record.providerId === provider.id),
      ),
    );
    const configuredIds = new Set(definitions.map((provider) => provider.id));
    const dynamicIds = [...new Set(records.map((record) => record.providerId))].filter((id) => !configuredIds.has(id));
    for (const id of dynamicIds) {
      const group = records.filter((record) => record.providerId === id);
      summaries.push(
        this.aggregator.provider(
          {
            id,
            label: group[0]?.providerLabel ?? this.codec.humanize(id),
            usageSource: { kind: 'meterable', providerId: id },
          },
          group,
        ),
      );
    }
    return summaries;
  }

  private async limits(definitions: UsageProviderDefinition[]): Promise<Record<string, UsageLimitSnapshot | null>> {
    const limits: Record<string, UsageLimitSnapshot | null> = {};
    for (const provider of definitions) {
      limits[provider.id] = provider.limitSource
        ? this.codec.snapshot(await this.repository.setting(provider.limitSource.key, null))
        : null;
    }
    return limits;
  }
}
