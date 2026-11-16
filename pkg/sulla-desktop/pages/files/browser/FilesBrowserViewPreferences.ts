// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, ref } from 'vue';

import { FilesBrowserState } from './FilesBrowserState';

import type { FilesBrowserViewMode, FilesExplorer } from './FilesBrowserTypes';
import type { ExplorerColumns } from '../composables/useFilesExplorerInteractions';

/** Sort, direction, column widths and list/grid view, remembered per folder through the explorer. */
export class FilesBrowserViewPreferences {
  readonly sort = ref('modified');
  readonly sortDirection = ref<'asc' | 'desc'>('desc');
  readonly columns = ref<ExplorerColumns>({ name: 360, owner: 190, modified: 160, size: 110 });
  readonly view = ref<FilesBrowserViewMode>('list');
  readonly sortLabel = computed(() => ({ name: 'Name', modified: 'Modified', size: 'Size', type: 'Type' } as Record<string, string>)[this.sort.value] ?? 'Name');

  constructor(private readonly state:FilesBrowserState, private readonly explorer:FilesExplorer) {}

  readonly setSort = (key:string):void => { if (this.sort.value === key) this.sortDirection.value = this.sortDirection.value === 'asc' ? 'desc' : 'asc'; else { this.sort.value = key; this.sortDirection.value = key === 'name' ? 'asc' : 'desc' } this.saveFolderPreferences() };

  readonly sortIndicator = (key:string):string => this.sort.value === key ? (this.sortDirection.value === 'asc' ? '↑' : '↓') : '';

  readonly columnStyle = (key:keyof ExplorerColumns):{ width:string; minWidth:string } => ({ width: `${ this.columns.value[key] }px`, minWidth: `${ this.columns.value[key] }px` });

  readonly setView = (view:FilesBrowserViewMode):void => { this.view.value = view };

  readonly loadFolderPreferences = ():void => { const context = this.preferenceContext(); const stored = this.explorer.loadFolderPreferences(context.collectionId, context.path); this.sort.value = stored.sort; this.sortDirection.value = stored.direction; this.columns.value = stored.columns; this.view.value = stored.view };

  readonly saveFolderPreferences = ():void => { if (!this.state.snapshot.value) return; const context = this.preferenceContext(); this.explorer.saveFolderPreferences(context.collectionId, context.path, { sort: this.sort.value, direction: this.sortDirection.value, columns: this.columns.value, view: this.view.value }) };

  private preferenceContext():{ collectionId:string; path:string } { return { collectionId: this.state.snapshot.value?.collection.id ?? 'pending', path: this.state.section.value === 'files' ? this.state.currentPath.value : `@${ this.state.section.value }` } }
}
