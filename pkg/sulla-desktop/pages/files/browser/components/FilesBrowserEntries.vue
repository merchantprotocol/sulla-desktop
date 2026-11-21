<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div
    v-if="view === 'list'"
    ref="listSurface"
    class="card files virtual-surface"
    :class="{ 'drop-background': dragging }"
    @pointerdown="startMarquee"
    @click.self="clearSelection"
    @contextmenu.self.prevent="openBackgroundActions"
    @dragover="onSurfaceDragOver"
  >
    <table class="tbl">
      <thead>
        <tr>
          <th style="width:36px">
            <button
              class="chk"
              :class="{ on: allVisibleSelected }"
              type="button"
              role="checkbox"
              :aria-checked="allVisibleSelected"
              aria-label="Select all"
              @click="toggleAll"
            />
          </th>
          <th :style="columnStyle('name')" @click="setSort('name')">Name <span class="sort-arrow">{{ sortIndicator('name') }}</span><i class="resize-handle" @pointerdown.stop.prevent="startColumnResize('name', $event)" /></th><th class="col-owner" :style="columnStyle('owner')">
            Owner
            <i class="resize-handle" @pointerdown.stop.prevent="startColumnResize('owner', $event)" />
          </th><th :style="columnStyle('modified')" @click="setSort('modified')">Modified <span class="sort-arrow">{{ sortIndicator('modified') }}</span><i class="resize-handle" @pointerdown.stop.prevent="startColumnResize('modified', $event)" /></th><th class="r col-size" :style="columnStyle('size')" @click="setSort('size')">
            Size
            <span class="sort-arrow">{{ sortIndicator('size') }}</span><i class="resize-handle" @pointerdown.stop.prevent="startColumnResize('size', $event)" />
          </th><th style="width:44px;text-align:center">
            Sync
          </th><th style="width:150px" />
        </tr>
      </thead>
      <tbody>
        <template
          v-for="group in groups"
          :key="group.label"
        >
          <tr class="sechead">
            <td colspan="7">
              {{ group.label }}
            </td>
          </tr>
          <tr v-if="listTopSpacer" class="virtual-spacer" aria-hidden="true"><td colspan="7" :style="{ height: `${listTopSpacer}px` }" /></tr>
          <tr
            v-for="entry in virtualListEntries"
            :key="entry.key"
            class="row"
            :class="{ 'is-sel': selectedKeys.has(entry.key), 'is-cut': isCut(entry), 'is-dragging': draggedKeys.has(entry.key), 'drop-target': dropTargetKey === entry.key, agent: entry.agent, 'is-active': activePaths.has(entry.path) }"
            :draggable="section === 'files' && !readOnlyArea && !busy && editingKey !== entry.key"
            :data-entry-key="entry.key"
            @pointerdown="prepareDragSnapshot(entry)"
            @click="focusEntry(entry, $event)"
            @dblclick="activate(entry)"
            @contextmenu.prevent.stop="openActions(entry, $event)"
            @dragstart="onEntryDragStart(entry, $event)"
            @dragenter="onFolderDragEnter(entry, $event)"
            @dragover="onFolderDragOver(entry, $event)"
            @dragleave="onFolderDragLeave(entry, $event)"
            @drop="onFolderDrop(entry, $event)"
            @dragend="clearInternalDrag"
            tabindex="0"
            :aria-selected="selectedKeys.has(entry.key)"
            @keydown="onEntryKeydown(entry, $event)"
          >
            <td>
              <button
                class="chk"
                :class="{ on: selectedKeys.has(entry.key) }"
                type="button"
                role="checkbox"
                :aria-checked="selectedKeys.has(entry.key)"
                :aria-label="`Select ${entry.name}`"
                @click.stop="toggleSelected(entry.key)"
                @dblclick.stop
              />
            </td>
            <td>
              <div class="name">
                <button v-if="entry.folder && !entry.rootCollectionId" class="disclosure" type="button" :aria-label="`${expandedFolders.has(entry.path) ? 'Collapse' : 'Expand'} ${entry.name}`" :aria-expanded="expandedFolders.has(entry.path)" :style="{ marginLeft: `${(entry.depth ?? 0) * 18}px` }" @click.stop="toggleFolderExpansion(entry)" @dblclick.stop>{{ expandedFolders.has(entry.path) ? '▾' : '›' }}</button><span v-else class="disclosure-spacer" :style="{ marginLeft: `${(entry.depth ?? 0) * 18}px` }" />
                <span
                  class="fi"
                  :class="entry.kindClass"
                  v-html="entry.icon"
                /><div class="t">
                  <input
                    v-if="editingKey === entry.key"
                    :ref="element => setRenameInput(element, entry)"
                    v-model="renameValue"
                    class="inline-rename"
                    aria-label="Rename item"
                    @click.stop
                    @dblclick.stop
                    @keydown.enter.prevent="commitRename(entry)"
                    @keydown.escape.prevent="cancelRename"
                    @blur="commitRename(entry)"
                  ><b v-else>{{ entry.name }}</b><small>{{ entry.subtitle }}</small>
                </div>
              </div>
            </td>
            <td>
              <div class="own">
                <img
                  v-if="entry.ownerAvatarUrl"
                  class="avatar sm"
                  :src="entry.ownerAvatarUrl"
                  alt=""
                ><span
                  v-else
                  class="avatar sm"
                  :class="avatarClass(entry)"
                >{{ ownerInitials(entry) }}</span><span class="nm">{{ ownerName(entry) }}</span>
              </div>
            </td>
            <td class="muted">
              {{ formatRelative(entry.updatedAt) }}
            </td>
            <td class="r muted col-size">
              {{ formatBytes(entry.size) }}
            </td>
            <td style="text-align:center">
              <span
                class="sync"
                :class="syncClass(entry)"
                :title="syncText(entry)"
                v-html="syncIcon(entry)"
              />
            </td>
            <td @dblclick.stop>
              <button v-if="!entry.rootCollectionId && (section !== 'trash' || !entry.folder)" class="btn sm details-action" type="button" @click.stop="showDetails(entry)">Details</button>
              <button v-if="!entry.folder && ['failed', 'unsupported'].includes(entry.indexStatus)" class="btn sm" type="button" :disabled="busy" :title="entry.indexReason" @click.stop="reindex(entry)">Re-index</button>
              <div
                v-if="entrySync(entry) === 'conflict' && !entry.folder"
                class="actions keep"
              >
                <button
                  class="btn sm danger"
                  type="button"
                  :disabled="busy || !dataSource.keepConflictCopies || !entry.conflictSourceFileId || !entry.conflictSourceVersionId"
                  title="Keep both preserved files and clear this conflict warning"
                  @click.stop="keepBothConflict(entry)"
                >
                  Keep both
                </button><button
                  class="btn ico"
                  type="button"
                  title="More"
                  @click.stop="openActions(entry, $event)"
                  v-html="icons.more"
                />
              </div>
              <div
                v-else
                class="actions"
              >
                <button
                  v-if="section !== 'trash'"
                  class="btn ico"
                  type="button"
                  :disabled="!dataSource.capabilities.publicLinks || entry.folder"
                  title="Copy public link"
                  @click.stop="shareEntry(entry)"
                  v-html="icons.share"
                /><button
                  v-if="section !== 'trash' && !readOnlyArea"
                  class="btn ico"
                  type="button"
                  :title="starred.has(entry.id) ? 'Unstar' : 'Star'"
                  @click.stop="toggleStar(entry.id)"
                  v-html="starred.has(entry.id) ? icons.starOn : icons.star"
                /><button
                  class="btn ico"
                  type="button"
                  title="More"
                  @click.stop="openActions(entry, $event)"
                  v-html="icons.more"
                />
              </div>
            </td>
          </tr>
        </template>
        <tr v-if="listBottomSpacer" class="virtual-spacer" aria-hidden="true"><td colspan="7" :style="{ height: `${listBottomSpacer}px` }" /></tr>
      </tbody>
    </table>
  </div>

  <div
    v-else
    ref="gridSurface"
    class="gridv virtual-surface"
    :class="{ 'drop-background': dragging }"
    @scroll="updateVirtualScroll"
    @pointerdown="startMarquee"
    @click.self="clearSelection"
    @contextmenu.self.prevent="openBackgroundActions"
    @dragover="onSurfaceDragOver"
  >
    <div v-if="gridTopSpacer" class="grid-spacer" :style="{ height: `${gridTopSpacer}px` }" />
    <div
      v-for="entry in virtualGridEntries"
      :key="entry.key"
      class="tile"
      :class="{ 'is-sel': selectedKeys.has(entry.key), 'is-cut': isCut(entry), 'is-dragging': draggedKeys.has(entry.key), 'drop-target': dropTargetKey === entry.key, 'is-active': activePaths.has(entry.path) }"
      :draggable="section === 'files' && !readOnlyArea && !busy && editingKey !== entry.key"
      :data-entry-key="entry.key"
      @pointerdown="prepareDragSnapshot(entry)"
      @click="focusEntry(entry, $event)"
      @dblclick="activate(entry)"
      @contextmenu.prevent.stop="openActions(entry, $event)"
      @dragstart="onEntryDragStart(entry, $event)"
      @dragenter="onFolderDragEnter(entry, $event)"
      @dragover="onFolderDragOver(entry, $event)"
      @dragleave="onFolderDragLeave(entry, $event)"
      @drop="onFolderDrop(entry, $event)"
      @dragend="clearInternalDrag"
            tabindex="0"
            :aria-selected="selectedKeys.has(entry.key)"
            @keydown="onEntryKeydown(entry, $event)"
    >
      <div
        class="th"
        :class="{ folderth: entry.folder && !entry.agent, agentth: entry.agent }"
      >
        <span
          class="fi"
          :class="entry.kindClass"
          v-html="entry.icon"
        /><span
          class="sync"
          :class="syncClass(entry)"
          v-html="syncIcon(entry)"
        />
      </div>
      <button v-if="!entry.rootCollectionId && (section !== 'trash' || !entry.folder)" class="btn sm details-action" type="button" @click.stop="showDetails(entry)" @dblclick.stop>Details</button>
      <div class="bd">
        <input
          v-if="editingKey === entry.key"
          :ref="element => setRenameInput(element, entry)"
          v-model="renameValue"
          class="inline-rename"
          aria-label="Rename item"
          @click.stop
          @dblclick.stop
          @keydown.enter.prevent="commitRename(entry)"
          @keydown.escape.prevent="cancelRename"
          @blur="commitRename(entry)"
        ><b v-else>{{ entry.name }}</b><small>{{ entry.folder ? (entry.childCount < 0 ? 'Folder' : `${entry.childCount} file${entry.childCount === 1 ? '' : 's'}`) : formatBytes(entry.size) }} · {{ formatShort(entry.updatedAt) }}</small>
      </div>
    </div>
    <div v-if="gridBottomSpacer" class="grid-spacer" :style="{ height: `${gridBottomSpacer}px` }" />
  </div>
