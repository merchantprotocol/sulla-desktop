<template>
  <div class="agent-pane" :class="{ dark: isDark }">
    <div class="agent-header" :class="{ dark: isDark }">
      <span class="agent-header-title">Agent</span>
      <div class="agent-header-actions">
        <button class="agent-header-btn" :class="{ dark: isDark }" title="New Agent" @click="$emit('open-new-agent-tab')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="12" y1="18" x2="12" y2="12"/>
            <line x1="9" y1="15" x2="15" y2="15"/>
          </svg>
        </button>
        <button class="agent-header-btn" :class="{ dark: isDark }" title="Refresh" @click="loadAgents">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </button>
        <button class="agent-header-btn" :class="{ dark: isDark }" title="Close Panel" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>

    <div class="agent-content">
      <!-- Loading -->
      <div v-if="loading" class="agent-status">Loading agents...</div>

      <!-- Empty state -->
      <div v-else-if="agents.length === 0" class="agent-empty">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.3">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="18" x2="12" y2="12"/>
          <line x1="9" y1="15" x2="15" y2="15"/>
        </svg>
        <p class="agent-empty-text">No agents yet</p>
        <p class="agent-empty-hint">Click + to create your first agent</p>
      </div>

      <!-- Agent list -->
      <div v-else class="agent-list">
        <div
          v-for="(agent, idx) in agents"
          :key="agent.id"
          class="agent-item"
          :class="{ dark: isDark, first: idx === 0 }"
        >
          <!-- Agent row (right-click = dir context menu) -->
          <div class="agent-row-wrapper">
            <button
              class="agent-row"
              :class="{ dark: isDark }"
              @click="editAgent(agent)"
              @contextmenu.prevent="showContextMenu($event, agent.path, true, '')"
            >
              <img :src="logoUrl" class="agent-logo" alt="" />
              <div class="agent-meta">
                <span class="agent-name">{{ agent.name }}</span>
                <span class="agent-type">{{ agent.type }}</span>
              </div>
            </button>
            <div class="agent-menu-anchor">
              <button
                class="agent-menu-btn"
                :class="{ dark: isDark }"
                title="Agent options"
                @click.stop="toggleAgentMenu(agent.id)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="5" r="2"/>
                  <circle cx="12" cy="12" r="2"/>
                  <circle cx="12" cy="19" r="2"/>
                </svg>
              </button>
              <!-- Dropdown -->
              <div
                v-if="openMenuId === agent.id"
                class="agent-dropdown"
                :class="{ dark: isDark }"
              >
                <button class="agent-dropdown-item" :class="{ dark: isDark }" @click="editAgent(agent)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                  <span>Edit</span>
                </button>
                <button class="agent-dropdown-item danger" :class="{ dark: isDark }" @click="confirmDeleteAgent(agent)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                  <span>Delete</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Agent files (all files and directories) -->
          <div v-if="agent.children && agent.children.length > 0" class="agent-files">
            <template v-for="entry in agent.children" :key="entry.path">
              <!-- Directory row -->
              <button
                v-if="entry.isDir"
                class="agent-file-row"
                :class="{ dark: isDark }"
                @click="toggleDir(entry.path, agent)"
                @contextmenu.prevent="showContextMenu($event, entry.path, true, '')"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5">
                  <path v-if="expandedDirs.has(entry.path)" d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                  <path v-else d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <span>{{ entry.name }}</span>
                <svg class="agent-expand-icon" :class="{ expanded: expandedDirs.has(entry.path) }" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </button>
              <!-- Expanded directory children -->
              <div v-if="entry.isDir && expandedDirs.has(entry.path) && dirChildren.get(entry.path)" class="agent-subfiles">
                <button
                  v-for="child in dirChildren.get(entry.path)"
                  :key="child.path"
                  class="agent-file-row agent-file-nested"
                  :class="{ dark: isDark }"
                  @click="child.isDir ? toggleDir(child.path, agent) : openFileEntry(child)"
                  @contextmenu.prevent="showContextMenu($event, child.path, child.isDir, child.ext)"
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
              <!-- File row -->
              <button
                v-if="!entry.isDir"
                class="agent-file-row"
                :class="{ dark: isDark }"
                @click="openFileEntry(entry)"
                @contextmenu.prevent="showContextMenu($event, entry.path, false, entry.ext)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
                <span>{{ entry.name }}</span>
              </button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- Delete confirmation dialog -->
    <Teleport to="body">
      <div v-if="deleteConfirm" class="agent-confirm-overlay" @click.self="deleteConfirm = null">
        <div class="agent-confirm-dialog" :class="{ dark: isDark }">
          <p class="agent-confirm-msg">Are you sure you want to delete <strong>{{ deleteConfirmName }}</strong>?</p>
          <p class="agent-confirm-hint">{{ deleteConfirmIsAgent
            ? 'This will permanently remove the agent directory and all its files.'
            : 'This action cannot be undone.' }}</p>
          <div class="agent-confirm-actions">
            <button class="agent-confirm-btn cancel" :class="{ dark: isDark }" @click="deleteConfirm = null">Cancel</button>
            <button class="agent-confirm-btn delete" :disabled="deleting" @click="doDelete">
              {{ deleting ? 'Deleting...' : 'Delete' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Reuse existing FileContextMenu -->
    <FileContextMenu
      ref="contextMenuRef"
      :is-dark="isDark"
      :has-clipboard="!!fileClipboard"
      @action="handleContextAction"
    />
    <InlinePrompt ref="inlinePromptRef" :is-dark="isDark" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
import { ipcRenderer, clipboard } from 'electron';
import FileContextMenu from '@pkg/pages/filesystem/FileContextMenu.vue';
import InlinePrompt from './InlinePrompt.vue';

interface AgentInfo {
  id: string;
  name: string;
  description: string;
  type: string;
  path: string;
  children?: FileEntry[];
}

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  ext: string;
  editorType?: 'code' | 'markdown';
}

const props = defineProps<{
  isDark: boolean;
}>();

const emit = defineEmits<{
  'close': [];
  'file-selected': [entry: FileEntry];
  'open-new-agent-tab': [];
  'edit-agent': [agent: AgentInfo];
}>();

const agents = ref<AgentInfo[]>([]);
const loading = ref(false);
const openMenuId = ref<string | null>(null);
const deleteConfirm = ref<{ name: string; path: string; isAgent: boolean } | null>(null);
const deleting = ref(false);

// Expandable directories
const expandedDirs = ref(new Set<string>());
const dirChildren = ref(new Map<string, FileEntry[]>());

// Clipboard for cut/copy/paste
const fileClipboard = ref<{ path: string; operation: 'copy' | 'cut' } | null>(null);

// Context menu ref (exposed methods: show/hide aren't typed by Options API)
const contextMenuRef = ref<{ show: (e: MouseEvent, path: string, isDir: boolean, ext: string) => void; hide: () => void } | null>(null);
const inlinePromptRef = ref<InstanceType<typeof InlinePrompt> | null>(null);

const deleteConfirmName = computed(() => deleteConfirm.value?.name ?? '');
const deleteConfirmIsAgent = computed(() => deleteConfirm.value?.isAgent ?? false);

const logoUrl = computed(() => {
  return new URL('../../../../resources/icons/logo-tray-Template@2x.png', import.meta.url).href;
});

function toggleAgentMenu(agentId: string) {
  openMenuId.value = openMenuId.value === agentId ? null : agentId;
}

function onOutsideClick() {
  if (openMenuId.value) {
    openMenuId.value = null;
  }
}

onMounted(() => {
  loadAgents();
  document.addEventListener('click', onOutsideClick);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onOutsideClick);
});

