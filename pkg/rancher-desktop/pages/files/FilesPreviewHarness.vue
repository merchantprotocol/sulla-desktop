<template><FilesBrowser tab-id="synthetic-files-preview" :data-source="dataSource" :navigation="navigation" /></template>

<script setup lang="ts">
import FilesBrowser from './FilesBrowser.vue';
import { SyntheticFilesDataSource } from './SyntheticFilesDataSource';

const dataSource = new SyntheticFilesDataSource();
const navigation = { section: new URLSearchParams(window.location.search).get('section') || 'shared-by-me' };
</script>
