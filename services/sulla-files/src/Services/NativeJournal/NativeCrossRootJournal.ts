// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import type pg from 'pg';
import { FilesMutationCoordinator } from '../../safeFilesystem.js';
import { NativeJournalLedger } from './NativeJournalLedger.js';
import { NativeJournalIntegrity, type CrossLeaf, type CrossPlan, type Fingerprint, type NativeJournalDependencies, type NativeJournalRoot } from './NativeJournalTypes.js';

const { packed, same, failure, publishedIdentity, verify, fingerprint } = NativeJournalIntegrity;

/** Version-3 plans: a receipt that moves or copies between two collections (and so possibly two native roots). */
export class NativeCrossRootJournal {
  constructor(private readonly deps:NativeJournalDependencies, private readonly ledger = new NativeJournalLedger(deps)) {}

  async publish(client:pg.PoolClient, receipt:any, targetCollectionId:string):Promise<void> {
    const source = await this.deps.resolve(receipt.collection_id);
    const target = await this.deps.resolve(targetCollectionId);
    if (!source && !target) return;
    const roots = [source,target].filter((root,index,items):root is NativeJournalRoot=>Boolean(root) && items.findIndex(item=>item?.id===root!.id)===index)
      .sort((left,right)=>left.id.localeCompare(right.id));
    const run = (index:number,operation:()=>Promise<void>):Promise<void>=>index===roots.length?operation():roots[index].mutations.runExclusive([],()=>run(index+1,operation));
    await run(0,async()=>{
      await FilesMutationCoordinator.requireAtomicRename();
      await this.publishLocked(client, receipt, targetCollectionId, source, target, roots);
    });
  }

