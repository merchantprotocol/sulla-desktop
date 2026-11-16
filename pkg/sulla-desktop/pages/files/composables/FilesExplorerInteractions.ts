// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, ref, type ComputedRef, type Ref } from 'vue';

import type { FilesCrossCollectionCapability, FilesFolderState } from '../types';

export interface ExplorerLocation {
  collectionId: string;
  section: string;
  path: string;
}

export interface ExplorerTarget {
  key: string;
  fileId?: string;
  folderPath?: string;
  expectedFolder?: FilesFolderState;
  sourceSubtreeSignature?: string;
  expectedVersionId?: string;
  expectedRevision?: string;
  path: string;
  name: string;
  folder: boolean;
}

export interface ExplorerClipboard {
  collectionId: string;
  sourceCapability: FilesCrossCollectionCapability;
  mode: 'copy' | 'cut';
  targets: ExplorerTarget[];
}

export interface ExplorerColumns {
  name: number;
  owner: number;
  modified: number;
  size: number;
}

export interface ExplorerFolderPreferences {
  sort: string;
  direction: 'asc' | 'desc';
  columns: ExplorerColumns;
  view: 'list' | 'grid';
}

/** The slice of Web Storage folder preferences need; production uses the window's localStorage. */
export interface ExplorerPreferenceStorage {
  getItem(key:string):string | null;
  setItem(key:string, value:string):void;
}

/** Back/forward history, the cut/copy clipboard and per-folder view preferences for one Files tab. */
export class FilesExplorerInteractions {
  private static readonly DEFAULT_COLUMNS:Readonly<ExplorerColumns> = { name: 360, owner: 190, modified: 160, size: 110 };
  private static readonly SORT_KEYS:readonly string[] = ['name', 'modified', 'size', 'type', 'owner'];
  private static readonly MIN_COLUMN_WIDTH = 72;
  private static readonly MAX_COLUMN_WIDTH = 720;

  readonly backStack:Ref<ExplorerLocation[]> = ref([]);
  readonly forwardStack:Ref<ExplorerLocation[]> = ref([]);
  readonly clipboard:Ref<ExplorerClipboard | null> = ref(null);
  readonly canGoBack:ComputedRef<boolean> = computed(() => this.backStack.value.length > 0);
  readonly canGoForward:ComputedRef<boolean> = computed(() => this.forwardStack.value.length > 0);

  constructor(private readonly tabId:string, private readonly storage:ExplorerPreferenceStorage = localStorage) {}

  visit(current:ExplorerLocation, next:ExplorerLocation):void {
    if (this.sameLocation(current, next)) return;
    this.backStack.value.push(current);
    this.forwardStack.value = [];
  }

  back(current:ExplorerLocation):ExplorerLocation | null {
    const next = this.backStack.value.pop();

    if (!next) return null;
    this.forwardStack.value.push(current);
    return next;
  }

  forward(current:ExplorerLocation):ExplorerLocation | null {
    const next = this.forwardStack.value.pop();

    if (!next) return null;
    this.backStack.value.push(current);
    return next;
  }

  clearForCollection(_collectionId:string):void {
    this.backStack.value = [];
    this.forwardStack.value = [];
  }

  setClipboard(collectionId:string, sourceCapability:FilesCrossCollectionCapability, mode:'copy' | 'cut', targets:ExplorerTarget[]):void {
    this.clipboard.value = { collectionId, sourceCapability, mode, targets: targets.map(target => ({ ...target, ...(target.expectedFolder ? { expectedFolder: { ...target.expectedFolder } } : {}) })) };
  }

  loadFolderPreferences(collectionId:string, path:string):ExplorerFolderPreferences {
    const defaults = FilesExplorerInteractions.DEFAULT_COLUMNS;

    try {
      const value = JSON.parse(this.storage.getItem(this.storageKey(collectionId, path)) || '{}') as { sort?:string; direction?:'asc' | 'desc'; columns?:Partial<ExplorerColumns>; view?:'list' | 'grid' };
      const columns = { ...defaults, ...value.columns };

      for (const key of Object.keys(columns) as (keyof ExplorerColumns)[]) columns[key] = Math.max(FilesExplorerInteractions.MIN_COLUMN_WIDTH, Math.min(FilesExplorerInteractions.MAX_COLUMN_WIDTH, Number(columns[key]) || defaults[key]));
      return { sort: FilesExplorerInteractions.SORT_KEYS.includes(value.sort ?? '') ? value.sort! : 'modified', direction: value.direction === 'asc' ? 'asc' : 'desc', columns, view: value.view === 'grid' ? 'grid' : 'list' };
    } catch {
      return { sort: 'modified', direction: 'desc', columns: { ...defaults }, view: 'list' };
    }
  }

  saveFolderPreferences(collectionId:string, path:string, value:ExplorerFolderPreferences):void {
    try { this.storage.setItem(this.storageKey(collectionId, path), JSON.stringify(value)) } catch { /* Browsing remains usable when storage is unavailable. */ }
  }

  private sameLocation(left:ExplorerLocation, right:ExplorerLocation):boolean {
    return left.collectionId === right.collectionId && left.section === right.section && left.path === right.path;
  }

  private storageKey(collectionId:string, path:string):string {
    return `sulla:files:${ encodeURIComponent(this.tabId) }:${ encodeURIComponent(collectionId) }:${ encodeURIComponent(path || '/') }`;
  }
}
