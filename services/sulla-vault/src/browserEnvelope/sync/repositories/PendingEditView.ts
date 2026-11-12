// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Derived counts for Desktop > Profile sync status (DESIGN-V6 D3: pure move).
// Pending edits are derived from item revisions vs the verified ledger, never stored.

import type { Queryable } from '../../../db.js';

export class PendingEditView {
  /** Records held for the owner's review (policy widening). */
  async policyReviewCount(q: Queryable, userId: string): Promise<string | undefined> {
    const review = await q.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM cloud_vault_sync_records WHERE owner_user_id=$1 AND policy_review_pending`, [userId],
    );
    return review.rows[0]?.n;
  }

  /** Local edits Cloud doesn't have yet: main debounces a push when this is non-zero. */
  async pendingChangeCount(q: Queryable, userId: string): Promise<string | undefined> {
    const pending = await q.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM items i
           LEFT JOIN cloud_vault_sync_records r ON r.owner_user_id=i.owner_user_id AND r.scope='personal' AND r.record_id=i.id
          WHERE i.owner_user_id=$1 AND i.collection_id IS NULL AND r.policy_review_pending IS NOT TRUE
            AND ((i.deleted_at IS NULL AND (r.record_id IS NULL OR r.deleted OR r.local_revision IS DISTINCT FROM i.revision))
              OR (i.deleted_at IS NOT NULL AND r.record_id IS NOT NULL AND NOT r.deleted))`, [userId],
    );
    return pending.rows[0]?.n;
  }
}