  private async publishLocked(client:pg.PoolClient, receipt:any, targetCollectionId:string, source:NativeJournalRoot|null, target:NativeJournalRoot|null, roots:NativeJournalRoot[]):Promise<void> {
    const { rows, cancellation } = this.deps;
    const itemId = receipt.request.itemId??receipt.id;
    const operationId = receipt.request.batchOperationId??receipt.id;
    const prefix = `.sulla-trash/.operations/${operationId}/${itemId}/${receipt.id}`;
    const folderPlan = receipt.folder_plan?.source?receipt.folder_plan:null;
    const incoming = (folderPlan?.children??[{before:receipt.before_state,after:receipt.after_state,action:receipt.action}]).map((item:any)=>({before:item.before??item.before_state,after:item.after??item.after_state,action:item.action??receipt.action}));
    const displaced = (folderPlan?.displaced?.children??(receipt.displaced_before?[{before:receipt.displaced_before,after:receipt.displaced_after,action:'rename'}]:[]))
      .map((item:any)=>({before:item.before??item.before_state,after:item.after??item.after_state,action:item.action??'rename'}));
    const ids = [...new Set<string>([...incoming,...displaced].flatMap(item=>[item.before?.fileId,item.after?.fileId]).filter(Boolean))];
    const watched = await rows.lockWatched(client, ids);
    const plan:CrossPlan = {version:3,receiptId:receipt.id,sourceCollectionId:receipt.collection_id,targetCollectionId,operationId,itemId,
      ...(source?{sourceRootId:source.id}:{}),...(target?{targetRootId:target.id}:{}),leaves:[],watched,
      ...(folderPlan?{sourceTree:folderPlan.source,targetTrees:[folderPlan.target,...(folderPlan.displaced?[folderPlan.displaced.target]:[])].filter(Boolean)}:{})};
    const rootById = (id:string)=>roots.find(root=>root.id===id)!;
    const addRelocate = async(record:any,index:number)=>{
      if (!target || !record.before?.fileId || !record.after?.fileId) return;
      const w = watched.find(row=>row.file_id===record.before.fileId && row.root_id===target.id && row.path===record.before.path);
      if (!w) return;
      await this.deps.verifyVersion(record.before.fileId,record.before.versionId,w.content_hash);
      const pin = await target.mutations.pinVerified(record.before.path,p=>verify(p,w.content_hash));
      try { plan.leaves.push({kind:'relocate',rootId:target.id,source:record.before.path,target:record.after.path,stage:`${prefix}/displaced-${index}`,fileId:record.before.fileId,versionId:record.before.versionId,hash:w.content_hash,before:packed(pin.fingerprint)}) }
      finally { await pin.close() }
    };
    if (target && folderPlan?.displaced) {
      const desired = [...new Set<string>((folderPlan.displaced.folders??[]).map((item:any)=>item.after.path))].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b));
      for (const [index,path] of desired.entries()) if (!await target.mutations.exists(path)) plan.leaves.push({kind:'mkdir',rootId:target.id,target:path,stage:`${prefix}/displaced-dir-${index}`});
    }
    if (target) for (const [index,record] of displaced.entries()) await addRelocate(record,index);
    if (target && folderPlan?.displaced) {
      for (const [index,item] of [...(folderPlan.displaced.folders??[])].reverse().entries()) {
        if (!await target.mutations.exists(item.before.path)) continue;
        plan.leaves.push({kind:'rmdir',rootId:target.id,source:item.before.path,stage:`${prefix}/displaced-rmdir-${index}`,directory:await target.mutations.directory(item.before.path)});
      }
    }
    if (target && folderPlan) {
      const desired = [...new Set<string>((folderPlan.folders??[]).filter((item:any)=>!item.deleted).map((item:any)=>item.after.path))].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b));
      for (const [index,path] of desired.entries()) {
        const replaced = folderPlan.displaced && (path===folderPlan.displaced.source || path.startsWith(folderPlan.displaced.source+'/'));
        if (replaced || !await target.mutations.exists(path)) plan.leaves.push({kind:'mkdir',rootId:target.id,target:path,stage:`${prefix}/target-dir-${index}`});
      }
    }
    for (const [index,record] of incoming.entries()) {
      const sourceWatch = source&&watched.find(row=>row.file_id===record.before?.fileId && row.root_id===source.id && row.path===record.before.path);
      let sourceFingerprint:Fingerprint|undefined;
      if (sourceWatch) {
        const pin = await source!.mutations.pinVerified(record.before.path,p=>verify(p,sourceWatch.content_hash));
        try { sourceFingerprint = packed(pin.fingerprint) } finally { await pin.close() }
      }
      if (target && record.after?.fileId && !record.after.deleted) plan.leaves.push({kind:'publish',rootId:target.id,sourceRootId:sourceWatch?source!.id:undefined,
        source:record.before.path,target:record.after.path,stage:`${prefix}/incoming-${index}`,fileId:record.before.fileId,versionId:record.before.versionId,
        ...(sourceWatch?{hash:sourceWatch.content_hash,before:sourceFingerprint}:{})});
      if (sourceWatch && receipt.action!=='copy') {
        const pin = await source!.mutations.pinVerified(record.before.path,p=>verify(p,sourceWatch.content_hash));
        try { plan.leaves.push({kind:'evict',rootId:source!.id,source:record.before.path,stage:`${prefix}/source-${index}`,fileId:record.before.fileId,versionId:record.before.versionId,hash:sourceWatch.content_hash,before:packed(pin.fingerprint)}) }
        finally { await pin.close() }
      }
    }
    if (source && folderPlan && receipt.action!=='copy') for (const [index,item] of [...(folderPlan.folders??[])].reverse().entries()) {
      if (!await source.mutations.exists(item.before.path)) continue;
      plan.leaves.push({kind:'rmdir',rootId:source.id,source:item.before.path,stage:`${prefix}/source-dir-${index}`,directory:await source.mutations.directory(item.before.path)});
    }
    await rows.startPublishing(this.deps.db, receipt.id, receipt.action, plan);
    for (const leaf of plan.leaves) {
      cancellation.assertNotCancelled(operationId);
      const root = rootById(leaf.rootId);
      if (leaf.kind==='publish') await this.stageLeaf(plan,leaf,root,source);
      if (leaf.kind==='mkdir') {
        const staged = await root.mutations.stageDirectory(leaf.stage); leaf.directory = {...staged,path:leaf.target!};
        await this.ledger.save(receipt.id,plan);
      }
      leaf.started = true; await this.ledger.save(receipt.id,plan);
      await this.forward(leaf,root);
      leaf.completed = true; await this.ledger.save(receipt.id,plan);
    }
    cancellation.assertNotCancelled(operationId);
    for (const record of displaced) if (record.before?.fileId) await rows.forgetWatched(client, record.before.fileId);
    if (receipt.action!=='copy') for (const record of incoming) if (record.before?.fileId) await rows.forgetWatched(client, record.before.fileId);
    for (const record of [...incoming,...displaced]) {
      if (!target || !record.after?.fileId || record.after.deleted) continue;
      const leaf = plan.leaves.find(item=>item.target===record.after.path && ['publish','relocate'].includes(item.kind));
      if (!leaf?.published || !leaf.hash) throw failure();
      await this.ledger.watch(client,target,record.after.fileId,record.after.path,leaf.hash,leaf.published);
    }
    plan.committed = await this.ledger.capture(client,receipt);
    await rows.markDbCommitted(client, receipt.id, plan);
  }

  /** Writes the incoming bytes (from the source root or the stored version) to a private stage and pins them. */
  private async stageLeaf(plan:CrossPlan, leaf:CrossLeaf, target:NativeJournalRoot, source:NativeJournalRoot|null):Promise<void> {
    if (await target.mutations.exists(leaf.stage)) throw failure();
    const output = await target.mutations.openPrivateExclusive(leaf.stage); const digest = createHash('sha256');
    try {
      const write = async(stream:AsyncIterable<Uint8Array>)=>{ for await (const value of stream) { const bytes = Buffer.from(value); digest.update(bytes); let offset = 0; while (offset<bytes.length) { const result = await output.write(bytes,offset); if (!result.bytesWritten) throw failure(); offset += result.bytesWritten } } };
      if (leaf.sourceRootId) {
        if (!source || source.id!==leaf.sourceRootId) throw failure();
        const pin = await source.mutations.pinVerified(leaf.source!,p=>verify(p,leaf.hash!,leaf.before));
        try { await write(pin.createReadStream()); await pin.assertUnchanged() } finally { await pin.close() }
      } else await write(await this.deps.readVersion(leaf.fileId!,leaf.versionId!));
      await output.sync();
    } finally { await output.close() }
    const hash = digest.digest('hex'); if (leaf.hash && leaf.hash!==hash) throw failure(); leaf.hash = hash;
    const staged = await target.mutations.pinVerified(leaf.stage,p=>verify(p,hash)); try { leaf.before = packed(staged.fingerprint) } finally { await staged.close() }
    await this.ledger.save(plan.receiptId,plan);
  }

  private async forward(leaf:CrossLeaf, root:NativeJournalRoot):Promise<void> {
    if (leaf.kind==='mkdir') { leaf.directory = await root.mutations.restoreEmptyDirectory(leaf.directory!,leaf.stage); return }
    if (leaf.kind==='rmdir') { await root.mutations.evictEmptyDirectory(leaf.directory!,leaf.stage); return }
    if (leaf.kind==='publish') { const published = await root.mutations.publishVerified({staged:leaf.stage,target:leaf.target!,verify:p=>verify(p,leaf.hash!,leaf.before)}); leaf.published = packed(published.fingerprint); return }
    const pin = await root.mutations.pinVerified(leaf.source!,p=>verify(p,leaf.hash!,leaf.before)); try { leaf.before = packed(pin.fingerprint) } finally { await pin.close() }
    await root.mutations.evictVerified({source:leaf.source!,quarantine:leaf.stage,verify:p=>verify(p,leaf.hash!,leaf.before)});
    if (leaf.kind==='relocate') { const published = await root.mutations.publishVerified({staged:leaf.stage,target:leaf.target!,verify:p=>verify(p,leaf.hash!,leaf.before)}); leaf.published = packed(published.fingerprint) }
  }

  private async roots(plan:CrossPlan):Promise<Map<string,NativeJournalRoot>> {
    const roots = new Map<string,NativeJournalRoot>();
    for (const collectionId of [plan.sourceCollectionId,plan.targetCollectionId]) {
      const root = await this.deps.resolve(collectionId); if (root) roots.set(root.id,root);
    }
    for (const id of [plan.sourceRootId,plan.targetRootId].filter(Boolean)) if (!roots.has(id!)) throw failure();
    return roots;
  }

  private async validateFilesystem(plan:CrossPlan, undo = false):Promise<void> {
    const roots = await this.roots(plan);
    for (const leaf of plan.leaves) {
      const root = roots.get(leaf.rootId); if (!root || !leaf.completed) throw failure();
      if (leaf.kind==='mkdir') {
        if (undo) {
          const restored = plan.leaves.find(candidate=>candidate.rootId===leaf.rootId && candidate.kind==='rmdir' && candidate.source===leaf.target);
          if (restored) {
            const directory = await root.mutations.directory(leaf.target!);
            if (directory.dev!==restored.directory?.dev || directory.ino!==restored.directory?.ino) throw failure();
          } else if (await root.mutations.exists(leaf.target!)) throw failure();
          const retained = await root.mutations.directory(leaf.stage+'.undo');
          if (retained.dev!==leaf.directory?.dev || retained.ino!==leaf.directory?.ino) throw failure();
          continue;
        }
        const directory = await root.mutations.directory(leaf.target!); if (directory.dev!==leaf.directory?.dev || directory.ino!==leaf.directory?.ino) throw failure();
      } else if (leaf.kind==='rmdir') {
        const path = undo?leaf.source!:leaf.stage; const directory = await root.mutations.directory(path);
        if (directory.dev!==leaf.directory?.dev || directory.ino!==leaf.directory?.ino) throw failure();
      } else if (undo) {
        if (leaf.source && ['evict','relocate'].includes(leaf.kind)) { const pin = await root.mutations.pinVerified(leaf.source,p=>verify(p,leaf.hash!,leaf.before)); await pin.close() }
        if (leaf.target && ['publish','relocate'].includes(leaf.kind) && await root.mutations.exists(leaf.target)) {
          const restored = plan.leaves.find(candidate=>candidate.rootId===leaf.rootId && candidate.kind==='relocate' && candidate.source===leaf.target);
          if (!restored) throw failure();
          const pin = await root.mutations.pinVerified(leaf.target,p=>verify(p,restored.hash!,restored.before)); await pin.close();
        }
        if (['publish','relocate'].includes(leaf.kind)) { const retained = await root.mutations.pinVerified(leaf.stage+'.undo',p=>verify(p,leaf.hash!,publishedIdentity(leaf))); await retained.close() }
      } else {
        const stage = await root.mutations.pinVerified(leaf.stage,p=>verify(p,leaf.hash!,leaf.before)); await stage.close();
        if (leaf.target) { const target = await root.mutations.pinVerified(leaf.target,p=>verify(p,leaf.hash!,publishedIdentity(leaf))); await target.close() }
        if (leaf.kind==='evict' && await root.mutations.exists(leaf.source!)) throw failure();
      }
    }
  }

  private async verifyCommitted(plan:CrossPlan, undo:boolean):Promise<void> {
    const expected = NativeJournalLedger.expected(undo?plan.inverseCommitted:plan.committed);
    if (!expected) throw failure();
    const actual = await this.ledger.captureIds(this.deps.db,expected.fileIds,expected.folderIds);
    if (NativeJournalIntegrity.canonical(expected)!==NativeJournalIntegrity.canonical(actual)) throw failure();
    await this.validateFilesystem(plan,undo);
  }

  async inverse(client:pg.PoolClient, receipt:any):Promise<void> {
    const { rows, db } = this.deps;
    const row = await rows.find(db, receipt.id);
    if (!row) {
      const source = await this.deps.resolve(receipt.collection_id);
      const target = await this.deps.resolve(receipt.request.targetCollectionId);
      if (!source && !target) return;
      throw failure();
    }
    if (row.plan?.version!==3 || !['completed','db-committed'].includes(row.state)) throw failure();
    const plan = row.plan as CrossPlan; await this.validateFilesystem(plan,false);
    const roots = await this.roots(plan); plan.undoProgress = 0;
    await rows.startUndoPublishing(db, receipt.id, plan);
    const reverse = [...plan.leaves].reverse();
    for (const leaf of reverse) {
      const root = roots.get(leaf.rootId)!; const undoStage = leaf.stage+'.undo';
      if (leaf.kind==='rmdir') await root.mutations.restoreEmptyDirectory(leaf.directory!,leaf.stage);
      else if (leaf.kind==='mkdir') await root.mutations.evictEmptyDirectory(leaf.directory!,undoStage);
      else if (leaf.kind==='evict') await root.mutations.recoverEviction({source:leaf.source!,quarantine:leaf.stage,fingerprint:fingerprint(leaf.before!)},p=>verify(p,leaf.hash!,leaf.before));
      else if (leaf.kind==='publish') await root.mutations.rollbackPublication({staged:leaf.stage,target:leaf.target!,rollback:undoStage,fingerprint:fingerprint(leaf.published!)},p=>verify(p,leaf.hash!,leaf.published));
      else {
        await root.mutations.rollbackPublication({staged:leaf.stage,target:leaf.target!,rollback:undoStage,fingerprint:fingerprint(leaf.published!)},p=>verify(p,leaf.hash!,leaf.published));
        await root.mutations.recoverEviction({source:leaf.source!,quarantine:leaf.stage,fingerprint:fingerprint(leaf.before!)},p=>verify(p,leaf.hash!,leaf.before));
      }
      plan.undoProgress = (plan.undoProgress??0)+1; await this.ledger.save(receipt.id,plan);
    }
    const folderPlan = receipt.folder_plan?.source?receipt.folder_plan:null;
    const afterStates = folderPlan?[...folderPlan.children,...(folderPlan.displaced?.children??[])].map((item:any)=>item.after):[receipt.after_state,receipt.displaced_after];
    for (const state of afterStates) if (state?.fileId) await rows.forgetWatched(client, state.fileId);
    for (const watched of plan.watched) {
      const root = roots.get(watched.root_id); if (!root) throw failure();
      const pin = await root.mutations.pinVerified(watched.path,p=>verify(p,watched.content_hash));
      try { await this.ledger.watch(client,root,watched.file_id,watched.path,watched.content_hash,packed(pin.fingerprint)) } finally { await pin.close() }
    }
    plan.inverseCommitted = await this.ledger.capture(client,receipt);
    await rows.markUndoDbCommitted(client, receipt.id, plan);
  }

  async recover(row:any):Promise<void> {
    const { rows, db } = this.deps;
    const plan = row.plan as CrossPlan;
    if (row.state==='db-committed') { await this.verifyCommitted(plan,false); await rows.markCompleted(db, row.operation_id); return }
    if (row.state==='undo-db-committed') { await this.verifyCommitted(plan,true); await rows.markUndone(db, row.operation_id); return }
    if (row.state==='planned' || row.state==='publishing') {
      await this.rollbackForward(plan); await rows.markRolledBack(db, row.operation_id); return;
    }
    if (row.state==='undo-planned' || row.state==='undo-publishing') {
      await this.rollbackUndo(plan); await this.verifyCommitted(plan,false);
      await rows.markCompletedWithPlan(db, row.operation_id, plan); return;
    }
    throw failure();
  }

  private async rollbackForward(plan:CrossPlan):Promise<void> {
    const roots = await this.roots(plan);
    for (const leaf of [...plan.leaves].reverse().filter(item=>item.started || item.completed)) {
      const root = roots.get(leaf.rootId)!;
      if (leaf.kind==='mkdir') {
        if (await root.mutations.exists(leaf.target!)) await root.mutations.evictEmptyDirectory(leaf.directory!,leaf.stage+'.rollback');
      } else if (leaf.kind==='rmdir') {
        if (!await root.mutations.exists(leaf.source!)) await root.mutations.restoreEmptyDirectory(leaf.directory!,leaf.stage);
        else {
          const current = await root.mutations.directory(leaf.source!);
          if (current.dev!==leaf.directory?.dev || current.ino!==leaf.directory?.ino) throw failure();
        }
      } else if (leaf.kind==='publish') {
        if (await root.mutations.exists(leaf.target!)) await this.unpublish(root, leaf);
      } else if (leaf.kind==='evict') {
        await this.unevict(root, leaf);
      } else {
        if (await root.mutations.exists(leaf.target!)) await this.unpublish(root, leaf);
        await this.unevict(root, leaf);
      }
      await this.ledger.save(plan.receiptId,plan);
    }
  }

  private async unpublish(root:NativeJournalRoot, leaf:CrossLeaf):Promise<void> {
    const target = await root.mutations.pinVerified(leaf.target!,p=>verify(p,leaf.hash!,publishedIdentity(leaf)));
    try { leaf.published ??= packed(target.fingerprint) } finally { await target.close() }
    await root.mutations.rollbackPublication({staged:leaf.stage,target:leaf.target!,rollback:leaf.stage+'.rollback',fingerprint:fingerprint(leaf.published)},p=>verify(p,leaf.hash!,leaf.published));
  }

  private async unevict(root:NativeJournalRoot, leaf:CrossLeaf):Promise<void> {
    if (await root.mutations.exists(leaf.stage)) await root.mutations.recoverEviction({source:leaf.source!,quarantine:leaf.stage,fingerprint:fingerprint(leaf.before!)},p=>verify(p,leaf.hash!,leaf.before));
    else { const sourceFile = await root.mutations.pinVerified(leaf.source!,p=>verify(p,leaf.hash!,leaf.before)); await sourceFile.close() }
  }

  /** Return a partially published inverse to its exact committed-forward state. */
  private async rollbackUndo(plan:CrossPlan):Promise<void> {
    const roots = await this.roots(plan);
    // Reconcile every leaf in original order. Leaves not yet inverted are
    // already exact no-ops; leaves interrupted at any inverse boundary are
    // driven back to the durable forward identity without guessing ownership.
    for (const leaf of plan.leaves) {
      const root = roots.get(leaf.rootId); if (!root) throw failure();
      const undoStage = leaf.stage+'.undo';
      if (leaf.kind==='rmdir') {
        if (await root.mutations.exists(leaf.stage)) {
          const retained = await root.mutations.directory(leaf.stage);
          if (retained.dev!==leaf.directory?.dev || retained.ino!==leaf.directory?.ino) throw failure();
          if (await root.mutations.exists(leaf.source!)) {
            const replacement = plan.leaves.slice(plan.leaves.indexOf(leaf)+1).find(candidate=>candidate.rootId===leaf.rootId && candidate.kind==='mkdir' && candidate.target===leaf.source);
            const current = await root.mutations.directory(leaf.source!);
            if (!replacement?.directory || current.dev!==replacement.directory.dev || current.ino!==replacement.directory.ino) throw failure();
          }
        } else await root.mutations.evictEmptyDirectory(leaf.directory!,leaf.stage);
      } else if (leaf.kind==='mkdir') {
        if (await root.mutations.exists(leaf.target!)) {
          const current = await root.mutations.directory(leaf.target!);
          if (current.dev!==leaf.directory?.dev || current.ino!==leaf.directory?.ino) throw failure();
        } else await root.mutations.restoreEmptyDirectory(leaf.directory!,undoStage);
      } else if (leaf.kind==='evict') {
        if (await root.mutations.exists(leaf.stage)) {
          const retained = await root.mutations.pinVerified(leaf.stage,p=>verify(p,leaf.hash!,leaf.before)); await retained.close();
          if (await root.mutations.exists(leaf.source!)) throw failure();
        } else await root.mutations.evictVerified({source:leaf.source!,quarantine:leaf.stage,verify:p=>verify(p,leaf.hash!,leaf.before)});
      } else if (leaf.kind==='publish') {
        await this.republish(root, leaf);
      } else {
        if (!await root.mutations.exists(leaf.stage)) await root.mutations.evictVerified({source:leaf.source!,quarantine:leaf.stage,verify:p=>verify(p,leaf.hash!,leaf.before)});
        else if (await root.mutations.exists(leaf.source!)) {
          const replacement = plan.leaves.slice(plan.leaves.indexOf(leaf)+1).find(candidate=>candidate.rootId===leaf.rootId && candidate.kind==='publish' && candidate.target===leaf.source);
          if (!replacement) throw failure();
          const current = await root.mutations.pinVerified(leaf.source!,p=>verify(p,replacement.hash!,publishedIdentity(replacement))); await current.close();
        }
        await this.republish(root, leaf);
      }
      plan.undoProgress = 0;
      await this.ledger.save(plan.receiptId,plan);
    }
  }

  /** The forward publication is present with its recorded identity, or is published again and must reproduce it. */
  private async republish(root:NativeJournalRoot, leaf:CrossLeaf):Promise<void> {
    if (await root.mutations.exists(leaf.target!)) {
      const target = await root.mutations.pinVerified(leaf.target!,p=>verify(p,leaf.hash!,publishedIdentity(leaf))); await target.close();
    } else {
      const published = await root.mutations.publishVerified({staged:leaf.stage,target:leaf.target!,verify:p=>verify(p,leaf.hash!,leaf.before)});
      if (!same(packed(published.fingerprint),publishedIdentity(leaf))) throw failure();
    }
  }
}
