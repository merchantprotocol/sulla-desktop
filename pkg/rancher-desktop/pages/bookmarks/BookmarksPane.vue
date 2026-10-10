<!--
  BookmarksPane — window-level left pane (sits beside the ModeRail) that
  lists browser bookmarks and folders.

  Browsing model (VS Code "preview" semantics):
    click            → show the bookmark in the single preview tab; the pane
                       stays open so you can keep clicking through bookmarks
    ↑ / ↓            → move through the list, previewing as you go
    double-click / ⏎ → keep the preview tab open (it becomes a normal tab)
    ⌘/Ctrl-click, middle-click → open in a new tab in the background
  The preview tab also becomes a normal tab the moment you click or type in
  the page (see BrowserTab.vue + browserTabViewManager input-event).

  Everything that pops up (edit, confirm, undo) is rendered inline inside the
  pane: the native browser view is layered above the DOM, so anything that
  overflowed to the right would be hidden behind the page.
-->
<template>
  <aside
    class="bm"
    aria-label="Bookmarks"
  >
    <header class="bm-header">
      <span class="bm-title">Bookmarks</span>
      <div class="bm-actions">
        <button
          class="bm-action"
          type="button"
          :disabled="!canBookmarkActive"
          :title="canBookmarkActive ? (activeIsBookmarked ? 'Page already bookmarked' : 'Bookmark this page') : 'Open a web page to bookmark it'"
          aria-label="Bookmark this page"
          @click="bookmarkActivePage"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            <line
              x1="12"
              y1="7"
              x2="12"
              y2="13"
            /><line
              x1="9"
              y1="10"
              x2="15"
              y2="10"
            />
          </svg>
        </button>
        <button
          class="bm-action"
          type="button"
          title="New folder"
          aria-label="New folder"
          @click="createFolder"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            <line
              x1="12"
              y1="11"
              x2="12"
              y2="17"
            /><line
              x1="9"
              y1="14"
              x2="15"
              y2="14"
            />
          </svg>
        </button>
        <button
          class="bm-action"
          type="button"
          title="Close bookmarks"
          aria-label="Close bookmarks"
          @click="$emit('close')"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line
              x1="18"
              y1="6"
              x2="6"
              y2="18"
            /><line
              x1="6"
              y1="6"
              x2="18"
              y2="18"
            />
          </svg>
        </button>
      </div>
    </header>

    <div class="bm-search">
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      >
        <circle
          cx="11"
          cy="11"
          r="7"
        /><line
          x1="21"
          y1="21"
          x2="16.65"
          y2="16.65"
        />
      </svg>
      <input
        ref="searchRef"
        v-model="query"
        type="text"
        placeholder="Search bookmarks"
        spellcheck="false"
        @keydown.down.prevent="focusList(0)"
        @keydown.esc="query = ''"
      >
    </div>

    <div
      ref="listRef"
      class="bm-list"
      tabindex="0"
      role="tree"
      :class="{ 'drop-root': dropHint?.zone === 'root' }"
      @keydown="onListKeydown"
      @dragover.prevent="onRootDragOver"
      @dragleave="onRootDragLeave"
      @drop.prevent="onDrop"
    >
      <div
        v-if="!loaded && !error"
        class="bm-empty"
      >
        Loading…
      </div>
      <div
        v-else-if="!loaded && error"
        class="bm-empty"
      >
        Waiting for the database…
      </div>
      <div
        v-else-if="rows.length === 0 && query"
        class="bm-empty"
      >
        No bookmarks match “{{ query }}”.
      </div>
      <div
        v-else-if="rows.length === 0"
        class="bm-empty"
      >
        <p>No bookmarks yet.</p>
        <button
          v-if="canBookmarkActive"
          class="bm-link"
          type="button"
          @click="bookmarkActivePage"
        >
          Bookmark the current page
        </button>
      </div>

      <template
        v-for="(row, index) in rows"
        :key="row.record.id"
      >
        <!-- Inline editor -->
        <form
          v-if="editingId === row.record.id"
          class="bm-edit"
          :style="{ paddingLeft: `${12 + row.depth * 14}px` }"
          @submit.prevent="commitEdit"
          @keydown.esc.stop.prevent="cancelEdit"
        >
          <input
            ref="editTitleRef"
            v-model="editTitle"
            class="bm-input"
            type="text"
            placeholder="Name"
            spellcheck="false"
          >
          <input
            v-if="row.record.kind === 'bookmark'"
            v-model="editUrl"
            class="bm-input bm-input-url"
            type="text"
            placeholder="https://"
            spellcheck="false"
          >
          <p
            v-if="editError"
            class="bm-edit-error"
          >
            {{ editError }}
          </p>
          <div class="bm-edit-actions">
            <button
              class="bm-btn"
              type="button"
              @click="cancelEdit"
            >
              Cancel
            </button>
            <button
              class="bm-btn bm-btn-primary"
              type="submit"
            >
              Save
            </button>
          </div>
        </form>

        <!-- Inline delete confirm (folders with contents) -->
        <div
          v-else-if="confirmDeleteId === row.record.id"
          class="bm-confirm"
          :style="{ paddingLeft: `${12 + row.depth * 14}px` }"
        >
          <span>Delete “{{ row.record.title }}” and {{ countDescendants(row) }} inside?</span>
          <div class="bm-edit-actions">
            <button
              class="bm-btn"
              type="button"
              @click="confirmDeleteId = null"
            >
              Cancel
            </button>
            <button
              class="bm-btn bm-btn-danger"
              type="button"
              @click="removeRow(row, true)"
            >
              Delete
            </button>
          </div>
        </div>

        <div
          v-else
          class="bm-row"
          role="treeitem"
          :aria-expanded="row.record.kind === 'folder' ? isExpanded(row.record.id) : undefined"
          :aria-selected="selectedId === row.record.id"
          :title="row.record.url || row.record.title"
          :class="{
            selected: selectedId === row.record.id,
            open: isOpenInActiveTab(row.record),
            previewing: isPreviewing(row.record),
            dragging: dragId === row.record.id,
            'drop-before': dropHint?.id === row.record.id && dropHint.zone === 'before',
            'drop-after': dropHint?.id === row.record.id && dropHint.zone === 'after',
            'drop-inside': dropHint?.id === row.record.id && dropHint.zone === 'inside',
            live: row.readonly,
          }"
          :style="{ paddingLeft: `${10 + row.depth * 14}px` }"
          :draggable="!row.readonly"
          @click="onRowClick($event, row, index)"
          @dblclick="onRowDblClick(row)"
          @auxclick="onRowAuxClick($event, row)"
          @dragstart="onDragStart($event, row)"
          @dragend="onDragEnd"
          @dragover.prevent.stop="onRowDragOver($event, row)"
          @drop.prevent.stop="onDrop"
        >
          <span
            v-if="row.record.kind === 'folder'"
            class="bm-chevron"
            :class="{ expanded: isExpanded(row.record.id) || !!query }"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            ><polyline points="9 6 15 12 9 18" /></svg>
          </span>
          <span
            v-else
            class="bm-chevron-spacer"
          />

          <span
            v-if="row.record.id === DOCKER_FOLDER_ID"
            class="bm-icon bm-icon-folder"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line
                x1="12"
                y1="22.08"
                x2="12"
                y2="12"
              />
            </svg>
          </span>
          <span
            v-else-if="row.record.kind === 'folder'"
            class="bm-icon bm-icon-folder"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          <img
            v-else-if="row.record.favicon"
            class="bm-icon bm-favicon"
            :src="row.record.favicon"
            alt=""
            draggable="false"
          >
          <span
            v-else
            class="bm-icon bm-monogram"
            :style="monogramStyle(row.record)"
          >{{ monogram(row.record) }}</span>

          <span class="bm-label">{{ row.record.title }}</span>
          <span
            v-if="query && row.path"
            class="bm-path"
          >{{ row.path }}</span>

          <span
            v-if="row.record.id === DOCKER_FOLDER_ID"
            class="bm-row-actions"
            @click.stop
            @dblclick.stop
          >
            <button
              class="bm-row-btn"
              type="button"
              title="Refresh containers"
              aria-label="Refresh containers"
              @click="refreshDocker"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              ><path d="M21 12a9 9 0 1 1-3.2-6.8" /><polyline points="21 3.5 21 9 15.5 9" /></svg>
            </button>
          </span>
          <span
            v-else-if="!row.readonly"
            class="bm-row-actions"
            @click.stop
            @dblclick.stop
          >
            <button
              class="bm-row-btn"
              type="button"
              title="Edit"
              aria-label="Edit"
              @click="startEdit(row.record)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              ><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
            </button>
            <button
              class="bm-row-btn"
              type="button"
              title="Delete"
              aria-label="Delete"
              @click="removeRow(row)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              ><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
            </button>
          </span>
        </div>
      </template>
    </div>

    <div
      v-if="undo"
      class="bm-toast"
    >
      <span class="bm-toast-text">Deleted “{{ undo.record.title }}”</span>
      <button
        class="bm-link"
        type="button"
        @click="undoDelete"
      >
        Undo
      </button>
    </div>
    <div
      v-else-if="actionError"
      class="bm-toast bm-toast-error"
    >
      <span class="bm-toast-text">{{ actionError }}</span>
    </div>
    <footer
      v-else
      class="bm-hint"
    >
      Click to preview · Double-click to keep
    </footer>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { useBookmarks, bookmarkUrlKey, type BookmarkNode, type BookmarkRecord } from '@pkg/composables/useBookmarks';
