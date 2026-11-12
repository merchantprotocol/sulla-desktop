// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// audit_log rows for sync events (DESIGN-V6 D3: pure move). Metadata is always empty.

import type { Queryable } from '../../../db.js';

export type SyncAuditAction =
  | 'cloud_sync_item_deleted' | 'cloud_sync_conflict_copy' | 'cloud_sync_policy_held'
  | 'cloud_sync_item_updated' | 'cloud_sync_item_created';

export class SyncAuditEventDispatcher {
  async record(q: Queryable, userId: string, action: SyncAuditAction, itemId: string | null): Promise<void> {
    await q.query(`INSERT INTO audit_log(actor_user_id,item_id,action,metadata,blocked) VALUES ($1,$2,$3,'{}'::jsonb,false)`, [userId, itemId, action]);
  }
}