async function loadAgents() {
  loading.value = true;
  try {
    const list: AgentInfo[] = await ipcRenderer.invoke('agents-list');

    // For each agent, load all files/dirs from its directory
    for (const agent of list) {
      try {
        const entries: FileEntry[] = await ipcRenderer.invoke('filesystem-read-dir', agent.path);
        agent.children = entries;
      } catch {
        agent.children = [];
      }
    }

    agents.value = list;
  } catch (err) {
    console.error('Failed to load agents:', err);
  } finally {
    loading.value = false;
  }
}

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx']);

function openFileEntry(entry: FileEntry) {
  emit('file-selected', {
    name:       entry.name,
    path:       entry.path,
    isDir:      false,
    size:       entry.size,
    ext:        entry.ext,
    editorType: MARKDOWN_EXTS.has(entry.ext.toLowerCase()) ? 'markdown' : undefined,
  });
}

function editAgent(agent: AgentInfo) {
  openMenuId.value = null;
  emit('edit-agent', agent);
}

function confirmDeleteAgent(agent: AgentInfo) {
  openMenuId.value = null;
  deleteConfirm.value = { name: agent.name, path: agent.path, isAgent: true };
}

async function doDelete() {
  if (!deleteConfirm.value) return;
  deleting.value = true;
  try {
    if (deleteConfirm.value.isAgent) {
      // Find agent ID from path
      const agent = agents.value.find(a => a.path === deleteConfirm.value!.path);
      if (agent) {
        await ipcRenderer.invoke('agents-delete', agent.id);
      }
    } else {
      await ipcRenderer.invoke('filesystem-delete', deleteConfirm.value.path);
    }
    deleteConfirm.value = null;
    await loadAgents();
  } catch (err: any) {
    console.error('Failed to delete:', err);
  } finally {
    deleting.value = false;
  }
}

