<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <FilesBrowser
    :data-source="dataSource"
    :tab-id="props.tabId"
    :navigation="props.navigation"
    @navigation-consumed="emit('navigation-consumed')"
    @open-editor="openEditor"
  >
    <template #cloud-vault><VaultPage modal restore-files /></template>
  </FilesBrowser>
</template>

<script setup lang="ts">
import { openDocumentTab, type FilesNavigationPayload } from '@pkg/composables/useBrowserTabs';

import VaultPage from './VaultPage.vue';
import { DesktopFilesDataSource } from './files/DesktopFilesDataSource';
import FilesBrowser from './files/FilesBrowser.vue';
import type { FilesItem } from './files/types';

const props = defineProps<{ tabId: string; navigation?: FilesNavigationPayload }>();
const emit = defineEmits<{ 'navigation-consumed': [] }>();
const dataSource = new DesktopFilesDataSource();

function openEditor(item:FilesItem, collectionId?:string):void {
  openDocumentTab({ fileId: item.id, path: item.path, collectionId });
}
</script>
