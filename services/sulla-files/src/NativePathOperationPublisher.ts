// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';

import { copyLockedFile } from './fileOperations.js';
import { OperationFingerprint, type PathOperationPlanEntry } from './PathOperationPlan.js';
import { isProtectedPath } from './protectedFiles.js';
import { CloudRenameSuccessor } from './Repositories/CloudRenameSuccessor.js';
import { FilesMutationCoordinator } from './safeFilesystem.js';
import { assertStoredFilePath, assertStoredFolderPath, ensureStoredFileParents, ensureStoredFolder, lockStoredNamespace } from './storedNamespace.js';

import type { FilesIdentity } from './auth.js';
import type { Config, FileRootConfig } from './config.js';
import type { TransactionRunner } from './FilesTransaction.js';
import type { PathOperationRecovery } from './PathOperationRecovery.js';
import type { PathOperationPublishRepository } from './Repositories/PathOperationPublishRepository.js';
import type { EvictionReceipt, PinnedRegularFile, PublicationReceipt } from './safeFilesystem.js';

export type PathOperationItem = { sourcePath:string; targetPath:string; folder:boolean; fileSnapshots:{ id:string; path:string; currentVersionId:string }[] };

/** What the manager does once a publication is fully committed and cleaned up (index, rescan, sync). */
export interface PathOperationPublishHost { afterPublish():Promise<void> }

/**
 * Publishes a native move/copy of watched files. Plan (short transaction, rows locked) → durable
 * journal → verified filesystem publication with per-file receipts (no transaction open) → revalidate
 * and commit metadata (short transaction). Failure before the commit rolls the filesystem back;
 * failure after it leaves the journal for PathOperationRecovery.
 */
export class NativePathOperationPublisher {
  constructor(
    private readonly config:Config,
    private readonly rootCollections:Map<string, string>,
    private readonly repository:PathOperationPublishRepository,
    private readonly recovery:PathOperationRecovery,
    private readonly transactions:TransactionRunner,
    private readonly host:PathOperationPublishHost,
  ) {}

  collectionOf(fileId:string):Promise<string | undefined> { return this.repository.collectionOf(fileId) }

