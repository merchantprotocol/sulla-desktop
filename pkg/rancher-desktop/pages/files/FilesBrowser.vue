<template>
  <div
    class="files-browser"
    :class="{ dragging }"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <nav
      class="nav"
      aria-label="Files sections"
    >
      <div class="brand">
        <div class="mark">
          S
        </div><div><b>Sulla</b><span>{{ brandLine }}</span></div>
      </div>
      <a
        v-for="entry in sections"
        :key="entry.id"
        href="#"
        :class="{ on: section === entry.id }"
        @click.prevent="selectSection(entry.id)"
      ><span
        class="sv"
        v-html="entry.icon"
      /><span>{{ entry.label }}</span><span
        v-if="entry.count"
        class="cnt"
        :class="{ warn: entry.warn }"
      >{{ entry.count }}</span></a>
      <template v-if="sharedFolders.length">
        <div class="sep" />
        <div class="grp">
          Shared folders
        </div>
        <a
          v-for="folder in sharedFolders"
          :key="folder"
          href="#"
          :class="{ on: section === 'files' && currentPath === folder }"
          @click.prevent="openPath(folder)"
        ><span
          class="sv"
          v-html="icons.folderLine"
        /><span>{{ folder.split('/').at(-1) }}</span></a>
      </template>
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
        </div><span>{{ activeFiles.length.toLocaleString() }} file{{ activeFiles.length === 1 ? '' : 's' }}<template v-if="snapshot?.collection.keptBytes !== undefined"> · {{ formatBytes(snapshot.collection.keptBytes) }} kept on this Mac</template></span>
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

    <main v-if="!selected" class="main">
      <div class="top">
        <div class="crumbs">
          <template v-if="crumbs.length">
            <a
              class="c"
              href="#"
              @click.prevent="openRoot"
            >{{ rootLabel }}</a>
            <template
              v-for="(crumb, index) in crumbs"
              :key="crumb.path"
            >
              <span>›</span><b v-if="index === crumbs.length - 1">{{ crumb.label }}</b><a
                v-else
                class="c"
                href="#"
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
          <button
            v-if="dataSource.capabilities.nativeFilesystem"
            class="btn"
            type="button"
            @click="newFolder"
          >
            <span
              class="bi"
              v-html="icons.plus"
            /> New folder
          </button>
          <button
            class="btn pri"
            type="button"
            :disabled="busy || !dataSource.capabilities.upload"
            @click="upload"
          >
            <span
              class="bi"
              v-html="icons.upload"
            /> Upload
          </button>
        </div>
      </div>

      <div v-if="section === 'sharedByMe'" class="content">
        <SharedByMe :data-source="dataSource" />
      </div>
      <div v-else class="content">
        <div class="toolbar">
          <h1>{{ pageTitle }}</h1><span class="meta">{{ summaryText }}</span>
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
          >Trash is kept for {{ retentionDays }} days</span>
          <div class="view">
            <label class="sel"><span>Sort</span> {{ sortLabel }}<select
              v-model="sort"
              aria-label="Sort"
            ><option value="name">Name</option><option value="modified">Modified</option><option value="size">Size</option><option value="type">Type</option></select></label>
            <div
              class="seg"
              role="group"
              aria-label="View"
            >
              <button
                type="button"
                :class="{ on: view === 'list' }"
                @click="view = 'list'"
              >
                <span
                  class="bi"
                  v-html="icons.list"
                /> List
              </button><button
                type="button"
                :class="{ on: view === 'grid' }"
                @click="view = 'grid'"
              >
                <span
                  class="bi"
                  v-html="icons.grid"
                /> Grid
              </button>
            </div>
          </div>
        </div>

        <div v-if="selectedEntries.length" class="selection-bar">
          <b>{{ selectedEntries.length }} selected</b>
          <button class="btn sm" type="button" :disabled="busy || selectedEntries.length !== 1" @click="renameSelected">Rename</button>
          <button class="btn sm" type="button" :disabled="busy" @click="moveSelected">Move</button>
          <button class="btn sm" type="button" :disabled="busy" @click="copySelected">Copy</button>
          <button class="btn sm" type="button" :disabled="busy || selectedEntries.every(entry => entry.folder)" @click="downloadSelected">Download</button>
          <button class="btn sm danger" type="button" :disabled="busy" @click="trashSelected">Move to Trash</button>
        </div>
        <div v-if="operationError" class="operation-error" role="alert">
          {{ operationError }} <button class="btn sm ghost" type="button" @click="operationError = ''">Dismiss</button>
        </div>

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
              v-if="dataSource.capabilities.nativeFilesystem"
              class="btn"
              type="button"
              @click="dataSource.openFolder()"
            >
              Open ~/sulla/Files
            </button>
          </div>
        </div>
        <div
          v-else-if="visibleEntries.length === 0"
          class="state-panel"
        >
          <span
            class="state-icon"
            v-html="section === 'trash' ? icons.trash : icons.folderLine"
          />
          <strong>{{ emptyTitle }}</strong><p>{{ emptyCopy }}</p>
          <button
            v-if="section === 'files'"
            class="btn pri"
            type="button"
            @click="upload"
          >
            Choose files
          </button>
        </div>

        <div
          v-else-if="view === 'list'"
          class="card files"
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
                <th>Name</th><th class="col-owner">
                  Owner
                </th><th>Modified</th><th class="r col-size">
                  Size
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
                <tr
                  v-for="entry in group.entries"
                  :key="entry.key"
                  class="row"
                  :class="{ 'is-sel': selectedKeys.has(entry.key), agent: entry.agent }"
                  @click="focusEntry(entry, $event)"
                  @dblclick="activate(entry)"
                  @contextmenu.prevent="openActions(entry)"
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
                    />
                  </td>
                  <td>
                    <div class="name">
                      <span
                        class="fi"
                        :class="entry.kindClass"
                        v-html="entry.icon"
                      /><div class="t">
                        <b>{{ entry.name }}</b><small>{{ entry.subtitle }}</small>
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
                  <td>
                    <div
                      v-if="entrySync(entry) === 'conflict' && !entry.folder"
                      class="actions keep"
                    >
                      <button
                        class="btn sm danger"
                        type="button"
                        @click.stop="resolveConflict(entry)"
                      >
                        Resolve
                      </button><button
                        class="btn ico"
                        type="button"
                        title="More"
                        @click.stop="openActions(entry)"
                        v-html="icons.more"
                      />
                    </div>
                    <div
                      v-else
                      class="actions"
                    >
                      <button
                        class="btn ico"
                        type="button"
                        :disabled="!dataSource.capabilities.publicLinks || entry.folder"
                        title="Copy public link"
                        @click.stop="shareEntry(entry)"
                        v-html="icons.share"
                      /><button
                        class="btn ico"
                        type="button"
                        :title="starred.has(entry.id) ? 'Unstar' : 'Star'"
                        @click.stop="toggleStar(entry.id)"
                        v-html="starred.has(entry.id) ? icons.starOn : icons.star"
                      /><button
                        class="btn ico"
                        type="button"
                        title="More"
                        @click.stop="openActions(entry)"
                        v-html="icons.more"
                      />
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <div
          v-else
          class="gridv"
        >
          <div
            v-for="entry in visibleEntries"
            :key="entry.key"
            class="tile"
            :class="{ 'is-sel': selectedKeys.has(entry.key) }"
            @click="focusEntry(entry, $event)"
            @dblclick="activate(entry)"
            @contextmenu.prevent="openActions(entry)"
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
            <div class="bd">
              <b>{{ entry.name }}</b><small>{{ entry.folder ? `${entry.childCount} file${entry.childCount === 1 ? '' : 's'}` : formatBytes(entry.size) }} · {{ formatShort(entry.updatedAt) }}</small>
            </div>
          </div>
        </div>
        <div v-if="actionTarget" class="action-menu" role="menu">
          <b>{{ actionTarget.name }}</b>
          <button type="button" @click="runTargetAction('rename')">Rename</button>
          <button type="button" @click="runTargetAction('move')">Move</button>
          <button type="button" @click="runTargetAction('copy')">Copy</button>
          <button v-if="!actionTarget.folder" type="button" @click="runTargetAction('download')">Download</button>
          <button type="button" class="danger" @click="runTargetAction('trash')">Move to Trash</button>
          <button type="button" @click="actionTarget = null">Cancel</button>
        </div>

        <div
          v-if="!loading && !error && section === 'files'"
          class="drop"
        >
          <span
            class="ico"
            v-html="icons.upload"
          /><div><b>Drop files here to upload to {{ pageTitle }}</b><small>{{ dropCopy }}</small></div><button
            class="btn"
            type="button"
            :disabled="busy || !dataSource.capabilities.upload"
            @click="upload"
          >
            Choose files
          </button>
        </div>
      </div>
    </main>

    <FileDetail
      v-else-if="snapshot"
      :key="`${selected.id}:${selected.currentVersionId}`"
      :item="selected"
      :collection="snapshot.collection"
      :data-source="dataSource"
      :initial-tab="detailTab === 'versions' ? 'Versions' : 'Details'"
      @close="selected = null"
      @share="shareEntry(selected)"
      @restored="selected = null; refresh(true)"
      @open-linked="openLinked"
    />

    <div
      v-if="dragging"
      class="drop-overlay"
    >
      <span v-html="icons.upload" /><strong>Drop files here to upload to {{ pageTitle }}</strong><p>{{ dropCopy }}</p>
    </div>
    <div
      v-if="uploadProgress"
      class="upl"
    >
      <div class="hd">
        {{ uploadProgress.done ? 'Upload complete' : `Uploading ${uploadProgress.current} of ${uploadProgress.total}` }}<button
          class="btn ico"
          type="button"
          aria-label="Hide upload progress"
          @click="uploadProgress = null; uploadLog = []"
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
    <ShareSheet v-if="shareTarget" :data-source="dataSource" :target="shareTarget" @close="shareTarget = null" @updated="refresh(true)" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import FileDetail from './FileDetail.vue';
