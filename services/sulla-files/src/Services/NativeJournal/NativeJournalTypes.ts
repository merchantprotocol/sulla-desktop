// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { FilesMutationCoordinator } from '../../safeFilesystem.js';
import type { FileFingerprint, DirectoryReceipt, PinnedRegularFile } from '../../safeFilesystem.js';
import type { NativeOperationJournalRepository } from '../../Repositories/NativeOperationJournalRepository.js';
import type { OperationCancellationRegistry } from '../OperationCancellationRegistry.js';

export type Fingerprint = { dev:string; ino:string; size:number; mtimeMs:number };
export interface Leaf {
  kind:'move'|'copy'|'trash'|'restore'|'mkdir'|'rmdir'|'restore-dir';
  source?:string; target?:string; stage:string; hash?:string;
  before?:Fingerprint; published?:Fingerprint; directory?:DirectoryReceipt;
  retainedDirectory?:DirectoryReceipt;
}
export interface Plan {
  version:2; rootId:string; collectionId:string; operationId:string; itemId:string;
  leaves:Leaf[]; inverse?:Leaf[]; watched:any[];
  committed?:Committed; inverseCommitted?:Committed;
  treeBefore?:string; treeAfter?:string;
  treesAfter?:string[]; absentAfter?:string[]; treesUndo?:string[]; absentUndo?:string[];
  grants?:any;
  disposal?:{undoInvalidatedAt:string;invalidatedBy:string;reason:string;disposedPaths?:string[];artifactsDisposedAt?:string;lastError?:string};
}
export interface CrossLeaf {
  kind:'publish'|'evict'|'relocate'|'mkdir'|'rmdir'; rootId:string;
  source?:string; target?:string; stage:string; fileId?:string; versionId?:string; hash?:string;
  before?:Fingerprint; published?:Fingerprint; directory?:DirectoryReceipt; started?:boolean; completed?:boolean;
  sourceRootId?:string;
}
export interface CrossPlan {
  version:3; receiptId:string; sourceCollectionId:string; targetCollectionId:string; operationId:string; itemId:string;
  sourceRootId?:string; targetRootId?:string; leaves:CrossLeaf[]; watched:any[];
  committed?:Committed; inverseCommitted?:Committed; undoProgress?:number; grants?:any;
  sourceTree?:string; targetTrees?:string[]; absentAfter?:{rootId:string;path:string}[];
}
export interface Committed { fileIds:string[]; folderIds:string[]; files:any[]; folders:any[]; watched:any[]; grants?:any }
export interface NativeJournalRoot { id:string; collectionId:string; mutations:FilesMutationCoordinator }

/** What the same-root and cross-root journals share: roots, content checks, the journal rows and cancellation. */
export interface NativeJournalDependencies {
  db:pg.Pool;
  resolve:(collectionId:string)=>Promise<NativeJournalRoot|null>;
  verifyVersion:(fileId:string,versionId:string,hash:string)=>Promise<void>;
  readVersion:(fileId:string,versionId:string)=>Promise<AsyncIterable<Uint8Array>>;
  cancellation:OperationCancellationRegistry;
  rows:NativeOperationJournalRepository;
}

/** Fingerprint, hashing and failure rules every native leaf is verified with. */
export class NativeJournalIntegrity {
  static packed(value:FileFingerprint):Fingerprint { return { ...value,dev:String(value.dev),ino:String(value.ino) } }

  static same(a:Fingerprint, b:Fingerprint):boolean { return a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeMs===b.mtimeMs }

  static failure():Error { return Object.assign(new Error('Native operation requires preserved-artifact reconciliation'),{ status:409,code:'recovery-required' }) }

  static publishedIdentity(leaf:CrossLeaf):Fingerprint {
    const identity = leaf.published??leaf.before;
    if (!identity) throw NativeJournalIntegrity.failure();
    return identity;
  }

  static canonical(value:any):string {
    return JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
  }

  static emptySignature():string { return createHash('sha256').update(NativeJournalIntegrity.canonical({files:[],directories:[]})).digest('hex') }

  /** The pinned file still has the recorded identity and exactly the recorded content. */
  static async verify(pinned:PinnedRegularFile, hash:string, expected?:Fingerprint):Promise<void> {
    if (expected && !NativeJournalIntegrity.same(NativeJournalIntegrity.packed(pinned.fingerprint),expected)) throw NativeJournalIntegrity.failure();
    const digest = createHash('sha256');
    for await (const chunk of pinned.createReadStream()) digest.update(chunk);
    if (digest.digest('hex')!==hash) throw NativeJournalIntegrity.failure();
    await pinned.assertUnchanged();
  }

  static fingerprint(value:Fingerprint):FileFingerprint {
    return {dev:BigInt(value.dev),ino:BigInt(value.ino),size:value.size,mtimeMs:value.mtimeMs};
  }
}
