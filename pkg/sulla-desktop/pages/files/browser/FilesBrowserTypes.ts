// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FilesNavigationPayload } from '@pkg/composables/useBrowserTabs';

import type { ExplorerTarget } from '../composables/useFilesExplorerInteractions';
import type { FilesDataSource, FilesFolderState, FilesItem, FilesTrashItem } from '../types';

/** The public props of FilesBrowser.vue (unchanged by the E2-S5 split). */
export interface FilesBrowserProps { dataSource: FilesDataSource; tabId: string; navigation?: FilesNavigationPayload }

/** The public emits of FilesBrowser.vue, as the typed emit function the component receives. */
export interface FilesBrowserEmit {
  (event:'navigation-consumed'):void;
  (event:'open-editor', item:FilesItem, collectionId?:string):void;
}

export type FilesBrowserSection = 'files' | 'shared' | 'sharedByMe' | 'recent' | 'starred' | 'agent' | 'trash';
export type FilesBrowserViewMode = 'list' | 'grid';

/** One row or tile the browser renders: a file, folder, Trash tombstone or collection root. */
export interface DisplayEntry extends FilesItem { key: string; name: string; folder: boolean; sortTimestamp:number; folderState?:FilesFolderState; trashItem?:FilesTrashItem; rootCollectionId?:string; agent: boolean; childCount: number; kindClass: string; icon: string; subtitle: string; depth?:number }

/** A Trash row that is backed by its exact Trash tombstone. */
export type TrashDisplayEntry = DisplayEntry & { trashItem:FilesTrashItem };

/** One move/copy item before it becomes a durable operation request. */
export interface OperationItem { fileId?:string; folderPath?:string; expectedFolder?:FilesFolderState; sourceSubtreeSignature?:string; targetPath:string; expectedVersionId?:string; expectedRevision?:string }

export interface DragSnapshot { sourceIdentity:string; preparationSignature:string; target:ExplorerTarget }
export interface DragPreparation { collectionId:string; signature:string; generation:number; anchorKey:string }
export interface DragSnapshotRequest { sourceIdentity:string; generation:number; promise:Promise<void> }

export interface CloudFilesCollection { collectionId:string; bytes:number; updatedAt:string }

export interface FilesNamePrompt { title: string; label: string; confirm: string; value: string; allowEmpty: boolean; resolve: (value:string | null) => void }

export interface FilesShareTarget { id:string; name:string; folder:boolean; path:string; collectionId:string; orgId?:string; ownerUserId?:string; assetKind?:'file' | 'capture' | 'artifact' }

export interface FilesUploadProgress { current: number; total: number; name: string; percent: number; done: boolean }
export interface FilesUploadLogItem { name: string; percent: number; done: boolean }

export interface FilesNativeSource { fileId:string; name:string; state:string; lastError?:string; recovery:Record<string, unknown> }

export interface FilesMenuPoint { x:number; y:number }

export interface FilesMarquee { left:number; top:number; width:number; height:number; additive:boolean }

export type FilesFilterKey = 'type' | 'person' | 'date' | 'folder';

export type FilesTargetAction = 'open' | 'open-sulla' | 'native-open' | 'reveal' | 'reference' | 'add-bookmark' | 'details' | 'share' | 'rename' | 'move' | 'copy' | 'cut' | 'download' | 'online-only' | 'keep-local' | 'trash' | 'restore' | 'purge' | 'new-folder' | 'new-file';

/** The per-tab explorer binding (history, clipboard, folder preferences). */
export type FilesExplorer = ReturnType<typeof import('../composables/useFilesExplorerInteractions').useFilesExplorerInteractions>;
/** The per-tab durable operation queue binding. */
export type FilesOperations = ReturnType<typeof import('../composables/useFilesOperationQueue').useFilesOperationQueue>;
