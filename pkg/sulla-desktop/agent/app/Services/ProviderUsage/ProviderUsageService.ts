// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';
import type { ProviderUsageStore } from '../../Repositories/ProviderUsageRepository';
import type { CliUsageRecord, UsageLimitSnapshot, UsageProviderDefinition, UsageSummary } from './ProviderUsageTypes';
import { UsageRecordCodec } from './UsageRecordCodec';
import { UsageSummaryBuilder } from './UsageSummaryBuilder';
import { UsageWriteQueue } from './UsageWriteQueue';

const RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 10_000;

export class ProviderUsageService extends Service {
  constructor(
    private readonly repository: ProviderUsageStore,
    private readonly queue: UsageWriteQueue,
    private readonly summaryBuilder: UsageSummaryBuilder,
    private readonly codec: UsageRecordCodec,
    private readonly providers: Readonly<Record<string, UsageProviderDefinition>>,
    private readonly now: () => Date,
  ) {
    super();
  }

  async record(providerId: string, record: Omit<CliUsageRecord, 'ts'> & { ts?: string }): Promise<void> {
    const provider = this.providers[providerId];
    const key = provider?.usageSource.kind === 'settings' ? provider.usageSource.key : `${providerId}Usage`;
    await this.queue.enqueue(key, async () => {
      const records = this.codec.records(await this.repository.setting(key, '[]'));
      const entry = this.codec.sanitize({ ...record, ts: record.ts ?? this.now().toISOString() });
      const cutoff = this.now().getTime() - RETENTION_MS;
      const retained = [...records, entry]
        .filter((item) => Number.isFinite(Date.parse(item.ts)) && Date.parse(item.ts) >= cutoff)
        .slice(-MAX_RECORDS);
      await this.repository.saveSetting(key, JSON.stringify(retained));
    });
  }

  async recordLimit(providerId: string, snapshot: UsageLimitSnapshot): Promise<void> {
    const key = this.providers[providerId]?.limitSource?.key ?? `${providerId}LimitSnapshot`;
    await this.queue.enqueue(key, async () => {
      const current = this.codec.snapshot(await this.repository.setting(key, null));
      const merged = new Map(current?.windows.map((window) => [window.id, window]) ?? []);
      for (const window of snapshot.windows) {
        merged.set(window.id, window);
      }
      const value = {
        providerId,
        capturedAt: snapshot.capturedAt,
        windows: [...merged.values()],
      } satisfies UsageLimitSnapshot;
      await this.repository.saveSetting(key, JSON.stringify(value));
    });
  }

  summary(hours = 24, profileId = 'default', providerFilter?: string): Promise<UsageSummary> {
    return this.summaryBuilder.build(hours, profileId, providerFilter);
  }
}