import ShareSheet from './ShareSheet.vue';
import SharedByMe from './SharedByMe.vue';

import type { FilesNavigationPayload } from '@pkg/composables/useBrowserTabs';

import type { FilesDataSource, FilesItem, FilesSnapshot } from './types';

const props = defineProps<{ dataSource: FilesDataSource; tabId: string; navigation?: FilesNavigationPayload }>();
const emit = defineEmits<{ 'navigation-consumed': [] }>();
type Section = 'files' | 'shared' | 'sharedByMe' | 'recent' | 'starred' | 'agent' | 'trash';
type ViewMode = 'list' | 'grid';
interface DisplayEntry extends FilesItem { key: string; name: string; folder: boolean; agent: boolean; childCount: number; kindClass: string; icon: string; subtitle: string }

// Icon set copied from the approved Files mockup (mockups/files/01-files.html).
const icons = {
  folder:     '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  folderLine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  users:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 19h5a4.5 4.5 0 0 0-3-4.2"/></svg>',
  clock:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  star:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.8l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 17l-5.2 2.8 1-5.8L3.6 9.9l5.8-.8z"/></svg>',
  starOn:     '<span class="star on"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.8l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 17l-5.2 2.8 1-5.8L3.6 9.9l5.8-.8z"/></svg></span>',
  agent:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4M9 4h6"/><circle cx="9" cy="13.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="13.5" r="1.2" fill="currentColor" stroke="none"/></svg>',
  trash:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  search:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/></svg>',
  plus:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  upload:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5M7 10l5-5 5 5M4 19h16"/></svg>',
  share:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M8.2 10.8l7.6-4M8.2 13.2l7.6 4"/></svg>',
  list:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  grid:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>',
  more:       '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18" cy="12" r="1.7"/></svg>',
  close:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  alert:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/></svg>',
  syncLocal:  '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="9" opacity=".16"/><path d="M8 12.5l2.6 2.6L16.5 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  syncOnline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4 4 0 0 1-.5-7.96A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 .5 7H7z"/></svg>',
  syncSpin:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 0 1-14.2 5M4 12a8 8 0 0 1 14.2-5"/><path d="M4 7v5h5M20 17v-5h-5"/></svg>',
  file:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/></svg>',
  doc:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  image:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20 15l-4.5-4.5L7 19"/></svg>',
  video:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>',
  audio:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
  pdf:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/><path d="M9 17v-5h2a1.5 1.5 0 0 1 0 3H9"/></svg>',
  zip:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M10 4v4h2v4h-2v4h2v4"/></svg>',
  code:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/></svg>',
};

const snapshot = ref<FilesSnapshot | null>(null); const loading = ref(true); const busy = ref(false); const error = ref('');
const section = ref<Section>('files'); const currentPath = ref(''); const query = ref(''); const sort = ref('modified'); const view = ref<ViewMode>((localStorage.getItem('sulla:files-view') as ViewMode) || 'list');
const activeFilters = ref<Record<'type' | 'person' | 'date' | 'folder', string>>({ type: '', person: '', date: '', folder: '' });
const searchResults = ref<FilesItem[] | null>(null); const searchInput = ref<HTMLInputElement | null>(null);
const selectedKeys = ref(new Set<string>()); const uploadProgress = ref<{ current: number; total: number; name: string; percent: number; done: boolean } | null>(null);
const operationError = ref(''); const actionTarget = ref<DisplayEntry | null>(null);
const uploadLog = ref<{ name: string; percent: number; done: boolean }[]>([]);
// In-progress upload first, then the ones already finished in this batch (the stream only reports the current file).
const uploadItems = computed(() => [...uploadLog.value.filter(item => !item.done), ...uploadLog.value.filter(item => item.done).reverse()]);
const selected = ref<DisplayEntry | null>(null); const detailTab = ref<'details' | 'versions'>('details');
const dragging = ref(false); let refreshTimer:ReturnType<typeof setInterval> | undefined;
const starred = ref(new Set<string>());
const shareTarget = ref<{ id:string; name:string; folder:boolean; path:string; collectionId:string; orgId?:string; ownerUserId?:string; assetKind?:'file' | 'capture' | 'artifact' } | null>(null);

const activeFiles = computed(() => snapshot.value?.files.filter(file => !file.deletedAt) ?? []);
const trashFiles = computed(() => snapshot.value?.files.filter(file => file.deletedAt) ?? []);
const totalBytes = computed(() => activeFiles.value.reduce((sum, file) => sum + file.size, 0));
const quotaBytes = computed(() => snapshot.value?.collection.storageQuota);
const storagePercent = computed(() => quotaBytes.value ? Math.min(100, Math.max(1, totalBytes.value / quotaBytes.value * 100)) : 0);
const storageWhere = computed(() => snapshot.value?.status.serverConfigured ? 'on server' : 'on this Mac');
const sharedFolders = computed(() => snapshot.value?.collection.sharedFolders ?? []);
const syncState = computed(() => snapshot.value?.status.state ?? 'error');
const retentionDays = computed(() => Number(snapshot.value?.collection.retentionPolicy?.trashDays ?? 90));
const locationWord = computed(() => ({ local: 'local', server: 'server', cloud: 'Sulla Cloud' }[snapshot.value?.status.location ?? (snapshot.value?.status.serverConfigured ? 'server' : 'local')]));
const brandLine = computed(() => `${ snapshot.value?.collection.accountName || 'Files' } · ${ locationWord.value }`);
const syncLine = computed(() => {
  const status = snapshot.value?.status;
  if (!status) return 'Checking sync…';
  if (status.state === 'syncing') return `Syncing ${ status.pendingFiles || '' } file${ status.pendingFiles === 1 ? '' : 's' }`.replace('  ', ' ');
  if (status.state === 'paused') return 'Sync paused · click to resume';
  if (status.state === 'conflict') return 'A file needs a decision';
  if (status.state === 'error') return 'Not syncing · files safe on this Mac';
  if (!status.serverConfigured) return 'Local only · files saved on this Mac';
  return `All files synced${ status.lastSyncAt ? ` · ${ timeAgo(status.lastSyncAt) }` : '' }`;
});
const syncTooltip = computed(() => syncState.value === 'paused' ? 'Resume Files sync' : 'Pause Files sync');
const rootLabel = computed(() => ({ files: 'My Files', shared: 'Shared with me', sharedByMe: 'Shared by me', recent: 'Recent', starred: 'Starred', agent: 'Agent files', trash: 'Trash' }[section.value]));
const pageTitle = computed(() => section.value === 'files' && currentPath.value ? currentPath.value.split('/').at(-1) : rootLabel.value);
const crumbs = computed(() => section.value === 'files' ? currentPath.value.split('/').filter(Boolean).map((label, index, parts) => ({ label, path: parts.slice(0, index + 1).join('/') })) : []);
const summaryText = computed(() => `${ visibleEntries.value.length } item${ visibleEntries.value.length === 1 ? '' : 's' } · ${ formatBytes(visibleEntries.value.reduce((sum, entry) => sum + entry.size, 0)) }`);
const accountName = computed(() => snapshot.value?.collection.accountName || 'Signed-in user');
const accountLine = computed(() => {
  const raw = snapshot.value?.collection.accountRole;
  const role = raw ? ({ manage: 'Owner', owner: 'Owner', edit: 'Editor', view: 'Viewer' }[raw] ?? raw.charAt(0).toUpperCase() + raw.slice(1)) : 'Role unavailable';
  const desktops = snapshot.value?.collection.desktopCount;

  return desktops === undefined ? role : `${ role } · ${ desktops } desktop${ desktops === 1 ? '' : 's' }`;
});
// One badge per agent run that left files behind, matching the mockup's "Agent files 2".
const agentCount = computed(() => new Set(activeFiles.value.filter(file => file.createdByType === 'agent-run').map(file => file.createdById)).size);
const sections = computed(() => [
  { id: 'files' as Section, label: 'My Files', icon: icons.folderLine, count: 0, warn: false },
  { id: 'shared' as Section, label: 'Shared with me', icon: icons.users, count: sharedFolders.value.length, warn: false },
  { id: 'sharedByMe' as Section, label: 'Shared by me', icon: icons.share, count: 0, warn: false },
  { id: 'recent' as Section, label: 'Recent', icon: icons.clock, count: 0, warn: false },
  { id: 'starred' as Section, label: 'Starred', icon: icons.star, count: 0, warn: false },
  { id: 'agent' as Section, label: 'Agent files', icon: icons.agent, count: agentCount.value, warn: true },
  { id: 'trash' as Section, label: 'Trash', icon: icons.trash, count: 0, warn: false },
]);
const emptyTitle = computed(() => ({ files: 'This folder is empty', shared: 'Nothing shared with you yet', sharedByMe: 'No public links yet', recent: 'No recent files', starred: 'No starred files', agent: 'No agent files to keep', trash: 'Trash is empty' }[section.value]));
const emptyCopy = computed(() => ({ files: 'Drop files here or choose files. They stay in ~/sulla/Files.', shared: 'Folders teammates share with you appear here.', sharedByMe: 'Links you create appear here.', recent: 'Files you change will appear here.', starred: 'Star important files to find them quickly.', agent: 'Files created by agent runs will appear here with their provenance.', trash: `Deleted files stay recoverable for ${ retentionDays.value } days.` }[section.value]));
const dropCopy = computed(() => snapshot.value?.status.serverConfigured ? 'Or paste a screenshot. Files sync to the server and are versioned on every change.' : 'Or paste a screenshot. Files stay on this Mac and are versioned on every change.');
const filters = computed(() => [
  { key: 'type' as const, label: 'Type', any: 'Any', options: [...new Set(activeFiles.value.map(file => kindLabel(file.mime, file.path)))].sort() },
  { key: 'person' as const, label: 'Person', any: 'Anyone', options: [...new Set(activeFiles.value.map(ownerName))].sort() },
  { key: 'date' as const, label: 'Date', any: 'Any time', options: ['Today', 'This week', 'Earlier'] },
  { key: 'folder' as const, label: 'Folder', any: 'This folder', options: [...new Set(activeFiles.value.filter(file => file.path.includes('/')).map(file => file.path.split('/')[0]))].sort() },
]);
const sortLabel = computed(() => ({ name: 'Name', modified: 'Modified', size: 'Size', type: 'Type' }[sort.value] ?? 'Name'));

