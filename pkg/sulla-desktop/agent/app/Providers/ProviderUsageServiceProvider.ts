// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { DesktopPostgresConnection } from '../Database/DesktopPostgresConnection';
import { ProviderUsageRepository } from '../Repositories/ProviderUsageRepository';
import {
  ProviderLimitNormalizerRegistry,
  ClaudeLimitNormalizer,
  CodexLimitNormalizer,
} from '../Services/ProviderUsage/ProviderLimitNormalizers';
import { ProviderUsageService } from '../Services/ProviderUsage/ProviderUsageService';
import type { UsageProviderDefinition } from '../Services/ProviderUsage/ProviderUsageTypes';
import { PricingCatalog } from '../Services/ProviderUsage/PricingCatalog';
import { UsageRecordCodec } from '../Services/ProviderUsage/UsageRecordCodec';
import {
  MeterableUsageNormalizer,
  SettingsUsageNormalizer,
  UsageSourceNormalizerRegistry,
} from '../Services/ProviderUsage/UsageSourceStrategies';
import { UsageWriteQueue } from '../Services/ProviderUsage/UsageWriteQueue';
import { UsageAggregator } from '../Services/ProviderUsage/UsageAggregator';
import { UsageSummaryBuilder } from '../Services/ProviderUsage/UsageSummaryBuilder';
import { postgresClient } from '../../database/PostgresClient';

export const USAGE_PROVIDER_REGISTRY: Readonly<Record<string, UsageProviderDefinition>> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    usageSource: { kind: 'settings', key: 'claudeCodeUsage' },
    limitSource: { kind: 'settings', key: 'claudeCodeLimitSnapshot' },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    usageSource: { kind: 'settings', key: 'codexUsage' },
    limitSource: { kind: 'settings', key: 'codexLimitSnapshot' },
  },
  opencode: { id: 'opencode', label: 'OpenCode', usageSource: { kind: 'settings', key: 'opencodeUsage' } },
  cursor: { id: 'cursor', label: 'Cursor', usageSource: { kind: 'settings', key: 'cursorUsage' } },
  grok: { id: 'grok', label: 'Grok', usageSource: { kind: 'meterable', providerId: 'grok' } },
  anthropic: { id: 'anthropic', label: 'Anthropic API', usageSource: { kind: 'meterable', providerId: 'anthropic' } },
  openai: { id: 'openai', label: 'OpenAI API', usageSource: { kind: 'meterable', providerId: 'openai' } },
  google: { id: 'google', label: 'Google API', usageSource: { kind: 'meterable', providerId: 'google' } },
  kimi: { id: 'kimi', label: 'Kimi API', usageSource: { kind: 'meterable', providerId: 'kimi' } },
  nvidia: { id: 'nvidia', label: 'NVIDIA API', usageSource: { kind: 'meterable', providerId: 'nvidia' } },
  alibaba: { id: 'alibaba', label: 'Alibaba API', usageSource: { kind: 'meterable', providerId: 'alibaba' } },
  cohere: { id: 'cohere', label: 'Cohere API', usageSource: { kind: 'meterable', providerId: 'cohere' } },
  deepseek: { id: 'deepseek', label: 'DeepSeek API', usageSource: { kind: 'meterable', providerId: 'deepseek' } },
  arcee: { id: 'arcee', label: 'Arcee API', usageSource: { kind: 'meterable', providerId: 'arcee' } },
  custom: { id: 'custom', label: 'Custom API', usageSource: { kind: 'meterable', providerId: 'custom' } },
};
export class ProviderUsageServiceProvider {
  readonly queue = new UsageWriteQueue();
  readonly usage: ProviderUsageService;
  readonly limits: ProviderLimitNormalizerRegistry;
  constructor() {
    const codec = new UsageRecordCodec();
    const repository = new ProviderUsageRepository(new DesktopPostgresConnection(postgresClient));
    const meterable = new MeterableUsageNormalizer(codec);
    const now = () => new Date();
    const pricing = new PricingCatalog(codec);
    const aggregator = new UsageAggregator(pricing, codec, now);
    const sources = new UsageSourceNormalizerRegistry([new SettingsUsageNormalizer(repository, codec), meterable]);
    const summaryBuilder = new UsageSummaryBuilder(
      repository,
      sources,
      meterable,
      aggregator,
      codec,
      USAGE_PROVIDER_REGISTRY,
      now,
    );
    this.queue.start();
    this.usage = new ProviderUsageService(repository, this.queue, summaryBuilder, codec, USAGE_PROVIDER_REGISTRY, now);
    this.limits = new ProviderLimitNormalizerRegistry([
      new ClaudeLimitNormalizer(codec, now),
      new CodexLimitNormalizer(codec, now),
    ]);
  }

  dispose(): Promise<void> {
    return this.queue.dispose();
  }
}
export const providerUsageProvider = new ProviderUsageServiceProvider();
