<template>
  <div
    class="files-browser"
    :class="{ dragging }"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <aside class="files-sidebar">
      <div class="files-brand">
        <span class="brand-mark">S</span>
        <div><strong>Files</strong><small>{{ locationLabel }}</small></div>
      </div>

      <nav aria-label="Files sections">
        <button
          v-for="entry in sections"
          :key="entry.id"
          :class="{ active: section === entry.id }"
          type="button"
          @click="selectSection(entry.id)"
        >
          <span
            class="nav-icon"
            v-html="entry.icon"
          />
          <span>{{ entry.label }}</span>
          <span
            v-if="entry.count"
            class="nav-count"
          >{{ entry.count }}</span>
        </button>
      </nav>

      <div class="side-rule" />
      <p class="side-label">
        Shared folders
      </p>
      <button
        class="disabled-row"
        type="button"
        disabled
        title="Coming soon · shared folders arrive with organization sharing"
      >
        <span
          class="nav-icon"
          v-html="icons.folder"
        />
        <span>Organization</span><em>Coming soon</em>
      </button>

      <div class="sidebar-spacer" />
      <div class="storage-card">
        <div class="storage-line">
          <span>Storage</span><strong>{{ formatBytes(totalBytes) }}</strong>
        </div>
        <div class="storage-bar">
          <i :style="{ width: `${storagePercent}%` }" />
        </div>
        <small>Only ~/sulla/Files is included</small>
      </div>
      <button
        class="sync-card"
        type="button"
        :title="syncTooltip"
        @click="togglePause"
      >
        <span
          class="sync-dot"
          :class="syncState"
        />
        <span><strong>{{ syncLabel }}</strong><small>{{ syncDetail }}</small></span>
        <span class="pause-symbol">{{ syncState === 'paused' ? '▶' : 'Ⅱ' }}</span>
      </button>
    </aside>

    <main class="files-main">
      <header class="files-topbar">
        <div class="breadcrumbs">
          <button
            type="button"
            @click="openRoot"
          >
            My Files
          </button>
          <template
            v-for="crumb in crumbs"
            :key="crumb.path"
          >
            <span>›</span><button
              type="button"
              @click="openPath(crumb.path)"
            >
              {{ crumb.label }}
            </button>
          </template>
        </div>
        <label class="search-box">
          <span v-html="icons.search" />
          <input
            v-model="query"
            type="search"
            placeholder="Search files, folders, transcripts…"
          >
          <kbd>⌘K</kbd>
        </label>
        <button
          class="button primary"
          type="button"
          :disabled="busy || !dataSource.capabilities.upload"
          @click="upload"
        >
          <span v-html="icons.upload" /> Upload
        </button>
      </header>

      <section class="files-content">
        <div class="title-row">
          <div>
            <h1>{{ pageTitle }}</h1>
            <p>{{ summaryText }}</p>
          </div>
          <div class="title-actions">
            <button
              class="button disabled-action"
              type="button"
              disabled
              title="Coming soon · one Jumpshare-style link through Sulla Cloud"
            >
              <span v-html="icons.link" /> Share
            </button>
            <button
              class="button"
              type="button"
              @click="dataSource.openFolder()"
            >
              <span v-html="icons.external" /> Open in Finder
            </button>
          </div>
        </div>

        <div class="toolbar">
          <label class="select-wrap">Sort
            <select v-model="sort"><option value="name">Name</option><option value="modified">Modified</option><option value="size">Size</option><option value="type">Type</option></select>
          </label>
          <span
            v-if="query"
            class="filter-chip"
          >Search: {{ query }} <button
            type="button"
            @click="query = ''"
          >×</button></span>
          <span
            v-if="section === 'trash'"
            class="retention-note"
          >Trash is retained for {{ retentionDays }} days</span>
          <div
            class="view-switch"
            role="group"
            aria-label="View"
          >
            <button
              type="button"
              :class="{ active: view === 'list' }"
              aria-label="List view"
              @click="view = 'list'"
              v-html="icons.list"
            />
            <button
              type="button"
              :class="{ active: view === 'grid' }"
              aria-label="Grid view"
              @click="view = 'grid'"
              v-html="icons.grid"
            />
          </div>
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
              class="button primary"
              type="button"
              @click="refresh"
            >
              Try again
            </button><button
              class="button"
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
            v-html="section === 'trash' ? icons.trash : icons.folder"
          />
          <strong>{{ emptyTitle }}</strong><p>{{ emptyCopy }}</p>
          <button
            v-if="section === 'files'"
            class="button primary"
            type="button"
            @click="upload"
          >
            Choose files
          </button>
        </div>

        <div
          v-else-if="view === 'list'"
          class="file-card list-card"
        >
          <table>
            <thead><tr><th>Name</th><th>Size</th><th>Modified</th><th>Version</th><th>Location</th><th /></tr></thead>
            <tbody>
              <tr
                v-for="entry in visibleEntries"
                :key="entry.key"
                :class="{ selected: selected?.key === entry.key }"
                @dblclick="activate(entry)"
                @click="selectEntry(entry)"
              >
                <td>
                  <div class="file-name">
                    <span
                      class="file-glyph"
                      :class="entry.kindClass"
                      v-html="entry.icon"
                    /><span><strong>{{ entry.name }}</strong><small>{{ entry.subtitle }}</small></span>
                  </div>
                </td>
                <td class="muted">
                  {{ entry.folder ? '—' : formatBytes(entry.size) }}
                </td>
                <td class="muted">
                  {{ entry.folder ? '—' : formatDate(entry.updatedAt) }}
                </td>
                <td>
                  <span
                    v-if="!entry.folder"
                    class="version-pill"
                  >v{{ entry.versionCount }}</span>
                </td>
                <td>
                  <span class="location-cell"><span
                    class="sync-dot tiny"
                    :class="syncState"
                  />{{ shortLocation }}</span>
                </td>
                <td>
                  <button
                    class="row-more"
                    type="button"
                    aria-label="Details"
                    @click.stop="selectEntry(entry)"
                    v-html="icons.more"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div
          v-else
          class="file-grid"
        >
          <button
            v-for="entry in visibleEntries"
            :key="entry.key"
            type="button"
            class="file-tile"
            :class="{ selected: selected?.key === entry.key }"
            @dblclick="activate(entry)"
            @click="selectEntry(entry)"
          >
            <span
              class="tile-preview"
              :class="entry.kindClass"
            ><span
              class="large-glyph"
              v-html="entry.icon"
            /><span
              class="sync-dot tile-sync"
              :class="syncState"
            /></span>
            <span class="tile-body"><strong>{{ entry.name }}</strong><small>{{ entry.folder ? entry.subtitle : `${formatBytes(entry.size)} · v${entry.versionCount}` }}</small></span>
          </button>
        </div>

        <button
          v-if="!loading && !error && section === 'files'"
          class="drop-zone"
          type="button"
          @click="upload"
        >
          <span v-html="icons.uploadCloud" /><span><strong>Drop files here</strong><small>They’re versioned locally, then synced when a server is connected.</small></span><em>Choose files</em>
        </button>
      </section>
    </main>

    <transition name="detail">
      <aside
        v-if="selected && !selected.folder"
        class="detail-panel"
      >
        <header>
          <div class="file-name">
            <span
              class="file-glyph"
              :class="selected.kindClass"
              v-html="selected.icon"
            /><span><strong>{{ selected.name }}</strong><small>{{ selected.mime }}</small></span>
          </div><button
            type="button"
            aria-label="Close details"
            @click="selected = null"
          >
            ×
          </button>
        </header>
        <div class="preview-box">
          <span
            v-if="previewLoading"
            class="loader"
          />
          <img
            v-else-if="previewUrl && selected.mime.startsWith('image/')"
            :src="previewUrl"
            :alt="selected.name"
          >
          <video
            v-else-if="previewUrl && selected.mime.startsWith('video/')"
            :src="previewUrl"
            controls
          />
          <audio
            v-else-if="previewUrl && selected.mime.startsWith('audio/')"
            :src="previewUrl"
            controls
          />
          <iframe
            v-else-if="previewUrl && selected.mime === 'application/pdf'"
            :src="previewUrl"
            :title="selected.name"
          />
          <pre v-else-if="previewText !== null">{{ previewText }}</pre>
          <div
            v-else
            class="preview-placeholder"
          >
            <span
              class="large-glyph"
              v-html="selected.icon"
            /><p>{{ previewError || 'Preview isn’t available for this file type.' }}</p><button
              v-if="section !== 'trash'"
              class="button"
              type="button"
              @click="dataSource.openFile(selected.path)"
            >
              Open file
            </button>
          </div>
        </div>
        <div class="detail-actions">
          <button
            v-if="section !== 'trash'"
            class="button primary"
            type="button"
            @click="dataSource.openFile(selected.path)"
          >
            Open
          </button>
          <button
            v-if="section === 'trash'"
            class="button"
            type="button"
            :disabled="busy"
            @click="restoreTrashed"
          >
            Restore
          </button>
          <button
            v-else
            class="button"
            type="button"
            :disabled="busy"
            @click="trashSelected"
          >
            Move to Trash
          </button>
          <button
            class="button"
            type="button"
            disabled
            title="Coming soon · public links use Sulla Cloud pass-through"
          >
            Share
          </button>
          <button
            class="button"
            type="button"
            :disabled="!dataSource.capabilities.onlineOnly"
            title="Coming soon · online-only arrives in phase 3"
          >
            Online only
          </button>
        </div>
        <div class="detail-tabs">
          <button
            type="button"
            :class="{ active: detailTab === 'details' }"
            @click="detailTab = 'details'"
          >
            Details
          </button><button
            type="button"
            :class="{ active: detailTab === 'versions' }"
            @click="detailTab = 'versions'"
          >
            Versions <span>{{ versions.length || selected.versionCount }}</span>
          </button>
        </div>
        <div
          v-if="detailTab === 'details'"
          class="detail-body"
        >
          <dl>
            <dt>Type</dt><dd>{{ selected.mime }}</dd><dt>Size</dt><dd>{{ formatBytes(selected.size) }}</dd><dt>Location</dt><dd>~/sulla/Files/{{ selected.path }}</dd><dt>Modified</dt><dd>{{ formatDate(selected.updatedAt, true) }}</dd><dt>Sync</dt><dd>
              <span class="status-inline"><span
                class="sync-dot tiny"
                :class="syncState"
              />{{ syncDetail }}</span>
            </dd><dt>Version</dt><dd>v{{ selected.versionCount }}</dd>
          </dl>
          <section class="coming-card">
            <strong>Share link</strong><p>One Jumpshare-style link through Sulla Cloud, with “Keep available when my computer is off.”</p><span>Coming soon</span>
          </section>
        </div>
        <div
          v-else
          class="versions-list"
        >
          <div
            v-if="versionsLoading"
            class="mini-state"
          >
            <span class="loader" /> Loading history…
          </div>
          <div
            v-for="(version, index) in versions"
            :key="version.id"
            class="version-row"
          >
            <span class="version-number">v{{ versions.length - index }}</span><span><strong>{{ version.message || 'File updated' }}</strong><small>{{ formatDate(version.created_at, true) }} · {{ formatBytes(version.size) }}<template v-if="version.device_id"> · {{ version.device_id }}</template></small></span>
            <span
              v-if="version.current && !version.deleted"
              class="current-pill"
            >Current</span><button
              v-else-if="!version.deleted"
              class="button small"
              type="button"
              :disabled="busy"
              title="Restore this version as a new version"
              @click="restoreVersion(version.id)"
            >
              Restore
            </button>
          </div>
          <p class="version-note">
            Restoring creates a new version. Existing versions are never overwritten.
          </p>
        </div>
      </aside>
    </transition>

    <div
      v-if="dragging"
      class="drop-overlay"
    >
      <span v-html="icons.uploadCloud" /><strong>Drop into Sulla Files</strong><p>Files go to ~/sulla/Files and are versioned immediately.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { FilesDataSource, FilesItem, FilesSnapshot, FilesVersion } from './types';

