// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, ref } from 'vue';

import { aggregateFolderChildren, fileNameCollator, type FolderAggregate } from '../fileAggregation';
import { FilesSectionSource, FolderSummaryIndex } from '../FilesCrossFolderViews';
import { FilesBrowserLocation } from './FilesBrowserLocation';
import { FilesBrowserState } from './FilesBrowserState';
import { FilesBrowserViewPreferences } from './FilesBrowserViewPreferences';
import { FilesEntryFactory } from './FilesEntryFactory';
import { FilesEntryFormatter } from './FilesEntryFormatter';
import { FilesEntryPresenter } from './FilesEntryPresenter';

import type { DisplayEntry } from './FilesBrowserTypes';
import type { FilesFolderState, FilesItem } from '../types';

/** The rows the open section and folder show: filtered, aggregated into folders, sorted and expanded. */
export class FilesBrowserListing {
  /** The open folder's rows are only that folder; collection-wide figures and cross-folder views have their own server sources. */
  readonly sectionSource = computed(() => new FilesSectionSource(this.state.props.dataSource));
  readonly sectionFiles = ref<FilesItem[] | null>(null);
  /** Replaced in the constructor once the data source is known (whether it serves server folder totals). */
  readonly folderSummaries = ref(new FolderSummaryIndex(false));
  readonly expandedFolderFiles = ref(new Map<string, FilesItem[]>());

  readonly visibleEntries = computed<DisplayEntry[]>(() => this.buildVisibleEntries());
  readonly displayedEntries = computed(() => this.visibleEntries.value.flatMap(entry => entry.folder && !entry.rootCollectionId && this.state.expandedFolders.value.has(entry.path) ? [{ ...entry, depth: 0 }, ...this.childrenForFolder(entry, 1)] : [{ ...entry, depth: 0 }]));
  readonly groups = computed(() => [{ label: this.state.currentPath.value ? 'Contents' : 'Files and folders', entries: this.displayedEntries.value }].filter(group => group.entries.length));
  readonly displayedEntryMap = computed(() => new Map(this.displayedEntries.value.map(entry => [entry.key, entry])));
  readonly displayedEntryKeys = computed(() => new Set(this.displayedEntryMap.value.keys()));
  readonly summaryText = computed(() => `${ this.visibleEntries.value.length } item${ this.visibleEntries.value.length === 1 ? '' : 's' } · ${ this.format.formatBytes(this.visibleEntries.value.reduce((sum, entry) => sum + entry.size, 0)) }`);
  readonly filters = computed(() => [
    { key: 'type' as const, label: 'Type', any: 'Any', options: [...new Set(this.location.activeFiles.value.map(file => this.format.kindLabel(file.mime, file.path)))].sort() },
    { key: 'person' as const, label: 'Person', any: 'Anyone', options: [...new Set(this.location.activeFiles.value.map(this.presenter.ownerName))].sort() },
    { key: 'date' as const, label: 'Date', any: 'Any time', options: ['Today', 'This week', 'Earlier'] },
    { key: 'folder' as const, label: 'Folder', any: 'This folder', options: [...new Set(this.location.activeFiles.value.filter(file => file.path.includes('/')).map(file => file.path.split('/')[0]))].sort() },
  ]);

  constructor(
    private readonly state:FilesBrowserState,
    private readonly location:FilesBrowserLocation,
    private readonly preferences:FilesBrowserViewPreferences,
    private readonly factory:FilesEntryFactory,
    private readonly presenter:FilesEntryPresenter,
    private readonly format:FilesEntryFormatter,
  ) {
    this.folderSummaries.value = new FolderSummaryIndex(typeof state.props.dataSource.folderSummaries === 'function');
  }

  readonly clearFilters = ():void => { this.state.activeFilters.value = { type: '', person: '', date: '', folder: '' } };

