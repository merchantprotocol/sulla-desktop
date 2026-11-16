<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <nav
    class="nav"
    aria-label="Files sections"
  >
    <div class="brand">
      <div class="mark">
        S
      </div><div><b>Sulla</b><span>{{ brandLine }}</span></div>
    </div>
    <div v-if="dragTargets.length && dragDrop.dragSourceCapability !== 'unavailable' && (snapshot?.availableCollections?.length ?? 0) > 1" class="collection-drops" aria-label="Move selection to collection">
      <button v-for="collection in otherCollections" :key="collection.id" class="btn sm" type="button" @dragover.prevent.stop="setCollectionDropEffect" @drop.prevent.stop="onCollectionDrop(collection.id, $event)">Move to {{ collection.name }}</button>
    </div>
    <a
      v-for="entry in sections"
      :key="entry.id"
      href="#"
      :class="{ on: section === entry.id }"
      @dragover.prevent="entry.id === 'files' && onNavigationDragOver('', $event)"
      @drop.prevent="entry.id === 'files' && onNavigationDrop('', $event)"
      @click.prevent="entry.id === 'files' ? openHome() : selectSection(entry.id)"
    ><span
      class="sv"
      v-html="entry.icon"
    /><span>{{ entry.label }}</span><span
      v-if="entry.count"
      class="cnt"
      :class="{ warn: entry.warn }"
    >{{ entry.count }}</span></a>
    <template v-if="trackedCollections.length">
      <div class="grp">Tracked folders</div>
      <a v-for="collection in trackedCollections" :key="collection.id" href="#" :class="{ on: snapshot?.collection.id === collection.id && section === 'files' && !atRoots }" @click.prevent="selectCollection(collection.id)"><span class="sv" v-html="icons.folderLine" /><span>{{ collection.name }}</span></a>
    </template>
    <template v-if="sharedFolders.length">
      <div class="grp">
        Shared folders
      </div>
      <a
        v-for="folder in sharedFolders"
        :key="folder"
        href="#"
        :class="{ on: section === 'files' && currentPath === folder, 'drop-target': externalNavigationTarget === folder }"
        @dragover.prevent="onNavigationDragOver(folder, $event)"
        @drop.prevent="onNavigationDrop(folder, $event)"
        @click.prevent="openPath(folder)"
      ><span
        class="sv"
        v-html="icons.folderLine"
      /><span>{{ folder.split('/').at(-1) }}</span></a>
    </template>

    <div class="sep" />
    <section
      class="favorites"
      :class="{ 'drop-target': favoriteDropActive }"
      aria-label="Favorite folders"
      @dragenter="onFavoriteDragEnter"
      @dragover="onFavoriteDragOver"
      @dragleave="onFavoriteDragLeave"
      @drop="onFavoriteDrop"
    >
      <div class="grp favorites-heading">
        Favorites <span>Drop folders here</span>
      </div>
      <div
        v-for="folder in folderFavorites"
        :key="folder.path"
        class="favorite-row"
        :class="{ unavailable: !folder.available }"
      >
        <button
          class="favorite-link"
          type="button"
          :class="{ on: section === 'files' && currentPath === folder.path }"
          :disabled="busy || loading || !folder.available"
          :title="folder.available ? folder.path : `${folder.path} is unavailable`"
          @click="openPath(folder.path)"
        ><span
          class="sv"
          v-html="icons.folderLine"
        /><span>{{ folder.name }}</span><small v-if="!folder.available">Unavailable</small></button>
        <button
          class="favorite-remove"
          type="button"
          :disabled="busy || loading"
          :aria-label="`Remove ${folder.path} from Favorites`"
          title="Remove from Favorites"
          @click="setFolderFavorite(folder.path, false)"
        >×</button>
      </div>
    </section>
    <div
      class="quota"
      :class="{ nobar: !quotaBytes }"
    >
      <b>{{ formatBytes(totalBytes) }}</b><template v-if="quotaBytes">
        of {{ formatBytes(quotaBytes) }}
      </template> {{ storageWhere }}<div
        v-if="quotaBytes"
        class="bar"
      >
        <i :style="{ width: `${storagePercent}%` }" />
      </div><span>{{ collectionFileCount.toLocaleString() }} file{{ collectionFileCount === 1 ? '' : 's' }}<template v-if="snapshot?.collection.keptBytes !== undefined"> · {{ formatBytes(snapshot.collection.keptBytes) }} kept on this Mac</template></span>
    </div>
    <button
      v-if="dataSource.capabilities.nativeFilesystem"
      class="syncline"
      type="button"
      :title="syncTooltip"
      @click="togglePause"
    >
      <span
        class="dot"
        :class="syncState"
      />{{ syncLine }}
    </button>
    <div v-else class="syncline" :title="syncTooltip">
      <span class="dot" :class="syncState" />{{ syncLine }}
    </div>
    <div class="foot">
      <div class="avatar">
        {{ initials(accountName) }}
      </div><div><b>{{ accountName }}</b><small>{{ accountLine }}</small></div>
    </div>
  </nav>
</template>

<script setup lang="ts">
// The Files sidebar: sections, tracked and shared folders, Favorites, storage, sync line and account.
import { computed } from 'vue';

import { injectFilesBrowser } from '../useFilesBrowser';

const browser = injectFilesBrowser();
const { icons, dragDrop } = browser;
const dataSource = computed(() => browser.props.dataSource);
const { snapshot, section, currentPath, busy, loading } = browser.state;
const { atRoots, trackedCollections, sharedFolders, otherCollections } = browser.location;
const { sections, folderFavorites, quotaBytes, totalBytes, storageWhere, storagePercent, collectionFileCount, syncLine, syncTooltip, brandLine, accountLine } = browser.sidebar;
const { accountName, syncState } = browser.presenter;
const { formatBytes, initials } = browser.format;
const { dragTargets, externalNavigationTarget, favoriteDropActive } = dragDrop;
const { setCollectionDropEffect, onCollectionDrop, onFavoriteDragEnter, onFavoriteDragOver, onFavoriteDragLeave, onFavoriteDrop, onNavigationDragOver, onNavigationDrop } = browser.dropZones;
const { openHome, selectSection, selectCollection, openPath } = browser.navigation;
const { setFolderFavorite, togglePause } = browser.itemActions;
</script>

<style scoped src="./FilesBrowser.css"></style>
