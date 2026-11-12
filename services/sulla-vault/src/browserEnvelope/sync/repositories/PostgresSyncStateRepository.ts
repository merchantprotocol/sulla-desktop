// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// cloud_vault_sync_state for the frozen v3 sync runner (DESIGN-V6 D3: pure move out of
// syncRunner.ts). The SQL is byte-for-byte what the runner ran; callers pick the client
// (the pool, or the transaction client) exactly as before.

import type { Queryable } from '../../../db.js';

export interface SyncStateRow {
  owner_user_id: string; vault_id: string; epoch: number; bundle_generation: number;
  head_seq: string | number; head_mac: string; last_push_at: string | null; last_pull_at: string | null; last_error: string | null;
  bundle_sha: string;
}

/** One row per local owner: which Cloud vault, its signed head and bundle generation. Never touches `users`. */
export class PostgresSyncStateRepository {
  async find(q: Queryable, userId: string): Promise<SyncStateRow | null> {
    const result = await q.query<SyncStateRow>('SELECT * FROM cloud_vault_sync_state WHERE owner_user_id=$1', [userId]);
    return result.rows[0] ?? null;
  }

  /** A newer Cloud wrap was seen: remember only its generation, never its key material. */
  async recordBundleGeneration(q: Queryable, userId: string, bundleGeneration: number): Promise<void> {
    await q.query(
      'UPDATE cloud_vault_sync_state SET bundle_generation=$2,updated_at=now() WHERE owner_user_id=$1',
      [userId, bundleGeneration],
    );
  }

  async advancePulledHead(q: Queryable, userId: string, headSeq: number, headMac: string): Promise<void> {
    await q.query(
      `UPDATE cloud_vault_sync_state SET head_seq=$2,head_mac=$3,last_pull_at=now(),last_error=NULL,updated_at=now() WHERE owner_user_id=$1`,
      [userId, headSeq, headMac],
    );
  }

  async advancePushedHead(q: Queryable, userId: string, headSeq: number, headMac: string): Promise<void> {
    await q.query(
      `UPDATE cloud_vault_sync_state SET head_seq=$2,head_mac=$3,last_push_at=now(),last_error=NULL,updated_at=now() WHERE owner_user_id=$1`,
      [userId, headSeq, headMac],
    );
  }

  /** enable / replace: the Cloud vault now exists at seq 1. */
  async saveCreated(q: Queryable, userId: string, vaultId: string, headMac: string, bundleSha: string): Promise<void> {
    await q.query(
      `INSERT INTO cloud_vault_sync_state(owner_user_id,vault_id,epoch,bundle_generation,head_seq,head_mac,bundle_sha,last_push_at)
         VALUES ($1,$2,1,1,1,$3,$4,now())
         ON CONFLICT(owner_user_id) DO UPDATE SET vault_id=$2,epoch=1,bundle_generation=1,head_seq=1,head_mac=$3,bundle_sha=$4,last_push_at=now(),last_error=NULL,updated_at=now()`,
      [userId, vaultId, headMac, bundleSha],
    );
  }

  async recordRewrap(q: Queryable, userId: string, bundleGeneration: number, bundleSha: string): Promise<void> {
    await q.query(
      'UPDATE cloud_vault_sync_state SET bundle_generation=$2,bundle_sha=$3,last_error=NULL,updated_at=now() WHERE owner_user_id=$1',
      [userId, bundleGeneration, bundleSha],
    );
  }

  async recordError(q: Queryable, userId: string, error: string): Promise<void> {
    await q.query('UPDATE cloud_vault_sync_state SET last_error=$2,updated_at=now() WHERE owner_user_id=$1', [userId, error]);
  }

  async remove(q: Queryable, userId: string): Promise<void> {
    await q.query('DELETE FROM cloud_vault_sync_state WHERE owner_user_id=$1', [userId]);
  }
}
