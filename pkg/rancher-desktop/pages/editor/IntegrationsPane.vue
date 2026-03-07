<template>
  <div class="integrations-pane" :class="{ dark: isDark }">
    <!-- Header -->
    <div class="integrations-header" :class="{ dark: isDark }">
      <span class="integrations-header-title">Integrations</span>
      <div class="integrations-header-actions">
        <button class="integrations-header-btn" :class="{ dark: isDark }" title="Pull latest" @click="gitPull">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="8 17 12 21 16 17"/>
            <line x1="12" y1="12" x2="12" y2="21"/>
            <path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/>
          </svg>
        </button>
        <button class="integrations-header-btn" :class="{ dark: isDark }" title="Refresh" @click="loadIntegrations">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </button>
        <button class="integrations-header-btn" :class="{ dark: isDark }" title="Close Panel" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>

    <!-- Git info bar -->
    <div v-if="branch" class="integrations-git-bar" :class="{ dark: isDark }">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="6" y1="3" x2="6" y2="15"/>
        <circle cx="18" cy="6" r="3"/>
        <circle cx="6" cy="18" r="3"/>
        <path d="M18 9a9 9 0 0 1-9 9"/>
      </svg>
      <span>{{ branch }}</span>
      <span v-if="gitStatus" class="integrations-git-status">{{ gitStatus }}</span>
    </div>

    <div class="integrations-content">
      <!-- Loading -->
      <div v-if="loading" class="integrations-status">Loading integrations...</div>

      <!-- Empty state -->
      <div v-else-if="entries.length === 0" class="integrations-empty">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.3">
          <path d="M4 6h16M4 12h16M4 18h16"/>
        </svg>
        <p class="integrations-empty-text">No integrations found</p>
        <p class="integrations-empty-hint">Integrations will be cloned from the repository on startup</p>
      </div>

      <!-- File tree -->
      <div v-else class="integrations-list">
        <template v-for="entry in entries" :key="entry.path">
          <!-- Directory -->
          <button
            v-if="entry.isDir"
            class="integrations-row"
            :class="{ dark: isDark }"
            @click="toggleDir(entry)"
            @contextmenu.prevent="showContextMenu($event, entry)"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" :class="{ rotated: expandedDirs.has(entry.path) }">
              <path d="M3 1l4 4-4 4z"/>
            </svg>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span class="integrations-row-name">{{ entry.name }}</span>
            <button
              class="integrations-api-btn"
              :class="{ dark: isDark }"
              title="Open in API tester"
              @click.stop="$emit('open-api-test', entry.name)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 14.66V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5.34"/>
                <polygon points="18 2 22 6 12 16 8 16 8 12 18 2"/>
              </svg>
            </button>
          </button>
          <!-- Directory children -->
          <div v-if="entry.isDir && expandedDirs.has(entry.path) && dirChildren.get(entry.path)" class="integrations-subfiles">
            <button
              v-for="child in dirChildren.get(entry.path)"
              :key="child.path"
              class="integrations-row integrations-nested"
              :class="{ dark: isDark }"
              @click="child.isDir ? toggleDir(child) : openFile(child)"
              @contextmenu.prevent="showContextMenu($event, child)"
            >
              <svg v-if="child.isDir" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              <span>{{ child.name }}</span>
            </button>
          </div>
          <!-- File -->
          <button
            v-if="!entry.isDir"
            class="integrations-row"
            :class="{ dark: isDark }"
            @click="openFile(entry)"
            @contextmenu.prevent="showContextMenu($event, entry)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5" style="margin-left: 14px">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span>{{ entry.name }}</span>
          </button>
        </template>
      </div>
    </div>

    <!-- Context menu -->
    <Teleport to="body">
      <div v-if="contextMenu.visible" class="integrations-ctx-overlay" @click="contextMenu.visible = false">
        <div
          class="integrations-ctx-menu"
          :class="{ dark: isDark }"
          :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }"
        >
          <button class="integrations-ctx-item" :class="{ dark: isDark }" @click="ctxNewFile">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
            <span>New File</span>
          </button>
          <button class="integrations-ctx-item" :class="{ dark: isDark }" @click="ctxNewFolder">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span>New Folder</span>
          </button>
          <button v-if="!contextMenu.entry?.isDir" class="integrations-ctx-item" :class="{ dark: isDark }" @click="ctxDelete">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            <span>Delete</span>
          </button>
          <button class="integrations-ctx-item" :class="{ dark: isDark }" @click="ctxReveal">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <span>Reveal in Finder</span>
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, reactive, onMounted } from 'vue';
import { ipcRenderer } from 'electron';
import os from 'os';
import path from 'path';

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  ext: string;
}

