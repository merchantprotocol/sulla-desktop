<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <template v-if="item">
  <DocumentEditorShell
    :data-source="dataSource"
    :collection-id="documentFile.collectionId"
    :item="item"
    :files="[item]"
    @back="backToFiles"
    @navigate="navigateFile"
    @open-external="openExternal"
    :can-back="navigation.canBack"
    :can-forward="navigation.canForward"
    @navigate-history="navigateHistory"
    @saved="onSaved"
  />
  <div v-if="notice" class="document-notice" role="alert" @click="clearNotice">{{ notice }} <button type="button" aria-label="Dismiss notice" @click.stop="clearNotice">×</button></div>
  </template>
  <div v-else-if="waiting" class="document-unavailable" role="status">
    {{ waiting === 'connecting' ? 'Connecting to Files…' : 'Opening document…' }}
  </div>
  <div v-else class="document-unavailable">
    <span>{{ loadError || 'This file is no longer available' }}</span>
    <button v-if="retryable" type="button" class="document-retry" @click="load()">Retry</button>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useBrowserTabs, type BrowserTab } from '@pkg/composables/useBrowserTabs';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import { filesItem, type FilesApiFile } from '../../../services/sulla-files/web-src/filesApiModels';
import { DesktopFilesDataSource } from './files/DesktopFilesDataSource';
import DocumentEditorShell from './files/editor/DocumentEditorShell.vue';
import type { FilesItem } from './files/types';
import { HtmlNavigation } from './files/editor/htmlNavigation';

const props = defineProps<{ tabId: string; documentFile: NonNullable<BrowserTab['documentFile']> }>();
const dataSource = new DesktopFilesDataSource();
const item = ref<FilesItem | null>(null);
const loadError = ref('');
const notice = ref('');
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const waiting = ref<'' | 'opening' | 'connecting'>('');
const retryable = ref(false);
const { createTab, tabs, updateTab } = useBrowserTabs();
const navigation = new HtmlNavigation();
let navigationInitialized=false;

let loadGeneration = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * A restored tab can mount before Files has unlocked. These readiness errors clear on their own,
 * so the read is retried a bounded number of times; permission and not-found errors are final.
 */
const FILES_STARTING = /Files is shutting down|Files is locked with the application|No Files collection is available yet/;
const STARTUP_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
const filesStarting = (error:unknown):boolean => error instanceof Error && FILES_STARTING.test(error.message);

function cancelRetry():void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
}

/**
 * The listing only covers one folder, so a nested document is resolved by its exact id.
 * It must still belong to the loaded collection and not be deleted; no path guess is made.
 */
async function exactDocument(fileId:string, collectionId:string):Promise<FilesItem | null> {
  const record = await (ipcRenderer.invoke('sulla-files:metadata', { fileId }) as Promise<FilesApiFile & { collection_id?:string; collectionId?:string }>)
    .catch((error) => { if (filesStarting(error)) throw error; return null });
  if (!record || record.id !== fileId || (record.collection_id ?? record.collectionId) !== collectionId) return null;
  const found = filesItem(record);
  return found.deletedAt ? null : found;
}

async function load(attempt = 0):Promise<void> {
  // A newer document switch owns the page; an older load never paints over it.
  const generation = ++loadGeneration;
  cancelRetry();
  const target = { ...props.documentFile };
  item.value = null;
  loadError.value = '';
  retryable.value = false;
  if (attempt === 0) waiting.value = 'opening';
  try {
    if (target.collectionId) dataSource.selectCollection(target.collectionId);
    const snapshot = await dataSource.load();
    if (generation !== loadGeneration) return;
    // Fail closed if the saved collection is not the one that loaded.
    if (target.collectionId && snapshot.collection.id !== target.collectionId) { waiting.value = ''; return }
    const found = snapshot.files.find(file => file.id === target.fileId && !file.deletedAt) ??
      await exactDocument(target.fileId, snapshot.collection.id);
    if (generation !== loadGeneration) return;
    waiting.value = '';
    if (!found) return;
    item.value = found;
    if (!navigationInitialized) {
      navigation.push(found.path);
      navigationInitialized = true;
    }
    updateTab(props.tabId, {
      title: found.path.split('/').at(-1) || 'Paper',
      documentFile: { fileId: found.id, path: found.path, collectionId: snapshot.collection.id },
    });
  } catch (error) {
    if (generation !== loadGeneration) return;
    if (filesStarting(error) && attempt < STARTUP_RETRY_DELAYS_MS.length) {
      waiting.value = 'connecting';
      retryTimer = setTimeout(() => { retryTimer = undefined; void load(attempt + 1) }, STARTUP_RETRY_DELAYS_MS[attempt]);
      return;
    }
    waiting.value = '';
    retryable.value = filesStarting(error);
    loadError.value = retryable.value
      ? 'Files is still starting. Try again once it is ready.'
      : error instanceof Error ? error.message : 'This file is no longer available';
  }
}

