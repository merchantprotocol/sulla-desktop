// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { FilesIdentity } from '../auth.js';
import type { DatabaseOperationContext } from './DatabaseOperationContext.js';
import type { DatabaseOperationUndoService } from './DatabaseOperationUndoService.js';
import type { DatabaseOperationAccess, OperationGuard } from './DatabaseOperationTypes.js';
import { FolderSubtreeInspector } from './FolderSubtreeInspector.js';
import { OperationFailure } from './OperationFailure.js';

const fail = (message:string, code='state-conflict') => OperationFailure.coded(409, message, code);

/** Undoes one folder receipt: verifies the whole subtree and its grants, then restores files, folders and grants. */
export class FolderUndoService {
  constructor(private readonly context:DatabaseOperationContext, private readonly fileUndo:DatabaseOperationUndoService) {}

  async undo(id:string, actor:FilesIdentity, access:DatabaseOperationAccess, guard:OperationGuard):Promise<void> {
    const scope = OperationFailure.scope(actor);
    const initial = await this.context.receipts.ownedHeader(this.context.db, id, actor.userId, scope);
    if (!initial) throw fail('Folder receipt missing');
    await access.prepare?.(initial.collection_id);
    if (initial.request?.targetCollectionId && initial.request.targetCollectionId!==initial.collection_id) await access.prepare?.(initial.request.targetCollectionId);
    await this.context.transaction.run(client => this.run(client, id, actor, access, guard));
  }

  private async run(client:pg.PoolClient, id:string, actor:FilesIdentity, access:DatabaseOperationAccess, guard:OperationGuard):Promise<void> {
    const { receipts, locks, policy, subtree } = this.context;
    await guard(client);
    const row = await receipts.lockOwned(client, id, actor.userId, OperationFailure.scope(actor));
    if (!row?.folder_plan) throw fail('Folder receipt missing');
    const plan = row.folder_plan;
    const sourceCollection = plan.sourceCollectionId??row.collection_id;
    const targetCollection = plan.targetCollectionId??row.collection_id;
    if (plan.lifecycle?.disposal?.undoInvalidatedAt) throw fail('Undo was explicitly invalidated by permanent disposal');
    await access.path(client,sourceCollection,plan.source);
    if (plan.target) await access.path(client,targetCollection,plan.target);
    if (row.state==='undone') return;
    if (row.state!=='completed') throw fail('Folder operation cannot be undone');
    if (row.permission_signature!==await policy.permissionSignature(client,row.collection_id,row.id)) throw fail('Folder permissions changed');
    for (const collectionId of [...new Set([sourceCollection,targetCollection])].sort()) await locks.lockNamespace(client, collectionId);
    const subtreePath = plan.target??plan.source;
    const currentCollection = plan.target?targetCollection:sourceCollection;
    await this.validateTree(client, access, currentCollection, subtreePath, plan.children, plan.folders, 'Folder');
    if (!await this.grantsMatch(client, currentCollection, subtreePath, plan.transferredGrants)) throw fail('Folder grants or public links changed');
    if (plan.displaced) await this.validateDisplaced(client, access, plan.displaced, targetCollection);
    const ownedGrantMigration = sourceCollection!==targetCollection && Boolean(plan.transferredGrants);
    if (ownedGrantMigration) await this.revertTransferredGrants(client, plan, sourceCollection, targetCollection);
    // File inverses restore metadata first; the one native journal publishes
    // the complete folder inverse before this transaction can commit.
    const metadata = FolderSubtreeInspector.metadataAccess(access);
    for (const child of [...plan.children].reverse()) await this.fileUndo.undo(child.operationId,actor,metadata,undefined,client,
      { ...(ownedGrantMigration?{permissionSignatureVerified:true as const}:{}), ...(row.action==='move'?{parentFollows:true as const}:{}) });
    for (const folder of [...plan.folders].reverse()) {
      await access.path(client,folder.after.collectionId??targetCollection,folder.after.path);
      await access.path(client,folder.before.collectionId??sourceCollection,folder.before.path);
      if (row.action==='copy') await subtree.deleteFolder(client, folder.after.folderId);
      else await subtree.restoreFolderTo(client, folder.after.folderId, folder.before.collectionId??sourceCollection, folder.before.path);
    }
    if (plan.displaced) {
      const displacedCollection = plan.displaced.collectionId??targetCollection;
      for (const child of [...plan.displaced.children].reverse()) await this.fileUndo.undo(child.operationId,actor,metadata,undefined,client,
        {folderGrantMigration:true,parentFollows:true,...(ownedGrantMigration?{permissionSignatureVerified:true as const}:{})});
      for (const folder of [...plan.displaced.folders].reverse()) {
        await access.path(client,displacedCollection,folder.after.path);
        await access.path(client,displacedCollection,folder.before.path);
        await subtree.restoreFolder(client, folder.after.folderId, folder.before.path);
      }
      for (const grant of plan.displaced.grants?.folderShares??[]) await this.context.grants.revertSharePath(client, grant.id, grant.beforePath, grant.afterPath);
      for (const link of plan.displaced.grants?.publicLinks??[]) await this.context.grants.revertLinkPath(client, link.id, link.beforePath, link.afterPath);
    }
    await access.custody?.publish(client,row,true);
    await receipts.markUndoneQuietly(client, id);
  }

