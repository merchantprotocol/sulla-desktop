// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { PushCandidate } from './repository.js';

export interface PushOrderingStore {
  /** Earliest unpushed, un-held file or folder version (seq > cursor, or a held one due for retry). */
  nextPushCandidate(collectionId:string, cursor:number):Promise<PushCandidate | null>;
  /** True once Cloud holds any version of this folder identity (pushed by us or pulled). */
  isFolderCommitted(collectionId:string, folderId:string):Promise<boolean>;
  /** The live folder's current namespace version as a candidate, journaling it first if it never was. */
  folderCandidate(collectionId:string, folderId:string):Promise<PushCandidate | null>;
  /** Parks a version whose parent Cloud cannot resolve; it is retried later, never published as root. */
  hold(collectionId:string, candidate:PushCandidate, reason:string):Promise<void>;
}

/**
 * Guarantees the uploader never publishes a manifest whose parentFolderId Cloud has
 * not committed. Other devices fail a whole pull on an unknown parent
 * ("namespace parent folder is unavailable"), and web shows such items as orphans.
 *
 * - Parent known locally but not in Cloud: upload the top-most uncommitted ancestor
 *   first. Its journalSeq is pinned to the current cursor so committing it can never
 *   move the cursor past the child that is still waiting.
 * - Parent unknown (a nested path with no folder identity): hold the child. It is
 *   never silently re-parented to the collection root.
 */
export class CloudPushOrdering {
  static readonly maxSteps = 64;

  constructor(private readonly store:PushOrderingStore) {}

  async next(collectionId:string, cursor:number):Promise<PushCandidate | null> {
    for (let step = 0; step < CloudPushOrdering.maxSteps; step++) {
      const first = await this.store.nextPushCandidate(collectionId, cursor);
      if (!first) return null;
      const ready = await this.resolve(collectionId, cursor, first);
      if (ready) return ready;
    }
    return null;
  }

  /** The candidate to upload now for `first`, or null after holding it. */
  private async resolve(collectionId:string, cursor:number, first:PushCandidate):Promise<PushCandidate | null> {
    let current = first;
    const seen = new Set<string>([first.fileId]);
    for (let depth = 0; depth < CloudPushOrdering.maxSteps; depth++) {
      if (current.deleted || !current.namespace || !current.path.includes('/')) return current;
      const parentId = current.namespace.parentFolderId;
      if (!parentId) return this.holdChain(collectionId, first, current, 'parent-unavailable');
      if (await this.store.isFolderCommitted(collectionId, parentId)) return current;
      if (seen.has(parentId)) return this.holdChain(collectionId, first, current, 'parent-cycle');
      seen.add(parentId);
      const parent = await this.store.folderCandidate(collectionId, parentId);
      if (!parent) return this.holdChain(collectionId, first, current, 'parent-unavailable');
      current = { ...parent, journalSeq: Math.min(parent.journalSeq, cursor) };
    }
    return this.holdChain(collectionId, first, current, 'parent-too-deep');
  }

  private async holdChain(collectionId:string, first:PushCandidate, current:PushCandidate, reason:string):Promise<null> {
    await this.store.hold(collectionId, first, reason);
    if (current.versionId !== first.versionId) await this.store.hold(collectionId, current, reason);
    return null;
  }
}