  async publish(action:'move' | 'copy', items:PathOperationItem[], actor:FilesIdentity, root:FileRootConfig, mutations:FilesMutationCoordinator):Promise<void> {
    await FilesMutationCoordinator.requireAtomicRename();
    if (!this.config.filesRoot) throw Object.assign(new Error('The watched Files folder is unavailable'), { status: 409 });
    const collectionId = this.rootCollections.get(root.id)!;
    const sources = items.map(item => item.sourcePath);
    if (sources.some((source, index) => sources.some((candidate, other) => index !== other && source.startsWith(`${ candidate }/`)))) throw Object.assign(new Error('Choose either a folder or an item inside it, not both'), { status: 400 });
    const destinations = items.flatMap(item => item.fileSnapshots.map(file => `${ item.targetPath }${ file.path.slice(item.sourcePath.length) }`));
    if (new Set(destinations).size !== destinations.length) throw Object.assign(new Error('Two selected items have the same destination'), { status: 409 });
    if (items.some(item => item.fileSnapshots.some(file => `${ item.targetPath }${ file.path.slice(item.sourcePath.length) }` === file.path))) throw Object.assign(new Error('The destination must be different from the source'), { status: 400 });
    const operationId = randomUUID();
    const completed:{ publication:PublicationReceipt; eviction?:EvictionReceipt }[] = [];
    let durablePlan:PathOperationPlanEntry[] = [];
    let intentCreated = false; let commitAttempted = false;
    const runner=this.transactions;
    try {
      const {lockedRows,storedFolders,plan}=await runner.run('path-operation-plan',async client=>{
      await lockStoredNamespace(client, collectionId);
      const lockedRows:any[][] = [];
      const storedFolders:{ sourcePath:string; targetPath:string }[] = [];
      for (const item of items) {
        const snapshots = new Map(item.fileSnapshots.map(file => [file.id, file]));
        const rows = await this.repository.lockWatchedFiles(client, collectionId, [...snapshots.keys()]);
        if (rows.rowCount !== snapshots.size || rows.rows.some(row => { const snapshot = snapshots.get(row.id); return !snapshot || snapshot.path !== row.watched_path || snapshot.currentVersionId !== row.current_version_id })) throw Object.assign(new Error('A selected file changed or became protected while this operation was starting. Refresh Files and try again.'), { status: 409 });
        for (const row of rows.rows) {
          const nextPath = `${ item.targetPath }${ row.watched_path.slice(item.sourcePath.length) }`;
          await assertStoredFilePath(client, collectionId, nextPath);
        }
        if (item.folder) {
          const folders = await this.repository.lockFolderTree(client, collectionId, item.sourcePath);
          for (const folder of folders) storedFolders.push({ sourcePath: folder.path, targetPath: `${ item.targetPath }${ folder.path.slice(item.sourcePath.length) }` });
          await assertStoredFolderPath(client, collectionId, item.targetPath);
          if (await this.repository.folderExists(client, collectionId, item.targetPath)) throw Object.assign(new Error(`A folder already exists at ${ item.targetPath }`), { status: 409 });
        }
        lockedRows.push(rows.rows);
      }
      const plan:PathOperationPlanEntry[] = [];
      for (const [index, item] of items.entries()) {
        for (const row of lockedRows[index]) {
          plan.push({
            rootId:      root.id,
            fileId:      row.id,
            sourcePath:  row.watched_path,
            targetPath:  `${ item.targetPath }${ row.watched_path.slice(item.sourcePath.length) }`,
            stagePath:   `.sulla-trash/.operations/${ operationId }/${ row.id }.${ action }`,
            contentHash: row.content_hash,
            kind:        action,
          });
        }
      }
      await this.repository.plan(client, operationId, action, plan);
      return {lockedRows,storedFolders,plan}; });
      durablePlan=plan; intentCreated = true;
      await this.repository.markPublishing(operationId);
      let planIndex = 0;
      for (const [index, item] of items.entries()) {
        for (const row of lockedRows[index]) {
          const sourcePath = row.watched_path;
          const targetPath = `${ item.targetPath }${ sourcePath.slice(item.sourcePath.length) }`;
          if (isProtectedPath(sourcePath) || isProtectedPath(targetPath)) throw Object.assign(new Error(`Protected Files content cannot be ${ action === 'move' ? 'moved' : 'copied' }`), { status: 403 });
          const verify = async(pinned:PinnedRegularFile) => {
            const hash = createHash('sha256');
            for await (const chunk of pinned.createReadStream()) hash.update(chunk);
            if (hash.digest('hex') !== row.content_hash) throw Object.assign(new Error('A selected file changed while the operation was starting. Refresh Files and try again.'), { status: 409 });
          };
          const operation = plan[planIndex++];
          if (action === 'copy') {
            completed.push({ publication: await mutations.copyVerified({ source: sourcePath, target: targetPath, staged: operation.stagePath, verify }) });
          } else {
            const eviction = await mutations.evictVerified({ source: sourcePath, quarantine: operation.stagePath, verify });
            try {
              const publication = await mutations.publishVerified({ staged: eviction.quarantine, target: targetPath, verify });
              completed.push({ publication, eviction });
            } catch (error) {
              try { await mutations.recoverEviction(eviction, verify) } catch (recoveryError) {
                throw Object.assign(new Error(`${ error instanceof Error ? error.message : String(error) }. The source was preserved for recovery at ${ eviction.quarantine }: ${ recoveryError instanceof Error ? recoveryError.message : String(recoveryError) }`), { status: (error as any)?.status ?? 500 });
              }
              throw error;
            }
          }
          await this.repository.appendReceipt(operationId, {
            fileId:      operation.fileId,
            stagePath:   operation.stagePath,
            targetPath:  operation.targetPath,
            published:   true,
            fingerprint: OperationFingerprint.serialize(completed.at(-1)!.publication.fingerprint),
          });
        }
      }
      await runner.run('path-operation-commit',async client=>{
      await lockStoredNamespace(client,collectionId);
      // Locks were intentionally released while filesystem copying/fsync ran. Revalidate
      // every source and destination before attaching the durable publications to metadata.
      for(const [index,item] of items.entries()){
        const expected=lockedRows[index];
        const current=await this.repository.relockWatchedFiles(client,expected.map(row=>row.id),collectionId);
        if(current.length!==expected.length||expected.some(row=>!current.some(now=>now.id===row.id&&now.path===row.path&&now.current_version_id===row.current_version_id&&now.content_hash===row.content_hash)))
          throw Object.assign(new Error('Source changed while preparing filesystem publication; preserved copies will be reconciled'),{status:409});
        for(const row of expected)await assertStoredFilePath(client,collectionId,`${item.targetPath}${row.watched_path.slice(item.sourcePath.length)}`);
        if(item.folder){
          const original=storedFolders.filter(folder=>folder.sourcePath===item.sourcePath||folder.sourcePath.startsWith(`${item.sourcePath}/`));
          const folders=await this.repository.relockFolderTree(client,collectionId,item.sourcePath,original.length);
          if(folders.length!==original.length||folders.some(folder=>!original.some(old=>old.sourcePath===folder.path)))throw Object.assign(new Error('Folder changed during publication'),{status:409});
          await assertStoredFolderPath(client,collectionId,item.targetPath);
          if(await this.repository.folderAppeared(client,collectionId,item.targetPath))throw Object.assign(new Error('Destination folder appeared during publication'),{status:409});
        }
      }
      let receiptIndex = 0;
      for (const [index, item] of items.entries()) {
        for (const row of lockedRows[index]) {
          const nextPath = `${ item.targetPath }${ row.watched_path.slice(item.sourcePath.length) }`;
          const receipt = completed[receiptIndex++].publication;
          if (action === 'move') {
            await this.repository.moveFile(client, collectionId, row.id, nextPath);
            const parentFollows = item.folder && row.watched_path.startsWith(`${ item.sourcePath }/`);
            const versionId = await new CloudRenameSuccessor(actor).versionFor(client, { fileId: row.id, currentVersionId: row.current_version_id, parentFollows });
            await this.repository.journalRename(client, collectionId, row.id, versionId);
            await this.repository.auditMove(client, actor, row.id, row.current_version_id, { collectionId, from: row.path, to: nextPath });
          } else {
            const copied = await copyLockedFile(client, row, nextPath, actor);
            await this.repository.watchCopy(client, { collectionId, path: nextPath, fileId: copied.id, contentHash: row.content_hash, size: receipt.fingerprint.size, mtimeMs: receipt.fingerprint.mtimeMs, rootId: root.id });
            await this.repository.auditCopy(client, actor, copied.id, copied.current_version_id, { collectionId, from: row.watched_path, to: nextPath });
          }
        }
        if (action === 'move' && item.folder) {
          await this.repository.moveFolderStars(client, collectionId, item.sourcePath, item.targetPath);
        }
      }
      if (action === 'copy') {
        for (const folder of storedFolders) await ensureStoredFolder(client, collectionId, folder.targetPath, actor);
      } else {
        for (const folder of [...storedFolders].sort((left, right) => right.sourcePath.length - left.sourcePath.length)) {
          await this.repository.moveFolder(client, collectionId, folder.sourcePath, folder.targetPath);
        }
        for (const folder of storedFolders) await ensureStoredFolder(client, collectionId, folder.targetPath, actor);
      }
      for (const [index, item] of items.entries()) {
        for (const row of lockedRows[index]) await ensureStoredFileParents(client, collectionId, `${ item.targetPath }${ row.watched_path.slice(item.sourcePath.length) }`, actor);
      }
      await this.repository.markDbCommitted(client, operationId);
      commitAttempted = true;
      });
    } catch (error) {
      if (commitAttempted) {
        throw Object.assign(new Error(`The database commit outcome is being reconciled; published files were preserved: ${ error instanceof Error ? error.message : String(error) }`), { status: 503 });
      }
      const preservationErrors:string[] = [];
      for (const item of completed.reverse()) {
        const planned = durablePlan.find(entry => entry.targetPath === item.publication.target);
        const verify = async(pinned:PinnedRegularFile) => planned ? this.recovery.verifyPinned(pinned, planned.contentHash) : pinned.assertUnchanged();
        try { await mutations.rollbackPublication(item.publication, verify) } catch (recoveryError) { preservationErrors.push(`${ item.publication.target }: ${ recoveryError instanceof Error ? recoveryError.message : String(recoveryError) }`); continue }
        if (item.eviction) {
          try { await mutations.recoverEviction(item.eviction, verify) } catch (recoveryError) { preservationErrors.push(`${ item.eviction.source }: ${ recoveryError instanceof Error ? recoveryError.message : String(recoveryError) }`) }
        } else {
          try { await mutations.finalizePublication(item.publication) } catch (recoveryError) { preservationErrors.push(`${ item.publication.staged }: ${ recoveryError instanceof Error ? recoveryError.message : String(recoveryError) }`) }
        }
      }
      if (intentCreated) {
        await this.repository.settle(operationId, preservationErrors.length ? 'publishing' : 'completed', (error instanceof Error ? error.message : String(error)).slice(0, 2000)).catch(() => undefined);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`${ reason }${ preservationErrors.length ? ` Recovery artifacts were preserved: ${ preservationErrors.join('; ') }` : '' }`), { status: (error as any)?.status ?? 500 });
    }
    const cleanupErrors:string[] = [];
    for (const item of completed) await mutations.finalizePublication(item.publication).catch(error => cleanupErrors.push(`${ item.publication.staged }: ${ error instanceof Error ? error.message : String(error) }`));
    await this.repository.settle(operationId, cleanupErrors.length ? 'db-committed' : 'completed', cleanupErrors.length ? cleanupErrors.join('; ').slice(0, 2000) : null);
    if (cleanupErrors.length) throw Object.assign(new Error(`The operation committed, but protected cleanup artifacts remain: ${ cleanupErrors.join('; ') }. Refresh Files before retrying.`), { status: 500 });
    await this.host.afterPublish();
  }
}
