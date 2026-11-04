// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = new Map<string, unknown>();
const meterableRecords: Array<Record<string, any>> = [];

vi.mock('../../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: {
    get: vi.fn(async(key: string, fallback: unknown) => settings.has(key) ? settings.get(key) : fallback),
    set: vi.fn(async(key: string, value: unknown) => { settings.set(key, value) }),
  },
}));

vi.mock('../../../database/models/MeterableUsageModel', () => ({
  MeterableUsageModel: { records: vi.fn(async() => meterableRecords) },
}));

import {
  getUsageSummary,
  normalizeClaudeLimitSnapshot,
  normalizeCodexLimitSnapshot,
} from '../../../usage/providerUsage';

describe('provider usage characterization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T06:00:00.000Z'));
    settings.clear();
    meterableRecords.length = 0;
  });

  afterEach(() => vi.useRealTimers());

  it('pins Claude and Codex limit normalization golden outputs', () => {
    // risk: provider payload changes silently corrupt displayed quota windows
    expect(normalizeClaudeLimitSnapshot({
      type: 'rate_limit_update',
      rate_limit: {
        five_hour: { utilization: 0.42, reset_time: 1_794_000_000, limit_window_seconds: 18_000 },
        seven_day_sonnet: { used_percentage: 87, resets_at: '2026-11-09T00:00:00Z' },
      },
    })).toEqual({
      providerId: 'claude-code',
      capturedAt: '2026-11-04T06:00:00.000Z',
      windows: [
        { id: 'five_hour', label: '5-hour', usedPercent: 42, resetsAt: '2026-11-06T18:40:00.000Z', windowMinutes: 300 },
        { id: 'seven_day_sonnet', label: 'Weekly · Sonnet', usedPercent: 87, resetsAt: '2026-11-09T00:00:00.000Z', windowMinutes: undefined },
      ],
    });
    expect(normalizeCodexLimitSnapshot({ msg: { info: { rate_limits: {
      primary_window: { used_percent: 25, reset_at: '2026-11-04T10:00:00Z' },
      secondary: { percent_used: 60, window_minutes: 10_080 },
    } } } })).toEqual({
      providerId: 'codex',
      capturedAt: '2026-11-04T06:00:00.000Z',
      windows: [
        { id: 'primary_window', label: 'Primary', usedPercent: 25, resetsAt: '2026-11-04T10:00:00.000Z', windowMinutes: undefined },
        { id: 'secondary', label: 'Weekly', usedPercent: 60, resetsAt: undefined, windowMinutes: 10_080 },
      ],
    });
  });

  it('pins mixed settings and ledger aggregation golden output', async() => {
    // risk: usage totals and estimated spend become inaccurate during extraction
    settings.set('claudeCodeUsage', JSON.stringify([
      { ts: '2026-11-04T05:00:00.000Z', model: 'claude-sonnet-4', input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 200_000 },
      { ts: '2026-11-02T05:00:00.000Z', model: 'old', total_tokens: 999 },
    ]));
    meterableRecords.push({
      created_at: '2026-11-04T04:00:00.000Z', quantity: 500_000, source: 'model:openai',
      metadata: { provider: 'openai', model: 'gpt-5-mini', input_tokens: 400_000, output_tokens: 100_000, cached_input_tokens: 50_000 },
    }, {
      created_at: '2026-11-04T03:00:00.000Z', quantity: 10, source: 'model:acme',
      metadata: { provider: 'acme', model: 'custom-v1', cost_usd: 0.25 },
    });

    const summary = await getUsageSummary(24, 'profile-1');
    expect({
      windowHours: summary.windowHours,
      profileId: summary.profileId,
      totals: summary.totals,
      providers: summary.providers.filter(provider => provider.records > 0),
      models: summary.models,
      daily: summary.daily,
    }).toEqual({
      windowHours: 24,
      profileId: 'profile-1',
      totals: { totalTokens: 1_600_010, inputTokens: 1_400_000, outputTokens: 200_000, cacheReadTokens: 250_000, cacheWriteTokens: 0, estimatedCostUsd: 6.06625, cacheSavingsUsd: 0.59625, pricedTokens: 1_600_000 },
      providers: [
        { id: 'claude-code', label: 'Claude Code', records: 1, totalTokens: 1_100_000, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 200_000, cacheWriteTokens: 0, estimatedCostUsd: 4.56, cacheSavingsUsd: 0.54, pricedTokens: 1_100_000 },
        { id: 'openai', label: 'OpenAI API', records: 1, totalTokens: 500_000, inputTokens: 400_000, outputTokens: 100_000, cacheReadTokens: 50_000, cacheWriteTokens: 0, estimatedCostUsd: 1.50625, cacheSavingsUsd: 0.05625, pricedTokens: 500_000 },
        { id: 'acme', label: 'Acme', records: 1, totalTokens: 10, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, cacheSavingsUsd: 0, pricedTokens: 0 },
      ],
      models: expect.any(Array),
      daily: expect.any(Array),
    });
    expect(summary.models.map(model => [model.providerId, model.model, model.totalTokens])).toEqual([
      ['claude-code', 'claude-sonnet-4', 1_100_000], ['openai', 'gpt-5-mini', 500_000], ['acme', 'custom-v1', 10],
    ]);
    expect(summary.daily.at(-1)?.totalTokens).toBe(1_600_010);
  });
});