function fileGlyph(mime:string, path = ''):{ icon: string; className: string } {
  const ext = path.split('.').at(-1)?.toLowerCase() ?? '';
  if (mime.startsWith('image/')) return { icon: icons.image, className: 'img' };
  if (mime.startsWith('video/')) return { icon: icons.video, className: 'vid' };
  if (mime.startsWith('audio/')) return { icon: icons.audio, className: 'aud' };
  if (mime === 'application/pdf') return { icon: icons.pdf, className: 'pdf' };
  if (isArchive(mime, ext)) return { icon: icons.zip, className: 'zip' };
  if (/json|yaml|javascript|typescript|x-sh|x-python/.test(mime) || ['js', 'ts', 'json', 'yaml', 'yml', 'py', 'sh', 'vue', 'css', 'html'].includes(ext)) return { icon: icons.code, className: 'code' };
  if (mime.startsWith('text/') || /document|msword|rtf|opendocument/.test(mime)) return { icon: icons.doc, className: 'doc' };
  return { icon: icons.file, className: 'zip' };
}
function isArchive(mime:string, ext:string) { return /zip|x-tar|gzip|x-7z|x-rar|compressed/.test(mime) || ['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(ext) }
function mimeFromName(name:string) { const ext = name.split('.').at(-1)?.toLowerCase() ?? ''; return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf', zip: 'application/zip', md: 'text/markdown', txt: 'text/plain' } as Record<string, string>)[ext] ?? 'application/octet-stream' }
function kindLabel(mime:string, path = '') {
  const ext = path.split('.').at(-1)?.toLowerCase() ?? '';
  if (mime === 'inode/directory') return 'Folder';
  if (mime.includes('markdown') || ext === 'md') return 'Markdown';
  if (mime.startsWith('image/')) return (ext || mime.split('/')[1]).toUpperCase();
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime === 'application/pdf') return 'PDF';
  if (isArchive(mime, ext)) return 'Archive';
  if (mime.startsWith('text/')) return 'Text';
  return ext ? ext.toUpperCase() : 'File';
}
function toDisplay(file:FilesItem):DisplayEntry {
  const glyph = fileGlyph(file.mime, file.path); const conflict = entrySync(file) === 'conflict';

  return { ...file, key: file.id, name: file.path.split('/').at(-1) || file.path, folder: false, agent: file.createdByType === 'agent-run', childCount: 0, kindClass: glyph.className, icon: glyph.icon, subtitle: conflict ? `Edited on ${ file.conflictDevices || 2 } desktops at once · pick a version` : `${ kindLabel(file.mime, file.path) } · v${ file.versionCount }` };
}
function folderEntry(prefix:string, name:string, children:FilesItem[]):DisplayEntry {
  const newest = [...children].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const agent = children.length > 0 && children.every(file => file.createdByType === 'agent-run');
  const state = children.some(file => entrySync(file) === 'conflict') ? 'conflict' : children.some(file => entrySync(file) === 'syncing') ? 'syncing' : children.length && children.every(file => entrySync(file) === 'online-only') ? 'online-only' : 'synced';
  const where = agent ? 'made by an agent' : state === 'online-only' ? 'online only' : 'kept on this computer';
  const size = children.reduce((sum, file) => sum + file.size, 0);

  return { id: `folder:${ prefix }${ name }`, key: `folder:${ prefix }${ name }`, path: `${ prefix }${ name }`, name, folder: true, agent, childCount: children.length, kindClass: agent ? 'folder agent' : 'folder', icon: agent ? icons.agent : icons.folder, subtitle: `${ children.length } file${ children.length === 1 ? '' : 's' } · ${ where }`, mime: 'inode/directory', size, updatedAt: newest?.updatedAt ?? '', currentVersionId: '', versionCount: 0, createdByType: newest?.createdByType ?? 'user', createdById: newest?.createdById ?? '', ownerDisplayName: newest?.ownerDisplayName, ownerAvatarUrl: newest?.ownerAvatarUrl, syncState: state as FilesItem['syncState'] };
}
const visibleEntries = computed<DisplayEntry[]>(() => {
  let files = section.value === 'trash' ? trashFiles.value : searchResults.value ?? activeFiles.value;
  if (section.value === 'agent') files = files.filter(file => file.createdByType === 'agent-run');
  if (section.value === 'starred') files = files.filter(file => starred.value.has(file.id));
  if (section.value === 'recent') files = [...files].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 50);
  if (section.value === 'shared') files = files.filter(file => sharedFolders.value.some(folder => file.path.startsWith(`${ folder }/`)));
  const search = query.value.trim().toLowerCase();
  if (search && section.value === 'trash') files = files.filter(file => file.path.toLowerCase().includes(search));
  const flat = Boolean(search) || ['recent', 'starred', 'trash'].includes(section.value);
  const prefix = currentPath.value && section.value === 'files' ? `${ currentPath.value }/` : '';
  const entries:DisplayEntry[] = []; const folders = new Set<string>();
  for (const file of files) {
    if (!flat && !file.path.startsWith(prefix)) continue;
    const relative = flat ? file.path : file.path.slice(prefix.length); const parts = relative.split('/');
    if (!flat && parts.length > 1) folders.add(parts[0]); else if (file.mime !== 'inode/directory') entries.push(toDisplay(file));
  }
  for (const name of folders) entries.push(folderEntry(prefix, name, files.filter(file => file.path.startsWith(`${ prefix }${ name }/`))));
  if (section.value === 'starred') {
    for (const key of starred.value) {
      if (!key.startsWith('folder:')) continue;
      const path = key.slice('folder:'.length); const children = activeFiles.value.filter(file => file.path.startsWith(`${ path }/`));
      if (children.length) entries.push(folderEntry(`${ path.split('/').slice(0, -1).join('/') }${ path.includes('/') ? '/' : '' }`, path.split('/').at(-1)!, children));
    }
  }
  const filtered = entries.filter(entry => (!activeFilters.value.type || kindLabel(entry.mime, entry.path) === activeFilters.value.type) && (!activeFilters.value.person || ownerName(entry) === activeFilters.value.person) && (!activeFilters.value.folder || entry.path.split('/')[0] === activeFilters.value.folder) && (!activeFilters.value.date || dateBucket(entry.updatedAt) === activeFilters.value.date));
  return filtered.sort((a, b) => { if (a.folder !== b.folder) return a.folder ? -1 : 1; if (a.agent !== b.agent) return a.agent ? 1 : -1; if (sort.value === 'modified') return Date.parse(b.updatedAt || '0') - Date.parse(a.updatedAt || '0'); if (sort.value === 'size') return b.size - a.size; if (sort.value === 'type') return a.mime.localeCompare(b.mime); return a.name.localeCompare(b.name, undefined, { numeric: true }) });
});
const groups = computed(() => [
  { label: 'Folders', entries: visibleEntries.value.filter(entry => entry.folder) },
  { label: 'Files', entries: visibleEntries.value.filter(entry => !entry.folder) },
].filter(group => group.entries.length));
const allVisibleSelected = computed(() => Boolean(visibleEntries.value.length) && visibleEntries.value.every(entry => selectedKeys.value.has(entry.key)));
const selectedFileForShare = computed(() => visibleEntries.value.find(entry => !entry.folder && selectedKeys.value.has(entry.key)) ?? selected.value);
const selectedEntries = computed(() => visibleEntries.value.filter(entry => selectedKeys.value.has(entry.key)));

async function refresh(silent = false) { if (!silent) loading.value = true; try { snapshot.value = await props.dataSource.load(); const stars = await props.dataSource.listStars(snapshot.value.collection.id); starred.value = new Set(stars.map(star => star.fileId ?? `folder:${ star.folderPath }`)); error.value = ''; selectedKeys.value = new Set([...selectedKeys.value].filter(key => visibleEntries.value.some(entry => entry.key === key))) } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { loading.value = false } }
async function upload() { busy.value = true; try { const count = await props.dataSource.chooseUpload(currentPath.value); if (count) setTimeout(() => refresh(true), 700); } finally { busy.value = false } }
async function newFolder() { const name = window.prompt('Name this folder'); if (!name?.trim()) return; await props.dataSource.createFolder([currentPath.value, name.trim()].filter(Boolean).join('/')); await refresh(true) }
function shareEntry(entry:DisplayEntry | null) {
  if (!entry || entry.folder || !props.dataSource.createPublicLink || !snapshot.value) return;
  const capture = /(^|\/)(screenshots?|recordings?|captures?)(\/|$)/i.test(entry.path);
  shareTarget.value = { id: entry.id, name: entry.name, folder: false, path: entry.path, collectionId: snapshot.value.collection.id, orgId: snapshot.value.collection.orgId, ownerUserId: snapshot.value.collection.ownerUserId, assetKind: entry.agent ? 'artifact' : capture ? 'capture' : 'file' };
}
function shareSelectedFile() { shareEntry(selectedFileForShare.value ?? null) }
function shareCurrentFolder() {
  if (!snapshot.value?.collection.orgId || !props.dataSource.shareFolder || !props.dataSource.listMembers || !currentPath.value || !props.dataSource.capabilities.orgSharing) return;
  shareTarget.value = { id: `folder:${ currentPath.value }`, name: currentPath.value.split('/').at(-1) || 'My Files', folder: true, path: currentPath.value, collectionId: snapshot.value.collection.id, orgId: snapshot.value.collection.orgId, ownerUserId: snapshot.value.collection.ownerUserId };
}
async function togglePause() { if (!snapshot.value) return; snapshot.value.status = await props.dataSource.setPaused(syncState.value !== 'paused') }
function selectSection(next:Section) { section.value = next; currentPath.value = ''; query.value = ''; searchResults.value = null; selected.value = null; selectedKeys.value = new Set() }
function openRoot() { section.value = 'files'; currentPath.value = ''; selected.value = null; selectedKeys.value = new Set() }
function openPath(next:string) { section.value = 'files'; currentPath.value = next; selected.value = null; selectedKeys.value = new Set() }
function focusEntry(entry:DisplayEntry, event:MouseEvent) { if (event.metaKey || event.ctrlKey) { toggleSelected(entry.key); return } selectedKeys.value = new Set([entry.key]) }
function activate(entry:DisplayEntry) { if (entry.folder) openPath(entry.path); else selectEntry(entry); }
function resolveConflict(entry:DisplayEntry) { selectedKeys.value = new Set([entry.key]); selectEntry(entry) }
function selectEntry(entry:DisplayEntry) { if (entry.folder) { openPath(entry.path); return } selected.value = entry; detailTab.value = entrySync(entry) === 'conflict' ? 'versions' : 'details' }
async function openLinked(fileId:string) { const file = snapshot.value?.files.find(item => item.id === fileId); if (file) selectEntry(toDisplay(file)); else await props.dataSource.openFile(fileId); }
function onDragLeave(event:DragEvent) { if (!event.currentTarget || !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) dragging.value = false; }
async function onDrop(event:DragEvent) { dragging.value = false; const paths = [...(event.dataTransfer?.files ?? [])].map(file => (file as File & { path?: string }).path).filter((value):value is string => Boolean(value)); if (!paths.length) { error.value = 'This Desktop build cannot read dropped file paths. Use Choose files instead.'; return } busy.value = true; try { await props.dataSource.uploadPaths(paths, currentPath.value); setTimeout(() => refresh(true), 700) } finally { busy.value = false } }
function formatBytes(bytes:number) { if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); const value = bytes / 1024 ** index; return `${ index < 2 || value >= 100 ? Math.round(value) : Number(value.toFixed(1)) } ${ units[index] }` }
function formatDate(value:string, detailed = false) { if (!value) return '—'; const date = new Date(value); return new Intl.DateTimeFormat(undefined, detailed ? { dateStyle: 'medium', timeStyle: 'short' } : { month: 'short', day: 'numeric' }).format(date) }
function dayLabel(date:Date) { const now = new Date(); if (date.toDateString() === now.toDateString()) return 'Today'; const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1); if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'; return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date) }
function formatRelative(value:string) { if (!value) return '—'; const date = new Date(value); return `${ dayLabel(date) }, ${ new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date) }` }
function formatShort(value:string) { return value ? dayLabel(new Date(value)) : '—' }
function timeAgo(value:string) { const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000)); if (minutes < 1) return 'just now'; if (minutes < 60) return `${ minutes } min ago`; const hours = Math.round(minutes / 60); return hours < 24 ? `${ hours } hr ago` : formatShort(value) }
function dateBucket(value:string) { const age = Date.now() - Date.parse(value || '0'); return age < 86_400_000 ? 'Today' : age < 604_800_000 ? 'This week' : 'Earlier' }
function ownerName(entry:FilesItem) { const collection = snapshot.value?.collection; if (!entry.ownerDisplayName && entry.createdByType !== 'agent-run' && collection?.accountName && collection.ownerUserId && entry.createdById === collection.ownerUserId) return collection.accountName; return entry.ownerDisplayName || (entry.createdByType === 'agent-run' ? entry.createdById || 'Sulla agent' : entry.createdById || 'Unknown owner') }
function initials(name:string) { const words = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean); return ((words[0]?.[0] ?? '?') + (words.length > 1 ? words[1][0] : '')).toUpperCase() }
function ownerInitials(entry:FilesItem) { return entry.createdByType === 'agent-run' ? ownerName(entry).charAt(0).toUpperCase() : initials(ownerName(entry)) }
function avatarClass(entry:FilesItem) { if (entry.createdByType === 'agent-run') return 'a'; const name = ownerName(entry); if (name === accountName.value || name.toLowerCase() === snapshot.value?.collection.accountName?.toLowerCase()) return ''; const tones = ['m', 'd', 'p']; return tones[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % tones.length] }
function entrySync(entry:FilesItem) { return entry.syncState || (/\(conflicted copy [^)]+\)/i.exec(entry.path) ? 'conflict' : syncState.value === 'syncing' ? 'syncing' : 'synced') }
function syncClass(entry:FilesItem) { return ({ synced: 'local', syncing: 'syncing', 'online-only': 'online', conflict: 'conflict' } as Record<string, string>)[entrySync(entry)] ?? 'local' }
function syncIcon(entry:FilesItem) { return ({ synced: icons.syncLocal, syncing: icons.syncSpin, 'online-only': icons.syncOnline, conflict: icons.alert } as Record<string, string>)[entrySync(entry)] ?? icons.syncLocal }
function syncText(entry:FilesItem) { return ({ synced: 'On this computer', syncing: 'Syncing', 'online-only': 'Online only', conflict: 'Conflict' } as Record<string, string>)[entrySync(entry)] ?? 'On this computer' }
function clearFilters() { activeFilters.value = { type: '', person: '', date: '', folder: '' } }
function toggleSelected(key:string) { const next = new Set(selectedKeys.value); next.has(key) ? next.delete(key) : next.add(key); selectedKeys.value = next }
function toggleAll() { selectedKeys.value = allVisibleSelected.value ? new Set() : new Set(visibleEntries.value.map(entry => entry.key)) }
async function toggleStar(id:string) { if (!snapshot.value) return; const entry = visibleEntries.value.find(item => item.id === id); if (!entry) return; const next = !starred.value.has(id); try { await props.dataSource.setStar(snapshot.value.collection.id, entry.folder ? { folderPath: entry.path } : { fileId: entry.id }, next); const changed = new Set(starred.value); next ? changed.add(id) : changed.delete(id); starred.value = changed } catch (cause) { operationError.value = cause instanceof Error ? cause.message : String(cause) } }
function openActions(entry:DisplayEntry) { if (!selectedKeys.value.has(entry.key)) selectedKeys.value = new Set([entry.key]); actionTarget.value = entry }
function joinPath(folder:string, name:string) { return [folder.replace(/^\/+|\/+$/g, ''), name].filter(Boolean).join('/') }
function operationItems(entries:DisplayEntry[], destination:string) { return entries.map(entry => ({ ...(entry.folder ? { folderPath: entry.path } : { fileId: entry.id }), targetPath: joinPath(destination, entry.name) })) }
async function perform(action:'move' | 'copy', items:{ fileId?:string; folderPath?:string; targetPath:string }[]) { if (!snapshot.value) return; busy.value = true; operationError.value = ''; try { await props.dataSource.operate(action, snapshot.value.collection.id, items); selectedKeys.value = new Set(); actionTarget.value = null; await refresh(true) } catch (cause) { operationError.value = cause instanceof Error ? cause.message : String(cause); await refresh(true) } finally { busy.value = false } }
async function renameSelected() { const entry = selectedEntries.value[0]; if (!entry || selectedEntries.value.length !== 1) return; const name = window.prompt('New name', entry.name)?.trim(); if (!name || name.includes('/')) { if (name) operationError.value = 'Names cannot contain “/”.'; return } const parent = entry.path.split('/').slice(0, -1).join('/'); await perform('move', [{ ...(entry.folder ? { folderPath: entry.path } : { fileId: entry.id }), targetPath: joinPath(parent, name) }]) }
async function moveSelected() { const entries = selectedEntries.value; if (!entries.length) return; const destination = window.prompt('Move to folder', currentPath.value)?.trim(); if (destination === undefined) return; await perform('move', operationItems(entries, destination)) }
async function copySelected() { const entries = selectedEntries.value; if (!entries.length) return; const destination = window.prompt('Copy to folder', currentPath.value)?.trim(); if (destination === undefined) return; await perform('copy', operationItems(entries, destination)) }
async function downloadSelected() { const entries = selectedEntries.value.filter(entry => !entry.folder); if (!entries.length) return; busy.value = true; operationError.value = ''; try { const result = await props.dataSource.downloadFiles(entries.map(entry => ({ fileId: entry.id, name: entry.name, versionId: entry.currentVersionId }))); if (result.error) { operationError.value = result.error; } } catch (cause) { operationError.value = cause instanceof Error ? cause.message : String(cause) } finally { busy.value = false } }
async function trashSelected() { const entries = selectedEntries.value; const files = new Map<string, FilesItem>(); for (const entry of entries) { if (!entry.folder) files.set(entry.id, entry); else for (const file of activeFiles.value.filter(file => file.path.startsWith(`${ entry.path }/`))) files.set(file.id, file) } busy.value = true; operationError.value = ''; try { for (const file of files.values()) await props.dataSource.trashFile(file.id); selectedKeys.value = new Set(); actionTarget.value = null; } catch (cause) { operationError.value = cause instanceof Error ? cause.message : String(cause) } finally { await refresh(true); busy.value = false } }
async function runTargetAction(action:'rename' | 'move' | 'copy' | 'download' | 'trash') { if (!actionTarget.value) return; selectedKeys.value = new Set([actionTarget.value.key]); if (action === 'rename') await renameSelected(); else if (action === 'move') await moveSelected(); else if (action === 'copy') await copySelected(); else if (action === 'download') await downloadSelected(); else await trashSelected(); }
function trackUpload(progress:{ current: number; name: string; percent: number; done: boolean }) { const log = progress.current <= 1 && !uploadLog.value.some(item => item.name === progress.name) ? [] : uploadLog.value.map(item => item.name === progress.name ? item : { ...item, done: true, percent: 100 }); const rest = log.filter(item => item.name !== progress.name); uploadLog.value = [...rest, { name: progress.name, percent: progress.percent, done: progress.done || progress.percent >= 100 }] }
function onKeydown(event:KeyboardEvent) { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput.value?.focus() } }
function navigateTo(detail:FilesNavigationPayload) {
  if (detail.section === 'shared-by-me') { selectSection('sharedByMe'); return }
  const file = snapshot.value?.files.find(item => item.id === detail.fileId) ?? snapshot.value?.files.find(item => item.path === detail.path);
  if (!file && detail.path) {
    openPath(detail.path);
    if (detail.section === 'share-review') shareCurrentFolder();
    return;
  }
  if (!file) { error.value = 'That file is no longer available in this collection.'; return }
  selectEntry(toDisplay(file));
  if (detail.section === 'versions') detailTab.value = 'versions';
  if (detail.section === 'share-review') shareEntry(toDisplay(file));
}

