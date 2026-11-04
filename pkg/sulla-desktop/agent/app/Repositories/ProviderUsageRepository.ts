// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Repository, type Connection } from '@sulla/foundation';

import { ProviderUsageEntry } from '../Models/ProviderUsageEntry';
import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import { MeterableUsageModel } from '../../database/models/MeterableUsageModel';
import type { MeterableUsageRow } from '../Services/ProviderUsage/ProviderUsageTypes';

export interface ProviderUsageStore {
  setting(key: string, fallback: unknown): Promise<unknown>;
  saveSetting(key: string, value: string): Promise<void>;
  meterableRecords(profileId: string, since: Date): Promise<MeterableUsageRow[]>;
}
export class ProviderUsageRepository extends Repository<ProviderUsageEntry> implements ProviderUsageStore {
  protected readonly model = ProviderUsageEntry;
  constructor(connection: Connection) { super(connection) }
  setting(key: string, fallback: unknown): Promise<unknown> { return SullaSettingsModel.get(key, fallback) }
  saveSetting(key: string, value: string): Promise<void> { return SullaSettingsModel.set(key, value) }
  async meterableRecords(profileId: string, since: Date): Promise<MeterableUsageRow[]> {
    return MeterableUsageModel.records(profileId, since);
  }
}