const props = defineProps<{ dataSource: FilesDataSource }>();
type Section = 'files' | 'shared' | 'recent' | 'starred' | 'agent' | 'trash';
type ViewMode = 'list' | 'grid';
interface DisplayEntry extends FilesItem { key: string; name: string; folder: boolean; kindClass: string; icon: string; subtitle: string }

const icons = {
  folder:      '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  users:       '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 19h5a4.5 4.5 0 0 0-3-4.2"/></svg>',
  clock:       '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  star:        '<svg viewBox="0 0 24 24"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/></svg>',
  agent:       '<svg viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4M9 4h6"/><circle cx="9" cy="13.5" r="1"/><circle cx="15" cy="13.5" r="1"/></svg>',
  trash:       '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  search:      '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  upload:      '<svg viewBox="0 0 24 24"><path d="M12 16V5M7 10l5-5 5 5M4 19h16"/></svg>',
  uploadCloud: '<svg viewBox="0 0 24 24"><path d="M7 18a4 4 0 0 1-.5-7.96A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 .5 7H7z"/><path d="m9 13 3-3 3 3M12 10v7"/></svg>',
  link:        '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/></svg>',
  external:    '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/></svg>',
  list:        '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  grid:        '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  more:        '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
  alert:       '<svg viewBox="0 0 24 24"><path d="M10.3 4.2 2.5 18a2 2 0 0 0 1.8 3h15.4a2 2 0 0 0 1.8-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  file:        '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/></svg>',
  image:       '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5L6 20"/></svg>',
  video:       '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>',
  audio:       '<svg viewBox="0 0 24 24"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>',
  pdf:         '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M8 15h8M8 18h6"/></svg>',
  code:        '<svg viewBox="0 0 24 24"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/></svg>',
};

