// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { isProtectedPath } from '../../protectedFiles.js';
import { FilesMutationCoordinator, type PinnedRegularFile } from '../../safeFilesystem.js';
import { NativeJournalLedger } from './NativeJournalLedger.js';
import { NativeJournalIntegrity, type Leaf, type NativeJournalDependencies, type NativeJournalRoot, type Plan } from './NativeJournalTypes.js';

const { packed, failure, verify } = NativeJournalIntegrity;

/** Version-2 plans: one receipt published inside one native root, its exact inverse, and crash recovery. */
export class NativeSameRootJournal {
  constructor(private readonly deps:NativeJournalDependencies, private readonly ledger = new NativeJournalLedger(deps)) {}

  /** Plans every leaf, persists the plan before the first byte moves, publishes, then records custody in `client`. */
  async publish(client:pg.PoolClient, receipt:any, root:NativeJournalRoot):Promise<void> {
    const { rows, cancellation } = this.deps;
    const m = root.mutations;
    const itemId = receipt.request.itemId ?? receipt.id;
    const operationId = receipt.request.batchOperationId ?? receipt.id;
    const prefix = `.sulla-trash/.operations/${operationId}/${itemId}/${receipt.id}`;
    const folderPlan = receipt.folder_plan?.source?receipt.folder_plan:null;
    const incomingRecords = folderPlan?.children?.map((c:any)=>({ before_state:c.before,after_state:c.after,action:c.action })) ?? [receipt];
    const displacedRecords = folderPlan?.displaced?.children?.map((c:any)=>({ before_state:c.before,after_state:c.after,action:c.action })) ?? [];
    const records = [...displacedRecords,...incomingRecords];
    const displacedFileBefore = !folderPlan && receipt.displaced_before?.fileId ? receipt.displaced_before : null;
    const displacedFileAfter = displacedFileBefore && receipt.displaced_after?.fileId ? receipt.displaced_after : null;
    const watched = await rows.lockWatched(client, [...records.map((r:any)=>r.before_state?.fileId),displacedFileBefore?.fileId].filter(Boolean));
    const plan:Plan = { version:2,rootId:root.id,collectionId:receipt.collection_id,operationId,itemId,leaves:[],watched };
    if (folderPlan) {
      if (receipt.action!=='copy') plan.treeBefore = folderPlan.source;
      if (receipt.action!=='trash') plan.treeAfter = folderPlan.target;
      if (folderPlan.displaced) {
        plan.treesAfter = [folderPlan.target,folderPlan.displaced.target];
        plan.absentAfter = receipt.action==='copy'?[]:[folderPlan.source];
        plan.treesUndo = [folderPlan.source,folderPlan.displaced.source];
        plan.absentUndo = [folderPlan.displaced.target];
      }
    } else if (receipt.action==='create-folder') plan.treeAfter = receipt.after_state.path;
    const fileLeaf = async(before:any,after:any,kind:Leaf['kind'],stage:string,leaves=plan.leaves) => {
      const w = watched.find(w=>w.file_id===before.fileId);
      if (!w || w.root_id!==root.id || w.path!==before.path) throw failure();
      await this.deps.verifyVersion(before.fileId,before.versionId,w.content_hash);
      const pin = await m.pinVerified(before.path,p=>verify(p,w.content_hash));
      try {
        if (pin.fingerprint.size!==Number(w.size) || pin.fingerprint.mtimeMs!==Number(w.mtime_ms)) throw failure();
        leaves.push({ kind,source:before.path,target:after?.path,stage,hash:w.content_hash,before:packed(pin.fingerprint) });
      } finally { await pin.close() }
    };
    if (displacedFileBefore) await fileLeaf(displacedFileBefore,displacedFileAfter,'move',`${prefix}/displaced`);
    const incomingDirectories:any[] = folderPlan?.folders??[];
    const displacedDirectories:any[] = folderPlan?.displaced?.folders??[];
    const desired = new Set<string>();
    const includeParents = (path:string,includeSelf=false)=>{
      const parts = path.split('/'); if (!includeSelf) parts.pop();
      for (let n=1;n<=parts.length;n++) desired.add(parts.slice(0,n).join('/'));
    };
    const mkdirs = async(paths:Set<string>,label:string,forceWithin?:string):Promise<Leaf[]> => {
      const leaves:Leaf[] = [];
      for (const path of [...paths].sort((a,b)=>a.split('/').length-b.split('/').length || a.localeCompare(b))) {
        const forced = Boolean(forceWithin && (path===forceWithin || path.startsWith(forceWithin+'/')));
        if (!forced && await m.exists(path)) { await m.directory(path); continue }
        leaves.push({kind:'mkdir',target:path,stage:`${prefix}/${label}-${leaves.length}`});
      }
      return leaves;
    };
    if (folderPlan?.displaced) {
      for (const directory of displacedDirectories) includeParents(directory.after.path,true);
      for (const record of displacedRecords) if (record.after_state?.fileId && !record.after_state.deleted) includeParents(record.after_state.path);
      plan.leaves.push(...await mkdirs(desired,'displaced-dir'));
      for (const [index,record] of displacedRecords.entries()) await fileLeaf(record.before_state,record.after_state,'move',`${prefix}/displaced-source-${index}`);
      for (const [index,directory] of [...displacedDirectories].reverse().entries()) plan.leaves.push({kind:'rmdir',source:directory.before.path,
        directory:await m.directory(directory.before.path),stage:`${prefix}/displaced-removed-dir-${index}`});
      desired.clear();
    }
    if (receipt.action==='create-folder') includeParents(receipt.after_state.path,true);
    for (const directory of incomingDirectories) if (!directory.deleted) includeParents(directory.after.path,true);
    for (const record of incomingRecords) if (record.after_state?.fileId && !record.after_state.deleted) includeParents(record.after_state.path);
    if (displacedFileAfter) includeParents(displacedFileAfter.path);
    plan.leaves.push(...await mkdirs(desired,'dir',folderPlan?.displaced?.source));
    if (receipt.action!=='create-folder') for (const [index,record] of incomingRecords.entries()) await fileLeaf(record.before_state,record.after_state,record.action==='rename'?'move':record.action,`${prefix}/source-${index}`);
    if (incomingDirectories.length && receipt.action!=='copy') {
      for (const [index,directory] of [...incomingDirectories].reverse().entries()) plan.leaves.push({kind:'rmdir',source:directory.before.path,
        directory:await m.directory(directory.before.path),stage:`${prefix}/removed-dir-${index}`});
    }
    await rows.startPublishing(this.deps.db, receipt.id, receipt.action, plan);
    for (const leaf of plan.leaves) {
      cancellation.assertNotCancelled(operationId);
      if (leaf.kind==='mkdir') {
        const staged = await m.stageDirectory(leaf.stage);
        leaf.directory = {...staged,path:leaf.target!};
        // Persist inode ownership BEFORE the directory becomes public.
        await this.ledger.save(receipt.id,plan);
      }
      await this.forward(m,leaf);
      await this.ledger.save(receipt.id,plan);
    }
    cancellation.assertNotCancelled(operationId);
    const displacedFileIds = new Set(displacedRecords.map((record:any)=>record.before_state?.fileId).filter(Boolean));
    for (const w of watched) if (receipt.action!=='copy' || displacedFileIds.has(w.file_id) || w.file_id===displacedFileBefore?.fileId) await rows.forgetWatched(client, w.file_id);
    for (const state of [...records.map((r:any)=>r.after_state),displacedFileAfter]) {
      if (!state?.fileId || state.deleted) continue;
      const leaf = plan.leaves.find(l=>l.target===state.path);
      if (!leaf?.published) throw failure();
      await this.ledger.watch(client,root,state.fileId,state.path,leaf.hash!,leaf.published);
    }
    plan.committed = await this.ledger.capture(client,receipt);
    await rows.markDbCommitted(client, receipt.id, plan);
  }

