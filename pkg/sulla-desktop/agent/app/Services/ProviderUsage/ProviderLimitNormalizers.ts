// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { UsageLimitSnapshot, UsageLimitWindow } from './ProviderUsageTypes';
import { UsageRecordCodec } from './UsageRecordCodec';

export interface ProviderLimitNormalizer {
  readonly providerId: string;
  normalize(event: unknown): UsageLimitSnapshot | null;
}
abstract class BaseLimitNormalizer implements ProviderLimitNormalizer {
  abstract readonly providerId: string;
  constructor(
    protected readonly codec: UsageRecordCodec,
    private readonly now: () => Date,
  ) {}
  abstract normalize(event: unknown): UsageLimitSnapshot | null;
  protected result(windows: UsageLimitWindow[]): UsageLimitSnapshot | null {
    return windows.length ? { providerId: this.providerId, capturedAt: this.now().toISOString(), windows } : null;
  }
  protected collect(source: Record<string, unknown>, keys: Array<[string, string]>): UsageLimitWindow[] {
    const windows: UsageLimitWindow[] = [];
    const seen = new Set<string>();
    for (const [key, label] of keys) {
      if (seen.has(key) || !this.codec.object(source[key])) continue;
      const parsed = this.codec.window(source[key], key, label);
      if (parsed) windows.push(parsed);
      seen.add(key);
    }
    return windows;
  }
}
export class ClaudeLimitNormalizer extends BaseLimitNormalizer {
  readonly providerId = 'claude-code';
  normalize(event: unknown): UsageLimitSnapshot | null {
    if (!this.codec.object(event)) return null;
    const type = String(event.type ?? event.event ?? '').toLowerCase();
    const payload = [event.rate_limit, event.rate_limit_info, event.rate_limits, event.data].find((value) =>
      this.codec.object(value),
    ) as Record<string, unknown> | undefined;
    if (!type.includes('rate_limit') && !payload) return null;
    const source = payload ?? event;
    const windows = this.collect(source, [
      ['five_hour', '5-hour'],
      ['fiveHour', '5-hour'],
      ['primary', 'Primary'],
      ['weekly', 'Weekly'],
      ['seven_day', 'Weekly'],
      ['seven_day_opus', 'Weekly · Opus'],
      ['seven_day_sonnet', 'Weekly · Sonnet'],
      ['secondary', 'Secondary'],
    ]);
    if (!windows.length) {
      const single = this.codec.window(source, String(source.rate_limit_type ?? source.window ?? 'current'));
      if (single) windows.push(single);
    }
    return this.result(windows);
  }
}
export class CodexLimitNormalizer extends BaseLimitNormalizer {
  readonly providerId = 'codex';
  normalize(event: unknown): UsageLimitSnapshot | null {
    if (!this.codec.object(event)) return null;
    const msg = this.codec.object(event.msg) ? event.msg : undefined;
    const info = this.codec.object(msg?.info) ? msg.info : undefined;
    const usage = this.codec.object(event.usage) ? event.usage : undefined;
    const payload = [event.rate_limits, usage?.rate_limits, msg?.rate_limits, info?.rate_limits].find((value) =>
      this.codec.object(value),
    ) as Record<string, unknown> | undefined;
    return payload
      ? this.result(
          this.collect(payload, [
            ['primary', 'Primary'],
            ['primary_window', 'Primary'],
            ['secondary', 'Secondary'],
            ['secondary_window', 'Secondary'],
          ]),
        )
      : null;
  }
}
export class ProviderLimitNormalizerRegistry {
  private readonly strategies: ReadonlyMap<string, ProviderLimitNormalizer>;
  constructor(strategies: ProviderLimitNormalizer[]) {
    this.strategies = new Map(strategies.map((strategy) => [strategy.providerId, strategy]));
  }
  normalize(providerId: string, event: unknown): UsageLimitSnapshot | null {
    return this.strategies.get(providerId)?.normalize(event) ?? null;
  }
}
