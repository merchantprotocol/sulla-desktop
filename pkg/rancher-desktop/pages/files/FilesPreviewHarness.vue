<template><FilesBrowser tab-id="synthetic-files-preview" :data-source="dataSource" :navigation="navigation" /></template>

<script setup lang="ts">
import { useRoute } from 'vue-router';

import FilesBrowser from './FilesBrowser.vue';
import { SyntheticFilesDataSource } from './SyntheticFilesDataSource';

const dataSource = new SyntheticFilesDataSource();
const route = useRoute();
const navigation = { section: typeof route.query.section === 'string' ? route.query.section : 'shared-by-me' };
</script>