  private async forward(m:FilesMutationCoordinator, leaf:Leaf):Promise<void> {
    if (leaf.kind==='mkdir') { leaf.directory = await m.restoreEmptyDirectory(leaf.directory!,leaf.stage); return }
    if (leaf.kind==='rmdir') { await m.evictEmptyDirectory(leaf.directory!,leaf.stage); return }
    if (leaf.kind==='restore-dir') { leaf.directory = await m.restoreEmptyDirectory(leaf.retainedDirectory!,leaf.stage); return }
    const check = (p:PinnedRegularFile)=>verify(p,leaf.hash!,leaf.before);
    if (leaf.kind==='copy') {
      const pin = await m.pinVerified(leaf.source!,check); await pin.close();
      const result = await m.copyVerified({ source:leaf.source!,target:leaf.target!,staged:leaf.stage,verify:p=>verify(p,leaf.hash!) });
      leaf.published = packed(result.fingerprint); return;
    }
    if (leaf.kind==='restore') {
      const result = await m.publishVerified({ staged:leaf.stage,target:leaf.target!,verify:check });
      leaf.published = packed(result.fingerprint); return;
    }
    await m.evictVerified({ source:leaf.source!,quarantine:leaf.stage,verify:check });
    if (leaf.kind==='move') {
      const result = await m.publishVerified({ staged:leaf.stage,target:leaf.target!,verify:check });
      leaf.published = packed(result.fingerprint);
    }
  }