// --- Expandable directories ---

async function toggleDir(dirPath: string, _agent: AgentInfo) {
  if (expandedDirs.value.has(dirPath)) {
    expandedDirs.value.delete(dirPath);
    // Trigger reactivity
    expandedDirs.value = new Set(expandedDirs.value);
    return;
  }
  try {
    const entries: FileEntry[] = await ipcRenderer.invoke('filesystem-read-dir', dirPath);
    dirChildren.value.set(dirPath, entries);
    dirChildren.value = new Map(dirChildren.value);
    expandedDirs.value.add(dirPath);
    expandedDirs.value = new Set(expandedDirs.value);
  } catch (err) {
    console.error('Failed to read directory:', err);
  }
}

// --- Context menu ---

function showContextMenu(event: MouseEvent, filePath: string, isDir: boolean, ext: string) {
  contextMenuRef.value?.show(event, filePath, isDir, ext);
}

async function handleContextAction(action: { type: string; path: string; isDir: boolean }) {
  // For new-file, new-folder, and paste: use parent directory when acting on a file
  const targetDir = action.isDir ? action.path : action.path.replace(/\/[^/]+$/, '');

  switch (action.type) {
    case 'new-file': {
      const name = await inlinePromptRef.value?.show('New file name:');
      if (!name) return;
      try {
        await ipcRenderer.invoke('filesystem-create-file', targetDir, name);
        await loadAgents();
      } catch (err: any) {
        alert(err?.message || 'Failed to create file');
      }
      break;
    }
    case 'new-folder': {
      const name = await inlinePromptRef.value?.show('New folder name:');
      if (!name) return;
      try {
        await ipcRenderer.invoke('filesystem-create-dir', targetDir, name);
        await loadAgents();
      } catch (err: any) {
        alert(err?.message || 'Failed to create folder');
      }
      break;
    }
    case 'cut':
      fileClipboard.value = { path: action.path, operation: 'cut' };
      break;
    case 'copy':
      fileClipboard.value = { path: action.path, operation: 'copy' };
      break;
    case 'paste': {
      if (!fileClipboard.value) return;
      try {
        if (fileClipboard.value.operation === 'copy') {
          await ipcRenderer.invoke('filesystem-copy', fileClipboard.value.path, targetDir);
        } else {
          await ipcRenderer.invoke('filesystem-move', fileClipboard.value.path, targetDir);
          fileClipboard.value = null;
        }
        await loadAgents();
      } catch (err: any) {
        alert(err?.message || 'Failed to paste');
      }
      break;
    }
    case 'rename': {
      const currentName = action.path.split('/').pop() || '';
      const newName = await inlinePromptRef.value?.show('Rename to:', currentName);
      if (!newName || newName === currentName) return;
      try {
        await ipcRenderer.invoke('filesystem-rename', action.path, newName);
        await loadAgents();
      } catch (err: any) {
        alert(err?.message || 'Failed to rename');
      }
      break;
    }
    case 'delete': {
      const fileName = action.path.split('/').pop() || 'this item';
      deleteConfirm.value = { name: fileName, path: action.path, isAgent: false };
      break;
    }
    case 'copy-path':
      clipboard.writeText(action.path);
      break;
    case 'copy-relative-path': {
      // Relative to ~/sulla
      const sullaIdx = action.path.indexOf('/sulla/');
      const rel = sullaIdx >= 0 ? action.path.slice(sullaIdx + 7) : action.path;
      clipboard.writeText(rel);
      break;
    }
    case 'reveal':
      await ipcRenderer.invoke('filesystem-reveal', action.path);
      break;
    case 'open-external':
      await ipcRenderer.invoke('filesystem-open-external', action.path);
      break;
    case 'open-code-editor': {
      const name = action.path.split('/').pop() || '';
      const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
      emit('file-selected', { name, path: action.path, isDir: false, size: 0, ext });
      break;
    }
  }
}

