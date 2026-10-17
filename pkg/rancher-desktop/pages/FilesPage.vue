<template>
  <FilesBrowser :data-source="dataSource" :tab-id="props.tabId" />
</template>

<script setup lang="ts">
import { DesktopFilesDataSource } from './files/DesktopFilesDataSource';
import FilesBrowser from './files/FilesBrowser.vue';

const props = defineProps<{ tabId:string }>();
const dataSource = new DesktopFilesDataSource();
</script>