import { useBrowserTabs } from '@pkg/composables/useBrowserTabs';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

interface ActiveTabInfo {
  id:    string;
  url:   string;
  title: string;
  mode:  string;
}

interface Row {
  record:    BookmarkRecord;
  depth:     number;
  node:      BookmarkNode;
  /** Folder path shown next to search results. */
  path?:     string;
  /** Live Docker rows — can't be edited, deleted, dragged, or dropped onto. */
  readonly?: boolean;
}

const props = defineProps<{
  activeTab?: ActiveTabInfo;
  /** Bookmark to reveal + select when the pane opens (e.g. from the toolbar star). */
  revealId?:  string | null;
}>();

defineEmits<(e: 'close') => void>();

const router = useRouter();
const { tree, records, loaded, error, findByUrl, addBookmark, addFolder, update, remove, move } = useBookmarks();
const { tabs, previewTabId, openInPreviewTab, promoteTab, createTab } = useBrowserTabs();

const query = ref('');
const selectedId = ref<string | null>(null);
const listRef = ref<HTMLElement | null>(null);
const searchRef = ref<HTMLInputElement | null>(null);
const actionError = ref<string | null>(null);

// ── Expanded folders (persisted) ──
const EXPANDED_KEY = 'sulla:bookmarks-expanded';
const expanded = ref<Set<string>>(new Set(loadExpanded()));

