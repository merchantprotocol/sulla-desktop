<template>
  <div class="h-screen overflow-hidden font-sans flex flex-col page-root" :class="{ dark: isDark }">
    <PostHogTracker page-name="AgentFilesystem" />
    <AgentHeader :is-dark="isDark" :toggle-theme="toggleTheme" @toggle-left-pane="leftPaneVisible = !leftPaneVisible" @toggle-center-pane="centerPaneVisible = !centerPaneVisible" @toggle-right-pane="rightPaneVisible = !rightPaneVisible" />

    <div class="flex flex-1 min-h-0 overflow-hidden">
        <!-- Left sidebar: File tree -->
        <div class="file-tree-panel" v-show="leftPaneVisible" :class="{ dark: isDark }">
          <FileTreeSidebar
            :is-dark="isDark"
            :highlight-path="highlightPath"
            @file-selected="onFileSelected"
          />
        </div>

        <!-- Right content: Editor area -->
        <div class="editor-panel" v-show="centerPaneVisible" :class="{ dark: isDark }">
          <!-- Top editor area -->
          <div class="editor-top">
            <!-- Tab bar (always visible when tabs exist) -->
            <div v-if="openTabs.length > 0" class="tab-bar" :class="{ dark: isDark }">
              <div
                v-for="tab in openTabs"
                :key="`${tab.path}-${tab.editorType || 'code'}`"
                class="tab"
                :class="{ active: activeTabKey === `${tab.path}-${tab.editorType || 'code'}`, dark: isDark }"
                @click="switchTab(tab)"
                @contextmenu.prevent="onTabContextMenu($event, tab)"
              >
                <span class="tab-icon">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M3.5 1C2.94772 1 2.5 1.44772 2.5 2V14C2.5 14.5523 2.94772 15 3.5 15H12.5C13.0523 15 13.5 14.5523 13.5 14V5L9.5 1H3.5Z" :fill="getIconColor(tab.ext)" stroke-width="0.5" :stroke="getIconColor(tab.ext)"/>
                    <path d="M9.5 1V5H13.5" :stroke="getIconColor(tab.ext)" stroke-width="0.8" fill="none"/>
                  </svg>
                </span>
                <span class="tab-label">{{ tab.name }}</span>
                <span v-if="tab.dirty" class="tab-dirty-dot"></span>
                <span class="tab-close" @click.stop="closeTab(tab)">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.707L8 8.707z"/>
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
            <template v-if="activeTab">
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
                <!-- Breadcrumb and Save Button Row -->
                <div class="editor-header" :class="{ dark: isDark }">
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
                  <button
                    v-if="activeTab && activeTab.dirty"
                    class="save-button"
                    :class="{ dark: isDark }"
                    @click="saveActiveTab"
                    :disabled="activeTab.loading"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                      <polyline points="17,21 17,13 7,13 7,21"/>
                      <polyline points="7,3 7,8 15,8"/>
                    </svg>
                    Save
                  </button>
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
                    :read-only="activeTab.editorType === 'preview'"
                    @dirty="markActiveTabDirty"
                  />
                </div>
              </template>
            </template>
          </div>

          <!-- Bottom center pane -->
          <div class="editor-bottom" :class="{ dark: isDark }">
            <!-- Empty for now -->
          </div>
        </div>

        <!-- Right pane -->
        <div class="right-pane" v-show="rightPaneVisible" :class="{ dark: isDark }">
          <!-- Empty for now -->
        </div>
    </div>
  </div>

  <!-- Tab Context Menu -->
  <Teleport to="body">
    <div
      v-if="tabContextMenu.visible"
      ref="tabContextMenuRef"
      class="tab-context-menu"
      :class="{ dark: isDark }"
      :style="{ top: tabContextMenu.y + 'px', left: tabContextMenu.x + 'px' }"
      @contextmenu.prevent
    >
      <!-- View in Finder -->
      <button class="context-menu-item" @click="viewInFinder(tabContextMenu.tab!)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span>View in Finder</span>
      </button>

      <!-- Open with... -->
      <div class="context-menu-sep"></div>
      <div class="context-menu-subheader">Open with…</div>
      <button class="context-menu-item" @click="openWithEditor(tabContextMenu.tab!, 'code')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
        </svg>
        <span>Code Editor</span>
      </button>
      <button
        v-if="tabContextMenu.tab && MARKDOWN_EXTS.has(tabContextMenu.tab.ext.toLowerCase())"
        class="context-menu-item"
        @click="openWithEditor(tabContextMenu.tab!, 'markdown')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </svg>
        <span>Markdown Editor</span>
      </button>
      <button
        v-if="tabContextMenu.tab && MARKDOWN_EXTS.has(tabContextMenu.tab.ext.toLowerCase())"
        class="context-menu-item"
        @click="openWithEditor(tabContextMenu.tab!, 'preview')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <span>Preview</span>
      </button>

      <!-- Save (if dirty) -->
      <div v-if="tabContextMenu.tab?.dirty" class="context-menu-sep"></div>
      <button v-if="tabContextMenu.tab?.dirty" class="context-menu-item" @click="saveTab(tabContextMenu.tab!)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
          <polyline points="17,21 17,13 7,13 7,21"/>
          <polyline points="7,3 7,8 15,8"/>
        </svg>
        <span>Save</span>
        <span class="context-menu-shortcut">⌘S</span>
      </button>
    </div>
  </Teleport>
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
  editorType?: 'code' | 'markdown' | 'preview';
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
  markdown:  markRaw(MarkdownEditor),
  code:      markRaw(CodeEditor),
  preview:   markRaw(MarkdownEditor), // Preview uses markdown editor but read-only
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

  setup(props, { emit }) {
    const isDark = ref(false);
    const THEME_STORAGE_KEY = 'agentTheme';
    const rootPath = ref('');
    const openTabs = ref<TabState[]>([]);
    const activeTabKey = ref('');
    const leftPaneVisible = ref(true);
    const centerPaneVisible = ref(true);
    const rightPaneVisible = ref(true);

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
      return openTabs.value.find(t => `${t.path}-${t.editorType || 'code'}` === activeTabKey.value) || null;
    });

    const activeEditorComponent = computed(() => {
      if (!activeTab.value) return null;
      // Use explicit editor type if provided, otherwise resolve by extension
      const editorType = activeTab.value.editorType || resolveEditorType(activeTab.value.ext);
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

    async function loadTabContent(tab: TabState) {
      try {
        tab.content = await ipcRenderer.invoke('filesystem-read-file', tab.path);
      } catch (err: any) {
        tab.error = err?.message || 'Failed to read file';
      } finally {
        tab.loading = false;
      }
    }

    async function onFileSelected(entry: FileEntry) {
      // Check if tab already open with same path and editorType
      const key = `${entry.path}-${entry.editorType || 'code'}`;
      const existing = openTabs.value.find(t => `${t.path}-${t.editorType || 'code'}` === key);
      if (existing) {
        activeTabKey.value = key;
        return;
      }

      // Create new tab
      const tab: TabState = reactive({
        path:       entry.path,
        name:       entry.name,
        ext:        entry.ext,
        content:    '',
        loading:    true,
        error:      '',
        dirty:      false,
        editorType: entry.editorType, // Use explicit editor type if provided
      });

      openTabs.value = [...openTabs.value, tab];
      activeTabKey.value = key;

      await loadTabContent(tab);
    }

    function switchTab(tab: TabState) {
      activeTabKey.value = `${tab.path}-${tab.editorType || 'code'}`;
    }

    function closeTab(tab: TabState) {
      const index = openTabs.value.findIndex(t => t === tab);
      if (index === -1) return;

      const wasActive = `${tab.path}-${tab.editorType || 'code'}` === activeTabKey.value;
      openTabs.value.splice(index, 1);

      if (wasActive) {
        if (openTabs.value.length === 0) {
          activeTabKey.value = '';
        } else {
          // Switch to the last tab
          const lastTab = openTabs.value[openTabs.value.length - 1];
          activeTabKey.value = `${lastTab.path}-${lastTab.editorType || 'code'}`;
        }
      }
    }

    const highlightPath = ref('');

    const tabContextMenu = ref<{
      visible: boolean;
      x: number;
      y: number;
      tab: TabState | null;
    }>({
      visible: false,
      x: 0,
      y: 0,
      tab: null,
    });

    function onTabContextMenu(event: MouseEvent, tab: TabState) {
      tabContextMenu.value = {
        visible: true,
        x: event.clientX,
        y: event.clientY,
        tab,
      };
    }

    function hideTabContextMenu() {
      tabContextMenu.value.visible = false;
    }

    function viewInFinder(tab: TabState) {
      // Set highlight path to highlight the file in the file tree
      highlightPath.value = tab.path;
      // Emit event to file tree to highlight this file (keeping for backward compatibility)
      emit('highlight-file', tab.path);
      hideTabContextMenu();
    }

    function openWithEditor(tab: TabState, editorType: 'code' | 'markdown' | 'preview') {
      // Check if tab with same path and editorType already exists
      const key = `${tab.path}-${editorType}`;
      const existing = openTabs.value.find(t => `${t.path}-${t.editorType || 'code'}` === key);
      if (existing) {
        activeTabKey.value = key;
        hideTabContextMenu();
        return;
      }

      // Create new tab with same path but different editor
      const newTab: TabState = reactive({
        path:       tab.path,
        name:       tab.name,
        ext:        tab.ext,
        content:    '',
        loading:    true,
        error:      '',
        dirty:      false,
        editorType: editorType,
      });

      openTabs.value = [...openTabs.value, newTab];
      activeTabKey.value = key;

      // Load content
      loadTabContent(newTab);
      hideTabContextMenu();
    }

    function saveTab(tab: TabState) {
      if (tab.dirty) {
        saveActiveTab();
      }
      hideTabContextMenu();
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
        // For code files, get content from Monaco editor
        else if (editorRef.value?.getContent) {
          content = editorRef.value.getContent();
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

    const tabContextMenuRef = ref<HTMLElement | null>(null);

    onMounted(() => {
      window.addEventListener('keydown', onKeyDown);
      // Add click outside handler for tab context menu
      document.addEventListener('mousedown', (e) => {
        if (tabContextMenuRef.value && !tabContextMenuRef.value.contains(e.target as Node)) {
          hideTabContextMenu();
        }
      });
    });

    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', () => {});
    });

    return {
      isDark,
      toggleTheme,
      openTabs,
      activeTabKey,
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
      tabContextMenu,
      tabContextMenuRef,
      hideTabContextMenu,
      onTabContextMenu,
      viewInFinder,
      openWithEditor,
      saveTab,
      highlightPath,
      loadTabContent,
      leftPaneVisible,
      centerPaneVisible,
      rightPaneVisible,
      MARKDOWN_EXTS,
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

.editor-top {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.editor-bottom {
  height: 200px;
  min-height: 150px;
  max-height: 300px;
  flex-shrink: 0;
  border-top: 1px solid #e2e8f0;
  overflow: hidden;
  background: #f8fafc;
}

.editor-bottom.dark {
  border-top-color: #3c3c3c;
  background: #1e293b;
}

.right-pane {
  width: 280px;
  min-width: 200px;
  max-width: 400px;
  flex-shrink: 0;
  border-left: 1px solid #e2e8f0;
  overflow: hidden;
  background: #f8fafc;
}

.right-pane.dark {
  border-left-color: #3c3c3c;
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

/* Editor header (breadcrumb + save button) */
.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  font-size: 12px;
  color: #888;
  background: #ffffff;
  border-bottom: 1px solid #e8e8e8;
  flex-shrink: 0;
}

.editor-header.dark {
  background: #0f172a;
  color: #888;
  border-bottom-color: #2d2d2d;
}

.save-button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  color: #ffffff;
  background: #0078d4;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.1s;
}

.save-button:hover:not(:disabled) {
  background: #106ebe;
}

.save-button:active:not(:disabled) {
  background: #005a9e;
}

.save-button:disabled {
  background: #cccccc;
  cursor: not-allowed;
}

.save-button.dark {
  color: #ffffff;
  background: #0078d4;
}

.save-button.dark:hover:not(:disabled) {
  background: #106ebe;
}

.save-button.dark:active:not(:disabled) {
  background: #005a9e;
}

.save-button.dark:disabled {
  background: #666666;
  color: #cccccc;
}

.breadcrumb-segment {
  white-space: nowrap;
}

.breadcrumb-sep {
  margin: 0 4px;
  color: #aaa;
}

/* Tab Context Menu */
.tab-context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 180px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 4px 0;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
}

.tab-context-menu.dark {
  background: #2d2d2d;
  border-color: #404040;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.3);
}

.tab-context-menu .context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: none;
  color: #333;
  cursor: pointer;
  text-align: left;
  line-height: 1;
}

.tab-context-menu .context-menu-item:hover {
  background: #f1f5f9;
}

.dark .tab-context-menu .context-menu-item {
  color: #ccc;
}

.dark .tab-context-menu .context-menu-item:hover {
  background: #383838;
}

.tab-context-menu .context-menu-sep {
  height: 1px;
  background: #e2e8f0;
  margin: 4px 0;
}

.dark .tab-context-menu .context-menu-sep {
  background: #404040;
}

.tab-context-menu .context-menu-subheader {
  padding: 8px 12px;
  font-weight: bold;
  font-size: 12px;
  color: #666;
}

.dark .tab-context-menu .context-menu-subheader {
  color: #ccc;
}

.tab-context-menu .context-menu-shortcut {
  margin-left: auto;
  font-size: 11px;
  color: #999;
  padding-left: 16px;
}

.dark .tab-context-menu .context-menu-shortcut {
  color: #666;
}
</style>