watch(view, value => localStorage.setItem('sulla:files-view', value));
let searchTimer:ReturnType<typeof setTimeout> | undefined;
watch(query, (value) => { if (searchTimer) clearTimeout(searchTimer); if (!value.trim() || section.value === 'trash') { searchResults.value = null; return } searchTimer = setTimeout(async() => { try { searchResults.value = await props.dataSource.search(value.trim()) } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } }, 220) });
let mounted = false;
function consumeNavigation() { if (!mounted || !props.navigation || !snapshot.value) return; navigateTo(props.navigation); emit('navigation-consumed') }
watch(() => props.navigation, () => consumeNavigation());
let stopUploadProgress:(() => void) | undefined;
onMounted(async() => { mounted = true; window.addEventListener('keydown', onKeydown); stopUploadProgress = props.dataSource.onUploadProgress?.((progress) => { trackUpload(progress); uploadProgress.value = progress; if (progress.done) setTimeout(() => { uploadProgress.value = null; uploadLog.value = [] }, 2200); }); await refresh(); consumeNavigation(); refreshTimer = setInterval(async() => { await refresh(true); consumeNavigation() }, 12_000) });
onBeforeUnmount(() => { mounted = false; window.removeEventListener('keydown', onKeydown); stopUploadProgress?.(); if (refreshTimer) clearInterval(refreshTimer); });
</script>

