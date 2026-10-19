<template><FilesBrowser tab-id="synthetic-files-preview" :data-source="dataSource" :navigation="navigation" /></template>

<script setup lang="ts">
import FilesBrowser from './FilesBrowser.vue';
import { SyntheticFilesDataSource } from './SyntheticFilesDataSource';

const dataSource = new SyntheticFilesDataSource();
const query = new URLSearchParams(window.location.search || window.location.hash.split('?')[1] || '');
const navigation = { section: query.get('section') || 'detail', fileId: query.get('fileId') || 'synthetic-video' };
</script>
