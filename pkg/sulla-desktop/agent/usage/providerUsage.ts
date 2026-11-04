// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { providerUsageProvider, USAGE_PROVIDER_REGISTRY } from '../app/Providers/ProviderUsageServiceProvider';
import type { CliUsageRecord, UsageLimitSnapshot } from '../app/Services/ProviderUsage/ProviderUsageTypes';

export { USAGE_PROVIDER_REGISTRY };
export type {
  CliUsageRecord,
  DailyUsageSummary,
  ModelUsageSummary,
  ProviderUsageSummary,
  UsageAggregate,
  UsageLimitSnapshot,
  UsageLimitWindow,
  UsageProviderDefinition,
  UsageSummary,
} from '../app/Services/ProviderUsage/ProviderUsageTypes';

export function recordCliUsage(
  providerId: string,
  record: Omit<CliUsageRecord, 'ts'> & { ts?: string },
): Promise<void> {
  return providerUsageProvider.usage.record(providerId, record);
}
export function recordCliLimitSnapshot(providerId: string, snapshot: UsageLimitSnapshot): Promise<void> {
  return providerUsageProvider.usage.recordLimit(providerId, snapshot);
}
export function normalizeClaudeLimitSnapshot(event: unknown): UsageLimitSnapshot | null {
  return providerUsageProvider.limits.normalize('claude-code', event);
}
export function normalizeCodexLimitSnapshot(event: unknown): UsageLimitSnapshot | null {
  return providerUsageProvider.limits.normalize('codex', event);
}
export function getUsageSummary(hours = 24, profileId = 'default', providerFilter?: string) {
  return providerUsageProvider.usage.summary(hours, profileId, providerFilter);
}
