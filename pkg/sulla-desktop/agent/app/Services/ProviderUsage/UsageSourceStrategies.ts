// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ProviderUsageStore } from '../../Repositories/ProviderUsageRepository';
import type {
  MeterableUsageRow,
  NormalizedUsageRecord,
  UsageProviderDefinition,
  UsageSource,
} from './ProviderUsageTypes';
import { UsageRecordCodec } from './UsageRecordCodec';

export interface UsageSourceContext {
  since: Date;
  meterable: MeterableUsageRow[];
}
export interface UsageSourceNormalizer {
  supports(source: UsageSource): boolean;
  normalize(provider: UsageProviderDefinition, context: UsageSourceContext): Promise<NormalizedUsageRecord[]>;
}
export class SettingsUsageNormalizer implements UsageSourceNormalizer {
  constructor(
    private readonly repository: ProviderUsageStore,
    private readonly codec: UsageRecordCodec,
  ) {}
  supports(source: UsageSource): boolean {
    return source.kind === 'settings';
  }
  async normalize(provider: UsageProviderDefinition, context: UsageSourceContext): Promise<NormalizedUsageRecord[]> {
    const source = provider.usageSource as Extract<UsageSource, { kind: 'settings' }>;
    const records = this.codec.records(await this.repository.setting(source.key, '[]'));
    return records
      .filter((record) => Date.parse(record.ts) >= context.since.getTime())
      .map((record) => ({ ...record, providerId: provider.id, providerLabel: provider.label }));
  }
}
export class MeterableUsageNormalizer implements UsageSourceNormalizer {
  constructor(private readonly codec: UsageRecordCodec) {}
  supports(source: UsageSource): boolean {
    return source.kind === 'meterable';
  }
  async normalize(provider: UsageProviderDefinition, context: UsageSourceContext): Promise<NormalizedUsageRecord[]> {
    const source = provider.usageSource as Extract<UsageSource, { kind: 'meterable' }>;
    return context.meterable
      .filter((record) => this.providerId(record) === source.providerId)
      .map((record) => this.convert(record, provider));
  }
  providerId(record: MeterableUsageRow): string {
    const metadata = record.metadata;
    return typeof metadata.provider === 'string' && metadata.provider
      ? metadata.provider
      : record.source.replace(/^model:/, '');
  }
  convert(record: MeterableUsageRow, provider: UsageProviderDefinition): NormalizedUsageRecord {
    const metadata = record.metadata ?? {};
    const input = this.codec.finite(metadata.input_tokens ?? metadata.prompt_tokens);
    const output = this.codec.finite(metadata.output_tokens ?? metadata.completion_tokens);
    return {
      ...this.codec.sanitize({
        ts: record.created_at,
        model: typeof metadata.model === 'string' ? metadata.model : undefined,
        input_tokens: input || undefined,
        output_tokens: output || undefined,
        total_tokens: Number(record.quantity),
        cached_input_tokens: this.codec.finite(metadata.cached_input_tokens) || undefined,
        cache_read_input_tokens: this.codec.finite(metadata.cache_read_input_tokens) || undefined,
        cache_creation_input_tokens: this.codec.finite(metadata.cache_creation_input_tokens) || undefined,
      }),
      providerId: provider.id,
      providerLabel: provider.label,
    };
  }
}
export class UsageSourceNormalizerRegistry {
  constructor(private readonly strategies: UsageSourceNormalizer[]) {}
  normalize(provider: UsageProviderDefinition, context: UsageSourceContext): Promise<NormalizedUsageRecord[]> {
    const strategy = this.strategies.find((candidate) => candidate.supports(provider.usageSource));
    if (!strategy) throw new Error(`No usage normalizer for ${provider.usageSource.kind}`);
    return strategy.normalize(provider, context);
  }
}
