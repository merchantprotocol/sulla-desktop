// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// The Postgres seams the frozen v3 sync runner uses (DESIGN-V6 D3). Injected into
// CloudVaultSyncRunner so tests can wrap or record them; defaults are the real classes.

import { PendingEditView } from './repositories/PendingEditView.js';
import { PostgresPersonalItemRepository } from './repositories/PostgresPersonalItemRepository.js';
import { PostgresSyncAccountReader } from './repositories/PostgresSyncAccountReader.js';
import { PostgresSyncStateRepository } from './repositories/PostgresSyncStateRepository.js';
import { PostgresSyncTransaction } from './repositories/PostgresSyncTransaction.js';
import { PostgresVerifiedRecordSet } from './repositories/PostgresVerifiedRecordSet.js';
import { SyncAuditEventDispatcher } from './repositories/SyncAuditEventDispatcher.js';

export class CloudSyncRepositories {
  constructor(
    readonly state: PostgresSyncStateRepository = new PostgresSyncStateRepository(),
    readonly records: PostgresVerifiedRecordSet = new PostgresVerifiedRecordSet(),
    readonly items: PostgresPersonalItemRepository = new PostgresPersonalItemRepository(),
    readonly pending: PendingEditView = new PendingEditView(),
    readonly audit: SyncAuditEventDispatcher = new SyncAuditEventDispatcher(),
    readonly accounts: PostgresSyncAccountReader = new PostgresSyncAccountReader(),
    readonly transaction: PostgresSyncTransaction = new PostgresSyncTransaction(),
  ) {}
}