function loadExpanded(): string[] {
  try {
    const stored = localStorage.getItem(EXPANDED_KEY);
    // First run: show the live Docker section open.
    if (stored === null) return ['docker:root'];
    const parsed = JSON.parse(stored);

    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

watch(expanded, (set) => {
  try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set])) } catch { /* best-effort */ }
}, { deep: true });

function isExpanded(id: string): boolean {
  return expanded.value.has(id);
}

function setExpanded(id: string, open: boolean): void {
  const next = new Set(expanded.value);
  if (open) next.add(id); else next.delete(id);
  expanded.value = next;
}

// ── Live Docker section ──
// Running containers with published ports, re-read from `docker ps` while the
// pane is open. Shown as a read-only folder above the saved bookmarks.
const DOCKER_FOLDER_ID = 'docker:root';
const DOCKER_POLL_MS = 15_000;

interface DockerLink { id: string; container: string; title: string; url: string }

const dockerLinks = ref<DockerLink[]>([]);
const dockerAvailable = ref(true);
let dockerTimer: ReturnType<typeof setInterval> | null = null;
let dockerInflight = false;

async function refreshDocker(): Promise<void> {
  if (dockerInflight) return;
  dockerInflight = true;
  try {
    const result = await ipcRenderer.invoke('bookmarks:docker-links');
    dockerAvailable.value = !!result?.available;
    dockerLinks.value = result?.links ?? [];
  } catch {
    dockerAvailable.value = false;
    dockerLinks.value = [];
  } finally {
    dockerInflight = false;
  }
}

refreshDocker();
dockerTimer = setInterval(refreshDocker, DOCKER_POLL_MS);

function liveRecord(id: string, kind: 'bookmark' | 'folder', title: string, url: string | null, parentId: string | null, position: number): BookmarkRecord {
  return { id, parent_id: parentId, kind, title, url, favicon: null, position, created_at: '', updated_at: '' };
}

const dockerNode = computed<BookmarkNode | null>(() => {
  if (!dockerAvailable.value && dockerLinks.value.length === 0) return null;
  const children = dockerLinks.value.map((link, i) => ({
    record:   liveRecord(link.id, 'bookmark', link.title, link.url, DOCKER_FOLDER_ID, i),
    children: [],
  }));

  return { record: liveRecord(DOCKER_FOLDER_ID, 'folder', `Docker (${ children.length })`, null, null, -1), children };
});

// ── Visible rows ──
const rows = computed<Row[]>(() => {
  const q = query.value.trim().toLowerCase();
  const out: Row[] = [];
  const docker = dockerNode.value;

  if (q) {
    for (const node of docker?.children ?? []) {
      const r = node.record;
      if (r.title.toLowerCase().includes(q) || (r.url || '').toLowerCase().includes(q)) {
        out.push({ record: r, depth: 0, node, path: 'Docker', readonly: true });
      }
    }
    const walk = (nodes: BookmarkNode[], path: string[]) => {
      for (const node of nodes) {
        const r = node.record;
        if (r.kind === 'folder') {
          walk(node.children, [...path, r.title]);
        } else if (r.title.toLowerCase().includes(q) || (r.url || '').toLowerCase().includes(q)) {
          out.push({ record: r, depth: 0, node, path: path.join(' / ') });
        }
      }
    };
    walk(tree.value, []);

    return out;
  }

  if (docker) {
    out.push({ record: docker.record, depth: 0, node: docker, readonly: true });
    if (isExpanded(DOCKER_FOLDER_ID)) {
      for (const node of docker.children) out.push({ record: node.record, depth: 1, node, readonly: true });
    }
  }

  const walk = (nodes: BookmarkNode[], depth: number) => {
    for (const node of nodes) {
      out.push({ record: node.record, depth, node });
      if (node.record.kind === 'folder' && isExpanded(node.record.id)) walk(node.children, depth + 1);
    }
  };
  walk(tree.value, 0);

  return out;
});

// ── Active / preview tab awareness ──
const previewTab = computed(() => (previewTabId.value ? tabs.find(t => t.id === previewTabId.value) : undefined));