const snapshot = ref<FilesSnapshot | null>(null); const loading = ref(true); const busy = ref(false); const error = ref('');
const section = ref<Section>('files'); const currentPath = ref(''); const query = ref(''); const sort = ref('name'); const view = ref<ViewMode>((localStorage.getItem('sulla:files-view') as ViewMode) || 'list');
const searchResults = ref<FilesItem[] | null>(null);
const selected = ref<DisplayEntry | null>(null); const detailTab = ref<'details' | 'versions'>('details'); const versions = ref<FilesVersion[]>([]); const versionsLoading = ref(false);
const previewUrl = ref(''); const previewText = ref<string | null>(null); const previewError = ref(''); const previewLoading = ref(false); const dragging = ref(false); let refreshTimer:ReturnType<typeof setInterval> | undefined;
const starred = ref(new Set<string>(JSON.parse(localStorage.getItem('sulla:files-starred') || '[]')));

const activeFiles = computed(() => snapshot.value?.files.filter(file => !file.deletedAt) ?? []);
const trashFiles = computed(() => snapshot.value?.files.filter(file => file.deletedAt) ?? []);
const totalBytes = computed(() => activeFiles.value.reduce((sum, file) => sum + file.size, 0));
const storagePercent = computed(() => Math.min(100, Math.max(4, Math.log10(Math.max(totalBytes.value, 1)) * 8)));
const syncState = computed(() => snapshot.value?.status.state ?? 'error');
const retentionDays = computed(() => Number(snapshot.value?.collection.retentionPolicy?.trashDays ?? 90));
const shortLocation = computed(() => snapshot.value?.status.location === 'cloud' ? 'Cloud' : snapshot.value?.status.serverConfigured ? 'Server' : 'Local');
const locationLabel = computed(() => snapshot.value?.status.serverConfigured ? `Synced to ${ snapshot.value.status.serverLabel || 'Sulla Server' }` : 'Local only');
const syncLabel = computed(() => ({ synced: 'Up to date', syncing: 'Syncing', paused: 'Sync paused', error: 'Local files safe', conflict: 'Conflict needs review' }[syncState.value]));
const syncDetail = computed(() => snapshot.value?.status.serverConfigured ? `${ locationLabel.value }${ snapshot.value.status.pendingFiles ? ` · ${ snapshot.value.status.pendingFiles } pending` : '' }` : 'No server joined · local-only is normal');
const syncTooltip = computed(() => syncState.value === 'paused' ? 'Resume Files sync' : 'Pause Files sync');
const pageTitle = computed(() => ({ files: currentPath.value ? currentPath.value.split('/').at(-1) : 'My Files', shared: 'Shared with me', recent: 'Recent', starred: 'Starred', agent: 'Agent files', trash: 'Trash' }[section.value]));
const crumbs = computed(() => currentPath.value.split('/').filter(Boolean).map((label, index, parts) => ({ label, path: parts.slice(0, index + 1).join('/') })));
const summaryText = computed(() => `${ visibleEntries.value.length } item${ visibleEntries.value.length === 1 ? '' : 's' } · ${ formatBytes(visibleEntries.value.reduce((sum, entry) => sum + (entry.folder ? 0 : entry.size), 0)) } · ${ locationLabel.value }`);
const sections = computed(() => [
  { id: 'files' as Section, label: 'My Files', icon: icons.folder, count: 0 },
  { id: 'shared' as Section, label: 'Shared with me', icon: icons.users, count: 0 },
  { id: 'recent' as Section, label: 'Recent', icon: icons.clock, count: 0 },
  { id: 'starred' as Section, label: 'Starred', icon: icons.star, count: starred.value.size },
  { id: 'agent' as Section, label: 'Agent files', icon: icons.agent, count: activeFiles.value.filter(file => file.createdByType === 'agent-run').length },
  { id: 'trash' as Section, label: 'Trash', icon: icons.trash, count: trashFiles.value.length },
]);
const emptyTitle = computed(() => ({ files: 'This folder is empty', shared: 'Shared folders are coming soon', recent: 'No recent files', starred: 'No starred files', agent: 'No agent files to keep', trash: 'Trash is empty' }[section.value]));
const emptyCopy = computed(() => ({ files: 'Drop files here or choose files. They stay in ~/sulla/Files.', shared: 'Organization sharing will appear here when the phase 2 server API is connected.', recent: 'Files you change will appear here.', starred: 'Star important files to find them quickly.', agent: 'Files created by agent runs will appear here with their provenance.', trash: `Deleted files stay recoverable for ${ retentionDays.value } days.` }[section.value]));

