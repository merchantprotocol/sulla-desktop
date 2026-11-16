<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="toolbar">
    <div v-if="section === 'files' && !readOnlyArea" class="history-controls">
      <button
        v-if="canCreateAnything"
        ref="newMenuButton"
        class="btn pri new-btn"
        type="button"
        aria-haspopup="menu"
        :aria-expanded="Boolean(newMenu)"
        :disabled="busy || loading"
        @click="toggleNewMenu"
      ><span class="bi" v-html="icons.plus" /> New</button>
      <div class="nav-pair" role="group" aria-label="History">
        <button
          class="folder-up"
          type="button"
          aria-label="Back"
          title="Back"
          :disabled="busy || loading || !canGoBack"
          @click="goBack"
        ><span v-html="icons.arrowLeft" /></button>
        <button
          class="folder-up"
          type="button"
          aria-label="Forward"
          title="Forward"
          :disabled="busy || loading || !canGoForward"
          @click="goForward"
        ><span v-html="icons.chevronRight" /></button>
      </div>
      <button
        v-if="currentPath"
        class="folder-up parent-up"
        type="button"
        :aria-label="`Up to ${parentFolderLabel}`"
        :title="`Up to ${parentFolderLabel}`"
        :disabled="busy || loading"
        :data-drop-path="parentPath"
        @dragover.prevent="onNavigationDragOver(parentPath, $event)"
        @drop.prevent="onNavigationDrop(parentPath, $event)"
        @click="openParent"
      >
        <span v-html="icons.arrowUp" />
      </button><h1>{{ pageTitle }}</h1><span class="meta">{{ summaryText }}</span>
    </div><h1 v-else>{{ pageTitle }}</h1><span v-if="section !== 'files'" class="meta">{{ summaryText }}</span>
    <div class="right">
      <button
        v-if="snapshot?.collection.memberCount !== undefined"
        class="btn sm ghost"
        type="button"
        :disabled="!dataSource.capabilities.orgSharing"
        title="Share this folder with an organization member"
        @click="shareCurrentFolder"
      >
        <span
          class="bi"
          v-html="icons.users"
        /> Shared with {{ snapshot.collection.memberCount }}
      </button>
      <button
        class="btn sm"
        type="button"
        :disabled="!dataSource.capabilities.publicLinks || !selectedFileForShare"
        title="Copy a public Sulla Cloud link for the selected file"
        @click="shareSelectedFile"
      >
        <span
          class="bi"
          v-html="icons.share"
        /> Share
      </button>
    </div>
  </div>
  <div v-if="query.trim() && searchCoverage && !searchCoverage.complete" class="operation-error" role="status">
    Search coverage is incomplete: {{ searchCoverage.pending + searchCoverage.indexing }} file{{ searchCoverage.pending + searchCoverage.indexing === 1 ? '' : 's' }} still processing, {{ searchCoverage.partial }} partially indexed, {{ searchCoverage.unsupported }} unsupported, and {{ searchCoverage.failed }} failed. Partial files can still match within the extracted portion; unsupported and failed files cannot contribute content matches.
  </div>
  <div v-for="source in nativeSources.filter(item => item.state !== 'active')" :key="source.fileId" class="operation-error" role="status">
    {{ source.name }} needs native access restored. {{ source.lastError || '' }}
    <button class="btn sm" type="button" :disabled="busy || !dataSource.recoverNativeSource" @click="recoverNativeSource(source.fileId)">Reselect file</button>
  </div>

  <div class="filters">
    <label
      v-for="filter in filters"
      :key="filter.key"
      class="sel"
      :class="{ active: activeFilters[filter.key] }"
    ><span>{{ filter.label }}</span> {{ activeFilters[filter.key] || filter.any }}<select
      v-model="activeFilters[filter.key]"
      :aria-label="filter.label"
    ><option value="">{{ filter.any }}</option><option
      v-for="option in filter.options"
      :key="option"
      :value="option"
    >{{ option }}</option></select></label>
    <button
      class="clear"
      type="button"
      @click="clearFilters"
    >
      Clear
    </button>
    <span
      v-if="section === 'trash'"
      class="pill idle"
    >{{ retentionLabel }}</span>
    <button v-if="section === 'trash'" class="btn sm danger" type="button" :disabled="busy || !canEmptyTrash || !trashItems.length" @click="emptyTrash">Empty Trash</button>
    <div class="view">
      <label class="sel"><span>Sort</span> {{ sortLabel }}<select
        v-model="sort"
        aria-label="Sort"
        @change="saveFolderPreferences"
      ><option value="name">Name</option><option value="modified">Modified</option><option value="size">Size</option><option value="type">Type</option></select></label>
      <div
        class="seg"
        role="group"
        aria-label="View"
      >
        <button
          type="button"
          :class="{ on: view === 'list' }"
          @click="setView('list')"
        >
          <span
            class="bi"
            v-html="icons.list"
          /> List
        </button><button
          type="button"
          :class="{ on: view === 'grid' }"
          @click="setView('grid')"
        >
          <span
            class="bi"
            v-html="icons.grid"
          /> Grid
        </button>
      </div>
    </div>
  </div>

  <div class="selection-slot" :class="{ active: selectedEntries.length }" :aria-hidden="!selectedEntries.length"><div v-show="selectedEntries.length" class="selection-bar">
    <b>{{ selectedEntries.length }} selected</b>
    <template v-if="section !== 'trash' && !readOnlyArea">
      <button class="btn sm" type="button" :disabled="busy || selectedEntries.length !== 1" @click="renameSelected">Rename</button>
      <button class="btn sm" type="button" :disabled="busy" @click="moveSelected">Move</button>
      <button class="btn sm" type="button" :disabled="busy" @click="copyToClipboard('copy')">Copy</button>
      <button class="btn sm" type="button" :disabled="busy" @click="copyToClipboard('cut')">Cut</button>
      <button class="btn sm" type="button" :disabled="busy || !canPaste" @click="pasteClipboard">Paste</button>
    </template>
    <button class="btn sm" type="button" :disabled="busy || selectedEntries.every(entry => entry.folder)" @click="downloadSelected">Download</button>
    <template v-if="section === 'trash'"><button class="btn sm" type="button" :disabled="busy || !dataSource.restoreTrashItem" @click="restoreSelected">Restore</button><button class="btn sm danger" type="button" :disabled="busy || !dataSource.purgeTrashItem" @click="purgeSelected">Delete permanently</button></template><button v-else class="btn sm danger" type="button" :disabled="busy" @click="trashSelected">Move to Trash</button>
  </div>
  </div>
  <div v-if="operationError" class="operation-error" role="alert">
    {{ operationError }} <button class="btn sm ghost" type="button" @click="dismissOperationError">Dismiss</button>
  </div>
  <div v-if="crossCollectionClipboardMessage" class="operation-panel" role="status">{{ crossCollectionClipboardMessage }}</div>
  <div v-if="operationNotice" class="operation-panel" role="status">{{ operationNotice }}</div>
  <div v-if="queueError" class="operation-error" role="alert">{{ queueError }} <button class="btn sm" :disabled="busy" @click="recoverOperation">Check operation</button></div>
  <div v-if="operationReceipt" class="operation-panel operation-queue" aria-label="File operations">
    <div>
      <label>Recent operations <select :value="operationReceipt.operationId" :disabled="busy" @change="showOperation(($event.target as HTMLSelectElement).value)"><option v-for="receipt in operationHistory" :key="receipt.operationId" :value="receipt.operationId">{{ receipt.items[0]?.action }} · {{ receipt.items.length }} items · {{ receipt.state }}</option></select></label>
      <b>Operation {{ operationReceipt.state }}</b>
      <span>{{ operationReceipt.items.filter(item => item.state === 'completed').length }} completed · {{ operationReceipt.items.filter(item => item.state === 'skipped').length }} skipped · {{ operationReceipt.items.filter(item => item.state === 'failed').length }} failed</span>
      <progress :value="operationReceipt.items.filter(item => item.state !== 'pending').length" :max="operationReceipt.items.length" aria-label="Items resolved" />
      <ul><li v-for="item in operationReceipt.items" :key="item.itemId">
        <span>{{ item.after?.path || item.before?.path || item.action }} — {{ item.state }}<template v-if="item.error">: {{ item.error.message }}</template></span>
        <button v-if="item.retryable && item.error?.code !== 'destination-conflict' && dataSource.retryOperation" class="btn sm" :disabled="busy" @click="retryReceipt(item.itemId)">Retry item</button>
      </li></ul>
    </div>
    <button v-if="operationReceipt.state === 'pending' && dataSource.cancelOperation" class="btn sm" :disabled="operationReceipt.cancelRequested" @click="cancelOperation(operationReceipt.operationId)">{{ operationReceipt.cancelRequested ? 'Cancellation requested' : 'Cancel remaining' }}</button>
    <button v-if="operationReceipt.retryable && dataSource.retryOperation" class="btn sm" :disabled="busy" @click="retryReceipt()">Retry remaining</button>
    <button v-if="undoReceipt && dataSource.undoOperation" class="btn sm" :disabled="!canUndo" @click="undoLastOperation">Undo</button>
  </div>
  <div v-if="collisionItem && dataSource.retryOperation" class="operation-panel collision-panel" role="dialog" aria-label="File name conflict">
    <div><b>A destination already exists</b><span>{{ collisionItem.error?.destination?.path || collisionItem.error?.message }}</span></div>
    <label><input v-model="applyCollisionToAll" type="checkbox">Apply to all current conflicts</label>
    <button class="btn sm" :disabled="busy" @click="resolveCollision('keep-both')">Keep Both</button>
    <button class="btn sm" :disabled="busy" @click="resolveCollision('skip')">Skip</button>
    <button class="btn sm danger" :disabled="busy || !canReplaceCollision" @click="resolveCollision('replace')">Replace</button>
  </div>
  <div v-if="busy && !operationReceipt" class="operation-panel" role="status">Working…</div>