const canBookmarkActive = computed(() => {
  const t = props.activeTab;

  return !!t && t.mode === 'browser' && /^(https?|file):/i.test(t.url || '');
});
const activeIsBookmarked = computed(() => !!(props.activeTab && findByUrl(props.activeTab.url)));

function isOpenInActiveTab(record: BookmarkRecord): boolean {
  return record.kind === 'bookmark' && !!props.activeTab && bookmarkUrlKey(record.url) === bookmarkUrlKey(props.activeTab.url);
}

function isPreviewing(record: BookmarkRecord): boolean {
  return record.kind === 'bookmark' && !!previewTab.value && bookmarkUrlKey(record.url) === bookmarkUrlKey(previewTab.value.url);
}

// ── Opening bookmarks ──
function preview(record: BookmarkRecord): void {
  if (record.kind !== 'bookmark' || !record.url) return;
  const tab = openInPreviewTab(record.url, record.title);
  router.push(`/Browser/${ tab.id }`);
}

function keepOpen(record: BookmarkRecord): void {
  if (record.kind !== 'bookmark' || !record.url) return;
  const current = previewTab.value;
  // Already showing it in the preview tab — just promote that tab.
  const tab = current && bookmarkUrlKey(current.url) === bookmarkUrlKey(record.url)
    ? current
    : openInPreviewTab(record.url, record.title);
  promoteTab(tab.id);
  router.push(`/Browser/${ tab.id }`);
}

function openInBackground(record: BookmarkRecord): void {
  if (record.kind !== 'bookmark' || !record.url) return;
  createTab(record.url);
}

let previewTimer: ReturnType<typeof setTimeout> | null = null;

function previewSoon(record: BookmarkRecord): void {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    preview(record);
  }, 220);
}

onBeforeUnmount(() => {
  if (dockerTimer) clearInterval(dockerTimer);
  if (previewTimer) clearTimeout(previewTimer);
  if (undoTimer) clearTimeout(undoTimer);
});

function onRowClick(event: MouseEvent, row: Row, _index: number): void {
  selectedId.value = row.record.id;
  listRef.value?.focus({ preventScroll: true });

  if (row.record.kind === 'folder') {
    if (!query.value) setExpanded(row.record.id, !isExpanded(row.record.id));

    return;
  }
  if (event.metaKey || event.ctrlKey) {
    openInBackground(row.record);

    return;
  }
  // A dblclick arrives as click, click, dblclick — the second click must not
  // re-navigate the page that's already loading.
  if (event.detail > 1) return;
  preview(row.record);
}

function onRowDblClick(row: Row): void {
  keepOpen(row.record);
}

function onRowAuxClick(event: MouseEvent, row: Row): void {
  if (event.button === 1) openInBackground(row.record);
}

// ── Keyboard ──
function focusList(index: number): void {
  const row = rows.value[index];
  if (!row) return;
  selectedId.value = row.record.id;
  listRef.value?.focus();
  scrollSelectedIntoView();
}

function scrollSelectedIntoView(): void {
  nextTick(() => {
    listRef.value?.querySelector('.bm-row.selected')?.scrollIntoView({ block: 'nearest' });
  });
}

function onListKeydown(event: KeyboardEvent): void {
  if (editingId.value || (event.target as HTMLElement) !== listRef.value) return;
  const list = rows.value;
  const idx = list.findIndex(r => r.record.id === selectedId.value);
  const row = idx >= 0 ? list[idx] : undefined;

  const select = (next: Row | undefined) => {
    if (!next) return;
    selectedId.value = next.record.id;
    scrollSelectedIntoView();
    if (next.record.kind === 'bookmark') previewSoon(next.record);
  };

  switch (event.key) {
  case 'ArrowDown':
    event.preventDefault();
    select(list[Math.min(idx + 1, list.length - 1)] ?? list[0]);
    break;
  case 'ArrowUp':
    event.preventDefault();
    if (idx <= 0) {
      searchRef.value?.focus();
    } else {
      select(list[idx - 1]);
    }
    break;
  case 'ArrowRight':
    if (row?.record.kind === 'folder' && !query.value) {
      event.preventDefault();
      setExpanded(row.record.id, true);
    }
    break;
  case 'ArrowLeft':
    if (!row || query.value) break;
    event.preventDefault();
    if (row.record.kind === 'folder' && isExpanded(row.record.id)) {
      setExpanded(row.record.id, false);
    } else if (row.record.parent_id) {
      selectedId.value = row.record.parent_id;
      scrollSelectedIntoView();
    }
    break;
  case 'Enter':
    if (!row) break;
    event.preventDefault();
    if (row.record.kind === 'folder') {
      if (!query.value) setExpanded(row.record.id, !isExpanded(row.record.id));
    } else if (event.metaKey || event.ctrlKey) {
      openInBackground(row.record);
    } else {
      if (previewTimer) clearTimeout(previewTimer);
      keepOpen(row.record);
    }
    break;
  case 'F2':
    if (row && !row.readonly) {
      event.preventDefault();
      startEdit(row.record);
    }
    break;
  case 'Delete':
  case 'Backspace':
    if (row && !row.readonly) {
      event.preventDefault();
      removeRow(row);
    }
    break;
  }
}