defineExpose({ refresh: loadAgents });
</script>

<style scoped>
.agent-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #f8fafc;
  color: #333;
  font-size: 13px;
  user-select: none;
  overflow: hidden;
}

.agent-pane.dark {
  background: var(--bg-surface, #1e293b);
  color: #ccc;
}

.agent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 12px;
  height: 35px;
  flex-shrink: 0;
  background: #f8fafc;
  border-bottom: 1px solid #cbd5e1;
}

.agent-header.dark {
  background: var(--bg-surface, #1e293b);
  border-bottom-color: var(--border-default, #334155);
}

.agent-header-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
}

.agent-header.dark .agent-header-title {
  color: #94a3b8;
}

.agent-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.agent-header-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: #94a3b8;
  border-radius: 4px;
  cursor: pointer;
}

.agent-header-btn:hover {
  background: rgba(0,0,0,0.06);
  color: #475569;
}

.agent-header-btn.dark {
  color: #64748b;
}

.agent-header-btn.dark:hover {
  background: rgba(255,255,255,0.08);
  color: #94a3b8;
}

.agent-content {
  flex: 1;
  overflow-y: auto;
}

.agent-status {
  padding: 16px 12px;
  font-size: 12px;
  color: #94a3b8;
}

.agent-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 16px;
  gap: 8px;
}

.agent-empty-text {
  font-size: 13px;
  font-weight: 500;
  color: #64748b;
  margin: 0;
}

.agent-empty-hint {
  font-size: 11px;
  color: #94a3b8;
  margin: 0;
}

.agent-pane.dark .agent-empty-text {
  color: #94a3b8;
}

.agent-pane.dark .agent-empty-hint {
  color: #64748b;
}

/* Agent list */
.agent-list {
  padding: 0;
}

.agent-item {
  border-top: 1px solid #e2e8f0;
}

.agent-item.first {
  border-top: none;
}

.agent-item.dark {
  border-top-color: var(--border-default, #334155);
}

.agent-item.dark.first {
  border-top: none;
}

.agent-row-wrapper {
  display: flex;
  align-items: center;
}

.agent-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  padding: 10px 0 10px 12px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}

.agent-row:hover {
  background: rgba(0,0,0,0.04);
}

.agent-row.dark:hover {
  background: rgba(255,255,255,0.04);
}

.agent-menu-anchor {
  position: relative;
  flex-shrink: 0;
}

