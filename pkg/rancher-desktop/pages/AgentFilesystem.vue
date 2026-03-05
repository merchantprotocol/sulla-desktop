<template>
  <div class="h-screen overflow-hidden font-sans flex flex-col page-root" :class="{ dark: isDark }">
    <PostHogTracker page-name="AgentFilesystem" />
    <AgentHeader :is-dark="isDark" :toggle-theme="toggleTheme" />

    <div class="flex flex-1 min-h-0 overflow-hidden">
        <!-- Left sidebar: File tree -->
        <div class="file-tree-panel" :class="{ dark: isDark }">
          <FileTreeSidebar
            :is-dark="isDark"
            @file-selected="onFileSelected"
          />
        </div>

        <!-- Right content: Editor area -->
        <div class="editor-panel" :class="{ dark: isDark }">
          <!-- Tab bar (always visible when tabs exist) -->
          <div v-if="openTabs.length > 0" class="tab-bar" :class="{ dark: isDark }">
            <div
              v-for="tab in openTabs"
              :key="tab.path"
              class="tab"
              :class="{ active: activeTabPath === tab.path, dark: isDark }"
              @click="switchTab(tab.path)"
            >
              <span class="tab-icon">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M3.5 1C2.94772 1 2.5 1.44772 2.5 2V14C2.5 14.5523 2.94772 15 3.5 15H12.5C13.0523 15 13.5 14.5523 13.5 14V5L9.5 1H3.5Z" :fill="getIconColor(tab.ext)" stroke-width="0.5" :stroke="getIconColor(tab.ext)"/>
                  <path d="M9.5 1V5H13.5" :stroke="getIconColor(tab.ext)" stroke-width="0.8" fill="none"/>
                </svg>
              </span>
              <span class="tab-label">{{ tab.name }}</span>
              <span v-if="tab.dirty" class="tab-dirty-dot"></span>
              <span class="tab-close" @click.stop="closeTab(tab.path)">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/>
                </svg>
              </span>
            </div>
          </div>

          <!-- Empty state (no tabs open) -->
          <div v-if="openTabs.length === 0" class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="empty-icon">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <p class="empty-text">Select a file to view its contents</p>
            <p class="empty-hint">Browse your sulla workspace using the file tree on the left</p>
          </div>

          <!-- Active tab content -->
          <template v-else-if="activeTab">
            <!-- Loading state -->
            <div v-if="activeTab.loading" class="empty-state">
              <div class="loading-spinner"></div>
              <p class="empty-text">Loading {{ activeTab.name }}…</p>
            </div>

            <!-- Error state -->
            <div v-else-if="activeTab.error" class="empty-state">
              <p class="error-text">{{ activeTab.error }}</p>
            </div>

            <!-- Editor content -->
            <template v-else>
              <!-- Breadcrumb -->
              <div class="breadcrumb-bar" :class="{ dark: isDark }">
                <span
                  v-for="(segment, idx) in activeBreadcrumbs"
                  :key="idx"
                  class="breadcrumb-segment"
                >
                  <span v-if="idx > 0" class="breadcrumb-sep">›</span>
                  {{ segment }}
                </span>
              </div>

              <!-- Editor content -->
              <div class="editor-content">
                <component
                  :is="activeEditorComponent"
                  ref="editorRef"
                  :content="activeTab.content"
                  :file-path="activeTab.path"
                  :file-ext="activeTab.ext"
                  :is-dark="isDark"
                  @dirty="markActiveTabDirty"
                />
              </div>
            </template>
          </template>
        </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, reactive, markRaw, onMounted, onBeforeUnmount, type Component } from 'vue';
import { ipcRenderer } from 'electron';

import PostHogTracker from '@pkg/components/PostHogTracker.vue';
import AgentHeader from './agent/AgentHeader.vue';
import FileTreeSidebar from './filesystem/FileTreeSidebar.vue';
import MarkdownEditor from './filesystem/MarkdownEditor.vue';
import CodeEditor from './filesystem/CodeEditor.vue';

import type { FileEntry } from './filesystem/FileTreeSidebar.vue';

interface TabState {
  path: string;
  name: string;
  ext: string;
  content: string;
  loading: boolean;
  error: string;
  dirty: boolean;
}

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx']);