// ── Monogram fallback icon ──
function hostOf(record: BookmarkRecord): string {
  try {
    return new URL(record.url || '').hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function monogram(record: BookmarkRecord): string {
  const source = hostOf(record) || record.title || '?';

  return source.charAt(0).toUpperCase();
}

function monogramStyle(record: BookmarkRecord): Record<string, string> {
  const key = hostOf(record) || record.title;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;

  return {
    color:      `hsl(${ hue }, 45%, 78%)`,
    background: `hsla(${ hue }, 40%, 45%, 0.22)`,
  };
}

// ── Create ──
function selectedFolderId(): string | null {
  const sel = records.value.find(r => r.id === selectedId.value);
  if (!sel || query.value) return null;
  if (sel.kind === 'folder') return sel.id;

  return sel.parent_id;
}

async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  actionError.value = null;
  try {
    return await fn();
  } catch (err) {
    actionError.value = (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    setTimeout(() => { actionError.value = null }, 5_000);

    return undefined;
  }
}

async function bookmarkActivePage(): Promise<void> {
  const tab = props.activeTab;
  if (!tab || !canBookmarkActive.value) return;
  const existing = findByUrl(tab.url);
  if (existing) {
    reveal(existing.id);

    return;
  }
  const parentId = selectedFolderId();
  const created = await run(() => addBookmark({ url: tab.url, title: tab.title, parentId, tabId: tab.id }));
  if (created) {
    if (parentId) setExpanded(parentId, true);
    reveal(created.id);
  }
}

async function createFolder(): Promise<void> {
  const parentId = selectedFolderId();
  const created = await run(() => addFolder('New folder', parentId));
  if (created) {
    if (parentId) setExpanded(parentId, true);
    query.value = '';
    selectedId.value = created.id;
    startEdit(created);
  }
}

/** Expand ancestors, select, and scroll to a bookmark. */
function reveal(id: string): void {
  query.value = '';
  let cursor = records.value.find(r => r.id === id);
  const next = new Set(expanded.value);
  while (cursor?.parent_id) {
    next.add(cursor.parent_id);
    cursor = records.value.find(r => r.id === cursor!.parent_id);
  }
  expanded.value = next;
  selectedId.value = id;
  scrollSelectedIntoView();
}

watch(() => props.revealId, (id) => {
  if (id && records.value.some(r => r.id === id)) reveal(id);
}, { immediate: true });
// The star may create the bookmark just before the list refreshes.
watch(records, () => {
  if (props.revealId && selectedId.value !== props.revealId && records.value.some(r => r.id === props.revealId)) reveal(props.revealId);
});

// ── Edit ──
const editingId = ref<string | null>(null);
const editTitle = ref('');
const editUrl = ref('');
const editError = ref<string | null>(null);
const editTitleRef = ref<HTMLInputElement[] | HTMLInputElement | null>(null);

function startEdit(record: BookmarkRecord): void {
  editingId.value = record.id;
  editTitle.value = record.title;
  editUrl.value = record.url || '';
  editError.value = null;
  nextTick(() => {
    const el = Array.isArray(editTitleRef.value) ? editTitleRef.value[0] : editTitleRef.value;
    el?.focus();
    el?.select();
  });
}

function cancelEdit(): void {
  editingId.value = null;
  editError.value = null;
  listRef.value?.focus();
}

function normalizeTypedUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;

  return /^(localhost|127\.0\.0\.1)(:\d+)?/i.test(trimmed) ? `http://${ trimmed }` : `https://${ trimmed }`;
}

async function commitEdit(): Promise<void> {
  const id = editingId.value;
  const record = records.value.find(r => r.id === id);
  if (!id || !record) return cancelEdit();

  try {
    await update(id, record.kind === 'bookmark'
      ? { title: editTitle.value, url: normalizeTypedUrl(editUrl.value) }
      : { title: editTitle.value });
    editingId.value = null;
    editError.value = null;
    listRef.value?.focus();
  } catch (err) {
    editError.value = (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
}

// ── Delete + undo ──
const confirmDeleteId = ref<string | null>(null);
const undo = ref<{ record: BookmarkRecord; index: number } | null>(null);
let undoTimer: ReturnType<typeof setTimeout> | null = null;

function countDescendants(row: Row): number {
  let n = 0;
  const walk = (nodes: BookmarkNode[]) => {
    for (const c of nodes) {
      n++;
      walk(c.children);
    }
  };
  walk(row.node.children);

  return n;
}

async function removeRow(row: Row, confirmed = false): Promise<void> {
  if (row.readonly) return;
  const record = row.record;
  // Folders with contents need an explicit confirm — undo only restores a
  // single row, so it can't bring back a whole subtree.
  if (record.kind === 'folder' && row.node.children.length > 0 && !confirmed) {
    confirmDeleteId.value = record.id;

    return;
  }
  confirmDeleteId.value = null;

  const siblings = records.value
    .filter(r => r.parent_id === record.parent_id)
    .sort((a, b) => a.position - b.position);
  const index = siblings.findIndex(r => r.id === record.id);

  // Keep keyboard selection on a neighbour.
  const visible = rows.value;
  const vIdx = visible.findIndex(r => r.record.id === record.id);
  const neighbour = visible[vIdx + 1] ?? visible[vIdx - 1];

  const ok = await run(() => remove(record.id));
  if (ok === undefined) return;

  selectedId.value = neighbour && neighbour.record.parent_id !== record.id ? neighbour.record.id : null;
  listRef.value?.focus();

  if (record.kind === 'bookmark' || row.node.children.length === 0) {
    undo.value = { record, index };
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { undo.value = null }, 6_000);
  }
}

async function undoDelete(): Promise<void> {
  const entry = undo.value;
  if (!entry) return;
  undo.value = null;
  if (undoTimer) clearTimeout(undoTimer);
  const { record, index } = entry;
  const parentId = record.parent_id && records.value.some(r => r.id === record.parent_id) ? record.parent_id : null;

  const restored = await run(async() => {
    const created = record.kind === 'folder'
      ? await addFolder(record.title, parentId)
      : await addBookmark({ url: record.url!, title: record.title, parentId });
    await move(created.id, parentId, index);

    return created;
  });
  if (restored) reveal(restored.id);
}

// ── Drag and drop ──
type DropZone = 'before' | 'after' | 'inside' | 'root';
const dragId = ref<string | null>(null);
const dropHint = ref<{ id: string | null; zone: DropZone } | null>(null);

function onDragStart(event: DragEvent, row: Row): void {
  if (editingId.value || row.readonly) {
    event.preventDefault();

    return;
  }
  dragId.value = row.record.id;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', row.record.url || row.record.title);
  }
}

function onDragEnd(): void {
  dragId.value = null;
  dropHint.value = null;
}

function isDescendant(candidateId: string, ancestorId: string): boolean {
  let cursor = records.value.find(r => r.id === candidateId);
  while (cursor) {
    if (cursor.id === ancestorId) return true;
    cursor = cursor.parent_id ? records.value.find(r => r.id === cursor!.parent_id) : undefined;
  }

  return false;
}

function onRowDragOver(event: DragEvent, row: Row): void {
  if (!dragId.value || query.value) return;
  if (row.readonly) {
    dropHint.value = null;

    return;
  }
  if (row.record.id === dragId.value || isDescendant(row.record.id, dragId.value)) {
    dropHint.value = null;

    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const y = (event.clientY - rect.top) / rect.height;
  let zone: DropZone;
  if (row.record.kind === 'folder') {
    zone = y < 0.25 ? 'before' : y > 0.75 && !isExpanded(row.record.id) ? 'after' : 'inside';
  } else {
    zone = y < 0.5 ? 'before' : 'after';
  }
  dropHint.value = { id: row.record.id, zone };
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
}

function onRootDragOver(event: DragEvent): void {
  if (!dragId.value || query.value) return;
  // Only the empty area below the rows counts as "top level, at the end".
  if ((event.target as HTMLElement) === listRef.value) dropHint.value = { id: null, zone: 'root' };
}

function onRootDragLeave(event: DragEvent): void {
  if ((event.target as HTMLElement) === listRef.value && dropHint.value?.zone === 'root') dropHint.value = null;
}

async function onDrop(): Promise<void> {
  const id = dragId.value;
  const hint = dropHint.value;
  dragId.value = null;
  dropHint.value = null;
  if (!id || !hint) return;

  let parentId: string | null;
  let index: number;
  const siblingsOf = (pid: string | null) => records.value
    .filter(r => r.parent_id === pid && r.id !== id)
    .sort((a, b) => a.position - b.position);

  if (hint.zone === 'root') {
    parentId = null;
    index = siblingsOf(null).length;
  } else {
    const target = records.value.find(r => r.id === hint.id);
    if (!target) return;
    if (hint.zone === 'inside') {
      parentId = target.id;
      index = siblingsOf(parentId).length;
      setExpanded(target.id, true);
    } else {
      parentId = target.parent_id;
      const sibs = siblingsOf(parentId);
      index = sibs.findIndex(r => r.id === target.id) + (hint.zone === 'after' ? 1 : 0);
    }
  }

  await run(() => move(id, parentId, index));
  selectedId.value = id;
}

defineExpose({ focusSearch: () => searchRef.value?.focus(), reveal });
</script>

<style scoped>
.bm {
  display: flex;
  flex-direction: column;
  width: 280px;
  height: 100%;
  flex-shrink: 0;
  overflow: hidden;
  background: var(--bg-surface);
  border-right: 1px solid var(--border-muted);
  user-select: none;
}

.bm-header {
  display: flex;
  align-items: center;
  height: 35px;
  padding: 0 8px 0 16px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-muted);
}

.bm-title {
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--accent);
}

