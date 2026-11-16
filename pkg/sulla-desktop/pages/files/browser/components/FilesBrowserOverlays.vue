<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <Teleport to="body">
    <div v-if="quickLookEntry" ref="quickLookDialog" class="quick-look" role="dialog" aria-modal="true" :aria-label="`Quick Look: ${quickLookEntry.name}`" @click.self="closeQuickLook">
      <button class="quick-look-close" type="button" aria-label="Close Quick Look" @click="closeQuickLook" v-html="icons.close" />
      <button class="quick-look-nav previous" type="button" aria-label="Previous item" :disabled="quickLookIndex <= 0" @click="stepQuickLook(-1)">‹</button>
      <div class="quick-look-card">
        <div v-if="quickLookLoading" class="state-panel"><span class="loader" /><strong>Loading preview</strong></div>
        <img v-else-if="quickLookUrl && quickLookEntry.mime.startsWith('image/')" :src="quickLookUrl" :alt="quickLookEntry.name">
        <video v-else-if="quickLookUrl && quickLookEntry.mime.startsWith('video/')" :src="quickLookUrl" controls autoplay />
        <audio v-else-if="quickLookUrl && quickLookEntry.mime.startsWith('audio/')" :src="quickLookUrl" controls autoplay />
        <iframe v-else-if="quickLookUrl && quickLookEntry.mime === 'application/pdf'" :src="quickLookUrl" :title="quickLookEntry.name" sandbox="" />
        <div v-else class="quick-look-fallback"><span class="fi" :class="quickLookEntry.kindClass" v-html="quickLookEntry.icon" /><p v-if="quickLookError" role="alert">Preview could not load: {{ quickLookError }}</p><p v-else>Preview isn’t available for this item.</p></div>
        <footer><b>{{ quickLookEntry.name }}</b><span>{{ formatBytes(quickLookEntry.size) }} · {{ formatDate(quickLookEntry.updatedAt, true) }}</span></footer>
        <button v-if="supportsDocumentEditor(quickLookEntry.path)" class="btn sm quick-look-open" type="button" @click="openQuickLookSelection">Open</button>
      </div>
      <button class="quick-look-nav next" type="button" aria-label="Next item" :disabled="quickLookIndex >= quickLookEntries.length - 1" @click="stepQuickLook(1)">›</button>
    </div>
  </Teleport>
  <div v-if="marquee" class="marquee" :style="marqueeStyle" />
  <div v-if="draggedKeys.size > 1" class="drag-count" :style="{ left: `${dragPointer.x + 14}px`, top: `${dragPointer.y + 14}px` }">{{ draggedKeys.size }}</div>
  <div
    v-if="uploadProgress"
    class="upl"
  >
    <div class="hd">
      {{ uploadProgress.done ? 'Upload complete' : `Uploading ${uploadProgress.current} of ${uploadProgress.total}` }}<button
        class="btn ico"
        type="button"
        aria-label="Hide upload progress"
        @click="hideUploadProgress"
        v-html="icons.close"
      />
    </div>
    <div
      v-for="item in uploadItems"
      :key="item.name"
      class="it"
    >
      <span
        class="fi"
        :class="fileGlyph(mimeFromName(item.name), item.name).className"
        v-html="fileGlyph(mimeFromName(item.name), item.name).icon"
      /><div class="t">
        <b>{{ item.name }}</b><small>{{ item.done ? 'Done' : `${item.percent}% sent` }}</small><div
          v-if="!item.done"
          class="prog"
        >
          <i :style="{ width: `${item.percent}%` }" />
        </div>
      </div><span
        v-if="item.done"
        class="sync local"
        v-html="icons.syncLocal"
      />
    </div>
  </div>
  <dialog v-if="folderDetails" ref="folderDialog" class="folder-details" aria-labelledby="folder-details-title" @close="closeFolderDetails" @click="onFolderBackdrop">
    <h2 id="folder-details-title">{{ folderDetails.name }}</h2>
    <dl><dt>Type</dt><dd>Folder</dd><dt>Location</dt><dd>{{ folderDetails.path }}</dd><dt>Files</dt><dd>{{ folderDetails.childCount < 0 ? '…' : folderDetails.childCount }}</dd><dt>Size</dt><dd>{{ formatBytes(folderDetails.size) }}</dd><dt>Modified</dt><dd>{{ formatDate(folderDetails.updatedAt, true) }}</dd></dl>
    <p v-if="folderDetails.folderState?.needsDescription" class="folder-guidance-warning">Needs description</p>
    <label class="folder-guidance-field">Description<textarea v-model="folderDescription" :disabled="busy" maxlength="2000" placeholder="What belongs in this folder?" /></label>
    <label class="folder-guidance-field">Naming hint<input v-model="folderNamingHint" :disabled="busy" maxlength="500" placeholder="Example: project-YYYY-MM-DD.md" /></label>
    <button class="btn" type="button" @click="folderDialog?.close()">Close</button>
    <button v-if="dataSource.updateFolderDescription && folderDetails.folderState" class="btn" type="button" :disabled="busy || !folderDescription.trim()" @click="saveFolderGuidance">Save description</button>
    <button class="btn pri" type="button" @click="openPath(folderDetails.path); folderDialog?.close()">Open folder</button>
  </dialog>
  <dialog v-if="namePrompt" ref="nameDialog" class="folder-details name-prompt" aria-labelledby="name-prompt-title" @close="settleNamePrompt(null)" @click="onNameBackdrop">
    <form method="dialog" @submit.prevent="(namePrompt.allowEmpty || namePrompt.value.trim()) && settleNamePrompt(namePrompt.value)">
      <h2 id="name-prompt-title">{{ namePrompt.title }}</h2>
      <label class="folder-guidance-field">{{ namePrompt.label }}<input ref="nameInput" v-model="namePrompt.value" maxlength="255" spellcheck="false" autocomplete="off"></label>
      <button class="btn" type="button" @click="settleNamePrompt(null)">Cancel</button>
      <button class="btn pri" type="submit" :disabled="!namePrompt.allowEmpty && !namePrompt.value.trim()">{{ namePrompt.confirm }}</button>
    </form>
  </dialog>
  <ShareSheet v-if="shareTarget" :data-source="dataSource" :target="shareTarget" @close="closeShare" @updated="refresh(true)" />
  <dialog ref="cloudRestoreDialog" class="folder-details cloud-restore-dialog">
    <h2>Restore from Sulla Cloud</h2>
    <p>This creates a Files collection inside Sulla, where agents can read it through Files. It does not put files into Documents or any other Mac folder.</p>
    <p v-if="cloudRestoreError" class="error">{{ cloudRestoreError }}</p>
      <p v-if="!cloudCollections.length" class="muted">No unrestored Cloud collections were found.</p>
      <button v-else-if="dataSource.restoreAllCloudCollections" class="btn pri" type="button" :disabled="busy" @click="restoreCloudCollection('all')">Restore everything</button>
      <article v-for="collection in cloudCollections" :key="collection.collectionId" class="cloud-collection">
        <div><b>{{ collection.collectionId }}</b><small>{{ formatBytes(collection.bytes) }} · updated {{ timeAgo(collection.updatedAt) }}</small></div>
        <button class="btn pri" type="button" :disabled="busy" @click="restoreCloudCollection(collection)">Restore</button>
      </article>
    <button class="btn" type="button" @click="cloudRestoreDialog?.close()">Close</button>
  </dialog>