  /** Validates ALL targets before moving the first byte, then publishes the exact inverse plan. */
  async inverse(client:pg.PoolClient, receipt:any, root:NativeJournalRoot):Promise<void> {
    const { rows, db } = this.deps;
    const row = await rows.find(db, receipt.id);
    if (!row || row.plan.version!==2 || !['completed','db-committed'].includes(row.state)) throw failure();
    const plan:Plan = row.plan;
    for (const leaf of plan.leaves) {
      if (leaf.kind==='mkdir') {
        const actual = await root.mutations.directory(leaf.target!);
        if (actual.dev!==leaf.directory?.dev || actual.ino!==leaf.directory?.ino) throw failure();
      } else if (leaf.kind==='rmdir') {
        const retained = await root.mutations.directory(leaf.stage);
        if (retained.dev!==leaf.directory?.dev || retained.ino!==leaf.directory?.ino) throw failure();
      } else {
        const pin = await root.mutations.pinVerified(leaf.kind==='trash'?leaf.stage:leaf.target!,p=>verify(p,leaf.hash!,leaf.published??leaf.before));
        await pin.close();
      }
    }
    const attempt = randomUUID();
    plan.inverse = [...plan.leaves].reverse().map((leaf,index):Leaf => {
      const stage = `.sulla-trash/.operations/${plan.operationId}/${plan.itemId}/${receipt.id}/undo-${attempt}-${index}`;
      if (leaf.kind==='mkdir') return { kind:'rmdir',stage,directory:leaf.directory };
      if (leaf.kind==='rmdir') return { kind:'restore-dir',stage:leaf.stage,directory:leaf.directory,retainedDirectory:leaf.directory };
      if (leaf.kind==='trash') return { kind:'restore',target:leaf.source,stage:leaf.stage,hash:leaf.hash,before:leaf.before };
      return { kind:leaf.kind==='copy'?'trash':'move',source:leaf.target,target:leaf.source,stage,hash:leaf.hash,before:leaf.published };
    });
    await rows.startUndoPublishing(db, receipt.id, plan);
    for (const leaf of plan.inverse) { await this.forward(root.mutations,leaf); await this.ledger.save(receipt.id,plan) }
    const folderPlan = receipt.folder_plan?.source?receipt.folder_plan:null;
    const states = folderPlan?[...folderPlan.children,...(folderPlan.displaced?.children??[])].map((c:any)=>c.after):[receipt.after_state,receipt.displaced_after];
    for (const state of states) if (state?.fileId) await rows.forgetWatched(client, state.fileId);
    const displacedFileIds = new Set((folderPlan?.displaced?.children??[]).map((child:any)=>child.before?.fileId).filter(Boolean));
    const displacedFileId = !folderPlan ? receipt.displaced_before?.fileId : undefined;
    for (const w of plan.watched) {
      if (receipt.action==='copy' && !displacedFileIds.has(w.file_id) && w.file_id!==displacedFileId) continue;
      const pin = await root.mutations.pinVerified(w.path,p=>verify(p,w.content_hash));
      try { await this.ledger.watch(client,root,w.file_id,w.path,w.content_hash,packed(pin.fingerprint)) } finally { await pin.close() }
    }
    plan.inverseCommitted = await this.ledger.capture(client,receipt);
    await rows.markUndoDbCommitted(client, receipt.id, plan);
  }

