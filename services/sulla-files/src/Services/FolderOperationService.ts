// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { FilesIdentity } from '../auth.js';
import type { FolderBatchExecution } from './DatabaseBatchTypes.js';
import type { DatabaseOperationContext } from './DatabaseOperationContext.js';
import type { DatabaseOperationService } from './DatabaseOperationService.js';
import { folderGrantMigration, type DatabaseOperationAccess, type OperationGuard } from './DatabaseOperationTypes.js';
import { FolderSubtreeInspector, type FolderTree } from './FolderSubtreeInspector.js';
import { OperationFailure } from './OperationFailure.js';

const fail = (message:string, code='state-conflict') => OperationFailure.coded(409, message, code);
const state = FolderSubtreeInspector.state;
const metadataAccess = FolderSubtreeInspector.metadataAccess;

/** Executes one folder move, copy, rename or Trash item with its whole subtree in one transaction. */
export class FolderOperationService {
  constructor(
    private readonly context:DatabaseOperationContext,
    private readonly files:DatabaseOperationService,
    private readonly inspector = new FolderSubtreeInspector(context),
  ) {}

  async execute(input:FolderBatchExecution, actor:FilesIdentity, access:DatabaseOperationAccess, guard:OperationGuard):Promise<void> {
    await access.prepare?.(input.collectionId);
    const destinationCollection = input.targetCollectionId??input.collectionId;
    if (destinationCollection!==input.collectionId) await access.prepare?.(destinationCollection);
    await this.context.transaction.run(client => this.run(client, input, destinationCollection, actor, access, guard));
  }

