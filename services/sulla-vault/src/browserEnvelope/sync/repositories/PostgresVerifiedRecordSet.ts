// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// cloud_vault_sync_records for the frozen v3 sync runner (DESIGN-V6 D3: pure move).
// The verified ledger: the generation and MAC of every record this Desktop has adopted.

import type { Queryable } from '../../../db.js';
import type { SyncRecord } from '../../envelope.js';

export interface KnownRecordRow {
  record_id: string; generation: string | number; deleted: boolean; record_mac: string;
  local_revision: string | number | null; policy_review_pending: boolean;
}

export class PostgresVerifiedRecordSet {
  async known(q: Queryable, userId: string): Promise<Map<string, KnownRecordRow>> {
    const result = await q.query<KnownRecordRow>(
      `SELECT record_id,generation,deleted,record_mac,local_revision,policy_review_pending
         FROM cloud_vault_sync_records WHERE owner_user_id=$1 AND scope='personal'`, [userId],
    );
    return new Map(result.rows.map(row => [row.record_id, row]));
  }

  /** Upsert one adopted record. `held` set means the change waits for the owner (policy widening). */
  async remember(
    q: Queryable, userId: string, record: Pick<SyncRecord, 'id' | 'generation' | 'deleted' | 'mac'>, localRevision: number | null, held: SyncRecord | null = null,
  ): Promise<void> {
    await q.query(
      `INSERT INTO cloud_vault_sync_records(owner_user_id,scope,record_id,generation,deleted,record_mac,local_revision,policy_review_pending,held_record)
       VALUES ($1,'personal',$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT(owner_user_id,scope,record_id) DO UPDATE SET generation=$3,deleted=$4,record_mac=$5,local_revision=$6,policy_review_pending=$7,held_record=$8::jsonb`,
      [userId, record.id, record.generation, record.deleted, record.mac, localRevision, held !== null, held ? JSON.stringify(held) : null],
    );
  }

  async removeAll(q: Queryable, userId: string): Promise<void> {
    await q.query('DELETE FROM cloud_vault_sync_records WHERE owner_user_id=$1', [userId]);
  }
}