  /** db-committed rows are verified exactly; anything earlier is rolled back leaf by leaf. Stages are retained for undo. */
  async recover(row:any):Promise<void> {
    const plan:Plan = row.plan;
    const root = await this.deps.resolve(plan.collectionId);
    if (!root || root.id!==plan.rootId) throw failure();
    await root.mutations.runExclusive([],async() => {
      const undo = row.state.startsWith('undo-');
      if (['db-committed','undo-db-committed'].includes(row.state)) await this.verifyCommitted(root,plan,undo);
      if (!['db-committed','undo-db-committed'].includes(row.state)) {
        for (const leaf of [...(undo?plan.inverse!:plan.leaves)].reverse()) await this.rollback(root.mutations,leaf);
        if (undo) {
          for (const leaf of plan.leaves) if (leaf.kind==='mkdir') leaf.directory = await root.mutations.directory(leaf.target!);
          await this.ledger.save(row.operation_id,plan);
        }
      }
      // Retain stages for undo; never finalize/delete recovery artifacts here.
      await this.deps.rows.markState(this.deps.db, row.operation_id, row.state==='undo-db-committed'?'undone':undo?'completed':row.state==='db-committed'?'completed':'rolled-back');
    });
  }

  /** The database rows and every native artifact match the committed plan exactly (forward or inverse). */
  private async verifyCommitted(root:NativeJournalRoot, plan:Plan, undo:boolean):Promise<void> {
    const expected = NativeJournalLedger.expected(undo?plan.inverseCommitted:plan.committed);
    if (!expected) throw failure();
    const actual = await this.ledger.captureIds(this.deps.db,expected.fileIds,expected.folderIds);
    if (NativeJournalIntegrity.canonical(expected)!==NativeJournalIntegrity.canonical(actual)) throw failure();
    const leaves = undo?plan.inverse!:plan.leaves;
    const finalTargets = new Set(leaves.filter(l=>['move','copy','restore','mkdir'].includes(l.kind)).map(l=>l.target));
    const directoryPath = (leaf:Leaf):string|undefined => leaf.kind==='mkdir' ? leaf.target
      : ['rmdir','restore-dir'].includes(leaf.kind) ? leaf.directory?.path : undefined;
    const finalDirectoryOperations = new Map<string,Leaf>();
    for (const leaf of leaves) {
      const path = directoryPath(leaf);
      if (path) finalDirectoryOperations.set(path,leaf);
    }
    for (const leaf of leaves) {
      if (leaf.kind==='mkdir' || leaf.kind==='restore-dir') {
        const path = directoryPath(leaf)!;
        const finalOperation = finalDirectoryOperations.get(path);
        if (finalOperation===leaf) {
          const actual = await root.mutations.directory(path);
          if (actual.dev!==leaf.directory!.dev || actual.ino!==leaf.directory!.ino) throw failure();
        } else if (finalOperation?.kind!=='rmdir' || finalOperation.directory?.dev!==leaf.directory!.dev || finalOperation.directory?.ino!==leaf.directory!.ino) {
          throw failure();
        }
      } else if (leaf.kind==='rmdir') {
        const retained = await root.mutations.directory(leaf.stage);
        if (retained.dev!==leaf.directory!.dev || retained.ino!==leaf.directory!.ino) throw failure();
        const tree = await root.mutations.inspectTree(leaf.stage);
        if (tree.files.length || tree.directories.length!==1) throw failure();
        const replacement = finalDirectoryOperations.get(leaf.directory!.path);
        if (replacement===leaf) {
          if (await root.mutations.exists(leaf.directory!.path)) throw failure();
        } else {
          if (!replacement || !['mkdir','restore-dir'].includes(replacement.kind) || !replacement.directory) throw failure();
          const published = await root.mutations.directory(leaf.directory!.path);
          if (published.dev!==replacement.directory.dev || published.ino!==replacement.directory.ino) throw failure();
        }
      } else {
        const pin = await root.mutations.pinVerified(leaf.stage,p=>verify(p,leaf.hash!,leaf.kind==='copy'?leaf.published:leaf.before)); await pin.close();
        if (leaf.kind!=='trash') {
          const target = await root.mutations.pinVerified(leaf.target!,p=>verify(p,leaf.hash!,leaf.published)); await target.close();
        }
        if ((leaf.kind==='move' || leaf.kind==='trash') && !finalTargets.has(leaf.source) && await root.mutations.exists(leaf.source!)) throw failure();
      }
    }
    const treePaths = undo?(plan.treesUndo??(plan.treeBefore?[plan.treeBefore]:[])):(plan.treesAfter??(plan.treeAfter?[plan.treeAfter]:[]));
    const absentPaths = undo?(plan.absentUndo??(plan.treeAfter?[plan.treeAfter]:[])):(plan.absentAfter??(plan.treeBefore?[plan.treeBefore]:[]));
    for (const absentPath of absentPaths) if (!treePaths.includes(absentPath) && await root.mutations.exists(absentPath)) throw failure();
    for (const treePath of treePaths) {
      const tree = await root.mutations.inspectTree(treePath,path=>!isProtectedPath(path));
      const inTree = (entry:any)=>!entry.deleted && (entry.path===treePath || entry.path.startsWith(treePath+'/'));
      const files = expected.files.filter(inTree).map(f=>f.path).sort();
      const dirs = expected.folders.filter(inTree).map(f=>f.path).sort();
      if (NativeJournalIntegrity.canonical(tree.files.sort())!==NativeJournalIntegrity.canonical(files) || NativeJournalIntegrity.canonical(tree.directories.sort())!==NativeJournalIntegrity.canonical(dirs)) throw failure();
    }
    // Old inverse artifacts stay part of the custody proof after undo too.
    if (undo) for (const leaf of plan.leaves) {
      if (leaf.hash) { const pin = await root.mutations.pinVerified(leaf.stage,p=>verify(p,leaf.hash!,leaf.published??leaf.before)); await pin.close() }
      if (leaf.kind==='rmdir') {
        const kept = await root.mutations.directory(leaf.directory!.path);
        if (kept.dev!==leaf.directory!.dev || kept.ino!==leaf.directory!.ino) throw failure();
      }
    }
  }

