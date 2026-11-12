// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Personal `items` (collection_id IS NULL) as the frozen v3 sync runner reads and
// writes them (DESIGN-V6 D3: pure move). Ciphertext is stored exactly as given.

import type { AgentPolicy } from '@sulla/vault-crypto';

import type { Queryable } from '../../../db.js';

export interface LockedPersonalItem {
  revision: string; deleted_at: string | null; agent_policy: AgentPolicy; integration_ref: string | null;
  ciphertext: unknown; encrypted_item_key: unknown; item_type: string;
}
export interface UploadItemRow { id: string; revision: string; ciphertext: unknown; encrypted_item_key: unknown }
export interface CommitItemRow extends UploadItemRow { deleted_at: string | null }

export class PostgresPersonalItemRepository {
  async lockForApply(q: Queryable, userId: string, itemId: string): Promise<LockedPersonalItem | undefined> {
    return (await q.query<LockedPersonalItem>(
      `SELECT revision,deleted_at,agent_policy,integration_ref,ciphertext,encrypted_item_key,item_type
         FROM items WHERE id=$1 AND owner_user_id=$2 AND collection_id IS NULL FOR UPDATE`, [itemId, userId],
    )).rows[0];
  }

  /** Returns the new revision. */
  async softDelete(q: Queryable, userId: string, itemId: string): Promise<string | undefined> {
    const res = await q.query<{ revision: string }>(
      `UPDATE items SET deleted_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 AND owner_user_id=$2 RETURNING revision`, [itemId, userId],
    );
    return res.rows[0]?.revision;
  }

  async insertConflictCopy(q: Queryable, userId: string, copyId: string, itemType: string, ciphertext: unknown, encryptedItemKey: unknown, policy: AgentPolicy): Promise<void> {
    await q.query(
      `INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref) VALUES ($1,$2,$3,$4,$5,$6,NULL)`,
      [copyId, userId, itemType, ciphertext, encryptedItemKey, policy],
    );
  }

  /** Returns the new revision. */
  async replaceFromCloud(q: Queryable, userId: string, itemId: string, itemType: string, ciphertext: unknown, encryptedItemKey: unknown, policy: AgentPolicy): Promise<string | undefined> {
    const res = await q.query<{ revision: string }>(
      `UPDATE items SET item_type=$3,ciphertext=$4,encrypted_item_key=$5,agent_policy=$6,deleted_at=NULL,revision=revision+1,updated_at=now()
          WHERE id=$1 AND owner_user_id=$2 RETURNING revision`,
      [itemId, userId, itemType, ciphertext, encryptedItemKey, policy],
    );
    return res.rows[0]?.revision;
  }

  /** Returns the new revision. */
  async insertFromCloud(q: Queryable, userId: string, itemId: string, itemType: string, ciphertext: unknown, encryptedItemKey: unknown, policy: AgentPolicy): Promise<string | undefined> {
    const res = await q.query<{ revision: string }>(
      `INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref)
         VALUES ($1,$2,$3,$4,$5,$6,NULL) RETURNING revision`,
      [itemId, userId, itemType, ciphertext, encryptedItemKey, policy],
    );
    return res.rows[0]?.revision;
  }

  /** Live personal items for an enable/replace upload, in id order. */
  async listLive(q: Queryable, userId: string): Promise<UploadItemRow[]> {
    return (await q.query<UploadItemRow>(
      `SELECT id,revision,ciphertext,encrypted_item_key FROM items WHERE owner_user_id=$1 AND collection_id IS NULL AND deleted_at IS NULL ORDER BY id`, [userId],
    )).rows;
  }

  /** Every personal item, deleted ones included, in id order (commit candidates). */
  async listForCommit(q: Queryable, userId: string): Promise<CommitItemRow[]> {
    return (await q.query<CommitItemRow>(
      `SELECT id,revision,deleted_at,ciphertext,encrypted_item_key FROM items WHERE owner_user_id=$1 AND collection_id IS NULL ORDER BY id`, [userId],
    )).rows;
  }
}
