// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface CliUsageRecord {
  ts: string; model?: string; input_tokens?: number; output_tokens?: number; total_tokens?: number;
  cached_input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number;
  cost_usd?: number; duration_ms?: number;
}
export interface UsageLimitWindow { id: string; label: string; usedPercent: number; resetsAt?: string; windowMinutes?: number }
export interface UsageLimitSnapshot { providerId: string; capturedAt: string; windows: UsageLimitWindow[] }
export type UsageSource = { kind: 'settings'; key: string } | { kind: 'meterable'; providerId: string };
export interface UsageProviderDefinition { id: string; label: string; usageSource: UsageSource; limitSource?: { kind: 'settings'; key: string } }
export interface UsageAggregate { totalTokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estimatedCostUsd: number; cacheSavingsUsd: number; pricedTokens: number }
export interface ProviderUsageSummary extends UsageAggregate { id: string; label: string; records: number }
export interface ModelUsageSummary extends UsageAggregate { providerId: string; providerLabel: string; model: string; records: number; cacheHitRate: number; estimatedCostPerMillionTokens: number | null }
export interface DailyUsageSummary extends UsageAggregate { date: string; providers: Array<{ id: string; label: string; totalTokens: number }> }
export interface UsageSummary { generatedAt: string; windowHours: number; profileId: string; totals: UsageAggregate; providers: ProviderUsageSummary[]; models: ModelUsageSummary[]; daily: DailyUsageSummary[]; limits: Record<string, UsageLimitSnapshot | null> }
export interface NormalizedUsageRecord extends CliUsageRecord { providerId: string; providerLabel: string }
export interface MeterableUsageRow { quantity: number; source: string; metadata: Record<string, unknown>; created_at: string }
