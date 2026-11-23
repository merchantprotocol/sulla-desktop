// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ref } from 'vue';

import type { FilesBrowserEmit, FilesBrowserProps, FilesBrowserSection, DisplayEntry, FilesNativeSource, FilesShareTarget } from './FilesBrowserTypes';
import type { FilesIndexCoverage, FilesItem, FilesSnapshot, FilesVersion } from '../types';

/**
 * The shared reactive state of one FilesBrowser instance: what is loaded, where the user is,
 * what is selected and the page-level status lines. Every region class reads and writes these refs.
 */
export class FilesBrowserState {
  readonly snapshot = ref<FilesSnapshot | null>(null);
  readonly loading = ref(true);
  readonly busy = ref(false);
  readonly error = ref('');
  readonly section = ref<FilesBrowserSection>('files');
  readonly currentPath = ref('');
  readonly query = ref('');
  readonly activeFilters = ref<Record<'type' | 'person' | 'date' | 'folder', string>>({ type: '', person: '', date: '', folder: '' });
  readonly searchResults = ref<FilesItem[] | null>(null);
  readonly searchCoverage = ref<FilesIndexCoverage | null>(null);
  readonly selectedKeys = ref(new Set<string>());
  readonly selectionAnchor = ref<string | null>(null);
  readonly operationError = ref('');
  readonly navigationError = ref('');
  readonly detailVersion = ref<FilesVersion>();
  readonly operationNotice = ref('');
  readonly selected = ref<DisplayEntry | null>(null);
  readonly detailTab = ref<'details' | 'versions'>('details');
  readonly expandedFolders = ref(new Set<string>());
  readonly nativeSources = ref<FilesNativeSource[]>([]);
  readonly starred = ref(new Set<string>());
  readonly shareTarget = ref<FilesShareTarget | null>(null);
  readonly collectionsRoot = ref(true);
  readonly refreshCount = ref(0);

  /** Root element of the browser and its <main> surface (template refs). */
  readonly browserSurface = ref<HTMLElement | null>(null);
  readonly mainSurface = ref<HTMLElement | null>(null);

  /** True between onMounted and onBeforeUnmount; async work checks it before writing state. */
  mounted = false;
  /** Bumped by every refresh and mutation so a stale load never overwrites newer state. */
  refreshGeneration = 0;

  constructor(readonly props:FilesBrowserProps, readonly emit:FilesBrowserEmit) {}

  readonly dismissOperationError = ():void => { this.operationError.value = '' };

  /** The message a caught failure shows, as the browser has always rendered it. */
  static messageOf(cause:unknown):string {
    return cause instanceof Error ? cause.message : String(cause);
  }
}