</template>

<script setup lang="ts">
// The listing itself: the virtualized list table or grid of tiles, with selection, drag/drop and inline rename.
import { computed } from 'vue';

import { injectFilesBrowser } from '../useFilesBrowser';

const browser = injectFilesBrowser();
const { icons } = browser;
const dataSource = computed(() => browser.props.dataSource);
const { section, busy, selectedKeys, expandedFolders, starred } = browser.state;
const { readOnlyArea } = browser.location;
const { view, columnStyle, setSort, sortIndicator } = browser.preferences;
const { listSurface, gridSurface, virtualListEntries, virtualGridEntries, listTopSpacer, listBottomSpacer, gridTopSpacer, gridBottomSpacer, updateVirtualScroll } = browser.virtualScroll;
const { groups, toggleFolderExpansion } = browser.listing;
const { allVisibleSelected, focusEntry, toggleSelected, toggleAll, clearSelection } = browser.selection;
const { activePaths } = browser.liveUpdates;
const { dragging, draggedKeys, dropTargetKey, onEntryDragStart, onFolderDragEnter, onFolderDragOver, onFolderDragLeave, onFolderDrop, onSurfaceDragOver, clearInternalDrag } = browser.dragDrop;
const { prepare: prepareDragSnapshot } = browser.dragSnapshots;
const { editingKey, renameValue, setRenameInput, commitRename, cancelRename } = browser.rename;
const { startMarquee, startColumnResize } = browser.gestures;
const { onEntryKeydown } = browser.keyboard;
const { activate } = browser.navigation;
const { openActions, openBackgroundActions } = browser.menus;
const { showDetails } = browser.dialogs;
const { shareEntry } = browser.sharing;
const { isCut } = browser.fileOperations;
const { reindex, keepBothConflict, toggleStar } = browser.itemActions;
const { ownerName, ownerInitials, avatarClass, entrySync, syncClass, syncIcon, syncText } = browser.presenter;
const { formatBytes, formatRelative, formatShort } = browser.format;
</script>

<style scoped src="./FilesBrowser.css"></style>