  private async run(client:pg.PoolClient, input:FolderBatchExecution, destinationCollection:string, actor:FilesIdentity, access:DatabaseOperationAccess, guard:OperationGuard):Promise<void> {
    const { subtree, locks, policy, receipts } = this.context;
    await guard(client);
    for (const id of [...new Set([input.collectionId,destinationCollection])].sort()) await locks.lockNamespace(client, id);
    const source = input.folderPath!;
    await access.path(client,input.collectionId,source);
    const files = await subtree.lockFilesByPath(client, input.collectionId, source);
    const folders = await subtree.lockFoldersByDepth(client, input.collectionId, source);
    const nativeFolders = await access.custody?.folders(input.collectionId,source,files.map(f=>f.path))??[];
    if (!files.length && !folders.length && !nativeFolders.length) throw fail('Folder no longer exists','source-conflict');
    if (files.some(f=>f.deleted_at) || folders.some(f=>f.deleted_at)) throw fail('Folder contains trashed entries; restore or relocate them first','source-conflict');
    const explicit = folders.find(f=>f.path===source);
    if (input.expectedFolder && (!explicit || explicit.id!==input.expectedFolder.folderId || explicit.path!==input.expectedFolder.path || String(explicit.operation_revision)!==input.expectedFolder.revision ||
      (input.expectedFolder.collectionId!==undefined && input.expectedFolder.collectionId!==input.collectionId))) throw fail('Folder identity or revision changed','source-conflict');
    for (const file of files) await access.file(client,file.id);
    for (const folder of folders) await access.path(client,input.collectionId,folder.path);
    const receiptId = randomUUID();
    const sourceTree = await this.inspector.tree(client, access, input.collectionId, source, files, folders);
    await this.assertTransferable(client, input, destinationCollection, source, files, sourceTree, actor);
    const destination = input.action!=='trash' ? await this.resolveDestination(client, input, destinationCollection, source, receiptId, actor, access) : { target: input.targetPath, skipped: false, displaced: null };
    const { target, skipped, displaced } = destination;
    const displacedRoot = displaced?.folders.find((f:any)=>f.before.path===displaced.source);
    const row = await receipts.insertFolder(client, receiptId, actor.userId, OperationFailure.scope(actor), input.idempotencyKey, input, input.collectionId, input.action, skipped?'skipped':'completed',
      JSON.stringify(explicit?state(explicit):null), JSON.stringify(displacedRoot?.before??null), JSON.stringify(displacedRoot?.after??null));
    if (skipped) return;
    const ordered = FolderSubtreeInspector.orderedPaths(source, folders, nativeFolders, files);
    const folderChanges:any[] = [];
    for (const path of ordered) {
      await access.path(client,input.collectionId,path);
      let folder = folders.find(f=>f.path===path);
      if (!folder) folder = await subtree.insertFolder(client, input.collectionId, path, actor.userId);
      const before = state(folder);
      let after:any;
      if (input.action==='copy') after = await subtree.insertFolder(client, destinationCollection, target+path.slice(source.length), actor.userId);
      else if (input.action==='trash') after = await subtree.trashFolder(client, folder.id);
      else after = await subtree.relocateFolder(client, folder.id, destinationCollection, target+path.slice(source.length));
      folderChanges.push({before,after:state(after),deleted:input.action==='trash'});
    }
    const children:any[] = [];
    for (const file of files) {
      if (input.batchOperationId) this.context.cancellation.assertNotCancelled(input.batchOperationId);
      const child = await this.files.execute({idempotencyKey:randomUUID(),collectionId:input.collectionId,action:input.action as 'move'|'copy'|'rename'|'trash',
        fileId:file.id,expectedVersionId:file.current_version_id,expectedRevision:String(file.operation_revision),
        ...(input.action==='trash'?{}:{targetPath:target+file.path.slice(source.length),...(destinationCollection!==input.collectionId?{targetCollectionId:destinationCollection}:{}),parentFollows:true})},actor,metadataAccess(access),undefined,client);
      children.push(child);
    }
    const transferredGrants = destinationCollection!==input.collectionId ? await this.transferGrants(client, input, destinationCollection, source, target!, sourceTree, actor) : undefined;
    // Child receipts are created before the folder-owned grant relocation is
    // complete. Sign them only after every owned grant change, otherwise an
    // immediate guarded Undo mistakes this operation's own changes for an
    // external permission change. This includes displaced Replace children:
    // their collection-wide signature also observes transferred grants.
    for (const child of [...children,...(displaced?.children??[])]) await receipts.signQuietly(client, child.operationId, await policy.permissionSignature(client,child.collectionId,child.operationId));
    const plan = { sourceCollectionId:input.collectionId,targetCollectionId:destinationCollection,source,target,folders:folderChanges,children,
      sourceSubtreeSignature:sourceTree.subtreeSignature,...(transferredGrants?{transferredGrants}:{}),...(displaced?{displaced}:{}),
      ...(input.action==='trash'?{lifecycle:await policy.receiptLifecycle(client,input.collectionId,new Date())}:{}) };
    const updated = await receipts.completeFolder(client, row.id, folderChanges.find(f=>f.before.path===source)?.after, plan);
    await receipts.signQuietly(client, row.id, await policy.permissionSignature(client,input.collectionId,row.id));
    await access.custody?.publish(client,updated,false);
    await this.context.audit.folderOperation(client, actor, {operationId:row.id,action:input.action,collectionId:input.collectionId});
  }

  /** Cross-collection items must match the displayed subtree; same-collection items must hold no nested grants. */
  private async assertTransferable(client:pg.PoolClient, input:FolderBatchExecution, destinationCollection:string, source:string, files:any[], sourceTree:FolderTree, actor:FilesIdentity):Promise<void> {
    if (destinationCollection!==input.collectionId) {
      const expectedSource = (input as any).sourceSubtreeSignature??input.expectedFolder?.subtreeSignature;
      if (!expectedSource || sourceTree.subtreeSignature!==expectedSource) {
        throw Object.assign(fail('The source folder subtree changed; refresh Files','source-conflict'),{source:{collectionId:input.collectionId,...(sourceTree.snapshot??{path:source}),subtreeSignature:sourceTree.subtreeSignature}});
      }
      if (input.action==='copy' && await this.context.grants.activeLinkInSubtree(client, files.map(file=>file.id), input.collectionId, source)) {
        throw Object.assign(new Error('Cross-collection folder copies with active public links require explicit new links'),{status:422,code:'cross-collection-boundary'});
      }
      await this.context.policy.crossCollectionBoundary(client,input.collectionId,destinationCollection,actor,{sourcePath:source,targetPath:input.targetPath,fileIds:files.map(file=>file.id)});
    } else if (sourceTree.folderShares.length || sourceTree.publicLinks.length) {
      throw Object.assign(new Error('Folder has nested grants or public links'),{ status:422,code:'folder-permission-boundary' });
    }
  }