.bm-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.bm-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.bm-action:hover:not(:disabled) {
  background: var(--accent-dim);
  color: var(--text);
}
.bm-action:disabled {
  opacity: 0.35;
  cursor: default;
}

.bm-search {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 10px 10px 6px;
  padding: 0 10px;
  height: 28px;
  border: 1px solid var(--border-muted);
  border-radius: 7px;
  color: var(--text-dim);
  background: rgba(255, 255, 255, 0.02);
  transition: border-color 0.12s ease;
}
.bm-search:focus-within {
  border-color: var(--accent-border, rgba(80, 150, 179, 0.4));
}
.bm-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: none;
  color: var(--text);
  font-size: 12px;
}
.bm-search input::placeholder {
  color: var(--text-dim);
}

.bm-list {
  flex: 1;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 2px 6px 10px;
  outline: none;
}
.bm-list::-webkit-scrollbar { width: 4px; }
.bm-list::-webkit-scrollbar-track { background: transparent; }
.bm-list::-webkit-scrollbar-thumb {
  background: var(--border-muted, rgba(80, 150, 179, 0.2));
  border-radius: 2px;
}
.bm-list.drop-root {
  box-shadow: inset 0 -2px 0 var(--accent);
}

.bm-empty {
  padding: 22px 12px;
  color: var(--text-dim);
  font-size: 12px;
  text-align: center;
  line-height: 1.6;
}
.bm-empty p {
  margin: 0 0 6px;
}

