// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import { streamFileContent } from './fileStream.js';
import { NativeOperationJournal } from './nativeOperationJournal.js';
import { isProtectedPath } from './protectedFiles.js';

import type { Config, FileRootConfig } from './config.js';
import type { OriginalRevealTarget } from './originalReveal.js';
import type { TrackedFileRepository } from './Repositories/TrackedFileRepository.js';
import type { FilesMutationCoordinator, PinnedRegularFile } from './safeFilesystem.js';
import type { Store } from './store.js';
import type pg from 'pg';

/**
 * Native custody of tracked roots for database operations: which root (if any) must publish a
 * change, verification of the Files version behind an original, and the reveal-original proof.
 */
export class NativeCustody {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly store:Store,
    private readonly roots:FileRootConfig[],
    private readonly rootCollections:Map<string, string>,
    private readonly rootMutations:Map<string, FilesMutationCoordinator>,
    private readonly repository:TrackedFileRepository,
    private readonly verifyPinned:(pinned:PinnedRegularFile, expectedHash:string)=>Promise<void>,
  ) {}

  private journalInstance?:NativeOperationJournal;
  /** The native operation journal, built on first use (same lazy lifetime the manager had). */
  get journal():NativeOperationJournal { return this.journalInstance ??= new NativeOperationJournal(this.db,async(collectionId) => {
    const row=await this.repository.rootForCollection(collectionId);
    const hasNativeCustody=() => this.repository.hasWatchedFiles(collectionId);
    if (!row) {
      if (await hasNativeCustody()) throw new Error('Tracked root is missing');
      return null;
    }
    // Detach explicitly relinquishes native custody. Keep the row as audit
    // history, but do not let an obsolete root turn ordinary Files database
    // operations into native publication attempts.
    if (!row.enabled || row.state==='detached') return null;
    // A Desktop-brokered root lives on the host; this container has no path to it (attachBrokeredRoot
    // never adds it to this.roots), so there is no container-side native root to check or publish to.
    // Desktop owns the host-side effects. Without this every rename/move in the home collection failed
    // closed with 'Tracked root is unavailable'.
    if (typeof row.mount_path==='string' && row.mount_path.startsWith('/brokered/')) return null;
    const root=this.roots.find(root=>root.id===row.id);
    if (!root || row.state==='offline' || root.path!==row.mount_path || this.rootCollections.get(root.id)!==collectionId) {
      if (await hasNativeCustody()) throw new Error('Tracked root is unavailable');
      return null;
    }
    return { id:root.id,collectionId,mutations:this.rootMutations.get(root.id)! };
  },(fileId,versionId,hash)=>this.verifyNativeVersion(fileId,versionId,hash),async(fileId,versionId)=>{
    const content=await streamFileContent(this.db,this.config,this.store,fileId,versionId,undefined,new AbortController().signal);
    if (!content) throw Object.assign(new Error('Original version content is unavailable'),{status:409,code:'original-changed'});
    return content.body;
  }) }

  async verifyNativeVersion(fileId:string,versionId:string,hash:string):Promise<void> {
    const content=await streamFileContent(this.db,this.config,this.store,fileId,versionId,undefined,new AbortController().signal);
    if (!content) throw Object.assign(new Error('Original version content is unavailable'),{status:409,code:'original-changed'});
    const digest=createHash('sha256');
    for await (const chunk of content.body) digest.update(chunk);
    if (digest.digest('hex')!==hash) throw Object.assign(new Error('Original differs from the current Files version'),{status:409,code:'original-changed'});
  }

  /** Proves the watched original still matches its Files version before Desktop may reveal it. Caller serializes. */
  async originalRevealTarget(file:any):Promise<OriginalRevealTarget|null> {
    const row = await this.repository.revealCandidate(file);
    if (!row) return null;
    const root = this.roots.find(root => root.id === row.root_id);
    if (!root || !row.enabled || ['detached','offline','error'].includes(row.state) || root.path !== row.mount_path ||
      this.rootCollections.get(root.id) !== file.collection_id) throw Object.assign(new Error('Original root is unavailable'), { status:409,code:'original-unavailable' });
    if (isProtectedPath(file.path) || file.path.split('/').some((part:string) => part === '.sulla-trash' || part === '.sulla-operation-recovery')) throw Object.assign(new Error('Protected original path'), { status:403,code:'original-forbidden' });
    const mutations = this.rootMutations.get(root.id)!;
    return mutations.runExclusive([file.path],async() => {
      await this.verifyNativeVersion(file.id,file.current_version_id,row.content_hash);
      const pinned = await mutations.pinVerified(file.path,pinned => this.verifyPinned(pinned,row.content_hash));
      try {
        if (pinned.fingerprint.size !== Number(row.size) || pinned.fingerprint.mtimeMs !== Number(row.mtime_ms)) throw Object.assign(new Error('Original changed since indexing'), { status:409,code:'original-changed' });
        const fresh=await this.repository.revealStillFresh(file,row,root);
        if (!fresh) throw Object.assign(new Error('Original changed during verification'),{status:409,code:'original-changed'});
        return { rootId:root.id,collectionId:file.collection_id,relativePath:file.path,fileId:file.id,
          versionId:file.current_version_id,revision:String(file.operation_revision),hash:row.content_hash,
          size:pinned.fingerprint.size,mtimeMs:pinned.fingerprint.mtimeMs };
      } finally { await pinned.close() }
    });
  }
}
