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
});