.bm-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding-right: 6px;
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 12.5px;
  cursor: pointer;
  transition: background 0.1s ease, color 0.1s ease;
}
.bm-row:hover {
  background: rgba(80, 150, 179, 0.08);
  color: var(--text);
}
.bm-row.open {
  color: var(--text);
}
.bm-row.open::before {
  content: "";
  position: absolute;
  left: -6px;
  top: 7px;
  bottom: 7px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}
.bm-row.previewing .bm-label {
  font-style: italic;
}
.bm-row.selected {
  background: var(--accent-dim, rgba(80, 150, 179, 0.14));
  color: var(--text);
}
.bm-list:focus .bm-row.selected {
  box-shadow: inset 0 0 0 1px var(--accent-border, rgba(80, 150, 179, 0.4));
}
.bm-row.dragging {
  opacity: 0.4;
}
.bm-row.drop-before { box-shadow: inset 0 2px 0 var(--accent); }
.bm-row.drop-after { box-shadow: inset 0 -2px 0 var(--accent); }
.bm-row.drop-inside {
  background: var(--accent-dim, rgba(80, 150, 179, 0.14));
  box-shadow: inset 0 0 0 1px var(--accent);
}

.bm-chevron,
.bm-chevron-spacer {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 10px;
  flex-shrink: 0;
  color: var(--text-dim);
}
.bm-chevron svg {
  transition: transform 0.15s ease;
}
.bm-chevron.expanded svg {
  transform: rotate(90deg);
}

.bm-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.bm-icon-folder {
  color: var(--accent);
  opacity: 0.85;
}
.bm-favicon {
  object-fit: contain;
  border-radius: 3px;
}
.bm-monogram {
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1;
}

.bm-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bm-path {
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
  font-size: 10.5px;
}

.bm-row-actions {
  display: none;
  align-items: center;
  gap: 1px;
}
.bm-row:hover .bm-row-actions,
.bm-row.selected .bm-row-actions {
  display: flex;
}
.bm-row-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--text-dim);
  cursor: pointer;
}
.bm-row-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
}

