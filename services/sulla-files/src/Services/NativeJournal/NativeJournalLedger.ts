// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { Committed, CrossPlan, Fingerprint, NativeJournalDependencies, NativeJournalRoot, Plan } from './NativeJournalTypes.js';

/** Persists journal plans and custody rows, and captures the committed database state a plan must reproduce. */
export class NativeJournalLedger {
  constructor(private readonly deps:NativeJournalDependencies) {}

  async save(id:string, plan:Plan|CrossPlan):Promise<void> {
    await this.deps.rows.savePlan(this.deps.db, id, plan);
  }

  async watch(client:pg.PoolClient, root:NativeJournalRoot, fileId:string, path:string, hash:string, fp:Fingerprint):Promise<void> {
    await this.deps.rows.watch(client, root.collectionId, path, fileId, hash, fp.size, fp.mtimeMs, root.id);
  }

  async capture(client:Pick<pg.PoolClient,'query'>, receipt:any):Promise<Committed> {
    const folderPlan = receipt.folder_plan?.source?receipt.folder_plan:null;
    const records = folderPlan?[...folderPlan.children,...(folderPlan.displaced?.children??[])]:[{before:receipt.before_state,after:receipt.after_state},
      {before:receipt.displaced_before,after:receipt.displaced_after}];
    const fileIds = [...new Set<string>(records.flatMap((r:any)=>[r.before?.fileId,r.after?.fileId]).filter(Boolean))].sort();
    const folderIds = [...new Set<string>((folderPlan?[...folderPlan.folders,...(folderPlan.displaced?.folders??[])]:[{after:receipt.after_state}]).flatMap((r:any)=>[r.before?.folderId,r.after?.folderId]).filter(Boolean))].sort();
    return this.captureIds(client, fileIds, folderIds);
  }

  async captureIds(client:Pick<pg.PoolClient,'query'>, fileIds:string[], folderIds:string[]):Promise<Committed> {
    const { files, folders, watched } = await this.deps.rows.capture(client, fileIds, folderIds);
    return {fileIds,folderIds,files,folders,watched};
  }

  /** The stored committed state without its grants, as `verify*Committed` compares it. */
  static expected(stored:Committed|undefined):Committed|undefined {
    return stored ? Object.fromEntries(Object.entries(stored).filter(([key])=>key!=='grants')) as unknown as Committed : stored;
  }
}