export default defineComponent({
  name: 'IntegrationsPane',

  props: {
    isDark: { type: Boolean, default: false },
  },

  emits: ['file-selected', 'close', 'open-api-test'],

  setup(props, { emit }) {
    const integrationsDir = path.join(os.homedir(), 'sulla', 'integrations');

    const loading = ref(false);
    const entries = ref<FileEntry[]>([]);
    const expandedDirs = ref(new Set<string>());
    const dirChildren = ref(new Map<string, FileEntry[]>());
    const branch = ref('');
    const gitStatus = ref('');

    const contextMenu = reactive({
      visible: false,
      x:       0,
      y:       0,
      entry:   null as FileEntry | null,
    });

    async function loadIntegrations() {
      loading.value = true;
      try {
        const list: FileEntry[] = await ipcRenderer.invoke('filesystem-read-dir', integrationsDir);
        // Filter out .git directory
        entries.value = list.filter(e => e.name !== '.git');
      } catch {
        entries.value = [];
      }
      loading.value = false;
    }

    async function loadGitInfo() {
      try {
        branch.value = await ipcRenderer.invoke('git-branch', integrationsDir);
        const status = await ipcRenderer.invoke('git-status-full', integrationsDir);
        const changed = (status?.staged?.length || 0) + (status?.unstaged?.length || 0) + (status?.untracked?.length || 0);
        gitStatus.value = changed > 0 ? `${changed} change${changed !== 1 ? 's' : ''}` : '';
      } catch {
        branch.value = '';
        gitStatus.value = '';
      }
    }

    async function gitPull() {
      try {
        await ipcRenderer.invoke('git-pull', integrationsDir);
        await loadIntegrations();
        await loadGitInfo();
      } catch (err) {
        console.error('[IntegrationsPane] git pull failed:', err);
      }
    }

    async function toggleDir(entry: FileEntry) {
      if (expandedDirs.value.has(entry.path)) {
        expandedDirs.value.delete(entry.path);
        return;
      }
      try {
        const children: FileEntry[] = await ipcRenderer.invoke('filesystem-read-dir', entry.path);
        dirChildren.value.set(entry.path, children.filter(e => e.name !== '.git'));
      } catch {
        dirChildren.value.set(entry.path, []);
      }
      expandedDirs.value.add(entry.path);
    }

    function openFile(entry: FileEntry) {
      emit('file-selected', { path: entry.path, name: entry.name, ext: entry.ext });
    }

    function showContextMenu(ev: MouseEvent, entry: FileEntry) {
      contextMenu.visible = true;
      contextMenu.x = ev.clientX;
      contextMenu.y = ev.clientY;
      contextMenu.entry = entry;
    }

    function closeContextMenu() {
      contextMenu.visible = false;
      contextMenu.entry = null;
    }

    async function ctxNewFile() {
      const targetDir = contextMenu.entry?.isDir ? contextMenu.entry.path : integrationsDir;
      closeContextMenu();
      const name = prompt('File name:');
      if (!name) return;
      try {
        await ipcRenderer.invoke('filesystem-create-file', targetDir, name);
        await loadIntegrations();
      } catch (err) {
        console.error('[IntegrationsPane] create file failed:', err);
      }
    }

    async function ctxNewFolder() {
      const targetDir = contextMenu.entry?.isDir ? contextMenu.entry.path : integrationsDir;
      closeContextMenu();
      const name = prompt('Folder name:');
      if (!name) return;
      try {
        await ipcRenderer.invoke('filesystem-create-dir', targetDir, name);
        await loadIntegrations();
      } catch (err) {
        console.error('[IntegrationsPane] create folder failed:', err);
      }
    }

    async function ctxDelete() {
      if (!contextMenu.entry) return;
      const entryPath = contextMenu.entry.path;
      closeContextMenu();
      if (!confirm(`Delete ${path.basename(entryPath)}?`)) return;
      try {
        await ipcRenderer.invoke('filesystem-delete', entryPath);
        await loadIntegrations();
      } catch (err) {
        console.error('[IntegrationsPane] delete failed:', err);
      }
    }

    async function ctxReveal() {
      if (!contextMenu.entry) return;
      const entryPath = contextMenu.entry.path;
      closeContextMenu();
      await ipcRenderer.invoke('filesystem-reveal', entryPath);
    }

    onMounted(() => {
      loadIntegrations();
      loadGitInfo();
    });

    return {
      loading,
      entries,
      expandedDirs,
      dirChildren,
      branch,
      gitStatus,
      contextMenu,
      loadIntegrations,
      gitPull,
      toggleDir,
      openFile,
      showContextMenu,
      ctxNewFile,
      ctxNewFolder,
      ctxDelete,
      ctxReveal,
    };
  },
});
</script>