  private async rollback(m:FilesMutationCoordinator, leaf:Leaf):Promise<void> {
    if (leaf.kind==='mkdir') {
      if (!await m.exists(leaf.target!)) return;
      if (!leaf.directory) throw failure();
      const retained = leaf.stage;
      if (await m.exists(retained)) throw failure();
      await m.evictEmptyDirectory(leaf.directory,retained); return;
    }
    if (leaf.kind==='rmdir') {
      if (!await m.exists(leaf.directory!.path)) {
        await m.restoreEmptyDirectory(leaf.directory!,leaf.stage); return;
      }
      const current = await m.directory(leaf.directory!.path);
      if (current.dev!==leaf.directory!.dev || current.ino!==leaf.directory!.ino) throw failure();
      return;
    }
    if (leaf.kind==='restore-dir') {
      if (await m.exists(leaf.directory!.path)) await m.evictEmptyDirectory(leaf.directory!,leaf.stage);
      return;
    }
    const staged = await m.exists(leaf.stage);
    if (!staged) {
      if (leaf.kind==='copy') { if (await m.exists(leaf.target!)) throw failure(); return }
      if (!leaf.source) throw failure();
      const pin = await m.pinVerified(leaf.source,p=>verify(p,leaf.hash!,leaf.before)); await pin.close(); return;
    }
    const pin = await m.pinVerified(leaf.stage,p=>verify(p,leaf.hash!,leaf.kind==='copy'?undefined:leaf.before));
    const fp = pin.fingerprint; await pin.close();
    if (leaf.kind!=='trash' && leaf.target && await m.exists(leaf.target)) {
      await m.rollbackPublication({ staged:leaf.stage,target:leaf.target,fingerprint:fp,rollback:leaf.stage+'-rollback-file' },p=>verify(p,leaf.hash!));
    }
    if (leaf.kind==='move' || leaf.kind==='trash') await m.recoverEviction({ source:leaf.source!,quarantine:leaf.stage,fingerprint:fp },p=>verify(p,leaf.hash!));
  }

