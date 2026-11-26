<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <FilesBrowser
    :data-source="dataSource"
    :bookmark-creator="bookmarkCreator"
    :tab-id="props.tabId"
    :navigation="props.navigation"
    @navigation-consumed="emit('navigation-consumed')"
    @navigation-result="emit('navigation-result', $event)"
    @open-editor="openEditor"
  />
</template>

<script setup lang="ts">
import { openWorkspaceTab, type FilesNavigationPayload, type FilesNavigationResult } from '@pkg/composables/useBrowserTabs';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import { DesktopFilesDataSource } from './files/DesktopFilesDataSource';
import FilesBrowser from './files/FilesBrowser.vue';
import type { FilesItem } from './files/types';

const props = defineProps<{ tabId: string; navigation?: FilesNavigationPayload }>();
const emit = defineEmits<{ 'navigation-consumed': []; 'navigation-result': [result:FilesNavigationResult] }>();
const dataSource = new DesktopFilesDataSource();
const bookmarkCreator = { create: (input: { kind: 'bookmark'; title: string; url: string }) => ipcRenderer.invoke('bookmarks:create', input) };

function openEditor(item:FilesItem, collectionId?:string):void {
  void openWorkspaceTab({ mode: 'paper', documentFile: { fileId: item.id, path: item.path, collectionId } })
    .catch(error => console.error('[FilesPage] Could not open document tab', error));
}
</script>