</template>

<script setup lang="ts">
// Everything layered over the browser: Quick Look, the marquee, the drag count, the upload tray and the dialogs.
import { computed } from 'vue';

import ShareSheet from '../../ShareSheet.vue';
import { supportsDocumentEditor } from '../../editor/editorTypes';
import { injectFilesBrowser } from '../useFilesBrowser';

const browser = injectFilesBrowser();
const { icons } = browser;
const dataSource = computed(() => browser.props.dataSource);
const { busy, shareTarget } = browser.state;
const { quickLookEntry, quickLookUrl, quickLookError, quickLookLoading, quickLookDialog, quickLookEntries, quickLookIndex, closeQuickLook, stepQuickLook, openQuickLookSelection } = browser.quickLook;
const { marquee, marqueeStyle } = browser.gestures;
const { draggedKeys, dragPointer } = browser.dragDrop;
const { uploadProgress, uploadItems, hideUploadProgress } = browser.uploads;
const { folderDetails, folderDialog, folderDescription, folderNamingHint, saveFolderGuidance, onFolderBackdrop, closeFolderDetails, cloudRestoreDialog, cloudCollections, cloudRestoreError, restoreCloudCollection } = browser.dialogs;
const { namePrompt, nameDialog, nameInput, settleNamePrompt, onNameBackdrop } = browser.creation;
const { closeShare } = browser.sharing;
const { openPath } = browser.navigation;
const { refresh } = browser.refresher;
const { formatBytes, formatDate, timeAgo, fileGlyph, mimeFromName } = browser.format;
</script>

<style scoped src="./FilesBrowser.css"></style>
