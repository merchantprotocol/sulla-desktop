<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="top">
    <div class="crumbs">
      <template v-if="crumbs.length || collectionCrumb">
        <a
          v-if="collectionCrumb"
          class="c"
          href="#"
          @click.prevent="openHome"
        >{{ rootLabel }}</a>
        <span v-if="collectionCrumb">›</span><b v-if="collectionCrumb && !crumbs.length">{{ collectionCrumb }}</b><a
          v-else
          class="c"
          href="#"
          data-drop-path=""
          @dragover.prevent="onNavigationDragOver('', $event)"
          @drop.prevent="onNavigationDrop('', $event)"
          @click.prevent="openRoot"
        >{{ collectionCrumb || rootLabel }}</a>
        <template
          v-for="(crumb, index) in crumbs"
          :key="crumb.path"
        >
          <span>›</span><b v-if="index === crumbs.length - 1">{{ crumb.label }}</b><a
            v-else
            class="c"
            href="#"
            :data-drop-path="crumb.path"
            @dragover.prevent="onNavigationDragOver(crumb.path, $event)"
            @drop.prevent="onNavigationDrop(crumb.path, $event)"
            @click.prevent="openPath(crumb.path)"
          >{{ crumb.label }}</a>
        </template>
      </template>
      <b v-else>{{ rootLabel }}</b>
    </div>
    <label v-if="section !== 'sharedByMe'" class="search"><span
      class="si"
      v-html="icons.search"
    /><input
      ref="searchInput"
      v-model="query"
      placeholder="Search files, folders, transcripts and screenshot text"
    ><kbd>⌘K</kbd></label>
    <div v-if="section !== 'sharedByMe'" class="acts">
      <button v-if="dataSource.listCloudCollections && dataSource.restoreCloudCollection" class="btn sm ghost" type="button" :disabled="busy || loading" @click="openCloudRestore">Restore from Sulla Cloud</button>
      <span v-if="cloudBackup?.enabled" class="cloud-backup-status" :title="cloudBackupTitle">{{ cloudBackupLine }}</span>
      <button
        v-if="dataSource.openPreferences"
        class="btn"
        type="button"
        :disabled="busy"
        title="Manage tracked folders"
        aria-label="Open File Manager preferences"
        @click="openFilePreferences"
      >
        <span
          class="bi"
          v-html="icons.settings"
        /> Preferences
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
// Breadcrumbs, search and the Cloud restore / Preferences actions above the listing.
import { computed } from 'vue';

import { injectFilesBrowser } from '../useFilesBrowser';

const browser = injectFilesBrowser();
const { icons } = browser;
const dataSource = computed(() => browser.props.dataSource);
const { section, query, busy, loading } = browser.state;
const { crumbs, collectionCrumb, rootLabel } = browser.location;
const { cloudBackup, cloudBackupLine, cloudBackupTitle } = browser.sidebar;
const { searchInput } = browser.search;
const { onNavigationDragOver, onNavigationDrop } = browser.dropZones;
const { openHome, openRoot, openPath } = browser.navigation;
const { openCloudRestore } = browser.dialogs;
const { openFilePreferences } = browser.itemActions;
</script>

<style scoped src="./FilesBrowser.css"></style>
