// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { CloudFolderCoverage, type CloudFolderCoverageStore } from '../../../../../../services/sulla-files/src/cloudSync/folderCoverage.js';
import { CloudPushOrdering, type PushOrderingStore } from '../../../../../../services/sulla-files/src/cloudSync/pushOrdering.js';
import type { PushCandidate } from '../../../../../../services/sulla-files/src/cloudSync/repository.js';

const COLLECTION = '00000000-0000-4000-8000-0000000000c1';

function candidate(fileId:string, path:string, parentFolderId:string | null, journalSeq:number, kind:'file' | 'folder' = 'file'):PushCandidate {
  return {
    journalSeq, fileId, path, mime: kind === 'file' ? 'text/plain' : '', versionId: `${ fileId }-v`, parentVersionId: null, deleted: false,
    chunkCollectionId: COLLECTION, chunkIds: [], size: 0, mtime: new Date(0).toISOString(),
    namespace: { kind, name: path.split('/').at(-1)!, parentFolderId, operation: 'create' },
  };
}

/** In-memory upload queue: candidates by seq, a committed-folder set and recorded holds. */
class FakeOrderingStore implements PushOrderingStore {
  readonly committed = new Set<string>();
  readonly holds:Array<{ versionId:string; reason:string }> = [];
  constructor(private readonly queue:PushCandidate[], private readonly folders:Map<string, PushCandidate>) {}

  async nextPushCandidate(_collectionId:string, cursor:number):Promise<PushCandidate | null> {
    const held = new Set(this.holds.map(hold => hold.versionId));
    return this.queue.filter(item => item.journalSeq > cursor && !held.has(item.versionId)).sort((a, b) => a.journalSeq - b.journalSeq)[0] ?? null;
  }

  async isFolderCommitted(_collectionId:string, folderId:string):Promise<boolean> { return this.committed.has(folderId) }
  async folderCandidate(_collectionId:string, folderId:string):Promise<PushCandidate | null> { return this.folders.get(folderId) ?? null }
  async hold(_collectionId:string, item:PushCandidate, reason:string):Promise<void> { this.holds.push({ versionId: item.versionId, reason }) }
}

describe('CloudPushOrdering', () => {
  it('uploads the top-most uncommitted ancestor first and pins it to the cursor', async() => {
    // risk: data integrity — Cloud must commit A before A/B before the file that references A/B.
    const folderA = candidate('fa', 'A', null, 90, 'folder');
    const folderB = candidate('fb', 'A/B', 'fa', 91, 'folder');
    const store = new FakeOrderingStore([candidate('f1', 'A/B/x.md', 'fb', 5)], new Map([['fa', folderA], ['fb', folderB]]));
    const ordering = new CloudPushOrdering(store);

    const first = await ordering.next(COLLECTION, 4);
    expect(first).toMatchObject({ fileId: 'fa', journalSeq: 4 }); // never ahead of the waiting child (seq 5)
    store.committed.add('fa');
    expect(await ordering.next(COLLECTION, 4)).toMatchObject({ fileId: 'fb', journalSeq: 4 });
    store.committed.add('fb');
    expect(await ordering.next(COLLECTION, 4)).toMatchObject({ fileId: 'f1', journalSeq: 5 });
  });

  it('holds a child whose parent is unknown and moves on, never returning it with a root parent', async() => {
    // risk: data integrity — an unknown parent must not become the collection root in Cloud.
    const store = new FakeOrderingStore([candidate('lost', 'X/lost.md', null, 1), candidate('ok', 'ok.md', null, 2)], new Map());
    const next = await new CloudPushOrdering(store).next(COLLECTION, 0);
    expect(next).toMatchObject({ fileId: 'ok' });
    expect(store.holds).toEqual([{ versionId: 'lost-v', reason: 'parent-unavailable' }]);
  });

  it('holds the child too when an ancestor cannot be uploaded, so the queue cannot spin on it', async() => {
    // risk: availability — an unresolvable ancestor must not stall every later upload.
    const folderB = candidate('fb', 'A/B', 'missing', 7, 'folder');
    const store = new FakeOrderingStore([candidate('f1', 'A/B/x.md', 'fb', 3)], new Map([['fb', folderB]]));
    expect(await new CloudPushOrdering(store).next(COLLECTION, 0)).toBeNull();
    expect(store.holds.map(hold => hold.versionId).sort()).toEqual(['f1-v', 'fb-v']);
  });

  it('passes root items and tombstones through unchanged', async() => {
    // risk: data integrity — the gate must not delay or alter items that have no parent dependency.
    const tombstone = { ...candidate('gone', 'Z/gone.md', null, 1), deleted: true };
    const store = new FakeOrderingStore([tombstone], new Map());
    expect(await new CloudPushOrdering(store).next(COLLECTION, 0)).toBe(tombstone);
    expect(store.holds).toEqual([]);
  });
});

class FakeCoverageStore implements CloudFolderCoverageStore {
  readonly journaled = new Map<string, number>();
  constructor(private missing:number) {}
  async enabledCollectionIds():Promise<string[]> { return [COLLECTION] }
  async counts():Promise<{ liveFolders:number; foldersMissingFromCloud:number; childrenOfUncommittedParents:number }> {
    return { liveFolders: 12, foldersMissingFromCloud: this.missing, childrenOfUncommittedParents: 4 };
  }

  async journalMissingFolders(collectionId:string):Promise<number> {
    const added = this.missing - (this.journaled.get(collectionId) ?? 0);
    this.journaled.set(collectionId, this.missing);
    return added;
  }
}

describe('CloudFolderCoverage', () => {
  it('logs a count-only preview, then backfills once', async() => {
    // risk: privacy + data integrity — the owner preview carries counts, never names; repeat runs add nothing.
    const lines:string[] = [];
    const coverage = new CloudFolderCoverage(new FakeCoverageStore(3), line => lines.push(line));
    expect(await coverage.previewAndBackfill()).toEqual({
      preview: { collections: 1, liveFolders: 12, foldersMissingFromCloud: 3, childrenOfUncommittedParents: 4 }, journaled: 3,
    });
    expect((await coverage.previewAndBackfill()).journaled).toBe(0);
    expect(lines[0]).toBe('[SullaFiles] cloud folder coverage preview: collections=1 liveFolders=12 foldersMissingFromCloud=3 childrenOfUncommittedParents=4');
  });

  it('does not touch the journal when Cloud already has every folder', async() => {
    // risk: data integrity — a healthy collection gets a read-only preview and no writes.
    const store = new FakeCoverageStore(0);
    expect((await new CloudFolderCoverage(store, () => undefined).previewAndBackfill()).journaled).toBe(0);
    expect(store.journaled.size).toBe(0);
  });
});