  readonly toggleFolderExpansion = (entry:DisplayEntry):void => { const next = new Set(this.state.expandedFolders.value); next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path); this.state.expandedFolders.value = next };

  /** A new collection starts with no server folder totals and no expanded-folder rows. */
  resetForCollection():void { this.folderSummaries.value = new FolderSummaryIndex(typeof this.state.props.dataSource.folderSummaries === 'function'); this.expandedFolderFiles.value = new Map() }

  private compareEntries = (a:DisplayEntry, b:DisplayEntry):number => this.factory.compare(a, b, this.preferences.sort.value, this.preferences.sortDirection.value);

  private emptyAggregate(name:string, path:string, flags:boolean):FolderAggregate {
    return { name, path, count: 0, size: 0, newestTimestamp: Date.parse('0'), allAgent: flags, hasConflict: false, hasSyncing: false, allOnlineOnly: flags };
  }

  private buildVisibleEntries():DisplayEntry[] {
    const state = this.state; const section = state.section.value; const snapshot = state.snapshot.value;

    if (this.location.atRoots.value && !state.query.value.trim()) return this.location.userCollections.value.map(this.factory.collectionRootEntry);
    if (section === 'trash') {
      const search = state.query.value.trim().toLowerCase();

      return this.location.trashItems.value.filter(item => item.path.split('/').at(-1) !== '_folder-metadata.yaml' && (!search || item.path.toLowerCase().includes(search))).map(this.factory.toTrashDisplay).sort(this.compareEntries);
    }
    const search = state.query.value.trim().toLowerCase();
    const crossFolder = !state.searchResults.value && this.sectionSource.value.supports(section);

    if (section === 'shared' && !search && this.folderSummaries.value.serverBacked) return this.sharedFolderEntries();
    let files = state.searchResults.value ?? (crossFolder ? this.sectionFiles.value ?? [] : this.location.activeFiles.value);

    if (section === 'agent') files = files.filter(file => file.createdByType === 'agent-run');
    if (section === 'starred') files = files.filter(file => state.starred.value.has(file.id));
    if (section === 'recent') { const timestamps = new Map(files.map(file => [file.id, Date.parse(file.updatedAt || '0')])); files = [...files].sort((a, b) => timestamps.get(b.id)! - timestamps.get(a.id)!).slice(0, 50) }
    if (section === 'shared') files = files.filter(file => this.location.sharedFolders.value.some(folder => file.path.startsWith(`${ folder }/`)));
    const flat = Boolean(search) || ['recent', 'starred', 'trash'].includes(section) || (crossFolder && section === 'agent');
    const prefix = state.currentPath.value && section === 'files' ? `${ state.currentPath.value }/` : '';
    const entries:DisplayEntry[] = [];
    const aggregation = aggregateFolderChildren(files, prefix);
    const folderStates = new Map<string, FilesFolderState | undefined>();

    if (flat) {
      for (const file of files) if (file.mime !== 'inode/directory') entries.push(this.factory.toDisplay(file));
    } else {
      entries.push(...aggregation.directFiles.map(file => this.factory.toDisplay(file, aggregation.timestamps.get(file.id) ?? Date.parse(file.updatedAt || '0'))));
      for (const folder of snapshot?.folders ?? []) {
        const folderPath = typeof folder === 'string' ? folder : folder.path;

        if (folderPath.startsWith(prefix) && folderPath.length > prefix.length) {
          const name = folderPath.slice(prefix.length).split('/')[0];
          const displayedPath = `${ prefix }${ name }`;

          folderStates.set(name, typeof folder !== 'string' && folder.path === displayedPath ? folder : folderStates.get(name));
          if (!aggregation.folders.has(name)) aggregation.folders.set(name, this.emptyAggregate(name, displayedPath, true));
        }
      }
      const summarized = section === 'files' ? this.folderSummaries.value.apply(aggregation, prefix) : aggregation;

      for (const aggregate of summarized.folders.values()) entries.push(this.factory.folderEntry(prefix, aggregate, folderStates.get(aggregate.name)));
    }
    if (section === 'starred') {
      for (const key of state.starred.value) {
        if (!key.startsWith('folder:')) continue;
        const path = key.slice('folder:'.length); const parent = path.split('/').slice(0, -1).join('/'); const parentPrefix = `${ parent }${ parent ? '/' : '' }`;
        const aggregate = this.starredFolderAggregate(path, parentPrefix);

        if (aggregate && aggregate.count !== 0) {
          const folderState = snapshot?.folders?.find(folder => typeof folder !== 'string' && folder.path === path);

          entries.push(this.factory.folderEntry(parentPrefix, aggregate, typeof folderState === 'string' ? undefined : folderState));
        }
      }
    }
    const filters = state.activeFilters.value;

    return entries.filter(entry => !(section === 'files' && !state.currentPath.value && entry.name === '_folder-metadata.yaml')).filter(entry => (!filters.type || this.format.kindLabel(entry.mime, entry.path) === filters.type) && (!filters.person || this.presenter.ownerName(entry) === filters.person) && (!filters.folder || entry.path.split('/')[0] === filters.folder) && (!filters.date || this.format.dateBucket(entry.updatedAt) === filters.date)).sort(this.compareEntries);
  }

  private starredFolderAggregate(path:string, parentPrefix:string):FolderAggregate | undefined {
    const name = path.split('/').at(-1)!;
    const aggregation = aggregateFolderChildren(this.location.activeFiles.value, parentPrefix);

    if (!this.folderSummaries.value.serverBacked) return aggregation.folders.get(name);
    const known = (this.state.snapshot.value?.folders ?? []).some(folder => (typeof folder === 'string' ? folder : folder.path) === path);

    if (!aggregation.folders.has(name)) aggregation.folders.set(name, this.emptyAggregate(name, path, false));
    const aggregate = this.folderSummaries.value.apply(aggregation, parentPrefix).folders.get(name);

    // A starred folder with a folder record but no files still shows (as empty), unlike the old loaded-rows check.
    return aggregate && (aggregate.count !== 0 || known) ? { ...aggregate, count: aggregate.count === 0 && known ? 0 : aggregate.count } : undefined;
  }

  private sharedFolderEntries():DisplayEntry[] {
    return this.location.sharedFolders.value.map(path => {
      const parent = path.split('/').slice(0, -1).join('/'); const prefix = parent ? `${ parent }/` : ''; const name = path.split('/').at(-1) ?? path;
      const aggregate = this.folderSummaries.value.apply({ directFiles: [], timestamps: new Map(), folders: new Map([[name, this.emptyAggregate(name, path, false)]]) }, prefix).folders.get(name)!;
      const folderState = this.state.snapshot.value?.folders?.find(folder => typeof folder !== 'string' && folder.path === path);

      return this.factory.folderEntry(prefix, aggregate, typeof folderState === 'string' ? undefined : folderState);
    }).sort(this.compareEntries);
  }

  private childrenForFolder(folder:DisplayEntry, depth:number):DisplayEntry[] {
    const prefix = `${ folder.path }/`; const aggregation = aggregateFolderChildren(this.state.props.dataSource.listFolderChildren ? this.expandedFolderFiles.value.get(folder.path) ?? [] : this.location.activeFiles.value, prefix); const states = new Map<string, FilesFolderState | undefined>();

    for (const item of this.state.snapshot.value?.folders ?? []) {
      const folderPath = typeof item === 'string' ? item : item.path;

      if (!folderPath.startsWith(prefix) || folderPath === folder.path) continue;
      const name = folderPath.slice(prefix.length).split('/')[0]; const direct = `${ prefix }${ name }`;

      if (!states.has(name) || folderPath === direct) states.set(name, typeof item === 'string' ? undefined : item);
      if (!aggregation.folders.has(name)) aggregation.folders.set(name, this.emptyAggregate(name, direct, true));
    }
    const entries = [...this.folderSummaries.value.apply(aggregation, prefix).folders.values()].map(item => ({ ...this.factory.folderEntry(prefix, item, states.get(item.name)), depth }));

    entries.push(...aggregation.directFiles.map(file => ({ ...this.factory.toDisplay(file, aggregation.timestamps.get(file.id) ?? Date.parse(file.updatedAt || '0')), depth })));
    const sorted = entries.sort((a, b) => a.folder === b.folder ? fileNameCollator.compare(a.name, b.name) : a.folder ? -1 : 1);

    return sorted.flatMap(entry => entry.folder && this.state.expandedFolders.value.has(entry.path) ? [entry, ...this.childrenForFolder(entry, depth + 1)] : [entry]);
  }
}
