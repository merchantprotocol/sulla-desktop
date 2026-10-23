<template>
  <DocumentEditorShell
    v-if="activeEditor"
    :key="activeEditor.id"
    :data-source="dataSource"
    :item="activeEditor"
    :files="openEditors"
    @back="activeEditor = null"
    @select="activeEditor = $event"
    @saved="updateEditor"
  />
  <FilesBrowser
    v-else
    :data-source="dataSource"
    :tab-id="props.tabId"
    :navigation="props.navigation"
    @navigation-consumed="emit('navigation-consumed')"
    @open-editor="openEditor"
  />
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { DesktopFilesDataSource } from './files/DesktopFilesDataSource';
import DocumentEditorShell from './files/editor/DocumentEditorShell.vue';
import { supportsDocumentEditor } from './files/editor/editorTypes';
import FilesBrowser from './files/FilesBrowser.vue';
import type { FilesItem } from './files/types';
import type { FilesNavigationPayload } from '@pkg/composables/useBrowserTabs';

const props = defineProps<{ tabId: string; navigation?: FilesNavigationPayload }>();
const emit = defineEmits<{ 'navigation-consumed': [] }>();
const dataSource = new DesktopFilesDataSource();
const openEditors=ref<FilesItem[]>([]);
const activeEditor=ref<FilesItem|null>(null);
function openEditor(item:FilesItem){ if(!openEditors.value.some(file=>file.id===item.id))openEditors.value.push(item); activeEditor.value=item }
function updateEditor(item:FilesItem){ const index=openEditors.value.findIndex(file=>file.id===item.id);if(index>=0)openEditors.value[index]=item;activeEditor.value=item }
watch(() => props.navigation, async detail => {
  if (!detail || (detail.section && !detail.openEditor)) return;
  try {
    const snapshot = await dataSource.load();
    if (props.navigation !== detail) return;
    const file = snapshot.files.find(item => item.id === detail.fileId) ?? snapshot.files.find(item => item.path === detail.path);
    if (file && supportsDocumentEditor(file.path)) { openEditor(file); emit('navigation-consumed'); return }
  } catch { /* Let FilesBrowser show its normal load error. */ }
  if (activeEditor.value) activeEditor.value = null;
}, { immediate: true });
</script>