  /** The live subtree must hold exactly the receipt's files and folders, with the same identities and lifecycle. */
  private async validateTree(client:pg.PoolClient, access:DatabaseOperationAccess, collectionId:string, subtreePath:string, children:any[], folders:any[], label:string):Promise<void> {
    const { subtree } = this.context;
    const actualFiles = await subtree.lockFilesAtOrUnder(client, collectionId, subtreePath);
    const expectedFiles = new Map(children.map((child:any)=>[child.after.fileId,child.after]));
    if (actualFiles.length!==expectedFiles.size || actualFiles.some(file=>{const expected:any=expectedFiles.get(file.id);return !expected || file.path!==expected.path || file.current_version_id!==expected.versionId || String(file.operation_revision)!==expected.revision || Boolean(file.deleted_at)!==expected.deleted})) throw fail(label+' subtree membership, identity or lifecycle changed');
    const actualFolders = await subtree.lockFoldersById(client, collectionId, subtreePath);
    if (actualFolders.length!==folders.length || folders.some((folder:any)=>!actualFolders.some(actual=>actual.id===folder.after.folderId && actual.path===folder.after.path && String(actual.operation_revision)===folder.after.revision && Boolean(actual.deleted_at)===Boolean(folder.deleted)))) throw fail(label+' folder identity, revision or membership changed');
    for (const file of actualFiles) await access.file(client,file.id);
    for (const folder of actualFolders) await access.path(client,collectionId,folder.path);
  }

  /** The folder grants and public links in the subtree are exactly the recorded ones, at their recorded paths. */
  private async grantsMatch(client:pg.PoolClient, collectionId:string, subtreePath:string, recorded:any):Promise<boolean> {
    const actualFolderShares = await this.context.grants.lockSharePaths(client, collectionId, subtreePath);
    const actualPublicLinks = await this.context.grants.lockLinkPaths(client, collectionId, subtreePath);
    const expectedFolderShares = recorded?.folderShares??[];
    const expectedPublicLinks = recorded?.publicLinks??[];
    return !(actualFolderShares.length!==expectedFolderShares.length || expectedFolderShares.some((grant:any)=>!actualFolderShares.some((actual:any)=>actual.id===grant.id && actual.folder_path===grant.afterPath)) ||
      actualPublicLinks.length!==expectedPublicLinks.length || expectedPublicLinks.some((link:any)=>!actualPublicLinks.some((actual:any)=>actual.id===link.id && actual.folder_path===link.afterPath)));
  }

  private async validateDisplaced(client:pg.PoolClient, access:DatabaseOperationAccess, displaced:any, targetCollection:string):Promise<void> {
    const { grants } = this.context;
    const displacedCollection = displaced.collectionId??targetCollection;
    await access.path(client,displacedCollection,displaced.target);
    await this.validateTree(client, access, displacedCollection, displaced.target, displaced.children, displaced.folders, 'Displaced folder');
    if (!await this.grantsMatch(client, displacedCollection, displaced.target, displaced.grants)) throw fail('Displaced folder grants changed');
    const fileIds = displaced.grants?.fileIds??[];
    const fileSharesSignature = await grants.fileSharesSignature(client, fileIds);
    const fileLinksSignature = await grants.fileLinksSignature(client, fileIds);
    if (fileSharesSignature!==displaced.grants?.fileSharesSignature || fileLinksSignature!==displaced.grants?.fileLinksSignature) throw fail('Displaced folder file grants or links changed');
  }

  /**
   * Verify every child before changing the signatures they cover. The transaction is
   * SERIALIZABLE, and only the exact recorded grants are then restored. Child undo may skip
   * its duplicate signature check, but still performs normal file CAS, authorization and
   * cross-collection audience/key-boundary validation against the restored audience.
   */
  private async revertTransferredGrants(client:pg.PoolClient, plan:any, sourceCollection:string, targetCollection:string):Promise<void> {
    const { receipts, policy, grants } = this.context;
    for (const child of [...plan.children,...(plan.displaced?.children??[])]) {
      const receipt = await receipts.lockSignatureState(client, child.operationId);
      if (!receipt || receipt.state!=='completed' || !receipt.permission_signature || receipt.permission_signature!==await policy.permissionSignature(client,receipt.collection_id,child.operationId)) {
        throw fail('Child permissions or public links changed');
      }
    }
    for (const grant of [...(plan.transferredGrants?.folderShares??[])].reverse()) {
      if (grant.copy) await grants.deleteCopiedShare(client, grant.id, targetCollection, grant.afterPath);
      else await grants.revertShare(client, grant.id, sourceCollection, grant.beforePath, targetCollection, grant.afterPath);
    }
    for (const link of plan.transferredGrants?.publicLinks??[]) await grants.revertLink(client, link.id, sourceCollection, link.beforePath, targetCollection, link.afterPath);
  }
}
