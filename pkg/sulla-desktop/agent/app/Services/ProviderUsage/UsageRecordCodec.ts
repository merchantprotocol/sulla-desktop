// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { CliUsageRecord, UsageLimitSnapshot, UsageLimitWindow } from './ProviderUsageTypes';

export class UsageRecordCodec {
  finite(value: unknown): number { const number = typeof value === 'number' ? value : Number(value); return Number.isFinite(number) ? number : 0 }
  sanitize(record: CliUsageRecord): CliUsageRecord {
    const optional = (value: unknown) => value === undefined || value === null || value === '' ? undefined : this.finite(value);
    return { ts: typeof record.ts === 'string' ? record.ts : new Date().toISOString(), model: typeof record.model === 'string' ? record.model : undefined,
      input_tokens: optional(record.input_tokens), output_tokens: optional(record.output_tokens), total_tokens: optional(record.total_tokens),
      cached_input_tokens: optional(record.cached_input_tokens), cache_creation_input_tokens: optional(record.cache_creation_input_tokens),
      cache_read_input_tokens: optional(record.cache_read_input_tokens), cost_usd: optional(record.cost_usd), duration_ms: optional(record.duration_ms) };
  }
  records(raw: unknown): CliUsageRecord[] {
    const parsed = typeof raw === 'string' ? this.json(raw) : raw;
    return Array.isArray(parsed) ? parsed.filter(item => this.object(item)).map(item => this.sanitize(item as CliUsageRecord)) : [];
  }
  snapshot(raw: unknown): UsageLimitSnapshot | null {
    const parsed = typeof raw === 'string' ? this.json(raw) : raw;
    if (!this.object(parsed) || !Array.isArray(parsed.windows)) return null;
    const windows = parsed.windows.filter(item => this.object(item)).map(item => this.window(item, String(item.id ?? 'window'), typeof item.label === 'string' ? item.label : undefined)).filter(Boolean) as UsageLimitWindow[];
    return windows.length ? { providerId: String(parsed.providerId ?? ''), capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : new Date().toISOString(), windows } : null;
  }
  window(source: Record<string, any>, id: string, label?: string): UsageLimitWindow | null {
    let used = this.finite(source.usedPercent ?? source.used_percentage ?? source.used_percent ?? source.percent_used ?? source.utilization ?? source.used);
    if (used > 0 && used <= 1 && source.usedPercent === undefined && source.used_percentage === undefined && source.used_percent === undefined && source.percent_used === undefined) used *= 100;
    const keys = ['usedPercent', 'used_percentage', 'used_percent', 'percent_used', 'utilization', 'used'];
    if (!Number.isFinite(used) || (used === 0 && !keys.some(key => key in source))) return null;
    const resets = source.resets_at ?? source.reset_at ?? source.reset_time ?? source.resetsAt ?? source.resetAt;
    const minutes = this.finite(source.window_minutes ?? source.windowMinutes ?? source.limit_window_seconds) / (source.limit_window_seconds ? 60 : 1);
    const derived = minutes === 300 ? '5-hour' : minutes === 10_080 ? 'Weekly' : undefined;
    return { id, label: derived ?? label ?? this.limitLabel(id), usedPercent: Math.max(0, Math.min(100, used)), resetsAt: this.resetTime(resets), windowMinutes: minutes || undefined };
  }
  object(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
  humanize(value: string): string { return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) }
  private json(value: string): unknown { try { return JSON.parse(value) } catch { return null } }
  private resetTime(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
    if (typeof value === 'string' && value.trim()) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value }
    return undefined;
  }
  private limitLabel(value: string): string { if (/five.?hour|session/i.test(value)) return '5-hour'; if (/week|seven.?day/i.test(value)) return 'Weekly'; return this.humanize(value) }
}