const EXT_ICON_COLORS: Record<string, string> = {
  '.ts':   '#3178c6',
  '.tsx':  '#3178c6',
  '.js':   '#f0db4f',
  '.jsx':  '#f0db4f',
  '.vue':  '#41b883',
  '.json': '#f0db4f',
  '.md':   '#519aba',
  '.py':   '#3572A5',
  '.yaml': '#cb171e',
  '.yml':  '#cb171e',
  '.sh':   '#89e051',
  '.css':  '#563d7c',
  '.html': '#e34c26',
};

/**
 * Editor registry — maps editor type keys to Vue components.
 * Extensible: add new entries here to support more file types.
 */
const editorRegistry: Record<string, Component> = {
  markdown: markRaw(MarkdownEditor),
  code:     markRaw(CodeEditor),
};

function resolveEditorType(ext: string): string {
  if (MARKDOWN_EXTS.has(ext.toLowerCase())) return 'markdown';
  return 'code';
}

export default defineComponent({
  name: 'AgentFilesystem',

  components: {
    PostHogTracker,
    AgentHeader,
    FileTreeSidebar,
    MarkdownEditor,
    CodeEditor,
  },

  setup() {
    const isDark = ref(false);
    const THEME_STORAGE_KEY = 'agentTheme';
    const rootPath = ref('');
    const openTabs = ref<TabState[]>([]);
    const activeTabPath = ref('');

    onMounted(async () => {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);

      if (stored === 'dark') {
        isDark.value = true;
      } else if (stored === 'light') {
        isDark.value = false;
      } else {
        isDark.value = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
      }
    });

    function toggleTheme() {
      isDark.value = !isDark.value;
      localStorage.setItem(THEME_STORAGE_KEY, isDark.value ? 'dark' : 'light');
    }

    async function loadRootPath() {
      try {
        rootPath.value = await ipcRenderer.invoke('filesystem-get-root');
      } catch { /* ignore */ }
    }
    loadRootPath();

    const activeTab = computed(() => {
      return openTabs.value.find(t => t.path === activeTabPath.value) || null;
    });

    const activeEditorComponent = computed(() => {
      if (!activeTab.value) return null;
      const editorType = resolveEditorType(activeTab.value.ext);
      return editorRegistry[editorType] || editorRegistry.code;
    });

    function getIconColor(ext: string): string {
      return EXT_ICON_COLORS[ext] || '#999';
    }

    const activeBreadcrumbs = computed(() => {
      if (!activeTab.value || !rootPath.value) return [];
      const relative = activeTab.value.path.replace(rootPath.value, '').replace(/^\//, '');
      return relative.split('/');
    });

    async function onFileSelected(entry: FileEntry) {
      // If tab already open, just switch to it
      const existing = openTabs.value.find(t => t.path === entry.path);
      if (existing) {
        activeTabPath.value = entry.path;
        return;
      }

      // Create new tab
      const tab: TabState = reactive({
        path:    entry.path,
        name:    entry.name,
        ext:     entry.ext,
        content: '',
        loading: true,
        error:   '',
        dirty:   false,
      });

      openTabs.value = [...openTabs.value, tab];
      activeTabPath.value = entry.path;

      try {
        tab.content = await ipcRenderer.invoke('filesystem-read-file', entry.path);
      } catch (err: any) {
        tab.error = err?.message || 'Failed to read file';
      } finally {
        tab.loading = false;
      }
    }

    function switchTab(path: string) {
      activeTabPath.value = path;
    }

    function closeTab(path: string) {
      const idx = openTabs.value.findIndex(t => t.path === path);
      if (idx === -1) return;

      const newTabs = openTabs.value.filter(t => t.path !== path);
      openTabs.value = newTabs;

      // If closing the active tab, switch to an adjacent tab
      if (activeTabPath.value === path) {
        if (newTabs.length === 0) {
          activeTabPath.value = '';
        } else {
          const newIdx = Math.min(idx, newTabs.length - 1);
          activeTabPath.value = newTabs[newIdx].path;
        }
      }
    }

    // Editor ref for accessing exposed methods (e.g. getMarkdown)
    const editorRef = ref<any>(null);

    function markActiveTabDirty() {
      const tab = activeTab.value;
      if (tab && !tab.dirty) tab.dirty = true;
    }

    async function saveActiveTab() {
      const tab = activeTab.value;
      if (!tab || !tab.dirty) return;

      try {
        let content = tab.content;

        // For markdown files, get content from BlockNote editor
        if (MARKDOWN_EXTS.has(tab.ext.toLowerCase()) && editorRef.value?.getMarkdown) {
          content = await editorRef.value.getMarkdown();
        }

        await ipcRenderer.invoke('filesystem-write-file', tab.path, content);
        tab.dirty = false;
        tab.content = content;
      } catch (err: any) {
        console.error('Save failed:', err);
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveActiveTab();
      }
    }

    onMounted(() => {
      window.addEventListener('keydown', onKeyDown);
    });

    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKeyDown);
    });

    return {
      isDark,
      toggleTheme,
      openTabs,
      activeTabPath,
      activeTab,
      activeEditorComponent,
      activeBreadcrumbs,
      getIconColor,
      onFileSelected,
      switchTab,
      closeTab,
      editorRef,
      markActiveTabDirty,
      saveActiveTab,
    };
  },
});
</script>

