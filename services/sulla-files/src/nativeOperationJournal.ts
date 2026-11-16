// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import type pg from 'pg';
import { FilesMutationCoordinator } from './safeFilesystem.js';
import type { DirectoryReceipt } from './safeFilesystem.js';
import { isProtectedPath,protectedPathError } from './protectedFiles.js';
import { NativeOperationJournalRepository } from './Repositories/NativeOperationJournalRepository.js';
import { OperationCancellationRegistry } from './Services/OperationCancellationRegistry.js';
import { NativeCrossRootJournal } from './Services/NativeJournal/NativeCrossRootJournal.js';
import { NativeSameRootJournal } from './Services/NativeJournal/NativeSameRootJournal.js';
import { NativeJournalIntegrity, type Fingerprint, type NativeJournalDependencies, type NativeJournalRoot } from './Services/NativeJournal/NativeJournalTypes.js';

export type { NativeJournalRoot } from './Services/NativeJournal/NativeJournalTypes.js';

/**
 * Uses only files_path_operations; LocalFilesManager owns scheduling/recovery.
 * Same-root receipts use version-2 plans (NativeSameRootJournal); cross-collection
 * receipts use version-3 plans (NativeCrossRootJournal).
 */
export class NativeOperationJournal {
  private readonly deps:NativeJournalDependencies;
  private readonly sameRoot:NativeSameRootJournal;
  private readonly crossRoot:NativeCrossRootJournal;

  constructor(db:pg.Pool, private readonly resolve:(collectionId:string)=>Promise<NativeJournalRoot|null>,
    verifyVersion:(fileId:string,versionId:string,hash:string)=>Promise<void>,
    readVersion:(fileId:string,versionId:string)=>Promise<AsyncIterable<Uint8Array>>,
    /** Must be the registry the batch service requests cancellation on (one per composition). */
    cancellation:OperationCancellationRegistry = OperationCancellationRegistry.sharedBy(db),
    rows = new NativeOperationJournalRepository()) {
    this.deps = { db, resolve, verifyVersion, readVersion, cancellation, rows };
    this.sameRoot = new NativeSameRootJournal(this.deps);
    this.crossRoot = new NativeCrossRootJournal(this.deps);
  }

  async occupied(collectionId:string,path:string):Promise<boolean> {
    const root=await this.resolve(collectionId);
    return root?root.mutations.exists(path):false;
  }

  async folders(collectionId:string,path:string,files:string[]):Promise<string[]> {
    return (await this.folderSnapshot(collectionId,path,files)).directories;
  }

  async folderSnapshot(collectionId:string,path:string,files:string[]):Promise<{directories:string[];nativeSignature:string}> {
    const root=await this.resolve(collectionId);
    if (!root) return {directories:[],nativeSignature:NativeJournalIntegrity.emptySignature()};
    const tree=await root.mutations.inspectTree(path,path=>!isProtectedPath(path) && !path.split('/').includes('.sulla-trash'));
    if ([...tree.directories,...tree.files].some(isProtectedPath)) throw protectedPathError();
    if (tree.files.length!==files.length || tree.files.some(path=>!files.includes(path))) throw NativeJournalIntegrity.failure();
    const directories:DirectoryReceipt[]=[];
    for (const directoryPath of [...tree.directories].sort()) directories.push(await root.mutations.directory(directoryPath));
    const nativeFiles:{path:string;fingerprint:Fingerprint;hash:string}[]=[];
    for (const filePath of [...tree.files].sort()) {
      const pin=await root.mutations.pinVerified(filePath,async()=>undefined);
      try {
        const digest=createHash('sha256');
        for await (const chunk of pin.createReadStream()) digest.update(chunk);
        await pin.assertUnchanged();
        nativeFiles.push({path:filePath,fingerprint:NativeJournalIntegrity.packed(pin.fingerprint),hash:digest.digest('hex')});
      } finally { await pin.close() }
    }
    return {directories:tree.directories,nativeSignature:createHash('sha256').update(NativeJournalIntegrity.canonical({files:nativeFiles,directories})).digest('hex')};
  }

  async publish(client:pg.PoolClient,receipt:any,undo:boolean):Promise<void> {
    const targetCollection=receipt.request?.targetCollectionId;
    if (targetCollection && targetCollection!==receipt.collection_id) {
      if (undo) return this.crossRoot.inverse(client,receipt);
      return this.crossRoot.publish(client,receipt,targetCollection);
    }
    const root=await this.resolve(receipt.collection_id);
    if (!root) return;
    await root.mutations.runExclusive([],async() => {
      await FilesMutationCoordinator.requireAtomicRename();
      if (undo) return this.sameRoot.inverse(client,receipt,root);
      return this.sameRoot.publish(client,receipt,root);
    });
  }

  async recover(row:any):Promise<void> {
    if (row.plan?.version===3) return this.crossRoot.recover(row);
    return this.sameRoot.recover(row);
  }

  /** GC only the exact retained identities recorded by one invalidated receipt. */
  dispose(receiptId:string):Promise<{state:'none'|'complete'|'recovery-required';error?:string}> {
    return this.sameRoot.dispose(receiptId);
  }
}
