// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { CliUsageRecord } from './ProviderUsageTypes';
import { UsageRecordCodec } from './UsageRecordCodec';

interface ModelPrice { input: number; output: number; cacheRead?: number; cacheWrite?: number }
export interface CostEstimate { cost: number; cacheSavings: number; priced: boolean }
export class PricingCatalog {
  private readonly prices: ReadonlyArray<readonly [RegExp, ModelPrice]> = [
    [/claude.*opus/i, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
    [/claude.*sonnet/i, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
    [/claude.*haiku/i, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
    [/gpt-5/i, { input: 1.25, output: 10, cacheRead: 0.125 }], [/gpt-4\.1/i, { input: 2, output: 8, cacheRead: 0.5 }],
    [/gpt-4o/i, { input: 2.5, output: 10, cacheRead: 1.25 }], [/grok.*fast/i, { input: 0.2, output: 0.5, cacheRead: 0.05 }],
    [/grok/i, { input: 3, output: 15, cacheRead: 0.75 }], [/gemini.*flash/i, { input: 0.3, output: 2.5, cacheRead: 0.03 }],
    [/gemini.*pro/i, { input: 1.25, output: 10, cacheRead: 0.125 }], [/deepseek/i, { input: 0.28, output: 0.42, cacheRead: 0.028 }],
  ];
  constructor(private readonly codec: UsageRecordCodec) {}
  estimate(record: CliUsageRecord, total: number, input: number, output: number, cacheRead: number, cacheWrite: number): CostEstimate {
    const price = this.prices.find(([pattern]) => pattern.test(record.model ?? ''))?.[1];
    if (!price) { const recorded = this.codec.finite(record.cost_usd); return { cost: recorded, cacheSavings: 0, priced: recorded > 0 } }
    const readRate = price.cacheRead ?? price.input; const writeRate = price.cacheWrite ?? price.input;
    const estimatedInput = input === 0 && output === 0 ? total : input;
    return { cost: ((estimatedInput * price.input) + (output * price.output) + (cacheRead * readRate) + (cacheWrite * writeRate)) / 1_000_000,
      cacheSavings: cacheRead * Math.max(0, price.input - readRate) / 1_000_000, priced: true };
  }
}
