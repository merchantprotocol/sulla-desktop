<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <Teleport to="body">
    <div v-if="actionTarget" ref="actionMenu" class="action-menu" role="menu" :aria-label="`Actions for ${actionTarget.name}`" :style="{ left: `${menuPosition.x}px`, top: `${menuPosition.y}px` }" @keydown="onMenuKeydown" @contextmenu.prevent @click.stop @dblclick.stop>
      <b>{{ actionTarget.name }}</b>
      <template v-if="section !== 'trash' && actionTarget.folder">
        <button role="menuitem" type="button" @click="runTargetAction('open')">Open folder</button>
        <template v-if="!readOnlyArea && section === 'files'">
          <button v-if="dataSource.capabilities.upload || dataSource.capabilities.durableOperations" role="menuitem" type="button" :disabled="busy" @click="runTargetAction('new-folder')">New folder inside</button>
          <button v-if="dataSource.createFile" role="menuitem" type="button" :disabled="busy" @click="runTargetAction('new-file')">New file inside</button>
        </template>
      </template>
      <template v-else-if="section !== 'trash'">
        <button role="menuitem" type="button" @click="runTargetAction('open-sulla')">Open in Sulla</button>
        <button role="menuitem" type="button" @click="runTargetAction('native-open')">Open with default app</button>
        <div v-if="recentApplications.length" class="menu-subsection"><small>Open with</small><button v-for="application in recentApplications" :key="application" role="menuitem" type="button" @click="openWithApplication(application)">{{ application.split('/').at(-1)?.replace(/\.app$/, '') }}</button></div>
        <button role="menuitem" type="button" @click="openWithApplication()">Open with…</button>
      </template>
      <div class="menu-sep" role="separator" />
      <button v-if="section !== 'trash' && !actionTarget.folder && dataSource.capabilities.nativeReveal && dataSource.revealFile" role="menuitem" type="button" @click="runTargetAction('reveal')">Reveal in folder</button>
      <button v-if="section !== 'trash' && !actionTarget.folder" role="menuitem" type="button" @click="runTargetAction('reference')">Copy file reference</button>
      <button v-if="section !== 'trash' && !actionTarget.folder && browser.state.props.bookmarkCreator" role="menuitem" type="button" @click="runTargetAction('add-bookmark')">Add to Bookmarks</button>
      <button v-if="section !== 'trash' || !actionTarget.folder" role="menuitem" type="button" @click="runTargetAction('details')">Details</button>
      <button v-if="section !== 'trash' && canShareEntry(actionTarget)" role="menuitem" type="button" @click="runTargetAction('share')">Share</button>
      <div class="menu-sep" role="separator" />
      <template v-if="section !== 'trash' && !readOnlyArea">
        <button role="menuitem" type="button" :disabled="busy" @click="runTargetAction('rename')">Rename</button>
        <button role="menuitem" type="button" :disabled="busy" @click="runTargetAction('move')">Move</button>
        <button role="menuitem" type="button" :disabled="busy" @click="runTargetAction('copy')">Copy</button>
        <button role="menuitem" type="button" :disabled="busy" @click="runTargetAction('cut')">Cut</button>
        <div class="menu-sep" role="separator" />
        <button v-if="!actionTarget.folder" role="menuitem" type="button" :disabled="busy" @click="runTargetAction('download')">Download</button>
        <button v-if="!actionTarget.folder && dataSource.capabilities.onlineOnly && (entrySync(actionTarget) === 'online-only' ? dataSource.keepOnMac : dataSource.makeOnlineOnly)" role="menuitem" type="button" :disabled="busy" @click="runTargetAction(entrySync(actionTarget) === 'online-only' ? 'keep-local' : 'online-only')">{{ entrySync(actionTarget) === 'online-only' ? 'Keep on this computer' : 'Make online only' }}</button>
        <div class="menu-sep" role="separator" />
        <button v-if="dataSource.capabilities.trash" role="menuitem" type="button" class="danger" :disabled="busy" @click="runTargetAction('trash')">Move to Trash</button>
      </template>
      <template v-else>
        <div class="menu-sep" role="separator" />
        <button role="menuitem" type="button" :disabled="busy || !dataSource.restoreTrashItem" @click="runTargetAction('restore')">Restore</button>
        <div class="menu-sep" role="separator" />
        <button role="menuitem" type="button" class="danger" :disabled="busy || !dataSource.purgeTrashItem" @click="runTargetAction('purge')">Delete permanently</button>
      </template>
    </div>
  </Teleport>
  <Teleport to="body">
    <div v-if="newMenu" ref="newActionMenu" class="action-menu new-menu" role="menu" aria-label="Create new" :style="{ left: `${newMenu.x}px`, top: `${newMenu.y}px` }" @keydown="onMenuKeydown" @click.stop @contextmenu.prevent>
      <button v-if="dataSource.capabilities.upload || dataSource.capabilities.durableOperations" role="menuitem" type="button" @click="closeNewMenu(); newFolder()">New folder</button>
      <template v-if="dataSource.createFile">
        <div class="menu-sep" role="separator" />
        <button v-for="kind in newFileKinds" :key="kind.label" role="menuitem" type="button" @click="closeNewMenu(); newFile(currentPath, kind.name)">{{ kind.label }}</button>
      </template>
      <div class="menu-sep" role="separator" />
      <button v-if="dataSource.capabilities.upload" role="menuitem" type="button" @click="closeNewMenu(); upload()">Upload files</button>
      <button v-if="dataSource.nativeSourceReady && dataSource.chooseNativeSource" role="menuitem" type="button" @click="closeNewMenu(); chooseNativeSource()">Link a file from your Mac</button>
    </div>
  </Teleport>
  <Teleport to="body">
    <div v-if="backgroundMenu" ref="backgroundActionMenu" class="action-menu" role="menu" aria-label="Folder actions" :style="{ left: `${backgroundMenu.x}px`, top: `${backgroundMenu.y}px` }" @keydown="onMenuKeydown" @click.stop @contextmenu.prevent>
      <b>{{ pageTitle }}</b>
      <button role="menuitem" type="button" :disabled="!canPaste || busy" @click="pasteClipboard(); closeBackgroundActions()">Paste</button>
      <div class="menu-sep" role="separator" />
      <button v-if="!readOnlyArea" role="menuitem" type="button" :disabled="busy || section !== 'files'" @click="closeBackgroundActions(); newFolder()">New folder</button>
      <button v-if="!readOnlyArea && dataSource.createFile" role="menuitem" type="button" :disabled="busy || section !== 'files'" @click="closeBackgroundActions(); newFile()">New file</button>
      <div class="menu-sep" role="separator" />
      <button role="menuitem" type="button" @click="setSort('name'); closeBackgroundActions()">Sort by name</button>
      <button role="menuitem" type="button" @click="refresh(true); closeBackgroundActions()">Refresh</button>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
// The row action menu, the New menu and the folder-background menu (teleported to <body>).
import { computed } from 'vue';

import { FilesBrowserCreation } from '../FilesBrowserCreation';
import { injectFilesBrowser } from '../useFilesBrowser';

const browser = injectFilesBrowser();
const newFileKinds = FilesBrowserCreation.newFileKinds;
const dataSource = computed(() => browser.props.dataSource);
const { section, currentPath, busy } = browser.state;
const { readOnlyArea, pageTitle } = browser.location;
const { actionMenu, actionTarget, menuPosition, recentApplications, backgroundActionMenu, backgroundMenu, onMenuKeydown, closeBackgroundActions, openWithApplication } = browser.menus;
const { newMenu, newActionMenu, closeNewMenu, newFolder, newFile, upload, chooseNativeSource } = browser.creation;
const { runTargetAction } = browser.targetActions;
const { canPaste, pasteClipboard } = browser.fileOperations;
const { canShareEntry } = browser.sharing;
const { setSort } = browser.preferences;
const { refresh } = browser.refresher;
const { entrySync } = browser.presenter;
</script>

<style scoped src="./FilesBrowser.css"></style>