  /** Applies the collision policy at the destination; Replace displaces the destination subtree first. */
  private async resolveDestination(client:pg.PoolClient, input:FolderBatchExecution, destinationCollection:string, source:string, receiptId:string, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<{ target?:string; skipped:boolean; displaced:any }> {
    let target = input.targetPath;
    let skipped = false; let displaced:any = null;
    const occupied = (collectionId:string, path:string) => this.occupied(client, access, collectionId, path);
    if (!target) throw fail('Folder destination is required');
    if (destinationCollection===input.collectionId && (target===source || target.startsWith(source+'/') || source.startsWith(target+'/'))) throw fail('Folder destination overlaps its source');
    await access.path(client,destinationCollection,target);
    if (await occupied(destinationCollection,target)) {
      if (input.collisionPolicy==='skip') skipped = true;
      else if (input.collisionPolicy==='keep-both') {
        let n = 2; while (await occupied(destinationCollection,target) && n<=1000) { target = input.targetPath+' ('+n+')'; n++ }
        if (await occupied(destinationCollection,target)) throw fail('No available Keep Both destination');
      } else if (input.collisionPolicy==='replace') {
        displaced = await this.displaceDestination(client, input, destinationCollection, target, receiptId, actor, access);
      } else {
        const destination = await this.inspector.tree(client, access, destinationCollection, target);
        throw Object.assign(fail('Folder destination is occupied; choose Replace, Keep Both or Skip','destination-conflict'),{...(destination.snapshot?{destination:destination.snapshot}:{})});
      }
    } else if (input.collisionPolicy==='replace') throw fail('The Replace destination no longer exists; refresh Files','destination-conflict');
    if (!skipped) {
      await access.path(client,destinationCollection,target);
      if (destinationCollection===input.collectionId) await this.context.policy.permissionBoundary(client,input.collectionId,source,target);
    }
    return { target, skipped, displaced };
  }

  private async occupied(client:pg.PoolClient, access:DatabaseOperationAccess, collectionId:string, path:string):Promise<boolean> {
    return await this.context.subtree.occupied(client, collectionId, path) || Boolean(await access.custody?.occupied(collectionId,path));
  }

  /**
   * Replace: the complete destination grant subtree moves with its identities to a
   * same-parent recovery sibling; inherited outer grants do not change.
   */
  private async displaceDestination(client:pg.PoolClient, input:FolderBatchExecution, destinationCollection:string, target:string, receiptId:string, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<any> {
    const { subtree, grants } = this.context;
    const destination = await this.inspector.tree(client, access, destinationCollection, target);
    const { destinationFiles, destinationFolders, destinationNativeFolders, folderShares, publicLinks } = destination;
    const destinationRoot = destination.root;
    const expected = (input as any).expectedDestination;
    if (!destinationRoot || !expected || destinationRoot.id!==expected.folderId || destinationRoot.collection_id!==(expected.collectionId??destinationCollection) || destinationRoot.path!==expected.path || String(destinationRoot.operation_revision)!==expected.revision || destination.snapshot?.subtreeSignature!==expected.subtreeSignature) {
      throw Object.assign(fail('The Replace destination changed; refresh Files','destination-conflict'),{...(destination.snapshot?{destination:destination.snapshot}:{})});
    }
    if (destinationFiles.some(f=>f.deleted_at) || destinationFolders.some(f=>f.deleted_at)) throw fail('Replace destination contains trashed entries; restore or relocate them first');
    for (const file of destinationFiles) await access.file(client,file.id);
    for (const folder of destinationFolders) await access.path(client,destinationCollection,folder.path);
    const slash = target.lastIndexOf('/');
    const recovery = target.slice(0,slash+1)+'.replaced-'+receiptId+'-'+target.slice(slash+1);
    if (await this.occupied(client, access, destinationCollection, recovery)) throw fail('Replace recovery sibling is occupied');
    await access.path(client,destinationCollection,recovery);
    const destinationOrdered = FolderSubtreeInspector.orderedPaths(target, destinationFolders, destinationNativeFolders, destinationFiles);
    const displacedChildren:any[] = [];
    for (const file of destinationFiles) {
      const child = await this.files.execute({idempotencyKey:randomUUID(),collectionId:destinationCollection,action:'rename',fileId:file.id,
        expectedVersionId:file.current_version_id,expectedRevision:String(file.operation_revision),targetPath:recovery+file.path.slice(target.length),[folderGrantMigration]:true,parentFollows:true},
      actor,metadataAccess(access),undefined,client);
      displacedChildren.push(child);
    }
    const displacedFolders:any[] = [];
    for (const path of destinationOrdered) {
      let folder = destinationFolders.find(f=>f.path===path);
      if (!folder) folder = await subtree.insertFolder(client, destinationCollection, path, actor.userId);
      const before = state(folder);
      const after = await subtree.renameFolder(client, folder.id, recovery+path.slice(target.length));
      displacedFolders.push({before,after:state(after),deleted:false});
    }
    const targetLength = target.length;
    const movedGrants = {
      folderShares:folderShares.map(grant=>({id:grant.id,beforePath:grant.folder_path,afterPath:recovery+grant.folder_path.slice(targetLength)})),
      publicLinks:publicLinks.map(link=>({id:link.id,beforePath:link.folder_path,afterPath:recovery+link.folder_path.slice(targetLength)})),
      fileIds:destination.fileIds,fileSharesSignature:destination.fileSharesSignature,fileLinksSignature:destination.fileLinksSignature,
    };
    for (const grant of movedGrants.folderShares) await grants.moveShare(client, grant.id, grant.afterPath);
    for (const link of movedGrants.publicLinks) await grants.moveLink(client, link.id, link.afterPath);
    return {collectionId:destinationCollection,source:target,target:recovery,folders:displacedFolders,children:displacedChildren,grants:movedGrants};
  }

  /** Cross-collection: folder grants follow a move, are duplicated for a copy; public links only follow a move. */
  private async transferGrants(client:pg.PoolClient, input:FolderBatchExecution, destinationCollection:string, source:string, target:string, sourceTree:FolderTree, actor:FilesIdentity):Promise<{ folderShares:any[]; publicLinks:any[] }> {
    const { grants } = this.context;
    const folderShares = [] as any[]; const publicLinks = [] as any[];
    for (const grant of sourceTree.folderShares) {
      const afterPath = target+grant.folder_path.slice(source.length);
      if (input.action==='copy') {
        const inserted = await grants.copyShare(client, destinationCollection, afterPath, grant, actor.userId);
        folderShares.push({id:inserted.id,beforePath:grant.folder_path,afterPath,copy:true});
      } else {
        await grants.transferShare(client, grant.id, destinationCollection, afterPath);
        folderShares.push({id:grant.id,beforePath:grant.folder_path,afterPath,copy:false});
      }
    }
    for (const link of sourceTree.publicLinks) {
      if (input.action==='copy') continue;
      const afterPath = target+link.folder_path.slice(source.length);
      await grants.transferLink(client, link.id, destinationCollection, afterPath);
      publicLinks.push({id:link.id,beforePath:link.folder_path,afterPath});
    }
    return {folderShares,publicLinks};
  }
}