.bm-edit,
.bm-confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 2px 0;
  padding: 8px 8px 8px 12px;
  border: 1px solid var(--accent-border, rgba(80, 150, 179, 0.4));
  border-radius: 7px;
  background: rgba(80, 150, 179, 0.06);
  color: var(--text);
  font-size: 12px;
}
.bm-input {
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border-muted);
  border-radius: 5px;
  outline: none;
  background: var(--bg-surface);
  color: var(--text);
  font-size: 12px;
  user-select: text;
}
.bm-input:focus {
  border-color: var(--accent);
}
.bm-input-url {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
}
.bm-edit-error {
  margin: 0;
  color: var(--danger, #e06c75);
  font-size: 11px;
}
.bm-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.bm-btn {
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--border-muted);
  border-radius: 5px;
  background: none;
  color: var(--text-muted);
  font-size: 11.5px;
  cursor: pointer;
}
.bm-btn:hover {
  color: var(--text);
  border-color: var(--accent-border, rgba(80, 150, 179, 0.4));
}
.bm-btn-primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
.bm-btn-primary:hover {
  color: #fff;
  filter: brightness(1.1);
}
.bm-btn-danger {
  border-color: var(--danger, #e06c75);
  color: var(--danger, #e06c75);
}

.bm-link {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent);
  font-size: 12px;
  cursor: pointer;
}
.bm-link:hover {
  text-decoration: underline;
}

.bm-toast,
.bm-hint {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 14px;
  flex-shrink: 0;
  border-top: 1px solid var(--border-muted);
  font-size: 11px;
}
.bm-hint {
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.04em;
}
.bm-toast {
  color: var(--text-muted);
}
.bm-toast-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bm-toast-error {
  color: var(--danger, #e06c75);
}
</style>

<style scoped>
.theme-noir .bm {
  width: 292px;
  background: color-mix(in srgb, var(--bg-surface-alt) 72%, transparent);
  border-color: var(--nx-hair);
  box-shadow: 16px 0 44px color-mix(in srgb, var(--shadow) 20%, transparent);
  backdrop-filter: blur(18px);
}

.theme-noir .bm-header {
  height: 46px;
  padding: 0 10px 0 16px;
  border-color: var(--nx-hair);
}

.theme-noir .bm-title {
  color: var(--nx-accent-2);
  font-size: 10px;
  letter-spacing: 0.18em;
}

.theme-noir .bm-action {
  width: 28px;
  height: 28px;
  border-radius: 14px;
  color: var(--nx-read-4);
  transition: color 0.16s, background 0.16s, transform 0.45s cubic-bezier(.22, 1, .36, 1);
}

.theme-noir .bm-action:hover:not(:disabled) {
  color: var(--nx-read-1);
  background: color-mix(in srgb, var(--nx-accent) 12%, transparent);
  transform: translateY(-1px);
}

.theme-noir .bm-search {
  height: 36px;
  margin: 12px 10px 8px;
  color: var(--nx-read-4);
  background: color-mix(in srgb, var(--nx-paper) 72%, transparent);
  border-color: color-mix(in srgb, var(--nx-hair-strong) 75%, transparent);
  border-radius: 11px;
}

.theme-noir .bm-search:focus-within {
  border-color: color-mix(in srgb, var(--nx-accent-2) 50%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--nx-accent) 10%, transparent);
}

.theme-noir .bm-search input {
  color: var(--nx-read-2);
  font-family: ui-monospace, 'SF Mono', monospace;
}

.theme-noir .bm-list { padding: 4px 8px 12px; }
.theme-noir .bm-row {
  height: 36px;
  margin-bottom: 3px;
  border: 1px solid transparent;
  border-radius: 10px;
  color: var(--nx-read-3);
  transition: background 0.16s, color 0.16s, border-color 0.16s, transform 0.42s cubic-bezier(.22, 1, .36, 1);
}

.theme-noir .bm-row:hover {
  color: var(--nx-read-2);
  background: color-mix(in srgb, var(--nx-accent) 8%, transparent);
  border-color: color-mix(in srgb, var(--nx-hair-strong) 37.5%, transparent);
  transform: translateX(2px);
}

.theme-noir .bm-row.open,
.theme-noir .bm-row.selected {
  color: var(--nx-read-1);
  background: linear-gradient(90deg, color-mix(in srgb, var(--nx-accent) 20%, transparent), color-mix(in srgb, var(--nx-accent) 8%, transparent));
  border-color: color-mix(in srgb, var(--nx-accent-2) 24%, transparent);
}

.theme-noir .bm-row.open::before {
  left: -9px;
  top: 7px;
  bottom: 7px;
  width: 3px;
  background: var(--nx-accent-2);
  box-shadow: 0 0 10px color-mix(in srgb, var(--nx-accent-2) 80%, transparent);
}

.theme-noir .bm-path {
  color: var(--nx-read-4);
  font-family: ui-monospace, 'SF Mono', monospace;
}

.theme-noir .bm-row-btn {
  border-radius: 10px;
  color: var(--nx-read-4);
}
.theme-noir .bm-row-btn:hover {
  color: var(--nx-read-1);
  background: color-mix(in srgb, var(--nx-accent) 15%, transparent);
}

.theme-noir .bm-edit,
.theme-noir .bm-confirm {
  padding: 12px;
  border-color: color-mix(in srgb, var(--nx-accent-2) 30%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--nx-accent) 7%, transparent);
}

.theme-noir .bm-input {
  height: 34px;
  color: var(--nx-read-2);
  background: color-mix(in srgb, var(--nx-paper) 72%, transparent);
  border-color: color-mix(in srgb, var(--nx-hair-strong) 75%, transparent);
  border-radius: 9px;
}

.theme-noir .bm-btn { border-radius: 12px; }
.theme-noir .bm-btn-primary {
  background: linear-gradient(180deg, var(--nx-accent-2), var(--nx-accent));
  border-color: var(--nx-accent-2);
  box-shadow: 0 0 14px color-mix(in srgb, var(--nx-accent) 30%, transparent);
}

.theme-noir .bm-toast,
.theme-noir .bm-hint {
  height: 36px;
  border-color: var(--nx-hair);
  background: color-mix(in srgb, var(--nx-paper) 42%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .theme-noir .bm-row,
  .theme-noir .bm-action { transition-duration: 0.01ms; }
}
</style>
