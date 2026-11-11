// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentPolicy } from '@sulla/vault-crypto';

import type { Queryable } from '../db.js';

export interface HeldRow<R = unknown> { record_id: string; held_record: R | null }
export interface HeldLocalItem { revision: string; deleted_at: string | null; agent_policy: AgentPolicy; ciphertext: unknown; encrypted_item_key: unknown }

/** Storage for held policy widenings: the sync ledger rows plus the personal items they would change. */
export class PostgresHeldRecordRepository<R = unknown> {
  constructor(private readonly client: Queryable) {}

  async listHeld(userId: string): Promise<Array<HeldRow<R>>> {
    return (await this.client.query<HeldRow<R>>(
      `SELECT record_id,held_record FROM cloud_vault_sync_records
        WHERE owner_user_id=$1 AND scope='personal' AND policy_review_pending ORDER BY record_id`, [userId],
    )).rows;
  }

  async lockHeld(userId: string, recordId: string): Promise<HeldRow<R> | undefined> {
    return (await this.client.query<HeldRow<R>>(
      `SELECT record_id,held_record FROM cloud_vault_sync_records
        WHERE owner_user_id=$1 AND scope='personal' AND record_id=$2 AND policy_review_pending FOR UPDATE`, [userId, recordId],
    )).rows[0];
  }

  async findItem(userId: string, recordId: string, lock: boolean): Promise<HeldLocalItem | undefined> {
    return (await this.client.query<HeldLocalItem>(
      `SELECT revision,deleted_at,agent_policy,ciphertext,encrypted_item_key FROM items
        WHERE id=$1 AND owner_user_id=$2 AND collection_id IS NULL${ lock ? ' FOR UPDATE' : '' }`, [recordId, userId],
    )).rows[0];
  }

  async replaceItem(userId: string, recordId: string, itemType: string, ciphertext: unknown, encryptedItemKey: unknown, policy: AgentPolicy): Promise<number> {
    const res = await this.client.query<{ revision: string }>(
      `UPDATE items SET item_type=$3,ciphertext=$4,encrypted_item_key=$5,agent_policy=$6,deleted_at=NULL,revision=revision+1,updated_at=now()
        WHERE id=$1 AND owner_user_id=$2 RETURNING revision`, [recordId, userId, itemType, ciphertext, encryptedItemKey, policy],
    );
    return Number(res.rows[0].revision);
  }

  async insertItem(userId: string, recordId: string, itemType: string, ciphertext: unknown, encryptedItemKey: unknown, policy: AgentPolicy): Promise<number> {
    const res = await this.client.query<{ revision: string }>(
      `INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref)
       VALUES ($1,$2,$3,$4,$5,$6,NULL) RETURNING revision`, [recordId, userId, itemType, ciphertext, encryptedItemKey, policy],
    );
    return Number(res.rows[0].revision);
  }

  async setItemPolicy(userId: string, recordId: string, policy: AgentPolicy): Promise<number> {
    const res = await this.client.query<{ revision: string }>(
      `UPDATE items SET agent_policy=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_user_id=$2 RETURNING revision`, [recordId, userId, policy],
    );
    return Number(res.rows[0].revision);
  }

  async resealItem(userId: string, recordId: string, ciphertext: unknown, encryptedItemKey: unknown): Promise<void> {
    await this.client.query(
      `UPDATE items SET ciphertext=$3,encrypted_item_key=$4,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_user_id=$2`,
      [recordId, userId, ciphertext, encryptedItemKey],
    );
  }

  /** Clear the hold. `localRevision` null makes the local version (or its delete) pending again. */
  async release(userId: string, recordId: string, localRevision: number | null): Promise<void> {
    await this.client.query(
      `UPDATE cloud_vault_sync_records SET held_record=NULL,policy_review_pending=false,local_revision=$3
        WHERE owner_user_id=$1 AND scope='personal' AND record_id=$2`, [userId, recordId, localRevision],
    );
  }

  async audit(userId: string, action: string, itemId: string | null): Promise<void> {
    const exists = itemId ? (await this.client.query('SELECT 1 FROM items WHERE id=$1', [itemId])).rows.length > 0 : false;
    await this.client.query(`INSERT INTO audit_log(actor_user_id,item_id,action,metadata,blocked) VALUES ($1,$2,$3,'{}'::jsonb,false)`,
      [userId, exists ? itemId : null, action]);
  }
}