function fileIcon(mime:string):{ icon: string; className: string } { if (mime.startsWith('image/')) return { icon: icons.image, className: 'image' }; if (mime.startsWith('video/')) return { icon: icons.video, className: 'video' }; if (mime.startsWith('audio/')) return { icon: icons.audio, className: 'audio' }; if (mime === 'application/pdf') return { icon: icons.pdf, className: 'pdf' }; if (mime.startsWith('text/') || /json|yaml|javascript|typescript/.test(mime)) return { icon: icons.code, className: 'code' }; return { icon: icons.file, className: 'document' } }
function toDisplay(file:FilesItem):DisplayEntry { const glyph = fileIcon(file.mime); return { ...file, key: file.id, name: file.path.split('/').at(-1) || file.path, folder: false, kindClass: glyph.className, icon: glyph.icon, subtitle: file.createdByType === 'agent-run' ? `Made by agent run ${ file.createdById }` : file.mime } }
const visibleEntries = computed<DisplayEntry[]>(() => {
  let files = section.value === 'trash' ? trashFiles.value : searchResults.value ?? activeFiles.value;
  if (section.value === 'agent') files = files.filter(file => file.createdByType === 'agent-run');
  if (section.value === 'starred') files = files.filter(file => starred.value.has(file.id));
  if (section.value === 'recent') files = [...files].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 50);
  if (section.value === 'shared') return [];
  const search = query.value.trim().toLowerCase();
  if (search && section.value === 'trash') files = files.filter(file => file.path.toLowerCase().includes(search));
  const prefix = currentPath.value ? `${ currentPath.value }/` : '';
  const entries:DisplayEntry[] = []; const folders = new Set<string>();
  for (const file of files) {
    if (!search && !file.path.startsWith(prefix)) continue;
    const relative = search ? file.path : file.path.slice(prefix.length); const parts = relative.split('/');
    if (!search && parts.length > 1) folders.add(parts[0]); else entries.push(toDisplay(file));
  }
  for (const name of folders) entries.push({ id: `folder:${ prefix }${ name }`, key: `folder:${ prefix }${ name }`, path: `${ prefix }${ name }`, name, folder: true, kindClass: 'folder', icon: icons.folder, subtitle: `${ files.filter(file => file.path.startsWith(`${ prefix }${ name }/`)).length } items`, mime: 'inode/directory', size: 0, updatedAt: '', currentVersionId: '', versionCount: 0, createdByType: 'user', createdById: '' });
  return entries.sort((a, b) => { if (a.folder !== b.folder) return a.folder ? -1 : 1; if (sort.value === 'modified') return Date.parse(b.updatedAt || '0') - Date.parse(a.updatedAt || '0'); if (sort.value === 'size') return b.size - a.size; if (sort.value === 'type') return a.mime.localeCompare(b.mime); return a.name.localeCompare(b.name, undefined, { numeric: true }) });
});

