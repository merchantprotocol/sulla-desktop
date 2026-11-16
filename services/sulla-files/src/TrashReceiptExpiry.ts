// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { TransactionRunner } from './FilesTransaction.js';
import type { NativeOperationJournal } from './nativeOperationJournal.js';
import type { PathOperationRepository } from './Repositories/PathOperationRepository.js';

type Outcome = { kind:'skip' } | { kind:'preserved' } | { kind:'invalidated'; receiptId:string; hasOperation:boolean };

/**
 * Applies configured Trash retention to trash receipts: once a receipt expires its undo is
 * invalidated (receipt and journal plan record why), then the retained native artifacts are
 * disposed. Receipts with unfinished operations, errors or an active retention hold are preserved.
 */
export class TrashReceiptExpiry {
  constructor(
    private readonly repository:PathOperationRepository,
    private readonly transactions:TransactionRunner,
    private readonly journal:()=>NativeOperationJournal,
  ) {}

  async expire(now = new Date()):Promise<{invalidated:number;disposed:number;preserved:number}> {
    let invalidated=0,disposed=0,preserved=0;
    for (const candidate of await this.repository.expiredTrashReceipts(now)) {
      const outcome = await this.transactions.run('trash-receipt-expiry', client => this.invalidate(client, candidate.id, now));
      if (outcome.kind==='skip') continue;
      if (outcome.kind==='preserved') { preserved++; continue }
      invalidated++;
      if (outcome.hasOperation) { const result=await this.journal().dispose(outcome.receiptId); if (result.state==='complete') disposed++; else preserved++ }
    }
    return {invalidated,disposed,preserved};
  }

  private async invalidate(client:Parameters<Parameters<TransactionRunner['run']>[1]>[0], id:string, now:Date):Promise<Outcome> {
    const receipt=await this.repository.lockReceipt(client,id);
    if (!receipt || receipt.folder_plan?.lifecycle?.disposal?.undoInvalidatedAt) return {kind:'skip'};
    const operation=await this.repository.lockOperation(client,receipt.id);
    if (operation && (!['completed','undone','rolled-back'].includes(operation.state)||operation.last_error)) return {kind:'preserved'};
    const folderPlan=receipt.folder_plan?.source?receipt.folder_plan:null;
    const fileIds=[...new Set<string>([receipt.file_id,...(folderPlan?.children??[]).flatMap((item:any)=>[item.before?.fileId,item.after?.fileId])].filter(Boolean))];
    if (fileIds.length && await this.repository.anyRetentionActive(client,fileIds)) return {kind:'preserved'};
    const invalidation={undoInvalidatedAt:now.toISOString(),invalidatedBy:'configured-retention',reason:'configured-trash-retention-expired'};
    receipt.folder_plan.lifecycle={...(receipt.folder_plan.lifecycle??{}),disposal:invalidation};
    await this.repository.saveReceiptPlan(client,receipt.id,receipt.folder_plan);
    if (operation) { operation.plan.disposal=invalidation; await this.repository.saveOperationPlan(client,receipt.id,operation.plan) }
    return {kind:'invalidated',receiptId:receipt.id,hasOperation:Boolean(operation)};
  }
}
