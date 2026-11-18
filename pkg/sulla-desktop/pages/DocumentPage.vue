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
    :initial-mode="documentFile.initialMode || 'preview'"
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
  <div v-else class="document-unavailable">
    {{ loadError || 'This file is no longer available' }}
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';

import { useBrowserTabs, type BrowserTab } from '@pkg/composables/useBrowserTabs';

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
const { createTab, tabs, updateTab } = useBrowserTabs();
const navigation = new HtmlNavigation();
let navigationInitialized=false;

async function load():Promise<void> {
  item.value = null;
  loadError.value = '';
  try {
    if (props.documentFile.collectionId) dataSource.selectCollection(props.documentFile.collectionId);
    const snapshot = await dataSource.load();
    item.value = await dataSource.resolveFile(props.documentFile, snapshot.files);
    if (!item.value) return;
    if(!navigationInitialized){navigation.push(item.value.path);navigationInitialized=true;}
    updateTab(props.tabId, {
      title: item.value.path.split('/').at(-1) || 'Paper',
      documentFile: { fileId: item.value.id, path: item.value.path, collectionId: snapshot.collection.id },
    });
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : 'This file is no longer available';
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

watch(() => `${ props.documentFile.collectionId ?? '' }|${ props.documentFile.fileId }`, load);
onMounted(load);
</script>

<style scoped>
.document-unavailable { display:grid;place-items:center;height:100%;color:var(--text-muted);font:14px var(--font-body); }
.document-notice { position:fixed;z-index:20;right:20px;bottom:20px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface-1);color:var(--text);font:13px var(--font-body); }
.document-notice button { margin-left:8px;border:0;background:transparent;color:inherit;cursor:pointer; }
</style>
