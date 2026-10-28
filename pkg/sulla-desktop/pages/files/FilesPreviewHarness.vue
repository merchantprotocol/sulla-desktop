<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <DocumentEditorShell v-if="activeEditor" :key="activeEditor.id" :data-source="dataSource" :item="activeEditor" :files="openEditors" @back="activeEditor=null" @select="activeEditor=$event" @saved="updateEditor" />
  <FilesBrowser v-else tab-id="synthetic-files-preview" :data-source="dataSource" :navigation="navigation" @navigation-consumed="navigation = undefined" @open-editor="openEditor" />
</template>

<script setup lang="ts">
import { ref } from 'vue';
import DocumentEditorShell from './editor/DocumentEditorShell.vue';
import FilesBrowser from './FilesBrowser.vue';
import { SyntheticFilesDataSource } from './SyntheticFilesDataSource';
import type { FilesItem } from './types';
const dataSource = new SyntheticFilesDataSource();
const query = new URLSearchParams(window.location.search || window.location.hash.split('?')[1] || '');
const navigation = ref<{ section:string; fileId:string } | undefined>(query.has('fileId') ? { section: query.get('section') || 'detail', fileId: query.get('fileId')! } : undefined);
const openEditors=ref<FilesItem[]>([]);const activeEditor=ref<FilesItem|null>(null);
function openEditor(item:FilesItem){if(!openEditors.value.some(file=>file.id===item.id))openEditors.value.push(item);activeEditor.value=item}
function updateEditor(item:FilesItem){const index=openEditors.value.findIndex(file=>file.id===item.id);if(index>=0)openEditors.value[index]=item;activeEditor.value=item}
</script>