async function refresh(silent = false) { if (!silent) loading.value = true; try { snapshot.value = await props.dataSource.load(); error.value = '' } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { loading.value = false } }
async function upload() { busy.value = true; try { const count = await props.dataSource.chooseUpload(); if (count) setTimeout(() => refresh(true), 700); } finally { busy.value = false } }
async function togglePause() { if (!snapshot.value) return; snapshot.value.status = await props.dataSource.setPaused(syncState.value !== 'paused') }
function selectSection(next:Section) { section.value = next; currentPath.value = ''; query.value = ''; searchResults.value = null; selected.value = null }
function openRoot() { section.value = 'files'; currentPath.value = ''; selected.value = null }
function openPath(next:string) { section.value = 'files'; currentPath.value = next; selected.value = null }
function activate(entry:DisplayEntry) { if (entry.folder) openPath(entry.path); else props.dataSource.openFile(entry.path); }
async function selectEntry(entry:DisplayEntry) { if (entry.folder) { selected.value = entry; return } selected.value = entry; detailTab.value = 'details'; versions.value = []; await loadVersions(entry); const previewVersion = entry.deletedAt ? versions.value.find(version => !version.deleted)?.id : undefined; await loadPreview(entry, previewVersion) }
async function loadVersions(entry:DisplayEntry) { versionsLoading.value = true; try { versions.value = await props.dataSource.history(entry.id) } catch { versions.value = [] } finally { versionsLoading.value = false } }
async function loadPreview(entry:DisplayEntry, versionId?:string) { if (previewUrl.value) URL.revokeObjectURL(previewUrl.value); previewUrl.value = ''; previewText.value = null; previewError.value = ''; if (entry.size > 64 * 1024 * 1024) { previewError.value = 'This file is too large for an inline preview. Open it in its default app.'; return } previewLoading.value = true; try { const result = await props.dataSource.preview(entry.id, versionId); const binary = new Uint8Array(result.data); if (result.mime.startsWith('text/') || /json|yaml|javascript|typescript/.test(result.mime)) previewText.value = new TextDecoder().decode(binary); else previewUrl.value = URL.createObjectURL(new Blob([binary], { type: result.mime })); } catch (cause) { previewError.value = cause instanceof Error ? cause.message : String(cause) } finally { previewLoading.value = false } }
async function restoreVersion(versionId:string) { if (!selected.value) return; busy.value = true; try { await props.dataSource.restoreVersion(selected.value.id, versionId); selected.value = null; await refresh(true) } finally { busy.value = false } }
async function restoreTrashed() { if (!selected.value) return; busy.value = true; try { await props.dataSource.restoreTrash(selected.value.id); selected.value = null; await refresh(true) } finally { busy.value = false } }
async function trashSelected() { if (!selected.value) return; busy.value = true; try { await props.dataSource.trashFile(selected.value.id); selected.value = null; await refresh(true) } finally { busy.value = false } }
function onDragLeave(event:DragEvent) { if (!event.currentTarget || !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) dragging.value = false; }
async function onDrop(event:DragEvent) { dragging.value = false; const paths = [...(event.dataTransfer?.files ?? [])].map(file => (file as File & { path?: string }).path).filter((value):value is string => Boolean(value)); if (!paths.length) { error.value = 'This Desktop build cannot read dropped file paths. Use Choose files instead.'; return } busy.value = true; try { await props.dataSource.uploadPaths(paths); setTimeout(() => refresh(true), 700) } finally { busy.value = false } }
function formatBytes(bytes:number) { if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${ (bytes / 1024 ** index).toFixed(index ? 1 : 0) } ${ units[index] }` }
function formatDate(value:string, detailed = false) { if (!value) return '—'; const date = new Date(value); return new Intl.DateTimeFormat(undefined, detailed ? { dateStyle: 'medium', timeStyle: 'short' } : { month: 'short', day: 'numeric' }).format(date) }

watch(view, value => localStorage.setItem('sulla:files-view', value));
let searchTimer:ReturnType<typeof setTimeout> | undefined;
watch(query, (value) => { if (searchTimer) clearTimeout(searchTimer); if (!value.trim() || section.value === 'trash') { searchResults.value = null; return } searchTimer = setTimeout(async() => { try { searchResults.value = await props.dataSource.search(value.trim()) } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } }, 220) });
watch(detailTab, value => { if (value === 'versions' && selected.value && !versions.value.length) loadVersions(selected.value); });
onMounted(() => { refresh(); refreshTimer = setInterval(() => refresh(true), 12_000) });
onBeforeUnmount(() => { if (refreshTimer) clearInterval(refreshTimer); if (previewUrl.value) URL.revokeObjectURL(previewUrl.value); });
</script>

<style scoped>
.files-browser{--f-bg:var(--nx-paper,#0a0d12);--f-surface:color-mix(in srgb,var(--nx-surface,#10151d) 91%,transparent);--f-surface-2:color-mix(in srgb,var(--nx-accent,#5096b3) 5%,var(--nx-paper,#0a0d12));--f-line:var(--nx-hair,rgba(180,205,228,.1));--f-text:var(--nx-read-1,#edf4f8);--f-text-2:var(--nx-read-3,#a8b7c2);--f-text-3:var(--nx-read-5,#71808c);--f-accent:var(--nx-accent,#5096b3);--f-accent-2:var(--nx-accent-2,#80bfd7);--f-ok:var(--nx-success,#4fb983);--f-warn:var(--nx-warning,#d5a850);--f-danger:var(--nx-danger,#dc6b70);position:relative;display:grid;grid-template-columns:218px minmax(0,1fr);height:100%;min-height:0;color:var(--f-text);background:radial-gradient(70% 60% at 95% 105%,color-mix(in srgb,var(--f-accent) 9%,transparent),transparent 65%),var(--f-bg);font-family:var(--font-body,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);font-size:13px;overflow:hidden}.files-sidebar{display:flex;flex-direction:column;min-height:0;padding:18px 12px 12px;border-right:1px solid var(--f-line);background:color-mix(in srgb,var(--f-bg) 78%,transparent);backdrop-filter:blur(18px)}.files-brand{display:flex;align-items:center;gap:10px;padding:2px 8px 18px}.brand-mark{width:29px;height:29px;display:grid;place-items:center;border-radius:9px;background:linear-gradient(135deg,var(--f-accent-2),var(--f-accent));color:var(--nx-paper,#061018);font-weight:800}.files-brand strong,.files-brand small{display:block}.files-brand strong{font-size:14px}.files-brand small{max-width:145px;color:var(--f-text-3);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.files-sidebar nav{display:flex;flex-direction:column;gap:3px}.files-sidebar nav button,.disabled-row{display:flex;align-items:center;gap:10px;width:100%;min-height:34px;padding:7px 9px;border:0;border-radius:9px;color:var(--f-text-2);background:transparent;text-align:left}.files-sidebar nav button:hover{color:var(--f-text);background:color-mix(in srgb,var(--f-accent) 7%,transparent)}.files-sidebar nav button.active{color:var(--f-accent-2);background:linear-gradient(90deg,color-mix(in srgb,var(--f-accent) 18%,transparent),color-mix(in srgb,var(--f-accent) 6%,transparent));box-shadow:inset 2px 0 0 var(--f-accent-2)}.nav-icon{display:grid;width:17px;height:17px;place-items:center}.nav-icon :deep(svg),.button :deep(svg),.search-box :deep(svg),.view-switch :deep(svg),.row-more :deep(svg),.drop-zone>span :deep(svg),.state-icon :deep(svg),.drop-overlay :deep(svg){width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.nav-count{margin-left:auto;min-width:19px;padding:1px 6px;border-radius:99px;background:color-mix(in srgb,var(--f-text-3) 14%,transparent);font-size:10px;text-align:center}.side-rule{height:1px;margin:13px 8px;background:var(--f-line)}.side-label{margin:0 9px 6px;color:var(--f-text-3);font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}.disabled-row{opacity:.58}.disabled-row em{margin-left:auto;color:var(--f-text-3);font-size:9px;font-style:normal}.sidebar-spacer{flex:1}.storage-card{padding:10px 9px 12px;border-top:1px solid var(--f-line)}.storage-line{display:flex;justify-content:space-between;color:var(--f-text-3);font-size:10.5px}.storage-line strong{color:var(--f-text-2);font-weight:600}.storage-bar{height:3px;margin:7px 0;border-radius:9px;background:color-mix(in srgb,var(--f-text-3) 14%,transparent);overflow:hidden}.storage-bar i{display:block;height:100%;border-radius:inherit;background:var(--f-accent)}.storage-card small{color:var(--f-text-3);font-size:9.5px}.sync-card{display:flex;align-items:center;gap:9px;padding:9px;border:1px solid var(--f-line);border-radius:11px;color:var(--f-text-2);background:var(--f-surface);text-align:left}.sync-card>span:nth-child(2){min-width:0;flex:1}.sync-card strong,.sync-card small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sync-card strong{color:var(--f-text);font-size:11px}.sync-card small{color:var(--f-text-3);font-size:9px}.pause-symbol{color:var(--f-text-3);font:10px var(--font-mono,monospace)}.sync-dot{width:8px;height:8px;border-radius:50%;background:var(--f-text-3);box-shadow:0 0 0 3px color-mix(in srgb,var(--f-text-3) 12%,transparent);flex:none}.sync-dot.synced{background:var(--f-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--f-ok) 14%,transparent)}.sync-dot.syncing{background:var(--f-accent-2);animation:pulse 1.3s infinite}.sync-dot.paused{background:var(--f-warn)}.sync-dot.error,.sync-dot.conflict{background:var(--f-danger)}.sync-dot.tiny{width:6px;height:6px;box-shadow:none}.files-main{min-width:0;min-height:0;overflow:auto}.files-topbar{position:sticky;top:0;z-index:4;display:flex;align-items:center;gap:14px;min-height:57px;padding:10px 24px;border-bottom:1px solid var(--f-line);background:color-mix(in srgb,var(--f-bg) 76%,transparent);backdrop-filter:blur(18px)}.breadcrumbs{display:flex;align-items:center;gap:6px;max-width:32%;overflow:hidden;white-space:nowrap}.breadcrumbs button{padding:0;border:0;color:var(--f-text-2);background:transparent}.breadcrumbs button:last-child{color:var(--f-text);font-weight:600}.breadcrumbs span{color:var(--f-text-3)}.search-box{display:flex;align-items:center;gap:8px;max-width:520px;min-width:180px;flex:1;margin-left:auto;padding:7px 10px;border:1px solid var(--f-line);border-radius:10px;color:var(--f-text-3);background:var(--f-surface)}.search-box>span{width:15px;height:15px}.search-box input{min-width:0;flex:1;border:0;outline:0;color:var(--f-text);background:transparent}.search-box kbd{padding:1px 5px;border:1px solid var(--f-line);border-radius:5px;color:var(--f-text-3);font:9px var(--font-mono,monospace)}.button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:6px 11px;border:1px solid var(--f-line);border-radius:9px;color:var(--f-text-2);background:var(--f-surface);white-space:nowrap}.button:hover:not(:disabled){border-color:color-mix(in srgb,var(--f-accent-2) 35%,transparent);color:var(--f-text);background:color-mix(in srgb,var(--f-accent) 10%,var(--f-surface))}.button.primary{border-color:color-mix(in srgb,var(--f-accent-2) 45%,transparent);color:var(--f-text);background:linear-gradient(180deg,color-mix(in srgb,var(--f-accent-2) 65%,var(--f-accent)),var(--f-accent));box-shadow:0 6px 18px color-mix(in srgb,var(--f-accent) 18%,transparent)}.button:disabled{cursor:not-allowed;opacity:.48}.button>span{width:14px;height:14px}.button.small{min-height:26px;padding:3px 8px;font-size:10.5px}.files-content{padding:22px 26px 56px}.title-row,.toolbar{display:flex;align-items:center;gap:12px}.title-row{align-items:flex-start;margin-bottom:18px}.title-row h1{margin:0 0 3px;font-family:var(--font-display,"Playfair Display",serif);font-size:25px;font-weight:600;letter-spacing:-.025em}.title-row p{margin:0;color:var(--f-text-3);font-size:11.5px}.title-actions{display:flex;gap:8px;margin-left:auto}.toolbar{margin-bottom:13px}.select-wrap{display:flex;align-items:center;gap:7px;color:var(--f-text-3);font-size:10.5px}.select-wrap select{padding:6px 26px 6px 9px;border:1px solid var(--f-line);border-radius:8px;color:var(--f-text-2);background:var(--f-surface)}.view-switch{display:flex;gap:2px;margin-left:auto;padding:2px;border:1px solid var(--f-line);border-radius:9px;background:var(--f-surface)}.view-switch button{display:grid;width:29px;height:27px;padding:6px;border:0;border-radius:7px;color:var(--f-text-3);background:transparent}.view-switch button.active{color:var(--f-accent-2);background:color-mix(in srgb,var(--f-accent) 15%,transparent)}.filter-chip,.retention-note{padding:4px 8px;border-radius:99px;color:var(--f-accent-2);background:color-mix(in srgb,var(--f-accent) 10%,transparent);font-size:10.5px}.filter-chip button{border:0;color:inherit;background:transparent}.retention-note{color:var(--f-text-3);background:var(--f-surface-2)}.file-card{overflow:hidden;border:1px solid var(--f-line);border-radius:14px;background:var(--f-surface);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--f-text) 2.5%,transparent),0 16px 42px color-mix(in srgb,var(--nx-ink,#000) 12%,transparent)}table{width:100%;border-collapse:collapse}th{padding:9px 12px;border-bottom:1px solid var(--f-line);color:var(--f-text-3);font-size:9px;font-weight:700;letter-spacing:.08em;text-align:left;text-transform:uppercase}td{padding:9px 12px;border-bottom:1px solid var(--f-line)}tbody tr:last-child td{border-bottom:0}tbody tr{cursor:default}tbody tr:hover td,tbody tr.selected td{background:color-mix(in srgb,var(--f-accent) 7%,transparent)}.file-name{display:flex;align-items:center;gap:10px;min-width:0}.file-name>span:last-child{min-width:0}.file-name strong,.file-name small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-name strong{font-size:12px;font-weight:580}.file-name small{margin-top:1px;color:var(--f-text-3);font-size:9.5px}.file-glyph{display:grid;width:31px;height:31px;flex:none;place-items:center;border-radius:8px;color:var(--f-accent-2);background:color-mix(in srgb,var(--f-accent) 12%,transparent)}.file-glyph :deep(svg),.large-glyph :deep(svg){width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.file-glyph.image,.tile-preview.image{color:#a78bda;background:color-mix(in srgb,#8f72c7 13%,transparent)}.file-glyph.video,.tile-preview.video{color:var(--f-danger);background:color-mix(in srgb,var(--f-danger) 10%,transparent)}.file-glyph.audio,.tile-preview.audio{color:var(--f-ok);background:color-mix(in srgb,var(--f-ok) 10%,transparent)}.file-glyph.pdf,.tile-preview.pdf{color:var(--f-warn);background:color-mix(in srgb,var(--f-warn) 11%,transparent)}.file-glyph.code,.tile-preview.code{color:var(--f-text-2);background:color-mix(in srgb,var(--f-text-3) 10%,transparent)}.muted{color:var(--f-text-3);font-size:10.5px}.version-pill,.current-pill{display:inline-flex;padding:2px 7px;border-radius:99px;color:var(--f-accent-2);background:color-mix(in srgb,var(--f-accent) 11%,transparent);font-size:9.5px;font-weight:650}.location-cell,.status-inline{display:inline-flex;align-items:center;gap:7px;color:var(--f-text-2);font-size:10.5px}.row-more{width:25px;height:25px;padding:5px;border:0;border-radius:7px;color:var(--f-text-3);background:transparent}.row-more:hover{background:color-mix(in srgb,var(--f-text-3) 9%,transparent)}.file-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:13px}.file-tile{overflow:hidden;padding:0;border:1px solid var(--f-line);border-radius:14px;color:var(--f-text);background:var(--f-surface);text-align:left}.file-tile:hover,.file-tile.selected{border-color:color-mix(in srgb,var(--f-accent-2) 40%,transparent);box-shadow:0 12px 28px color-mix(in srgb,var(--f-accent) 9%,transparent)}.tile-preview{position:relative;display:grid;height:108px;place-items:center;color:var(--f-accent-2);background:linear-gradient(160deg,color-mix(in srgb,var(--f-accent) 7%,transparent),var(--f-surface-2))}.tile-preview.folder{background:linear-gradient(160deg,color-mix(in srgb,var(--f-accent) 7%,transparent),color-mix(in srgb,var(--f-accent) 16%,transparent))}.large-glyph{display:grid;width:44px;height:44px;place-items:center;border-radius:12px;background:color-mix(in srgb,currentColor 10%,transparent)}.large-glyph :deep(svg){width:25px;height:25px}.tile-sync{position:absolute;right:9px;bottom:9px}.tile-body{display:block;padding:10px 12px}.tile-body strong,.tile-body small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tile-body strong{font-size:11.5px}.tile-body small{margin-top:2px;color:var(--f-text-3);font-size:9.5px}.drop-zone{display:flex;align-items:center;gap:13px;width:100%;margin-top:15px;padding:18px;border:1px dashed color-mix(in srgb,var(--f-accent-2) 38%,transparent);border-radius:13px;color:var(--f-text-2);background:color-mix(in srgb,var(--f-accent) 4%,transparent);text-align:left}.drop-zone>span:first-child{width:31px;height:31px;padding:7px;border-radius:9px;color:var(--f-accent-2);background:color-mix(in srgb,var(--f-accent) 12%,transparent)}.drop-zone strong,.drop-zone small{display:block}.drop-zone small{color:var(--f-text-3);font-size:10.5px}.drop-zone em{margin-left:auto;padding:6px 10px;border:1px solid var(--f-line);border-radius:8px;color:var(--f-text);font-style:normal}.state-panel{display:flex;min-height:320px;flex-direction:column;align-items:center;justify-content:center;padding:40px;border:1px solid var(--f-line);border-radius:14px;color:var(--f-text-3);background:var(--f-surface);text-align:center}.state-panel strong{margin-top:12px;color:var(--f-text);font-family:var(--font-display,serif);font-size:20px}.state-panel p{max-width:430px;margin:6px 0 16px}.state-panel>div{display:flex;gap:8px}.state-icon{width:38px;height:38px;color:var(--f-accent-2)}.error-state .state-icon{color:var(--f-danger)}.loader{display:inline-block;width:22px;height:22px;border:2px solid color-mix(in srgb,var(--f-accent) 20%,transparent);border-top-color:var(--f-accent-2);border-radius:50%;animation:spin .8s linear infinite}.detail-panel{position:absolute;z-index:8;top:0;right:0;bottom:0;width:min(390px,42vw);overflow:auto;border-left:1px solid var(--f-line);background:color-mix(in srgb,var(--nx-surface,#111821) 96%,transparent);box-shadow:-35px 0 90px color-mix(in srgb,var(--nx-ink,#000) 34%,transparent);backdrop-filter:blur(22px)}.detail-panel>header{position:sticky;top:0;z-index:2;display:flex;align-items:center;padding:15px;border-bottom:1px solid var(--f-line);background:color-mix(in srgb,var(--f-surface) 94%,transparent);backdrop-filter:blur(16px)}.detail-panel>header .file-name{flex:1}.detail-panel>header>button{width:28px;height:28px;border:0;border-radius:8px;color:var(--f-text-3);background:transparent;font-size:20px}.preview-box{display:grid;min-height:250px;max-height:390px;margin:15px;place-items:center;overflow:hidden;border:1px solid var(--f-line);border-radius:13px;background:color-mix(in srgb,var(--nx-ink,#000) 30%,var(--f-bg))}.preview-box img,.preview-box video,.preview-box iframe{width:100%;height:100%;max-height:388px;object-fit:contain;border:0}.preview-box audio{width:88%}.preview-box pre{width:100%;height:100%;max-height:388px;margin:0;padding:16px;overflow:auto;color:var(--f-text-2);font:10.5px/1.6 var(--font-mono,monospace);white-space:pre-wrap}.preview-placeholder{text-align:center;color:var(--f-text-3)}.preview-placeholder .large-glyph{margin:auto}.preview-placeholder p{max-width:260px}.detail-actions{display:flex;gap:7px;padding:0 15px 15px}.detail-tabs{display:flex;padding:0 15px;border-bottom:1px solid var(--f-line)}.detail-tabs button{padding:10px 8px;border:0;border-bottom:2px solid transparent;color:var(--f-text-3);background:transparent}.detail-tabs button.active{border-color:var(--f-accent-2);color:var(--f-text)}.detail-tabs span{padding:1px 5px;border-radius:99px;background:var(--f-surface-2);font-size:9px}.detail-body{padding:16px}.detail-body dl{display:grid;grid-template-columns:82px 1fr;gap:11px;margin:0}.detail-body dt{color:var(--f-text-3);font-size:10px}.detail-body dd{min-width:0;margin:0;color:var(--f-text-2);font-size:10.5px;overflow-wrap:anywhere}.coming-card{margin-top:18px;padding:13px;border:1px solid var(--f-line);border-radius:11px;background:color-mix(in srgb,var(--f-accent) 5%,transparent)}.coming-card strong{font-size:11px}.coming-card p{margin:4px 0 10px;color:var(--f-text-3);font-size:10px}.coming-card span{color:var(--f-accent-2);font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.versions-list{padding:10px 15px 18px}.version-row{display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:9px;align-items:center;padding:11px 0;border-bottom:1px solid var(--f-line)}.version-number{display:grid;width:28px;height:28px;place-items:center;border-radius:50%;color:var(--f-accent-2);background:color-mix(in srgb,var(--f-accent) 10%,transparent);font:9.5px var(--font-mono,monospace)}.version-row strong,.version-row small{display:block}.version-row strong{font-size:10.5px}.version-row small{margin-top:2px;color:var(--f-text-3);font-size:9px}.version-note,.mini-state{color:var(--f-text-3);font-size:9.5px}.mini-state{display:flex;align-items:center;gap:8px;padding:20px}.mini-state .loader{width:16px;height:16px}.drop-overlay{position:absolute;z-index:20;inset:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;border:2px dashed var(--f-accent-2);border-radius:18px;color:var(--f-accent-2);background:color-mix(in srgb,var(--f-bg) 86%,transparent);backdrop-filter:blur(15px)}.drop-overlay>span{width:48px;height:48px}.drop-overlay strong{margin-top:13px;color:var(--f-text);font-family:var(--font-display,serif);font-size:24px}.drop-overlay p{color:var(--f-text-2)}.detail-enter-active,.detail-leave-active{transition:transform .22s ease,opacity .18s ease}.detail-enter-from,.detail-leave-to{transform:translateX(30px);opacity:0}@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{50%{opacity:.4;transform:scale(.75)}}
@media(max-width:980px){.files-browser{grid-template-columns:64px minmax(0,1fr)}.files-sidebar{padding:16px 8px}.files-brand{justify-content:center;padding:2px 0 14px}.files-brand>div,.files-sidebar nav button>span:not(.nav-icon),.side-label,.disabled-row>span:not(.nav-icon),.disabled-row em,.storage-card,.sync-card>span:not(.sync-dot){display:none}.files-sidebar nav button,.disabled-row{justify-content:center}.side-rule{margin:10px 3px}.sync-card{justify-content:center}.files-topbar{padding:9px 15px}.files-content{padding:18px 18px 48px}th:nth-child(2),td:nth-child(2),th:nth-child(5),td:nth-child(5){display:none}}
@media(max-width:700px){.search-box{max-width:none}.breadcrumbs,.title-actions .disabled-action,th:nth-child(3),td:nth-child(3),th:nth-child(4),td:nth-child(4){display:none}.files-topbar{flex-wrap:wrap}.search-box{order:2;flex-basis:calc(100% - 94px);margin-left:0}.files-content{padding:14px 12px 40px}.title-row h1{font-size:21px}.detail-panel{width:calc(100% - 64px)}.file-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}}
</style>