<style scoped>
.integrations-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  font-size: 12px;
}

.integrations-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.integrations-header.dark { border-bottom-color: #334155; }

.integrations-header-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #475569;
}
.dark .integrations-header-title { color: #94a3b8; }

.integrations-header-actions { display: flex; gap: 2px; }

.integrations-header-btn {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}
.integrations-header-btn:hover { background: rgba(0,0,0,0.06); color: #334155; }
.integrations-header-btn.dark { color: #94a3b8; }
.integrations-header-btn.dark:hover { background: rgba(255,255,255,0.06); color: #cbd5e1; }

.integrations-git-bar {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  font-size: 11px;
  color: #64748b;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.integrations-git-bar.dark { color: #94a3b8; border-bottom-color: #334155; }
.integrations-git-status { color: #f59e0b; font-size: 10px; }

.integrations-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.integrations-status {
  padding: 16px;
  text-align: center;
  color: #94a3b8;
  font-size: 11px;
}

.integrations-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 32px 16px;
}
.integrations-empty-text { color: #94a3b8; font-size: 12px; margin: 0; }
.integrations-empty-hint { color: #94a3b8; font-size: 11px; opacity: 0.7; margin: 0; }

.integrations-list { padding: 4px 0; }

.integrations-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 10px;
  border: none;
  background: transparent;
  color: #334155;
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  line-height: 1.4;
}
.integrations-row:hover { background: rgba(0,0,0,0.04); }
.integrations-row.dark { color: #cbd5e1; }
.integrations-row.dark:hover { background: rgba(255,255,255,0.04); }

.integrations-nested { padding-left: 28px; }

.integrations-row-name { flex: 1; min-width: 0; }

.integrations-api-btn {
  display: none;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  padding: 2px;
  border-radius: 3px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
}
.integrations-api-btn:hover { background: rgba(59,130,246,0.15); color: #3b82f6; }
.integrations-api-btn.dark { color: #94a3b8; }
.integrations-api-btn.dark:hover { background: rgba(96,165,250,0.15); color: #60a5fa; }
.integrations-row:hover .integrations-api-btn { display: flex; }

.integrations-subfiles { /* nesting container */ }

.rotated { transform: rotate(90deg); }

/* Context menu */
.integrations-ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
}
.integrations-ctx-menu {
  position: fixed;
  min-width: 160px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.12);
  padding: 4px 0;
  z-index: 10001;
}
.integrations-ctx-menu.dark {
  background: #1e293b;
  border-color: #334155;
}
.integrations-ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: #334155;
  cursor: pointer;
  font-size: 12px;
  text-align: left;
}
.integrations-ctx-item:hover { background: rgba(0,0,0,0.06); }
.integrations-ctx-item.dark { color: #cbd5e1; }
.integrations-ctx-item.dark:hover { background: rgba(255,255,255,0.06); }
</style>
