<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div
    ref="browserSurface"
    class="files-browser"
    @dragenter.prevent="onBrowserDragEnter"
    @dragover.prevent="onBrowserDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <FilesBrowserSidebar />
    <div v-if="navigationError" class="navigation-error" role="alert">
      {{ navigationError }}
      <button class="btn sm ghost" type="button" @click="navigationError = ''">Dismiss</button>
    </div>

    <main
      v-if="!selected"
      ref="mainSurface"
      class="main"
      tabindex="-1"
      @auxclick="onMouseNavigation"
      @contextmenu.self.prevent="openBackgroundActions"
    >
      <FilesBrowserTopBar />

      <div v-if="section === 'sharedByMe'" class="content">
        <SharedByMe :data-source="dataSource" />
      </div>
      <div v-else class="content" @contextmenu="onSurfaceContextMenu" @click.self="clearSelection">
        <FilesBrowserToolbar />

        <div
          v-if="loading"
          class="state-panel"
        >
          <span class="loader" /><strong>Loading your files</strong><p>Reading the synced index from the Files service.</p>
        </div>
        <div
          v-else-if="error"
          class="state-panel error-state"
        >
          <span
            class="state-icon"
            v-html="icons.alert"
          /><strong>Files service isn’t available</strong>
          <p>{{ error }}</p><div>
            <button
              class="btn pri"
              type="button"
              @click="refresh()"
            >
              Try again
            </button><button
              v-if="dataSource.capabilities.upload"
              class="btn"
              type="button"
              @click="upload"
            >
              Choose files
            </button>
          </div>
        </div>
        <div
          v-else-if="visibleEntries.length === 0"
          class="state-panel"
          @click.self="clearSelection"
        >
          <span
            class="state-icon"
            v-html="section === 'trash' ? icons.trash : icons.folderLine"
          />
          <strong>{{ emptyTitle }}</strong><p>{{ emptyCopy }}</p>
          <button
            v-if="section === 'files' && !readOnlyArea"
            class="btn pri"
            type="button"
            @click="upload"
          >
            Choose files
          </button>
        </div>

        <FilesBrowserEntries v-else />
        <FilesBrowserMenus />
      </div>
    </main>

    <FileDetail
      v-else-if="snapshot"
      :key="`${selected.id}:${selected.currentVersionId}:${detailVersion?.id ?? ''}`"
      :item="selected"
      :view-version="detailVersion"
      :trash-item="selected.trashItem?.kind === 'file' ? selected.trashItem : undefined"
      :collection="snapshot.collection"
      :data-source="dataSource"
      :initial-tab="detailTab === 'versions' ? 'Versions' : 'Details'"
      @close="closeDetail"
      @open="openDetail"
      @share="shareEntry(selected)"
      @restored="onDetailRestored"
      @trash-outcome="onTrashDetailOutcome"
      @open-linked="openLinked"
    />

    <FilesBrowserOverlays />
  </div>
</template>

<script setup lang="ts">
// The Files screen. A thin shell: FilesBrowserController (browser/) owns the state and behaviour, and the
// regions render in browser/components/. Props and emits are this component's public API; keep them stable.
import { computed } from 'vue';

import FileDetail from './FileDetail.vue';
import SharedByMe from './SharedByMe.vue';
import FilesBrowserEntries from './browser/components/FilesBrowserEntries.vue';
import FilesBrowserMenus from './browser/components/FilesBrowserMenus.vue';
import FilesBrowserOverlays from './browser/components/FilesBrowserOverlays.vue';
import FilesBrowserSidebar from './browser/components/FilesBrowserSidebar.vue';
import FilesBrowserToolbar from './browser/components/FilesBrowserToolbar.vue';
import FilesBrowserTopBar from './browser/components/FilesBrowserTopBar.vue';
import { useFilesBrowser } from './browser/useFilesBrowser';

import type { FilesNavigationPayload } from '@pkg/composables/useBrowserTabs';

import type { FilesDataSource, FilesItem } from './types';

const props = defineProps<{ dataSource: FilesDataSource; tabId: string; navigation?: FilesNavigationPayload }>();
const emit = defineEmits<{ 'navigation-consumed': []; 'open-editor': [item:FilesItem, collectionId?:string] }>();
const browser = useFilesBrowser(props, emit);
const { icons } = browser;
const dataSource = computed(() => props.dataSource);
const { snapshot, loading, error, section, selected, detailTab, detailVersion, navigationError, browserSurface, mainSurface } = browser.state;
const { readOnlyArea, emptyTitle, emptyCopy } = browser.location;
const { visibleEntries } = browser.listing;
const { refresh } = browser.refresher;
const { upload } = browser.creation;
const { clearSelection } = browser.selection;
const { onBrowserDragEnter, onBrowserDragOver, onDragLeave, onDrop } = browser.dragDrop;
const { onMouseNavigation, closeDetail, onDetailRestored, openDetail, openLinked } = browser.navigation;
const { openBackgroundActions, onSurfaceContextMenu } = browser.menus;
const { shareEntry } = browser.sharing;
const { onTrashDetailOutcome } = browser.trash;
</script>

<style scoped>
.navigation-error{position:absolute;z-index:45;top:8px;right:16px;max-width:calc(100% - 32px);padding:8px 12px;border:1px solid var(--border-default);border-radius:8px;background:var(--bg-surface);color:var(--status-error)}
</style>
<style scoped src="./browser/components/FilesBrowser.css"></style>
