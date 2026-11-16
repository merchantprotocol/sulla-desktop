// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DisplayEntry, OperationItem } from './FilesBrowserTypes';
import type { ExplorerTarget } from '../composables/useFilesExplorerInteractions';
import type { FilesCrossCollectionCapability } from '../types';

/**
 * What a drag, cut/copy or rename acts on, and where it lands: the source targets a gesture carries and the
 * move/copy items they become at a destination folder. Pure rules, no Vue or DOM.
 */
export class FilesDropTargets {
  private static readonly SUBTREE_SIGNATURE = /^[0-9a-f]{64}$/;

  /** `folder/name`, ignoring leading/trailing slashes on the folder; the root is ''. */
  static joinPath(folder:string, name:string):string { return [folder.replace(/^\/+|\/+$/g, ''), name].filter(Boolean).join('/') }

  /** The source identity a gesture captures for one row (its revision guards for files, folder state for folders). */
  static toTarget(entry:DisplayEntry):ExplorerTarget { return { key: entry.key, ...(entry.folder ? { folderPath: entry.path, expectedFolder: entry.folderState ? { ...entry.folderState } : undefined } : { fileId: entry.id, expectedVersionId: entry.currentVersionId, expectedRevision: entry.operationRevision }), path: entry.path, name: entry.name, folder: entry.folder } }

  /** The move/copy item that places `target` inside `destination` under its own name. */
  static operationTarget(target:ExplorerTarget, destination:string):OperationItem { return { ...(target.folder ? { folderPath: target.folderPath, expectedFolder: target.expectedFolder, sourceSubtreeSignature: target.sourceSubtreeSignature } : { fileId: target.fileId, expectedVersionId: target.expectedVersionId, expectedRevision: target.expectedRevision }), targetPath: FilesDropTargets.joinPath(destination, target.name) } }

  static operationItems(entries:DisplayEntry[], destination:string):OperationItem[] { return entries.map(entry => FilesDropTargets.operationTarget(FilesDropTargets.toTarget(entry), destination)) }

  /**
   * The rows a drag starting on `entry` carries: the whole selection when the entry is selected, otherwise just
   * the entry; files already inside a carried folder are dropped so nothing moves twice.
   */
  static dragEntriesFor(entry:DisplayEntry, selectedKeys:ReadonlySet<string>, selectedEntries:DisplayEntry[]):DisplayEntry[] {
    const requested = selectedKeys.has(entry.key) && selectedEntries.length ? selectedEntries : [entry];
    const selectedFolders = requested.filter(item => item.folder).map(item => item.path);

    return requested.filter(item => item.folder || !selectedFolders.some(folder => item.path.startsWith(`${ folder }/`)));
  }

  /** True when a folder carries the exact source snapshot a cross-collection transfer requires. */
  static hasSubtreeSignature(signature:string | undefined):boolean { return FilesDropTargets.SUBTREE_SIGNATURE.test(signature ?? '') }

  /** Targets may leave their collection only with a transfer capability and a snapshot for every folder. */
  static canLeaveCollection(targets:ExplorerTarget[], sourceCapability:FilesCrossCollectionCapability):boolean {
    return sourceCapability !== 'unavailable' && !targets.some(target => target.folder && !FilesDropTargets.hasSubtreeSignature(target.sourceSubtreeSignature));
  }
}
