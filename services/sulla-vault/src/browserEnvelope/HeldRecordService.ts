// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Held policy widening (VAULT-E2E-DESIGN §4): a pulled record that would give
// agents more access than the local item does is NOT applied. The local item
// is left exactly as it is, the verified remote record waits in
// cloud_vault_sync_records.held_record, and the owner approves or rejects it.
//
//   approve → the held record is applied (a normal pull-apply of that record)
//   reject  → the held record is dropped; the local version is kept and is
//             pushed again on the next commit (local_revision is cleared)
//
// Rows held by older builds have no held_record: their ciphertext already holds
// the widened policy while the policy column holds the old one ("legacy").
//   approve → the column takes the ciphertext policy
//   reject  → the item is re-encrypted with the column policy and pushed

import { decryptItemText, encryptItem, type AgentPolicy, type VaultItemPlaintext } from '@sulla/vault-crypto';

import { CloudSyncError } from './CloudSyncError.js';
import type { DomainVaultSyncCodec } from './DomainVaultSyncCodec.js';
import type { SyncRecord } from './envelope.js';
import { RemoteItemParser } from './RemoteItemParser.js';
import { PostgresHeldRecordRepository, type HeldLocalItem, type HeldRow } from '../repositories/PostgresHeldRecordRepository.js';

import type { Queryable } from '../db.js';

export interface HeldContext {
  userId:   string;
  userKey:  Uint8Array;
  vaultId:  string;
}

export interface HeldSummary {
  id:             string;
  /** True for rows held by a build that stored the widened ciphertext locally. */
  legacy:         boolean;
  currentPolicy:  AgentPolicy | null;
  proposedPolicy: AgentPolicy | null;
}

type Repo = PostgresHeldRecordRepository<SyncRecord>;

export class HeldRecordService {
  constructor(
    private readonly envelope: DomainVaultSyncCodec,
    private readonly parser: RemoteItemParser = new RemoteItemParser(),
    private readonly repository: (client: Queryable) => Repo = client => new PostgresHeldRecordRepository<SyncRecord>(client),
  ) {}

  async list(client: Queryable, ctx: HeldContext): Promise<HeldSummary[]> {
    const repo = this.repository(client);
    const out: HeldSummary[] = [];
    for (const row of await repo.listHeld(ctx.userId)) {
      const local = await repo.findItem(ctx.userId, row.record_id, false);
      const proposed = row.held_record
        ? this.parseHeld(row.held_record, ctx).agentPolicy
        : local ? (await this.plaintext(local, ctx, row.record_id)).agentPolicy : null;
      out.push({ id: row.record_id, legacy: !row.held_record, currentPolicy: local && !local.deleted_at ? local.agent_policy : null, proposedPolicy: proposed });
    }
    return out;
  }

  async approve(client: Queryable, ctx: HeldContext, recordId: string): Promise<void> {
    const repo = this.repository(client);
    const row = await this.heldRow(repo, ctx, recordId);
    const local = await repo.findItem(ctx.userId, recordId, true);
    let revision: number | null = local ? Number(local.revision) : null;
    if (row.held_record) {
      const record = row.held_record;
      const plaintext = this.parseHeld(record, ctx);
      const write = local ? repo.replaceItem.bind(repo) : repo.insertItem.bind(repo);
      revision = await write(ctx.userId, recordId, plaintext.type, record.item!.ciphertext, record.item!.encryptedItemKey, plaintext.agentPolicy);
    } else if (local && !local.deleted_at) {
      revision = await repo.setItemPolicy(ctx.userId, recordId, (await this.plaintext(local, ctx, recordId)).agentPolicy);
    }
    // Cloud already holds exactly what is now local, so nothing is pushed.
    await repo.release(ctx.userId, recordId, revision);
    await repo.audit(ctx.userId, 'cloud_sync_policy_approved', recordId);
  }

  async reject(client: Queryable, ctx: HeldContext, recordId: string): Promise<void> {
    const repo = this.repository(client);
    const row = await this.heldRow(repo, ctx, recordId);
    const local = await repo.findItem(ctx.userId, recordId, true);
    if (!row.held_record && local && !local.deleted_at) {
      // Legacy: put the column policy back into the ciphertext the item will push.
      const plaintext = await this.plaintext(local, ctx, recordId);
      const sealed = await encryptItem(JSON.stringify({ ...plaintext, agentPolicy: local.agent_policy }), ctx.userKey, { itemId: recordId, ownerId: ctx.userId });
      await repo.resealItem(ctx.userId, recordId, sealed.ciphertext, sealed.encryptedItemKey);
    }
    // A null local revision makes the local version (or its delete) pending again.
    await repo.release(ctx.userId, recordId, null);
    await repo.audit(ctx.userId, 'cloud_sync_policy_rejected', recordId);
  }

  private async heldRow(repo: Repo, ctx: HeldContext, recordId: string): Promise<HeldRow<SyncRecord>> {
    const row = await repo.lockHeld(ctx.userId, recordId);
    if (!row) throw new CloudSyncError('not_held', 404, 'That item has no change waiting for review');
    return row;
  }

  /** The held record was verified when pulled; verify it again before it can change anything. */
  private parseHeld(record: SyncRecord, ctx: HeldContext): VaultItemPlaintext {
    this.envelope.verifyRecord(record, ctx.userKey, { vaultId: ctx.vaultId, scope: 'personal' });
    if (record.deleted || !record.item) throw new CloudSyncError('held_record_invalid', 409, 'The held Cloud record has no item body');
    return this.parser.parse(this.envelope.decryptItem(record.item, ctx.userKey, ctx.userId, record.id));
  }

  private async plaintext(local: HeldLocalItem, ctx: HeldContext, recordId: string): Promise<VaultItemPlaintext> {
    return JSON.parse(await decryptItemText(
      { version: 1, ciphertext: local.ciphertext as never, encryptedItemKey: local.encrypted_item_key as never }, ctx.userKey,
      { itemId: recordId, ownerId: ctx.userId },
    )) as VaultItemPlaintext;
  }
}
