// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesDropTargets } from './FilesDropTargets';

import type { FilesBrowserController } from './FilesBrowserController';
import type { DisplayEntry, DragPreparation, DragSnapshot, DragSnapshotRequest } from './FilesBrowserTypes';

/**
 * Exact folder source snapshots captured before a drag, so a folder can be moved to another collection.
 * A preparation is tied to one selection signature; any change to it invalidates every captured snapshot.
 */
export class FilesDragSnapshots {
  private readonly snapshots = new Map<string, DragSnapshot>();
  private readonly requests = new Map<string, DragSnapshotRequest>();
  private readonly generations = new Map<string, number>();
  private preparation:DragPreparation | undefined;
  private preparationGeneration = 0;

  constructor(private readonly browser:FilesBrowserController) {}

  /** The rows a drag starting on `entry` carries (see FilesDropTargets.dragEntriesFor). */
  dragEntriesFor(entry:DisplayEntry):DisplayEntry[] { return FilesDropTargets.dragEntriesFor(entry, this.browser.state.selectedKeys.value, this.browser.selection.selectedEntries.value) }

  entryIdentity(entry:DisplayEntry, collectionId:string):string {
    const snapshot = this.browser.state.snapshot.value; const folder = entry.folderState;
    const descendants = entry.folder ? snapshot?.files.filter(file => file.path === entry.path || file.path.startsWith(`${ entry.path }/`)).map(file => JSON.stringify([file.id, file.path, file.currentVersionId, file.operationRevision, file.deletedAt])).sort() : undefined;
    const folders = entry.folder ? snapshot?.folders?.filter(item => (typeof item === 'string' ? item : item.path).startsWith(`${ entry.path }/`)).map(item => JSON.stringify(item)).sort() : undefined;

    return JSON.stringify(entry.folder ? [collectionId, entry.key, entry.path, folder?.collectionId, folder?.folderId, folder?.path, folder?.revision, descendants, folders] : [collectionId, entry.key, entry.path, entry.currentVersionId, entry.operationRevision]);
  }

  selectionSignature(entries:DisplayEntry[], collectionId:string):string { return entries.map(entry => this.entryIdentity(entry, collectionId)).sort().join('\n') }

  prepared(entry:DisplayEntry, preparation:DragPreparation) {
    const record = this.snapshots.get(this.key(preparation.collectionId, entry.path));

    return record?.sourceIdentity === this.entryIdentity(entry, preparation.collectionId) && record.preparationSignature === preparation.signature ? record.target : undefined;
  }

  readonly invalidate = ():void => {
    this.preparation = undefined; this.preparationGeneration++; this.snapshots.clear(); this.requests.clear(); this.generations.clear();
  };

  begin(entries:DisplayEntry[], collectionId:string, anchorKey:string):DragPreparation {
    const signature = this.selectionSignature(entries, collectionId);

    if (this.preparation?.collectionId === collectionId && this.preparation.signature === signature) return this.preparation;
    this.invalidate();
    this.preparation = { collectionId, signature, generation: this.preparationGeneration, anchorKey };
    return this.preparation;
  }

  async capture(entry:DisplayEntry, preparation:DragPreparation):Promise<void> {
    const state = this.browser.state; const collectionId = preparation.collectionId;

    if (!entry.folder || this.prepared(entry, preparation)) return;
    const key = this.key(collectionId, entry.path); const sourceIdentity = this.entryIdentity(entry, collectionId);
    const pending = this.requests.get(key);

    if (pending?.sourceIdentity === sourceIdentity && pending.generation === preparation.generation) { await pending.promise; return }
    const generation = (this.generations.get(key) ?? 0) + 1;

    this.generations.set(key, generation);
    const promise = (async() => {
      const captured = await this.browser.fileOperations.captureTarget(entry, collectionId);

      if (entry.folderState && (captured.expectedFolder?.folderId !== entry.folderState.folderId || captured.expectedFolder?.revision !== entry.folderState.revision)) return;
      const current = this.browser.listing.visibleEntries.value.find(item => item.key === entry.key);

      if (state.mounted && state.section.value === 'files' && this.generations.get(key) === generation && this.preparation?.generation === preparation.generation && this.preparation.signature === preparation.signature && state.snapshot.value?.collection.id === collectionId && current && this.entryIdentity(current, collectionId) === sourceIdentity && this.selectionSignature(this.dragEntriesFor(current), collectionId) === preparation.signature && captured.sourceSubtreeSignature) {
        this.snapshots.set(key, { sourceIdentity, preparationSignature: preparation.signature, target: captured });
      }
    })();

    this.requests.set(key, { sourceIdentity, generation: preparation.generation, promise });
    try { await promise } finally { if (this.requests.get(key)?.promise === promise) this.requests.delete(key) }
  }

  /** Pointer-down on a row starts capturing folder snapshots for the selection it would drag. */
  readonly prepare = (entry:DisplayEntry):void => {
    const state = this.browser.state; const collectionId = state.snapshot.value?.collection.id;

    if (state.section.value !== 'files' || state.busy.value || state.loading.value || !collectionId) return;
    const entries = this.dragEntriesFor(entry); const preparation = this.begin(entries, collectionId, entry.key);

    entries.filter(item => item.folder && !this.prepared(item, preparation)).forEach(item => this.capture(item, preparation).catch(() => undefined));
  };

  /** Watch handler for [selectedKeys, visibleEntries]: a changed selection drops the preparation. */
  readonly revalidate = ():void => {
    const preparation = this.preparation;

    if (!preparation) return;
    const anchor = this.browser.listing.visibleEntries.value.find(entry => entry.key === preparation.anchorKey);

    if (!anchor || this.selectionSignature(this.dragEntriesFor(anchor), preparation.collectionId) !== preparation.signature) this.invalidate();
  };

  private key(collectionId:string, path:string):string { return `${ collectionId }:${ path }` }
}