  /** GC only the exact retained identities recorded by one invalidated receipt. */
  async dispose(receiptId:string):Promise<{state:'none'|'complete'|'recovery-required';error?:string}> {
    const row = await this.deps.rows.find(this.deps.db, receiptId);
    if (!row) return {state:'none'};
    const plan:Plan = row.plan;
    if (row.action!=='trash' || !plan?.disposal?.undoInvalidatedAt) throw failure();
    if (!['completed','undone','rolled-back'].includes(row.state)) throw failure();
    if (plan.disposal.artifactsDisposedAt) return {state:'complete'};
    const root = await this.deps.resolve(plan.collectionId);
    if (!root || root.id!==plan.rootId) return {state:'recovery-required',error:'Native root is unavailable; retained artifacts were preserved'};
    try {
      await root.mutations.runExclusive([],async()=>{
        const disposed = new Set(plan.disposal!.disposedPaths??[]);
        for (const leaf of plan.leaves) {
          if (disposed.has(leaf.stage)) continue;
          if (leaf.kind==='rmdir') {
            if (!leaf.directory) throw failure();
            if (await root.mutations.exists(leaf.stage)) await root.mutations.disposeRetainedDirectory({...leaf.directory,path:leaf.stage});
            else if (row.state==='undone') {
              const restored = await root.mutations.directory(leaf.directory.path);
              if (restored.dev!==leaf.directory.dev || restored.ino!==leaf.directory.ino) throw failure();
            } else if (row.state!=='completed') throw failure();
          } else if (leaf.hash && leaf.before) {
            if (await root.mutations.exists(leaf.stage)) await root.mutations.disposeRetainedFile(leaf.stage,NativeJournalIntegrity.fingerprint(leaf.before),p=>verify(p,leaf.hash!,leaf.before));
          } else continue;
          disposed.add(leaf.stage); plan.disposal!.disposedPaths = [...disposed]; plan.disposal!.lastError = undefined; await this.ledger.save(receiptId,plan);
        }
        plan.disposal!.artifactsDisposedAt = new Date().toISOString(); plan.disposal!.lastError = undefined; await this.ledger.save(receiptId,plan);
      });
      return {state:'complete'};
    } catch(error:any) {
      plan.disposal.lastError = String(error?.message??error).slice(0,1000); await this.ledger.save(receiptId,plan).catch(()=>undefined);
      return {state:'recovery-required',error:'Retained artifacts were preserved because ownership verification or cleanup did not complete'};
    }
  }
}
