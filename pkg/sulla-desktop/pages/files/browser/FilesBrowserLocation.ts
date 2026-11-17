// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed } from 'vue';

import { FilesBrowserState } from './FilesBrowserState';

import type { FilesSnapshot } from '../types';

type FilesCollectionRow = NonNullable<FilesSnapshot['availableCollections']>[number];

/** One "Organizations" sub-heading and the shared collections listed under it. */
export interface FilesOrgCollectionGroup { orgName:string; collections:FilesCollectionRow[] }

/** Where the browser is: the loaded collection, the open section and folder, and the titles for them. */
export class FilesBrowserLocation {
  readonly activeFiles = computed(() => this.state.snapshot.value?.files.filter(file => !file.deletedAt && file.path.split('/').at(-1) !== '_folder-metadata.yaml') ?? []);
  readonly trashItems = computed(() => this.state.snapshot.value?.trash ?? []);
  readonly sharedFolders = computed(() => this.state.snapshot.value?.collection.sharedFolders ?? []);
  /** Organization collections are listed under "Organizations" instead, so they are not tracked folders. */
  readonly trackedCollections = computed(() => this.userCollections.value.filter(collection => collection.workspaceScope !== 'organization').slice(1));
  /** Organization collections grouped by org name, then sorted by collection name. */
  readonly orgCollections = computed<FilesOrgCollectionGroup[]>(() => this.userCollections.value
    .filter(collection => collection.workspaceScope === 'organization')
    .sort((a, b) => (a.orgName ?? '').localeCompare(b.orgName ?? '') || a.name.localeCompare(b.name))
    .reduce<FilesOrgCollectionGroup[]>((groups, collection) => {
      const orgName = collection.orgName || collection.orgId || 'Organization';
      const group = groups.at(-1);
      if (group?.orgName === orgName) group.collections.push(collection);
      else groups.push({ orgName, collections: [collection] });
      return groups;
    }, []));
  /** My Files opens on one folder per collection (this desktop's Files plus each synced folder), the same tree Sulla Cloud and Mobile show. */
  readonly userCollections = computed(() => (this.state.snapshot.value?.availableCollections ?? []).filter(collection => !collection.systemArea));
  readonly atRoots = computed(() => this.state.collectionsRoot.value && this.state.section.value === 'files' && this.userCollections.value.length > 1);
  readonly collectionCrumb = computed(() => this.state.section.value === 'files' && !this.atRoots.value && this.userCollections.value.length > 1 && !this.state.snapshot.value?.collection.systemArea ? this.state.snapshot.value?.collection.name ?? '' : '');
  readonly readOnlyArea = computed(() => this.atRoots.value);
  /** The Logs collection is the Files service's internal audit store: never a move/copy target. */
  readonly otherCollections = computed(() => this.state.snapshot.value?.availableCollections?.filter(collection => collection.id !== this.state.snapshot.value?.collection.id && collection.systemArea !== 'logs') ?? []);
  readonly rootLabel = computed(() => ({ files: 'My Files', shared: 'Shared with me', sharedByMe: 'Shared by me', recent: 'Recent', starred: 'Starred', agent: 'Agent files', trash: 'Trash' }[this.state.section.value]));
  readonly pageTitle = computed(() => this.state.section.value === 'files' && this.state.currentPath.value ? this.state.currentPath.value.split('/').at(-1) : this.collectionCrumb.value || this.rootLabel.value);
  readonly parentFolderLabel = computed(() => this.state.currentPath.value.split('/').filter(Boolean).at(-2) ?? this.rootLabel.value);
  readonly parentPath = computed(() => this.state.currentPath.value.split('/').filter(Boolean).slice(0, -1).join('/'));
  readonly crumbs = computed(() => this.state.section.value === 'files' ? this.state.currentPath.value.split('/').filter(Boolean).map((label, index, parts) => ({ label, path: parts.slice(0, index + 1).join('/') })) : []);
  readonly emptyTitle = computed(() => ({ files: 'This folder is empty', shared: 'Nothing shared with you yet', sharedByMe: 'No public links yet', recent: 'No recent files', starred: 'No starred files', agent: 'No agent files to keep', trash: 'Trash is empty' }[this.state.section.value]));
  readonly emptyCopy = computed(() => ({ files: 'Drop files here or choose files. Files are stored securely and versioned on every change.', shared: 'Folders teammates share with you appear here.', sharedByMe: 'Links you create appear here.', recent: 'Files you change will appear here.', starred: 'Star important files to find them quickly.', agent: 'Files created by agent runs will appear here with their provenance.', trash: 'Deleted files remain discoverable until the Files service permits disposal.' }[this.state.section.value]));
  readonly canEmptyTrash = computed(() => Boolean(this.state.props.dataSource.purgeTrashItem));
  readonly canCreateAnything = computed(() => { const source = this.state.props.dataSource; return Boolean(source.capabilities.upload || source.capabilities.durableOperations || source.createFile || (source.nativeSourceReady && source.chooseNativeSource)) });

  constructor(private readonly state:FilesBrowserState) {}
}
