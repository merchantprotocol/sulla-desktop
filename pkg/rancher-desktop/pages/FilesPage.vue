<template>
  <FilesBrowser :data-source="dataSource" />
</template>

<script setup lang="ts">
import { DesktopFilesDataSource } from './files/DesktopFilesDataSource';
import FilesBrowser from './files/FilesBrowser.vue';

const dataSource = new DesktopFilesDataSource();
</script>