<style scoped>
.page-root {
  background: #ffffff;
  color: #0d0d0d;
}

.page-root.dark {
  background: #0f172a;
  color: #fafafa;
}

.file-tree-panel {
  width: 280px;
  min-width: 200px;
  max-width: 400px;
  flex-shrink: 0;
  border-right: 1px solid #e2e8f0;
  overflow: hidden;
  background: #f8fafc;
}

.file-tree-panel.dark {
  border-right-color: #3c3c3c;
  background: #1e293b;
}

.editor-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #ffffff;
}

.editor-panel.dark {
  background: #1e293b;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #999;
}

.empty-icon {
  opacity: 0.3;
}

.dark .empty-icon {
  opacity: 0.2;
}

.empty-text {
  font-size: 14px;
  color: #666;
}

.dark .empty-text {
  color: #888;
}

.empty-hint {
  font-size: 12px;
  color: #999;
}

.error-text {
  font-size: 13px;
  color: #e53e3e;
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid rgba(0, 0, 0, 0.1);
  border-top-color: #0078d4;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.dark .loading-spinner {
  border-color: rgba(255, 255, 255, 0.1);
  border-top-color: #0078d4;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Tab bar */
.tab-bar {
  display: flex;
  align-items: stretch;
  height: 35px;
  background: #f8fafc;
  border-bottom: 1px solid #e0e0e0;
  flex-shrink: 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.tab-bar::-webkit-scrollbar {
  height: 0;
}

.tab-bar.dark {
  background: #1e293b;
  border-bottom-color: #3c3c3c;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  font-size: 13px;
  color: #333;
  border-right: 1px solid #e0e0e0;
  background: #eef2f6;
  cursor: pointer;
  flex-shrink: 0;
  max-width: 200px;
  user-select: none;
}

.tab:hover {
  background: #e8ecf0;
}

.tab.dark {
  color: #999;
  border-right-color: #3c3c3c;
  background: #2d2d2d;
}

.tab.dark:hover {
  background: #323232;
  color: #ccc;
}

.tab.active {
  background: #ffffff;
  color: #333;
  border-bottom: 1px solid #ffffff;
  margin-bottom: -1px;
}

.tab.active.dark {
  background: #0f172a;
  border-bottom-color: #0f172a;
  color: #ccc;
}

.tab-icon {
  display: flex;
  align-items: center;
}

.tab-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-dirty-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #0078d4;
  flex-shrink: 0;
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  color: #999;
  margin-left: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.1s;
}

.tab:hover .tab-close {
  opacity: 1;
}

.tab.active .tab-close {
  opacity: 0.6;
}

.tab.active:hover .tab-close,
.tab-close:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.1);
}

.dark .tab-close:hover {
  background: rgba(255, 255, 255, 0.1);
}

/* Breadcrumb */
.breadcrumb-bar {
  display: flex;
  align-items: center;
  padding: 4px 12px;
  font-size: 12px;
  color: #888;
  background: #ffffff;
  border-bottom: 1px solid #e8e8e8;
  flex-shrink: 0;
  overflow: hidden;
}

.breadcrumb-bar.dark {
  background: #0f172a;
  color: #888;
  border-bottom-color: #2d2d2d;
}

.breadcrumb-segment {
  white-space: nowrap;
}

.breadcrumb-sep {
  margin: 0 4px;
  color: #aaa;
}

/* Editor content area */
.editor-content {
  flex: 1;
  overflow: hidden;
}
</style>
