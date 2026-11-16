// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed } from 'vue';

import { FilesBrowserIcons as icons } from './FilesBrowserIcons';
import { FilesEntryFormatter } from './FilesEntryFormatter';
import { FilesBrowserState } from './FilesBrowserState';

import type { FilesItem } from '../types';

/** Owner, avatar and sync presentation for one row, read against the loaded collection. */
export class FilesEntryPresenter {
  readonly accountName = computed(() => this.state.snapshot.value?.collection.accountName || 'Signed-in user');
  readonly syncState = computed(() => this.state.snapshot.value?.status.state ?? 'error');

  constructor(private readonly state:FilesBrowserState, private readonly format:FilesEntryFormatter) {}

  readonly ownerName = (entry:FilesItem):string => { const collection = this.state.snapshot.value?.collection; if (!entry.ownerDisplayName && entry.createdByType !== 'agent-run' && collection?.accountName && collection.ownerUserId && entry.createdById === collection.ownerUserId) return collection.accountName; return entry.ownerDisplayName || (entry.createdByType === 'agent-run' ? entry.createdById || 'Sulla agent' : entry.createdById || 'Unknown owner') };

  readonly ownerInitials = (entry:FilesItem):string => entry.createdByType === 'agent-run' ? this.ownerName(entry).charAt(0).toUpperCase() : this.format.initials(this.ownerName(entry));

  readonly avatarClass = (entry:FilesItem):string => { if (entry.createdByType === 'agent-run') return 'a'; const name = this.ownerName(entry); if (name === this.accountName.value || name.toLowerCase() === this.state.snapshot.value?.collection.accountName?.toLowerCase()) return ''; const tones = ['m', 'd', 'p']; return tones[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % tones.length] };

  readonly entrySync = (entry:FilesItem):string => entry.syncState || (this.syncState.value === 'syncing' ? 'syncing' : 'synced');

  readonly syncClass = (entry:FilesItem):string => ({ synced: 'local', syncing: 'syncing', 'online-only': 'online', conflict: 'conflict' } as Record<string, string>)[this.entrySync(entry)] ?? 'local';

  readonly syncIcon = (entry:FilesItem):string => ({ synced: icons.syncLocal, syncing: icons.syncSpin, 'online-only': icons.syncOnline, conflict: icons.alert } as Record<string, string>)[this.entrySync(entry)] ?? icons.syncLocal;

  readonly syncText = (entry:FilesItem):string => ({ synced: this.state.snapshot.value?.status.location === 'server' ? 'Stored on Sulla Server' : 'Stored in Sulla', syncing: 'Syncing', 'online-only': 'Online only', conflict: 'Conflict' } as Record<string, string>)[this.entrySync(entry)] ?? 'Stored in Sulla';
}
