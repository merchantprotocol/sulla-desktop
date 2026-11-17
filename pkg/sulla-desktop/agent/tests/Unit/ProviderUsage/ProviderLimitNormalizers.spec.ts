// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { ClaudeLimitNormalizer, CodexLimitNormalizer, ProviderLimitNormalizerRegistry } from '../../../app/Services/ProviderUsage/ProviderLimitNormalizers';
import { UsageRecordCodec } from '../../../app/Services/ProviderUsage/UsageRecordCodec';

describe('ProviderLimitNormalizerRegistry', () => {
  it('routes provider payloads to their shape strategy without cross-normalizing', () => {
    // risk: one provider's quota payload is attributed to another provider
    const codec = new UsageRecordCodec(); const now = () => new Date('2026-11-04T06:00:00Z');
    const registry = new ProviderLimitNormalizerRegistry([new ClaudeLimitNormalizer(codec, now), new CodexLimitNormalizer(codec, now)]);
    expect(registry.normalize('claude-code', { rate_limit: { weekly: { used: 0.5 } } })?.windows[0].usedPercent).toBe(50);
    expect(registry.normalize('codex', { rate_limits: { primary: { used_percent: 12 } } })?.windows[0].usedPercent).toBe(12);
    expect(registry.normalize('unknown', {})).toBeNull();
  });
  it('captures Codex token_count limits from the item event envelope with 5-hour and weekly labels', () => {
    // risk: provider quota pacing is unavailable or misreads weekly as session usage
    const codec = new UsageRecordCodec(); const now = () => new Date('2026-11-04T06:00:00Z');
    const registry = new ProviderLimitNormalizerRegistry([new CodexLimitNormalizer(codec, now)]);
    const result = registry.normalize('codex', { type: 'item.completed', item: { type: 'token_count', info: { rate_limits: {
      primary: { used_percent: 42, reset_at: '2026-11-04T11:00:00Z' },
      secondary: { used_percent: 18, reset_at: '2026-11-11T06:00:00Z' },
    } } } });
    expect(result?.windows.map(window => [window.label, window.usedPercent])).toEqual([['5-hour', 42], ['Weekly', 18]]);
  });
});
