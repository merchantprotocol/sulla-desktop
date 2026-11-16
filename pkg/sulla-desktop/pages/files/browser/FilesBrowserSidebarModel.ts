// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed } from 'vue';

import { FilesBrowserIcons as icons } from './FilesBrowserIcons';
import { FilesBrowserLocation } from './FilesBrowserLocation';
import { FilesBrowserState } from './FilesBrowserState';
import { FilesEntryFormatter } from './FilesEntryFormatter';
import { FilesEntryPresenter } from './FilesEntryPresenter';

import type { FilesBrowserSection } from './FilesBrowserTypes';

/** The sidebar's derived figures: sections, favorites, storage, sync line, backup and account. */
export class FilesBrowserSidebarModel {
  readonly collectionFileCount = computed(() => this.state.snapshot.value?.collection.fileCount ?? this.location.activeFiles.value.length);
  readonly totalBytes = computed(() => this.state.snapshot.value?.collection.totalBytes ?? this.location.activeFiles.value.reduce((sum, file) => sum + file.size, 0));
  readonly quotaBytes = computed(() => this.state.snapshot.value?.collection.storageQuota);
  readonly storagePercent = computed(() => this.quotaBytes.value ? Math.min(100, Math.max(1, this.totalBytes.value / this.quotaBytes.value * 100)) : 0);
  readonly storageWhere = computed(() => this.state.snapshot.value?.status.serverConfigured ? 'on server' : 'on this Mac');
  readonly folderFavorites = computed(() => {
    const folders = new Set((this.state.snapshot.value?.folders ?? []).map(folder => typeof folder === 'string' ? folder : folder.path));

    return [...this.state.starred.value]
      .filter(key => key.startsWith('folder:'))
      .map(key => key.slice('folder:'.length))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map(path => ({
        path,
        name:      path.split('/').at(-1) ?? path,
        available: folders.has(path) || this.location.activeFiles.value.some(file => file.path.startsWith(`${ path }/`)),
      }));
  });

  readonly cloudBackup = computed(() => this.state.snapshot.value?.collection.cloudBackup);
  readonly cloudBackupTitle = computed(() => { const backup = this.cloudBackup.value; if (!backup) return 'Encrypted Files backup is unavailable'; if (backup.status === 'needs-vault') return 'Turn on Passwords sync first. Passwords holds the encryption keys for Files backup.'; return backup.lastError || `Encrypted with ${ backup.cryptoModule.provider } ${ backup.cryptoModule.version }${ backup.cryptoModule.fips ? ' (FIPS mode)' : '' }` });
  readonly cloudBackupLine = computed(() => { const backup = this.cloudBackup.value; if (!backup) return ''; if (backup.status === 'needs-vault') return 'Needs Passwords sync'; const pending = backup.pendingBytes ? `${ this.format.formatBytes(backup.pendingBytes) } pending` : 'Nothing pending'; const conflicts = backup.conflicts ? ` · ${ backup.conflicts } conflict${ backup.conflicts === 1 ? '' : 's' }` : ''; const last = backup.lastSyncAt ? ` · Last backup ${ this.format.timeAgo(backup.lastSyncAt) }` : ''; return `${ pending }${ conflicts }${ last } · ${ backup.cryptoModule.provider }` });
  readonly retentionDays = computed(() => Number(this.state.snapshot.value?.collection.retentionPolicy?.trashDays ?? 90));
  readonly retentionLabel = computed(() => this.state.snapshot.value?.collection.retentionPolicy?.mode === 'none' ? 'No automatic disposal' : this.state.snapshot.value?.collection.retentionPolicy?.mode ? `Retention: ${ this.state.snapshot.value.collection.retentionPolicy.mode }` : `Trash is recoverable for ${ this.retentionDays.value } days`);
  readonly locationWord = computed(() => ({ local: 'local', server: 'server', cloud: 'Sulla Cloud' }[this.state.snapshot.value?.status.location ?? (this.state.snapshot.value?.status.serverConfigured ? 'server' : 'local')]));
  readonly brandLine = computed(() => `${ this.state.snapshot.value?.collection.accountName || 'Files' } · ${ this.locationWord.value }`);
  readonly syncLine = computed(() => {
    const status = this.state.snapshot.value?.status;

    if (!status) return 'Checking sync…';
    if (status.legacyImport?.state === 'secure-import-required') return status.legacyImport.action || 'Legacy Files data is contained pending secure import';
    if (status.state === 'syncing') return `Syncing ${ status.pendingFiles || '' } file${ status.pendingFiles === 1 ? '' : 's' }`.replace('  ', ' ');
    if (status.state === 'paused') return 'Sync paused · click to resume';
    if (status.state === 'conflict') return 'A file needs a decision';
    if (status.state === 'error') return 'Not syncing · files safe on this Mac';
    if (!status.serverConfigured) return 'Local only · files saved on this Mac';
    return `All files synced${ status.lastSyncAt ? ` · ${ this.format.timeAgo(status.lastSyncAt) }` : '' }`;
  });

  readonly syncTooltip = computed(() => this.presenter.syncState.value === 'paused' ? 'Resume Files sync' : 'Pause Files sync');
  readonly accountLine = computed(() => {
    const raw = this.state.snapshot.value?.collection.accountRole;
    const role = raw ? ({ manage: 'Owner', owner: 'Owner', edit: 'Editor', view: 'Viewer' }[raw] ?? raw.charAt(0).toUpperCase() + raw.slice(1)) : 'Role unavailable';
    const desktops = this.state.snapshot.value?.collection.desktopCount;

    return desktops === undefined ? role : `${ role } · ${ desktops } desktop${ desktops === 1 ? '' : 's' }`;
  });

  /** One badge per agent run that left files behind, matching the mockup's "Agent files 2". */
  readonly agentCount = computed(() => this.state.snapshot.value?.collection.agentRunCount ?? new Set(this.location.activeFiles.value.filter(file => file.createdByType === 'agent-run').map(file => file.createdById)).size);
  readonly sections = computed(() => [
    { id: 'files' as FilesBrowserSection, label: 'My Files', icon: icons.folderLine, count: 0, warn: false },
    { id: 'shared' as FilesBrowserSection, label: 'Shared with me', icon: icons.users, count: this.location.sharedFolders.value.length, warn: false },
    { id: 'sharedByMe' as FilesBrowserSection, label: 'Shared by me', icon: icons.share, count: 0, warn: false },
    { id: 'recent' as FilesBrowserSection, label: 'Recent', icon: icons.clock, count: 0, warn: false },
    { id: 'starred' as FilesBrowserSection, label: 'Starred', icon: icons.star, count: 0, warn: false },
    { id: 'agent' as FilesBrowserSection, label: 'Agent files', icon: icons.agent, count: this.agentCount.value, warn: true },
    { id: 'trash' as FilesBrowserSection, label: 'Trash', icon: icons.trash, count: this.location.trashItems.value.length, warn: this.location.trashItems.value.some(item => item.currentTombstone.undo.state === 'recovery-required') },
  ]);

  constructor(
    private readonly state:FilesBrowserState,
    private readonly location:FilesBrowserLocation,
    private readonly presenter:FilesEntryPresenter,
    private readonly format:FilesEntryFormatter,
  ) {}
}