<style scoped>
/* Ported from the approved Files mockup (mockups/files/01-files.html). Sizes, spacing and
   type are copied as-is; colors map to Noir tokens, with Noir Light pinned to the mockup values. */
.files-browser {
  --text: var(--nx-read-1, #f3f5f8);
  --muted: var(--nx-read-3, #a9b3c1);
  --dim: var(--nx-read-4, #7a8291);
  --paper: var(--nx-paper, #01030a);
  --paper-2: color-mix(in srgb, var(--nx-read-1, #f3f5f8) 7%, var(--nx-paper, #01030a));
  --card: color-mix(in srgb, var(--nx-surface, #070d1a) 82%, transparent);
  --card-solid: var(--nx-surface, #070d1a);
  --line: var(--nx-hair, rgba(168, 192, 220, .08));
  --line-2: var(--nx-hair-strong, rgba(168, 192, 220, .16));
  --accent: var(--nx-accent, #5096b3);
  --accent-2: var(--nx-accent-2, #6ab0cc);
  --accent-soft: color-mix(in srgb, var(--nx-accent, #5096b3) 14%, transparent);
  --accent-line: color-mix(in srgb, var(--nx-accent, #5096b3) 40%, transparent);
  --ok: var(--nx-success, #3fb950);
  --ok-soft: color-mix(in srgb, var(--nx-success, #3fb950) 14%, transparent);
  --warn: var(--nx-warning, #e3b341);
  --warn-soft: color-mix(in srgb, var(--nx-warning, #e3b341) 15%, transparent);
  --bad: var(--nx-danger, #f85149);
  --bad-soft: color-mix(in srgb, var(--nx-danger, #f85149) 13%, transparent);
  --idle-soft: color-mix(in srgb, var(--nx-read-4, #7a8291) 18%, transparent);
  --ink-05: color-mix(in srgb, var(--nx-ink, #f3f5f8) 5%, transparent);
  --ink-08: color-mix(in srgb, var(--nx-ink, #f3f5f8) 8%, transparent);
  --nav-bg: color-mix(in srgb, var(--nx-surface, #070d1a) 55%, transparent);
  --top-bg: color-mix(in srgb, var(--nx-surface, #070d1a) 40%, transparent);
  --glow-1: color-mix(in srgb, var(--nx-accent, #5096b3) 10%, transparent);
  --glow-2: color-mix(in srgb, var(--nx-accent, #5096b3) 6%, transparent);
  --fi-img: #a993e6; --fi-img-bg: rgba(147, 120, 220, .16);
  --fi-vid: var(--bad); --fi-vid-bg: color-mix(in srgb, var(--nx-danger, #f85149) 14%, transparent);
  --fi-pdf: var(--warn); --fi-pdf-bg: color-mix(in srgb, var(--nx-warning, #e3b341) 15%, transparent);
  --fi-aud: var(--ok); --fi-aud-bg: color-mix(in srgb, var(--nx-success, #3fb950) 14%, transparent);
  --shadow: 0 1px 2px rgba(0, 0, 0, .2), 0 10px 30px -12px rgba(0, 0, 0, .5);
  --shadow-sm: 0 1px 1px rgba(0, 0, 0, .2), 0 2px 8px -2px rgba(0, 0, 0, .4);
  --shadow-lg: 0 2px 4px rgba(0, 0, 0, .3), 0 30px 60px -20px rgba(0, 0, 0, .7);
  --sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  --r: 12px;

  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  overflow: hidden;
  container-type: inline-size;
  font-family: var(--sans);
  color: var(--text);
  background: var(--paper);
  background-image: radial-gradient(900px 500px at 15% -10%, var(--glow-1), transparent 60%), radial-gradient(700px 400px at 100% 0%, var(--glow-2), transparent 55%);
  font-size: 13px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  font-feature-settings: "tnum" 1, "cv11" 1;
}
.selection-bar { display:flex; align-items:center; gap:8px; margin:0 0 12px; padding:8px 10px; border:1px solid var(--accent-line); border-radius:8px; background:var(--accent-soft); }
.selection-bar b { margin-right:auto; font-size:12px; }
.operation-error { display:flex; align-items:center; gap:8px; margin:0 0 12px; padding:9px 11px; border:1px solid color-mix(in srgb, var(--bad) 40%, transparent); border-radius:8px; background:var(--bad-soft); color:var(--bad); }
.operation-error .btn { margin-left:auto; }
.action-menu { position:absolute; z-index:20; top:122px; right:32px; width:190px; padding:6px; border:1px solid var(--line-2); border-radius:10px; background:var(--card-solid); box-shadow:var(--shadow-lg); }
.action-menu b { display:block; padding:7px 9px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.action-menu button { display:block; width:100%; padding:7px 9px; border:0; border-radius:6px; background:transparent; color:var(--text); text-align:left; }
.action-menu button:hover { background:var(--ink-05); }
.action-menu button.danger { color:var(--bad); }
/* Noir Light reproduces the approved mockup palette exactly. */
:global(.theme-noir-light) .files-browser {
  --muted: #5b6778;
  --dim: #8a94a3;
  --paper-2: #eaf0f6;
  --line: rgba(26, 35, 50, .09);
  --line-2: rgba(26, 35, 50, .14);
  --accent-2: #2f6a86;
  --accent-soft: rgba(58, 127, 160, .10);
  --accent-line: rgba(58, 127, 160, .32);
  --ok: #1f9d55; --ok-soft: rgba(31, 157, 85, .12);
  --warn: #d98a0a; --warn-soft: rgba(217, 138, 10, .13);
  --bad: #d9403a; --bad-soft: rgba(217, 64, 58, .11);
  --idle-soft: rgba(138, 148, 163, .16);
  --fi-img: #6b4fbf; --fi-img-bg: rgba(107, 79, 191, .12);
  --fi-vid: #c0392b; --fi-vid-bg: rgba(217, 64, 58, .10);
  --fi-pdf: #b26f05; --fi-pdf-bg: rgba(217, 138, 10, .13);
  --fi-aud: #167a42; --fi-aud-bg: rgba(31, 157, 85, .12);
  --shadow: 0 1px 2px rgba(26, 35, 50, .04), 0 10px 30px -12px rgba(26, 35, 50, .12);
  --shadow-sm: 0 1px 1px rgba(26, 35, 50, .04), 0 2px 8px -2px rgba(26, 35, 50, .08);
  --shadow-lg: 0 2px 4px rgba(26, 35, 50, .06), 0 30px 60px -20px rgba(26, 35, 50, .28);
}

.files-browser *, .files-browser *::before, .files-browser *::after { box-sizing: border-box; }
.files-browser a { color: inherit; text-decoration: none; }
.files-browser button { font: inherit; color: inherit; cursor: pointer; }
.files-browser input { font: inherit; color: inherit; }

/* Sidebar */
.nav { position: relative; width: 224px; height: 100%; min-height: 0; overflow-y: auto; padding: 18px 14px; border-right: 1px solid var(--line); background: var(--nav-bg); backdrop-filter: blur(14px); display: flex; flex-direction: column; gap: 4px; }
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 16px; }
.brand .mark { width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, #3a7fa0, #1a2332); display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 13px; letter-spacing: .02em; flex: none; }
.brand b { display: block; font-size: 13px; letter-spacing: .01em; }
.brand span { display: block; font-size: 11px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
.nav a { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 9px; color: var(--muted); font-weight: 500; }
.nav a .sv { display: grid; width: 16px; height: 16px; flex: none; opacity: .8; }
.nav a .sv :deep(svg) { width: 16px; height: 16px; }
.nav a:hover { background: var(--ink-05); color: var(--text); }
.nav a.on { background: var(--accent-soft); color: var(--accent-2); font-weight: 600; }
.nav a.on .sv { opacity: 1; }
.nav a .cnt { margin-left: auto; font-size: 11px; font-weight: 600; background: var(--paper-2); color: var(--muted); padding: 1px 7px; border-radius: 999px; }
.nav a .cnt.warn { background: var(--warn-soft); color: var(--warn); }
.nav .sep { height: 1px; background: var(--line); margin: 10px 8px; }
.nav .grp { font-size: 10.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); padding: 8px 10px 4px; }
.nav .quota { padding: 10px 10px 6px; font-size: 11px; color: var(--muted); }
.nav .quota .bar { height: 4px; border-radius: 2px; background: var(--paper-2); overflow: hidden; margin: 6px 0 4px; }
.nav .quota .bar i { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
.nav .quota b { color: var(--text); font-weight: 600; }
.nav .quota > span { display: block; }
.nav .quota.nobar > span { margin-top: 4px; }
.syncline { display: flex; align-items: center; gap: 7px; padding: 8px 10px; font-size: 11.5px; color: var(--muted); border-radius: 9px; background: color-mix(in srgb, var(--nx-surface, #070d1a) 60%, transparent); border: 1px solid var(--line); margin-top: 8px; text-align: left; }
.syncline .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); flex: none; }
.syncline .dot.syncing { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.syncline .dot.paused { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); }
.syncline .dot.error, .syncline .dot.conflict { background: var(--bad); box-shadow: 0 0 0 3px var(--bad-soft); }
.nav .foot { margin-top: auto; padding: 10px 8px 0; border-top: 1px solid var(--line); display: flex; align-items: center; gap: 10px; }
.nav .foot b { display: block; font-size: 12px; }
.nav .foot small { display: block; color: var(--dim); font-size: 11px; }
.avatar { width: 26px; height: 26px; border-radius: 50%; background: linear-gradient(135deg, #9ec1d3, #3a7fa0); color: #fff; font-size: 11px; font-weight: 700; display: grid; place-items: center; flex: none; object-fit: cover; }
.avatar.m { background: linear-gradient(135deg, #f0c38e, #d98a0a); }
.avatar.d { background: linear-gradient(135deg, #b7a7e0, #6b4fbf); }
.avatar.p { background: linear-gradient(135deg, #9ad7b4, #1f9d55); }
.avatar.a { background: linear-gradient(135deg, #1a2332, #3a7fa0); }
.avatar.sm { width: 20px; height: 20px; font-size: 9px; }

/* Top bar */
.main { min-width: 0; min-height: 0; overflow: auto; }
.top { display: flex; align-items: center; gap: 14px; padding: 12px 28px; border-bottom: 1px solid var(--line); background: var(--top-bg); backdrop-filter: blur(10px); position: sticky; top: 0; z-index: 5; }
.crumbs { display: flex; align-items: center; gap: 6px; color: var(--dim); font-size: 12.5px; white-space: nowrap; }
.crumbs b { color: var(--text); font-weight: 600; }
.crumbs .c { color: var(--muted); }
.crumbs .c:hover { color: var(--accent-2); }
.top .search { display: flex; align-items: center; gap: 8px; flex: 1; max-width: 560px; padding: 6px 10px; border: 1px solid var(--line-2); border-radius: 9px; background: var(--card-solid); color: var(--dim); font-size: 12.5px; min-width: 0; }
.top .search .si { display: grid; width: 14px; height: 14px; flex: none; }
.top .search .si :deep(svg) { width: 14px; height: 14px; }
.top .search input { border: 0; outline: 0; background: transparent; flex: 1; min-width: 0; color: var(--text); padding: 0; }
.top .search input::placeholder { color: var(--dim); }
.top .search kbd { font-family: var(--mono); font-size: 10.5px; border: 1px solid var(--line-2); border-radius: 5px; padding: 1px 5px; color: var(--dim); background: var(--paper); }
.top .acts { margin-left: auto; display: flex; gap: 8px; align-items: center; }

/* Buttons and controls */
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: 8px; border: 1px solid var(--line-2); background: var(--card-solid); font-size: 12.5px; font-weight: 500; color: var(--text); box-shadow: 0 1px 1px rgba(26, 35, 50, .03); white-space: nowrap; line-height: 1.45; }
.btn:hover { border-color: var(--accent-line); color: var(--accent-2); }
.btn.pri { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.pri:hover { background: var(--accent-2); color: #fff; }
.btn.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 35%, transparent); }
.btn.danger:hover { background: var(--bad-soft); }
.btn.sm { padding: 3px 8px; font-size: 11.5px; border-radius: 6px; }
.btn.ghost { background: transparent; border-color: transparent; box-shadow: none; color: var(--muted); }
.btn.ghost:hover { background: var(--ink-05); color: var(--text); }
.btn .bi { display: grid; width: 13px; height: 13px; flex: none; }
.btn .bi :deep(svg) { width: 13px; height: 13px; }
.btn.ico { padding: 6px; width: 30px; height: 30px; justify-content: center; }
.btn:disabled { cursor: not-allowed; opacity: .55; }
.btn[aria-disabled="true"] { cursor: default; }
.seg { display: inline-flex; border: 1px solid var(--line-2); border-radius: 8px; background: var(--card-solid); padding: 2px; gap: 2px; }
.seg button { border: 0; background: transparent; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 500; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; line-height: 1.45; }
.seg button .bi { display: grid; width: 13px; height: 13px; }
.seg button .bi :deep(svg) { width: 13px; height: 13px; }
.seg button.on { background: var(--accent-soft); color: var(--accent-2); font-weight: 600; }
.seg button:hover:not(.on) { color: var(--text); }
.sel { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--card-solid); font-size: 12px; font-weight: 500; color: var(--text); white-space: nowrap; cursor: pointer; }
.sel > span { color: var(--dim); font-weight: 400; }
.sel::after { content: ""; width: 6px; height: 6px; border-right: 1.5px solid var(--dim); border-bottom: 1.5px solid var(--dim); transform: rotate(45deg) translateY(-2px); }
.sel select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; font-size: 12px; }
.pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.pill.idle { background: var(--idle-soft); color: var(--muted); }

/* Page header + filters */
.content { padding: 20px 28px 60px; }
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.toolbar h1 { font-size: 20px; font-weight: 650; letter-spacing: -.01em; margin: 0; font-family: var(--sans); color: var(--text); }
.toolbar .meta { color: var(--dim); font-size: 12px; }
.toolbar .right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.filters { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
.filters .sel.active { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent-2); }
.filters .sel.active > span { color: var(--accent-2); }
.filters .clear { font-size: 12px; color: var(--muted); padding: 5px 8px; border-radius: 7px; border: 0; background: transparent; }
.filters .clear:hover { color: var(--text); background: var(--ink-05); }
.filters .view { margin-left: auto; display: flex; gap: 8px; align-items: center; }

/* List view */
.card { background: var(--card); backdrop-filter: blur(12px); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--shadow); }
.files { overflow: hidden; }
.tbl { width: 100%; border-collapse: collapse; }
.tbl th { font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--dim); font-weight: 600; text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.tbl td { padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; }
.tbl tr:last-child td { border-bottom: 0; }
.tbl td.r, .tbl th.r { text-align: right; }
.files .tbl th:first-child, .files .tbl td:first-child { padding-left: 16px; }
.files .tbl th:last-child, .files .tbl td:last-child { padding-right: 14px; }
.muted { color: var(--muted); }
.files tr.row { cursor: default; }
.files tr.row:hover td { background: color-mix(in srgb, var(--accent) 4.5%, transparent); }
.files tr.row.is-sel td { background: var(--accent-soft); }
tr.row.agent td { background: color-mix(in srgb, var(--nx-ink, #f3f5f8) 2.5%, transparent); }
.tbl tr.sechead td { padding: 10px 16px 4px; border-bottom: 0; font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); font-weight: 600; }
.tbl tr.sechead:not(:first-child) td { padding-top: 14px; }
.files .name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.files .name .t { min-width: 0; }
.files .name .t b { display: block; font-weight: 500; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.files .name .t small { display: block; color: var(--dim); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.files .own { display: flex; align-items: center; gap: 7px; white-space: nowrap; color: var(--muted); }
.files .actions { display: flex; gap: 4px; justify-content: flex-end; opacity: 0; transition: opacity .12s; }
.files tr.row:hover .actions, .files tr.row.is-sel .actions, .files .actions.keep { opacity: 1; }
.files .actions .btn.ico { width: 26px; height: 26px; padding: 4px; border-color: transparent; box-shadow: none; background: transparent; color: var(--muted); }
.files .actions .btn.ico:hover { background: var(--ink-08); color: var(--text); }
.files .actions .btn.ico :deep(svg) { width: 14px; height: 14px; }
.files .actions .btn.ico :deep(.star) { display: grid; width: 14px; height: 14px; }
.chk { width: 14px; height: 14px; padding: 0; border: 1.5px solid var(--line-2); border-radius: 4px; background: var(--card-solid); display: inline-block; vertical-align: middle; position: relative; }
.chk.on { background: var(--accent); border-color: var(--accent); }
.chk.on::after { content: ""; position: absolute; left: 3.5px; top: .5px; width: 4px; height: 7px; border-right: 2px solid #fff; border-bottom: 2px solid #fff; transform: rotate(45deg); }
:deep(.star) { color: var(--dim); }
:deep(.star.on) { color: var(--warn); }

/* File glyphs */
.fi { width: 30px; height: 30px; border-radius: 7px; display: grid; place-items: center; flex: none; position: relative; }
.fi :deep(svg) { width: 17px; height: 17px; }
.fi.folder { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent-2); }
.fi.folder.agent, .fi.code { background: var(--ink-08); color: var(--text); }
.fi.img { background: var(--fi-img-bg); color: var(--fi-img); }
.fi.vid { background: var(--fi-vid-bg); color: var(--fi-vid); }
.fi.pdf { background: var(--fi-pdf-bg); color: var(--fi-pdf); }
.fi.doc { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent-2); }
.fi.aud { background: var(--fi-aud-bg); color: var(--fi-aud); }
.fi.zip { background: var(--idle-soft); color: var(--muted); }

/* Sync state */
.sync { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; }
.sync :deep(svg) { width: 14px; height: 14px; }
.sync.local { color: var(--ok); }
.sync.online { color: var(--dim); }
.sync.syncing { color: var(--accent); }
.sync.syncing :deep(svg) { animation: spin 1.6s linear infinite; }
.sync.conflict { color: var(--bad); }

/* Grid view */
.gridv { display: grid; grid-template-columns: repeat(auto-fill, minmax(188px, 1fr)); gap: 14px; }
.tile { background: var(--card); backdrop-filter: blur(12px); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--shadow-sm); overflow: hidden; position: relative; cursor: default; }
.tile:hover, .tile.is-sel { border-color: var(--accent-line); box-shadow: var(--shadow); }
.tile .th { height: 116px; background: var(--paper-2); display: grid; place-items: center; position: relative; overflow: hidden; }
.tile .th .fi { width: 44px; height: 44px; border-radius: 10px; }
.tile .th .fi :deep(svg) { width: 24px; height: 24px; }
.tile .th .sync { position: absolute; right: 8px; bottom: 8px; background: color-mix(in srgb, var(--nx-surface, #070d1a) 90%, transparent); box-shadow: var(--shadow-sm); width: 22px; height: 22px; }
.tile .folderth { background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 8%, transparent), color-mix(in srgb, var(--accent) 14%, transparent)); }
.tile .agentth { background: color-mix(in srgb, var(--nx-ink, #f3f5f8) 6%, transparent); }
.tile .bd { padding: 10px 12px 11px; }
.tile .bd b { display: block; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12.5px; }
.tile .bd small { display: block; color: var(--dim); font-size: 11px; margin-top: 2px; }

/* Drop zone */
.drop { margin-top: 16px; border: 1.5px dashed var(--accent-line); border-radius: var(--r); padding: 22px; display: flex; align-items: center; gap: 14px; background: color-mix(in srgb, var(--accent) 4%, transparent); color: var(--muted); }
.drop .ico { width: 38px; height: 38px; border-radius: 10px; background: var(--accent-soft); color: var(--accent-2); display: grid; place-items: center; flex: none; }
.drop .ico :deep(svg) { width: 18px; height: 18px; }
.drop b { display: block; color: var(--text); font-weight: 600; font-size: 13px; }
.drop small { display: block; font-size: 12px; color: var(--muted); }
.drop .btn { margin-left: auto; }

/* Upload progress */
.upl { position: absolute; right: 24px; bottom: 24px; width: 320px; background: var(--card-solid); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--shadow-lg); overflow: hidden; z-index: 20; }
.upl .hd { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); font-weight: 600; font-size: 12.5px; }
.upl .hd .btn.ico { margin-left: auto; width: 24px; height: 24px; padding: 3px; border: 0; box-shadow: none; background: transparent; color: var(--dim); }
.upl .hd .btn.ico :deep(svg) { width: 14px; height: 14px; }
.upl .it { display: flex; align-items: center; gap: 10px; padding: 8px 14px; font-size: 12px; }
.upl .it .t { flex: 1; min-width: 0; }
.upl .it .t b { display: block; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.upl .it .t small { display: block; color: var(--dim); font-size: 11px; }
.upl .it .prog { height: 3px; border-radius: 2px; background: var(--paper-2); margin-top: 5px; overflow: hidden; }
.upl .it .prog i { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
.upl .it .fi { width: 26px; height: 26px; }
.upl .it .fi :deep(svg) { width: 14px; height: 14px; }

/* Loading, error and empty states */
.state-panel { display: flex; min-height: 320px; flex-direction: column; align-items: center; justify-content: center; padding: 40px; border: 1px solid var(--line); border-radius: var(--r); color: var(--muted); background: var(--card); box-shadow: var(--shadow); text-align: center; }
.state-panel strong { margin-top: 12px; color: var(--text); font-size: 15px; font-weight: 600; }
.state-panel p { max-width: 430px; margin: 6px 0 16px; }
.state-panel > div { display: flex; gap: 8px; }
.state-icon { display: grid; width: 38px; height: 38px; color: var(--accent-2); }
.state-icon :deep(svg) { width: 38px; height: 38px; }
.error-state .state-icon { color: var(--bad); }
.loader { display: inline-block; width: 22px; height: 22px; border: 2px solid var(--accent-soft); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
.drop-overlay { position: absolute; z-index: 30; inset: 14px; display: flex; flex-direction: column; align-items: center; justify-content: center; border: 1.5px dashed var(--accent-line); border-radius: var(--r); color: var(--accent-2); background: color-mix(in srgb, var(--paper) 90%, transparent); backdrop-filter: blur(12px); }
.drop-overlay > span { display: grid; width: 48px; height: 48px; }
.drop-overlay > span :deep(svg) { width: 48px; height: 48px; }
.drop-overlay strong { margin-top: 12px; color: var(--text); font-size: 15px; font-weight: 600; }
.drop-overlay p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }

/* Detail panel (opened with double-click or the row ⋯ button) */
.detail-panel { position: absolute; z-index: 8; top: 0; right: 0; bottom: 0; width: min(390px, 42vw); overflow: auto; border-left: 1px solid var(--line); background: var(--card-solid); box-shadow: var(--shadow-lg); }
.detail-panel > header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); background: var(--card-solid); }
.detail-panel > header .file-name { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.detail-panel > header .file-name > span:last-child { min-width: 0; }
.detail-panel > header strong, .detail-panel > header small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-panel > header strong { font-weight: 600; }
.detail-panel > header small { color: var(--dim); font-size: 11px; }
.detail-panel > header > button { width: 28px; height: 28px; border: 0; border-radius: 8px; color: var(--dim); background: transparent; font-size: 20px; }
.preview-box { display: grid; min-height: 250px; max-height: 390px; margin: 16px; place-items: center; overflow: hidden; border: 1px solid var(--line); border-radius: var(--r); background: var(--paper-2); }
.preview-box img, .preview-box video, .preview-box iframe { width: 100%; height: 100%; max-height: 388px; object-fit: contain; border: 0; }
.preview-box audio { width: 88%; }
.preview-box pre { width: 100%; height: 100%; max-height: 388px; margin: 0; padding: 16px; overflow: auto; color: var(--muted); font: 11.5px/1.6 var(--mono); white-space: pre-wrap; }
.preview-placeholder { text-align: center; color: var(--dim); }
.large-glyph { display: grid; width: 44px; height: 44px; margin: auto; place-items: center; }
.large-glyph :deep(svg) { width: 32px; height: 32px; }
.preview-placeholder p { max-width: 260px; }
.detail-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 16px; }
.detail-tabs { display: flex; padding: 0 16px; border-bottom: 1px solid var(--line); }
.detail-tabs button { padding: 10px 8px; border: 0; border-bottom: 2px solid transparent; color: var(--muted); background: transparent; font-size: 12.5px; font-weight: 500; }
.detail-tabs button.active { border-color: var(--accent); color: var(--text); font-weight: 600; }
.detail-tabs span { padding: 1px 6px; border-radius: 999px; background: var(--paper-2); font-size: 11px; }
.detail-body { padding: 16px; }
.detail-body dl { display: grid; grid-template-columns: 84px 1fr; gap: 10px; margin: 0; font-size: 12.5px; }
.detail-body dt { color: var(--dim); }
.detail-body dd { min-width: 0; margin: 0; color: var(--text); overflow-wrap: anywhere; }
.status-inline { display: inline-flex; align-items: center; gap: 7px; }
.sync-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; }
.sync-dot.syncing { background: var(--accent); }
.sync-dot.paused { background: var(--warn); }
.sync-dot.error, .sync-dot.conflict { background: var(--bad); }
.coming-card { margin-top: 18px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r); background: var(--accent-soft); }
.coming-card strong { font-size: 12.5px; }
.coming-card p { margin: 4px 0 8px; color: var(--muted); font-size: 12px; }
.coming-card span { color: var(--accent-2); font-size: 10.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.versions-list { padding: 10px 16px 18px; }
.version-row { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line); }
.version-number { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 50%; color: var(--accent-2); background: var(--accent-soft); font: 11px var(--mono); }
.version-row strong, .version-row small { display: block; }
.version-row strong { font-size: 12.5px; font-weight: 500; }
.version-row small { margin-top: 2px; color: var(--dim); font-size: 11px; }
.current-pill { display: inline-flex; padding: 2px 8px; border-radius: 999px; color: var(--accent-2); background: var(--accent-soft); font-size: 11px; font-weight: 600; }
.version-note, .mini-state { color: var(--dim); font-size: 11px; }
.mini-state { display: flex; align-items: center; gap: 8px; padding: 20px; }
.mini-state .loader { width: 16px; height: 16px; }
.detail-enter-active, .detail-leave-active { transition: transform .22s ease, opacity .18s ease; }
.detail-enter-from, .detail-leave-to { transform: translateX(30px); opacity: 0; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Mockup breakpoints, measured against the Files surface instead of the window */
@container (max-width: 1180px) {
  .nav { width: 64px; padding: 14px 10px; }
  .nav a { justify-content: center; padding: 9px 0; position: relative; }
  .nav a > span:not(.sv):not(.cnt), .brand b, .brand span, .nav .grp, .nav .foot small, .nav .foot div:not(.avatar), .nav .quota, .syncline { display: none; }
  .nav a .cnt { position: absolute; margin: 0; transform: translate(14px, -10px); }
  .brand { justify-content: center; padding-bottom: 12px; }
  .content { padding: 16px 18px 50px; }
  .top { padding: 10px 18px; }
  .top .search { max-width: 360px; }
  .col-size, .col-owner-name { display: none; }
  .files .own .nm { display: none; }
}
@container (max-width: 700px) {
  .crumbs > span, .crumbs .c { display: none; }
  .top { flex-wrap: wrap; gap: 8px; padding: 10px 14px; }
  .top .search { order: 5; flex-basis: 100%; max-width: none; width: 100%; }
  .top .search kbd { display: none; }
  .content { padding: 12px 12px 40px; }
  .toolbar { flex-wrap: wrap; gap: 4px 10px; }
  .filters { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; }
  .filters .view { margin-left: 0; flex: none; }
  .files .tbl th:nth-child(1), .files .tbl td:nth-child(1), .files .tbl th:nth-child(3), .files .tbl td:nth-child(3), .files .tbl th:nth-child(5), .files .tbl td:nth-child(5), .files .tbl th:nth-child(7), .files .tbl td:nth-child(7) { display: none; }
  .gridv { grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .drop { flex-wrap: wrap; }
  .drop .btn { margin-left: 0; }
  .upl { display: none; }
  .detail-panel { width: calc(100% - 64px); }
}
</style>
