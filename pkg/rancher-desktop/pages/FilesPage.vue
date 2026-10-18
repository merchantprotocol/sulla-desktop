<template>
  <FilesBrowser
    :data-source="dataSource"
    :tab-id="props.tabId"
    :navigation="props.navigation"
    @navigation-consumed="emit('navigation-consumed')"
  />
</template>

<script setup lang="ts">
import { DesktopFilesDataSource } from './files/DesktopFilesDataSource';
import FilesBrowser from './files/FilesBrowser.vue';

import type { FilesNavigationPayload } from '@pkg/composables/useBrowserTabs';

const props = defineProps<{ tabId: string; navigation?: FilesNavigationPayload }>();
const emit = defineEmits<{ 'navigation-consumed': [] }>();
const dataSource = new DesktopFilesDataSource();
</script>
