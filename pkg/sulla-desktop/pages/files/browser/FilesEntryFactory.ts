// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { fileNameCollator, type FolderAggregate } from '../fileAggregation';
import { FilesBrowserIcons as icons } from './FilesBrowserIcons';
import { FilesEntryFormatter } from './FilesEntryFormatter';
import { FilesEntryPresenter } from './FilesEntryPresenter';

import type { DisplayEntry } from './FilesBrowserTypes';
import type { FilesFolderState, FilesItem, FilesTrashItem } from '../types';

/** Builds the rows the browser renders from files, folder aggregates, Trash tombstones and collections. */
export class FilesEntryFactory {
  constructor(private readonly format:FilesEntryFormatter, private readonly presenter:FilesEntryPresenter) {}

  readonly toDisplay = (file:FilesItem, sortTimestamp = Date.parse(file.updatedAt || '0')):DisplayEntry => {
    const glyph = this.format.fileGlyph(file.mime, file.path); const conflict = this.presenter.entrySync(file) === 'conflict';

    return { ...file, sortTimestamp, key: file.id, name: file.path.split('/').at(-1) || file.path, folder: false, agent: file.createdByType === 'agent-run', childCount: 0, kindClass: glyph.className, icon: glyph.icon, subtitle: conflict ? `Edited on ${ file.conflictDevices || 2 } desktops at once · both copies preserved` : `${ this.format.kindLabel(file.mime, file.path) } · v${ file.versionCount } · ${ file.indexStatus }: ${ file.indexReason }` };
  };

  readonly toTrashDisplay = (item:FilesTrashItem):DisplayEntry => {
    const undo = item.currentTombstone.undo.state.replace('-', ' ');

    if (item.kind === 'file') {
      return {
        ...this.toDisplay(item), key: `trash:file:${ item.id }`, trashItem: item,
        subtitle: `${ this.format.kindLabel(item.mime, item.path) } · Trash restore ${ undo }`,
      };
    }

    return {
      id: item.id, key: `trash:folder:${ item.id }`, path: item.path, sortTimestamp: Date.parse(item.deletedAt || '0'),
      name: item.path.split('/').at(-1) || item.path, folder: true, trashItem: item,
      agent: false, childCount: 0, kindClass: 'folder', icon: icons.folder,
      subtitle: `Folder · Trash restore ${ undo }`, mime: 'inode/directory', size: 0,
      updatedAt: item.deletedAt, deletedAt: item.deletedAt, currentVersionId: '',
      operationRevision: item.revision, versionCount: 0, createdByType: 'user', createdById: '',
      syncState: 'synced', indexStatus: 'indexed', indexReason: 'Folder tombstone.',
      capabilities: item.capabilities,
    };
  };

  readonly folderEntry = (prefix:string, aggregate:FolderAggregate, folderState?:FilesFolderState):DisplayEntry => {
    const newest = aggregate.newest;
    const agent = aggregate.count > 0 && aggregate.allAgent;
    const state = aggregate.hasConflict ? 'conflict' : aggregate.hasSyncing ? 'syncing' : aggregate.count > 0 && aggregate.allOnlineOnly ? 'online-only' : 'synced';
    const where = agent ? 'made by an agent' : state === 'online-only' ? 'online only' : 'stored in Sulla';
    const countLabel = aggregate.count < 0 ? 'Folder' : `${ aggregate.count } file${ aggregate.count === 1 ? '' : 's' }`;

    return { id: `folder:${ prefix }${ aggregate.name }`, key: `folder:${ prefix }${ aggregate.name }`, path: `${ prefix }${ aggregate.name }`, name: aggregate.name, folder: true, folderState, agent, childCount: aggregate.count, kindClass: agent ? 'folder agent' : 'folder', icon: agent ? icons.agent : icons.folder, subtitle: `${ countLabel } · ${ where }`, mime: 'inode/directory', size: Math.max(0, aggregate.size), updatedAt: newest?.updatedAt ?? '', sortTimestamp: aggregate.newestTimestamp, currentVersionId: '', versionCount: 0, createdByType: newest?.createdByType ?? 'user', createdById: newest?.createdById ?? '', ownerDisplayName: newest?.ownerDisplayName, ownerAvatarUrl: newest?.ownerAvatarUrl, syncState: state as FilesItem['syncState'], indexStatus: 'indexed', indexReason: 'Folder indexing is reported per file.' };
  };

  /**
   * The first collection loaded is the person's home; other collections appear as
   * top-level folders there, mirroring the single tree agents see at /mnt/sulla-files.
   */
  readonly collectionRootEntry = (collection:{ id:string; name:string }, index:number):DisplayEntry => {
    return { id: `collection:${ collection.id }`, key: `collection:${ collection.id }`, path: collection.name, name: collection.name, rootCollectionId: collection.id, folder: true, agent: false, childCount: 0, kindClass: 'folder', icon: icons.folder, subtitle: index === 0 ? 'Files on this desktop' : 'Synced folder', mime: 'inode/directory', size: 0, updatedAt: '', sortTimestamp: index, currentVersionId: '', versionCount: 0, createdByType: 'user', createdById: '', ownerDisplayName: this.presenter.accountName.value, syncState: 'synced', indexStatus: 'indexed', indexReason: 'Collection root.' };
  };

  /** Folders first, agent output last, then the chosen sort key in the chosen direction. */
  compare(a:DisplayEntry, b:DisplayEntry, sort:string, direction:'asc' | 'desc'):number {
    if (a.folder !== b.folder) return a.folder ? -1 : 1;
    if (a.agent !== b.agent) return a.agent ? 1 : -1;
    let result = sort === 'modified' ? a.sortTimestamp - b.sortTimestamp : sort === 'size' ? a.size - b.size : sort === 'type' ? fileNameCollator.compare(a.mime, b.mime) : fileNameCollator.compare(a.name, b.name);

    if (sort === 'owner') result = fileNameCollator.compare(this.presenter.ownerName(a), this.presenter.ownerName(b));
    return direction === 'asc' ? result : -result;
  }
}