</template>

<script setup lang="ts">
// Above the listing: New, history, title, sharing, filters, sort/view, the selection bar and the operations tray.
import { computed } from 'vue';

import { injectFilesBrowser } from '../useFilesBrowser';

const browser = injectFilesBrowser();
const { icons } = browser;
const dataSource = computed(() => browser.props.dataSource);
const { snapshot, section, currentPath, query, busy, loading, searchCoverage, nativeSources, activeFilters, operationError, operationNotice, dismissOperationError } = browser.state;
const { readOnlyArea, canCreateAnything, pageTitle, parentPath, parentFolderLabel, canEmptyTrash, trashItems } = browser.location;
const { retentionLabel } = browser.sidebar;
const { summaryText, filters, clearFilters } = browser.listing;
const { sort, view, sortLabel, saveFolderPreferences, setView } = browser.preferences;
const { canGoBack, canGoForward } = browser.explorer;
const { error: queueError } = browser.operations;
const { newMenu, newMenuButton, toggleNewMenu } = browser.creation;
const { selectedEntries, selectedFileForShare } = browser.selection;
const { canPaste, crossCollectionClipboardMessage, copyToClipboard, pasteClipboard, moveSelected, downloadSelected, trashSelected } = browser.fileOperations;
const { renameSelected } = browser.rename;
const { restoreSelected, purgeSelected, emptyTrash } = browser.trash;
const { operationHistory, operationReceipt, undoReceipt, collisionItem, applyCollisionToAll, canReplaceCollision, canUndo, retryReceipt, resolveCollision, recoverOperation, showOperation, undoLastOperation, cancelOperation } = browser.receipts;
const { onNavigationDragOver, onNavigationDrop } = browser.dropZones;
const { goBack, goForward, openParent } = browser.navigation;
const { shareCurrentFolder, shareSelectedFile } = browser.sharing;
const { recoverNativeSource } = browser.itemActions;
</script>

<style scoped src="./FilesBrowser.css"></style>
