<template><FilesBrowser tab-id="synthetic-files-preview" :data-source="dataSource" :navigation="navigation" @navigation-consumed="navigation = undefined" /></template>

<script setup lang="ts">
import { ref } from 'vue';

import FilesBrowser from './FilesBrowser.vue';
import { SyntheticFilesDataSource } from './SyntheticFilesDataSource';

const dataSource = new SyntheticFilesDataSource();
const query = new URLSearchParams(window.location.search || window.location.hash.split('?')[1] || '');
const navigation = ref<{ section:string; fileId:string } | undefined>(query.has('fileId') ? { section: query.get('section') || 'detail', fileId: query.get('fileId')! } : undefined);
</script>