.agent-menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-right: 6px;
  border: none;
  background: transparent;
  color: #94a3b8;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.1s;
}

.agent-row-wrapper:hover .agent-menu-btn {
  opacity: 1;
}

.agent-menu-btn:hover {
  background: rgba(0,0,0,0.08);
  color: #475569;
}

.agent-menu-btn.dark {
  color: #64748b;
}

.agent-menu-btn.dark:hover {
  background: rgba(255,255,255,0.1);
  color: #94a3b8;
}

.agent-dropdown {
  position: absolute;
  top: 100%;
  right: 4px;
  z-index: 100;
  min-width: 130px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 4px 0;
  box-shadow: 0 4px 16px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.08);
}

.agent-dropdown.dark {
  background: var(--bg-surface, #1e293b);
  border-color: var(--border-default, #334155);
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}

.agent-dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: none;
  color: #333;
  cursor: pointer;
  font-size: 13px;
  text-align: left;
}

.agent-dropdown-item:hover {
  background: #f1f5f9;
}

.agent-dropdown-item.dark {
  color: #e2e8f0;
}

.agent-dropdown-item.dark:hover {
  background: rgba(255,255,255,0.06);
}

.agent-dropdown-item.danger {
  color: #ef4444;
}

.agent-dropdown-item.danger:hover {
  background: #fef2f2;
}

.agent-dropdown-item.danger.dark:hover {
  background: rgba(239,68,68,0.12);
}

/* Delete confirmation dialog */
.agent-confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.4);
}

.agent-confirm-dialog {
  background: #fff;
  border-radius: 8px;
  padding: 24px;
  max-width: 380px;
  width: 90%;
  box-shadow: 0 8px 32px rgba(0,0,0,0.2);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.agent-confirm-dialog.dark {
  background: var(--bg-surface, #1e293b);
  color: #e2e8f0;
}

.agent-confirm-msg {
  font-size: 14px;
  margin: 0 0 8px 0;
}

.agent-confirm-hint {
  font-size: 12px;
  color: #94a3b8;
  margin: 0 0 20px 0;
}

.agent-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.agent-confirm-btn {
  padding: 6px 16px;
  font-size: 13px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font-weight: 500;
}

.agent-confirm-btn.cancel {
  background: #f1f5f9;
  color: #333;
}

.agent-confirm-btn.cancel.dark {
  background: var(--border-default, #334155);
  color: #e2e8f0;
}

.agent-confirm-btn.delete {
  background: #ef4444;
  color: #fff;
}

.agent-confirm-btn.delete:hover {
  background: #dc2626;
}

.agent-confirm-btn.delete:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.agent-logo {
  width: 16px;
  height: 16px;
  opacity: 0.5;
  flex-shrink: 0;
}

.agent-pane.dark .agent-logo {
  filter: invert(1);
}

.agent-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.agent-name {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-type {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: #94a3b8;
  background: rgba(0,0,0,0.04);
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
}

.agent-pane.dark .agent-type {
  color: #64748b;
  background: rgba(255,255,255,0.06);
}

/* File list under each agent */
.agent-files {
  padding: 0 0 6px 0;
}

.agent-file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 12px 3px 36px;
  border: none;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  font-size: 12px;
  text-align: left;
}

.agent-file-row:hover {
  background: rgba(0,0,0,0.04);
  color: #333;
}

.agent-file-row.dark {
  color: #64748b;
}

.agent-file-row.dark:hover {
  background: rgba(255,255,255,0.04);
  color: #94a3b8;
}

/* Expand chevron icon on directory rows */
.agent-expand-icon {
  margin-left: auto;
  opacity: 0.4;
  transition: transform 0.15s ease;
  flex-shrink: 0;
}

.agent-expand-icon.expanded {
  transform: rotate(90deg);
}

/* Nested files inside expanded directories */
.agent-subfiles {
  padding: 0;
}

.agent-file-row.agent-file-nested {
  padding-left: 52px;
}
</style>