async function navigateFile(href:string):Promise<void>{
  const current=item.value;
  const path=current&&navigation.resolve(current.path,href);
  if(!path)return;
  try{
    const target=await dataSource.resolveFile({path});
    if(!target){showNotice(`File not found: ${path}`);return;}
    navigation.push(target.path);item.value=target;loadError.value='';
    updateTab(props.tabId,{title:target.path.split('/').at(-1)||'Paper',documentFile:{...props.documentFile,fileId:target.id,path:target.path}});
  }catch(error){showNotice(error instanceof Error?error.message:`File not found: ${path}`);}
}

async function navigateHistory(direction:'back'|'forward'):Promise<void>{
  const path=direction==='back'?navigation.back():navigation.forward();
  if(path)await openPath(path);
}

async function openPath(path:string):Promise<void>{
  try{
    const target=await dataSource.resolveFile({path});
    if(!target){showNotice(`File not found: ${path}`);return;}
    item.value=target;loadError.value='';clearNotice();
    updateTab(props.tabId,{title:target.path.split('/').at(-1)||'Paper',documentFile:{...props.documentFile,fileId:target.id,path:target.path}});
  }catch(error){showNotice(error instanceof Error?error.message:`File not found: ${path}`);}
}

function showNotice(message:string):void{notice.value=message;clearTimeout(noticeTimer);noticeTimer=setTimeout(clearNotice,5000);}
function clearNotice():void{notice.value='';clearTimeout(noticeTimer);}

function openExternal(url:string):void{
  if(!/^https?:\/\//i.test(url))return;
  const tab=createTab(url,{mode:'browser',title:url});
  window.dispatchEvent(new CustomEvent('sulla:navigate-tab',{detail:{tabId:tab.id}}));
}

function backToFiles():void {
  const slash = props.documentFile.path.lastIndexOf('/');
  const filesNavigation = {
    path: slash < 0 ? '' : props.documentFile.path.slice(0, slash),
    section: 'files',
    collectionId: props.documentFile.collectionId,
  };
  const existing = tabs.find(tab => tab.mode === 'files');
  const tab = existing ?? createTab('about:blank', { mode: 'files', title: 'File Manager', filesNavigation });
  if (existing) updateTab(existing.id, { filesNavigation });
  window.dispatchEvent(new CustomEvent('sulla:navigate-tab', { detail: { tabId: tab.id } }));
}

function onSaved(saved:FilesItem):void {
  item.value = saved;
  updateTab(props.tabId, {
    title: saved.path.split('/').at(-1) || 'Paper',
    documentFile: { ...props.documentFile, fileId: saved.id, path: saved.path },
  });
}

watch(() => `${ props.documentFile.collectionId ?? '' }|${ props.documentFile.fileId }`, () => load());
onMounted(() => load());
onBeforeUnmount(() => { loadGeneration++; cancelRetry() });
</script>

<style scoped>
.document-unavailable { display:grid;place-content:center;justify-items:center;gap:12px;height:100%;color:var(--text-muted);font:14px var(--font-body); }
.document-retry { padding:6px 14px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text);font:inherit;cursor:pointer; }
.document-notice { position:fixed;z-index:20;right:20px;bottom:20px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface-1);color:var(--text);font:13px var(--font-body); }
.document-notice button { margin-left:8px;border:0;background:transparent;color:inherit;cursor:pointer; }
</style>
