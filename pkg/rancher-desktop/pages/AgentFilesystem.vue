<template>
  <div
    class="h-screen overflow-hidden font-sans flex flex-col page-root"
    :class="{ dark: isDark }"
  >
    <PostHogTracker page-name="AgentFilesystem" />
    <AgentHeader
      :is-dark="isDark"
      :toggle-theme="toggleTheme"
      @toggle-left-pane="leftPaneVisible = !leftPaneVisible"
      @toggle-center-pane="centerPaneVisible = !centerPaneVisible"
      @toggle-right-pane="rightPaneVisible = !rightPaneVisible"
    />

    <div class="flex flex-1 min-h-0 overflow-hidden">
      <!-- Left sidebar: File tree -->
      <div
        v-show="leftPaneVisible"
        class="file-tree-panel"
        :class="{ dark: isDark }"
      >
        <FileTreeSidebar
          :is-dark="isDark"
          :highlight-path="highlightPath"
          @file-selected="onFileSelected"
        />
      </div>

      <!-- Right content: Editor area -->
      <div
        v-show="centerPaneVisible"
        class="editor-panel"
        :class="{ dark: isDark }"
      >
        <!-- Top editor area -->
        <div class="editor-top">
          <!-- Tab bar (always visible when tabs exist) -->
          <div
            v-if="openTabs.length > 0"
            class="tab-bar"
            :class="{ dark: isDark }"
          >
            <div
              v-for="tab in openTabs"
              :key="`${tab.path}-${tab.editorType || 'code'}`"
              class="tab"
              :class="{ active: activeTabKey === `${tab.path}-${tab.editorType || 'code'}`, dark: isDark }"
              @click="switchTab(tab)"
              @contextmenu.prevent="onTabContextMenu($event, tab)"
            >
              <span class="tab-icon">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                >
                  <path
                    d="M3.5 1C2.94772 1 2.5 1.44772 2.5 2V14C2.5 14.5523 2.94772 15 3.5 15H12.5C13.0523 15 13.5 14.5523 13.5 14V5L9.5 1H3.5Z"
                    :fill="getIconColor(tab.ext)"
                    stroke-width="0.5"
                    :stroke="getIconColor(tab.ext)"
                  />
                  <path
                    d="M9.5 1V5H13.5"
                    :stroke="getIconColor(tab.ext)"
                    stroke-width="0.8"
                    fill="none"
                  />
                </svg>
              </span>
              <span class="tab-label">{{ tab.name }}</span>
              <span
                v-if="tab.dirty"
                class="tab-dirty-dot"
              />
              <span
                class="tab-close"
                @click.stop="closeTab(tab)"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.707L8 8.707z" />
                </svg>
              </span>
            </div>
          </div>

          <!-- Empty state (no tabs open) -->
          <div
            v-if="openTabs.length === 0"
            class="empty-state"
          >
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="empty-icon"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <p class="empty-text">
              Select a file to view its contents
            </p>
            <p class="empty-hint">
              Browse your sulla workspace using the file tree on the left
            </p>
          </div>

          <!-- Active tab content -->
          <template v-if="activeTab">
            <!-- Loading state -->
            <div
              v-if="activeTab.loading"
              class="empty-state"
            >
              <div class="loading-spinner" />
              <p class="empty-text">
                Loading {{ activeTab.name }}…
              </p>
            </div>

            <!-- Error state -->
            <div
              v-else-if="activeTab.error"
              class="empty-state"
            >
              <p class="error-text">
                {{ activeTab.error }}
              </p>
            </div>

            <!-- Editor content -->
            <template v-else>
              <!-- Breadcrumb and Save Button Row -->
              <div
                class="editor-header"
                :class="{ dark: isDark }"
              >
                <div
                  class="breadcrumb-bar"
                  :class="{ dark: isDark }"
                >
                  <span
                    v-for="(segment, idx) in activeBreadcrumbs"
                    :key="idx"
                    class="breadcrumb-segment"
                  >
                    <span
                      v-if="idx > 0"
                      class="breadcrumb-sep"
                    >›</span>
                    {{ segment }}
                  </span>
                </div>
                <button
                  v-if="activeTab && activeTab.dirty"
                  class="save-button"
                  :class="{ dark: isDark }"
                  :disabled="activeTab.loading"
                  @click="saveActiveTab"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                    <polyline points="17,21 17,13 7,13 7,21" />
                    <polyline points="7,3 7,8 15,8" />
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
        <div
          class="editor-bottom"
          :class="{ dark: isDark }"
        >
          <!-- Empty for now -->
        </div>
      </div>

      <!-- Right pane -->
      <div
        v-show="rightPaneVisible"
        class="right-pane"
        :class="{ dark: isDark }"
      >
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
      <button
        class="context-menu-item"
        @click="viewInFinder(tabContextMenu.tab!)"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle
            cx="12"
            cy="12"
            r="3"
          />
        </svg>
        <span>View in Finder</span>
      </button>

      <!-- Open with... -->
      <div class="context-menu-sep" />
      <div class="context-menu-subheader">
        Open with…
      </div>
      <button
        class="context-menu-item"
        @click="openWithEditor(tabContextMenu.tab!, 'code')"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        <span>Code Editor</span>
      </button>
      <button
        v-if="tabContextMenu.tab && MARKDOWN_EXTS.has(tabContextMenu.tab.ext.toLowerCase())"
        class="context-menu-item"
        @click="openWithEditor(tabContextMenu.tab!, 'markdown')"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line
            x1="16"
            y1="13"
            x2="8"
            y2="13"
          />
          <line
            x1="16"
            y1="17"
            x2="8"
            y2="17"
          />
          <polyline points="10 9 9 9 8 9" />
        </svg>
        <span>Markdown Editor</span>
      </button>
      <button
        v-if="tabContextMenu.tab && MARKDOWN_EXTS.has(tabContextMenu.tab.ext.toLowerCase())"
        class="context-menu-item"
        @click="openWithEditor(tabContextMenu.tab!, 'preview')"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span>Preview</span>
      </button>

      <!-- Save (if dirty) -->
      <div
        v-if="tabContextMenu.tab?.dirty"
        class="context-menu-sep"
      />
      <button
        v-if="tabContextMenu.tab?.dirty"
        class="context-menu-item"
        @click="saveTab(tabContextMenu.tab!)"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <polyline points="17,21 17,13 7,13 7,21" />
          <polyline points="7,3 7,8 15,8" />
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
import { useTheme } from '@pkg/composables/useTheme';
import AgentHeader from './agent/AgentHeader.vue';
import FileTreeSidebar from './filesystem/FileTreeSidebar.vue';
import CodeEditor from './filesystem/CodeEditor.vue';

import type { FileEntry } from './filesystem/FileTreeSidebar.vue';

interface TabState {
  path:        string;
  name:        string;
  ext:         string;
  content:     string;
  loading:     boolean;
  error:       string;
  dirty:       boolean;
  editorType?: 'code' | 'preview';
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
  code: markRaw(CodeEditor),
};

function resolveEditorType(_ext: string): string {
  return 'code';
}

export default defineComponent({
  name: 'AgentFilesystem',

  components: {
    PostHogTracker,
    AgentHeader,
    FileTreeSidebar,
    CodeEditor,
  },

  setup(props, { emit }) {
    const { isDark, toggleTheme, currentTheme, setTheme, availableThemes, themeGroups } = useTheme();
    const rootPath = ref('');
    const openTabs = ref<TabState[]>([]);
    const activeTabKey = ref('');
    const leftPaneVisible = ref(true);
    const centerPaneVisible = ref(true);
    const rightPaneVisible = ref(true);

    async function loadRootPath() {
      try {
        rootPath.value = await ipcRenderer.invoke('filesystem-get-root');
      } catch { /* ignore */ }
    }
    loadRootPath();

    const activeTab = computed(() => {
      return openTabs.value.find(t => `${ t.path }-${ t.editorType || 'code' }` === activeTabKey.value) || null;
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
      const key = `${ entry.path }-${ entry.editorType || 'code' }`;
      const existing = openTabs.value.find(t => `${ t.path }-${ t.editorType || 'code' }` === key);
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
      activeTabKey.value = `${ tab.path }-${ tab.editorType || 'code' }`;
    }

    function closeTab(tab: TabState) {
      const index = openTabs.value.findIndex(t => t === tab);
      if (index === -1) return;

      const wasActive = `${ tab.path }-${ tab.editorType || 'code' }` === activeTabKey.value;
      openTabs.value.splice(index, 1);

      if (wasActive) {
        if (openTabs.value.length === 0) {
          activeTabKey.value = '';
        } else {
          // Switch to the last tab
          const lastTab = openTabs.value[openTabs.value.length - 1];
          activeTabKey.value = `${ lastTab.path }-${ lastTab.editorType || 'code' }`;
        }
      }
    }

    const highlightPath = ref('');

    const tabContextMenu = ref<{
      visible: boolean;
      x:       number;
      y:       number;
      tab:     TabState | null;
    }>({
      visible: false,
      x:       0,
      y:       0,
      tab:     null,
    });

    function onTabContextMenu(event: MouseEvent, tab: TabState) {
      tabContextMenu.value = {
        visible: true,
        x:       event.clientX,
        y:       event.clientY,
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
      const key = `${ tab.path }-${ editorType }`;
      const existing = openTabs.value.find(t => `${ t.path }-${ t.editorType || 'code' }` === key);
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
        editorType,
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

    // Editor ref for accessing exposed methods (e.g. getContent)
    const editorRef = ref<any>(null);

    function markActiveTabDirty() {
      const tab = activeTab.value;
      if (tab && !tab.dirty) tab.dirty = true;
    }

    async function saveActiveTab() {
      const tab = activeTab.value;
      if (!tab?.dirty) return;

      try {
        let content = tab.content;

        // Get content from Monaco editor
        if (editorRef.value?.getContent) {
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
      currentTheme,
      setTheme,
      availableThemes,
      themeGroups,
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
  background: var(--bg-page);
  color: var(--text-primary);
}

.file-tree-panel {
  width: 280px;
  min-width: 200px;
  max-width: 400px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-default);
  overflow: hidden;
  background: var(--bg-surface);
}

.editor-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-page);
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
  border-top: 1px solid var(--border-default);
  overflow: hidden;
  background: var(--bg-surface);
}

.right-pane {
  width: 280px;
  min-width: 200px;
  max-width: 400px;
  flex-shrink: 0;
  border-left: 1px solid var(--border-default);
  overflow: hidden;
  background: var(--bg-surface);
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-muted);
}

.empty-icon {
  opacity: 0.3;
}

.dark .empty-icon {
  opacity: 0.2;
}

.empty-text {
  font-size: var(--fs-body);
  color: var(--text-secondary);
}

.empty-hint {
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
}

.error-text {
  font-size: var(--fs-code);
  color: var(--text-error);
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--bg-hover);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Tab bar */
.tab-bar {
  display: flex;
  align-items: stretch;
  height: 35px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.tab-bar::-webkit-scrollbar {
  height: 0;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  font-size: var(--fs-code);
  color: var(--text-primary);
  border-right: 1px solid var(--border-default);
  background: var(--bg-surface-hover);
  cursor: pointer;
  flex-shrink: 0;
  max-width: 200px;
  user-select: none;
}

.tab:hover {
  background: var(--bg-surface-hover);
}

.tab.active {
  background: var(--bg-page);
  color: var(--text-primary);
  border-bottom: 1px solid var(--bg-page);
  margin-bottom: -1px;
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
  background: var(--accent-primary);
  flex-shrink: 0;
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  color: var(--text-muted);
  margin-left: 2px;
  cursor: pointer;
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
  background: var(--bg-hover);
}

/* Editor header (breadcrumb + save button) */
.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  background: var(--bg-page);
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.save-button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-medium);
  color: var(--text-on-accent);
  background: var(--accent-primary);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.1s;
}

.save-button:hover:not(:disabled) {
  background: var(--accent-primary);
}

.save-button:active:not(:disabled) {
  background: var(--accent-primary-hover);
}

.save-button:disabled {
  background: var(--bg-surface-hover);
  cursor: not-allowed;
}

.breadcrumb-segment {
  white-space: nowrap;
}

.breadcrumb-sep {
  margin: 0 4px;
  color: var(--text-muted);
}

/* Tab Context Menu */
.tab-context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 180px;
  background: var(--bg-page);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 4px 0;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08);
  font-family: var(--font-sans);
  font-size: var(--fs-code);
}

.tab-context-menu .context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: none;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  line-height: 1;
}

.tab-context-menu .context-menu-item:hover {
  background: var(--bg-surface-hover);
}

.tab-context-menu .context-menu-sep {
  height: 1px;
  background: var(--border-default);
  margin: 4px 0;
}

.tab-context-menu .context-menu-subheader {
  padding: 8px 12px;
  font-weight: var(--weight-bold);
  font-size: var(--fs-body-sm);
  color: var(--text-secondary);
}

.tab-context-menu .context-menu-shortcut {
  margin-left: auto;
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  padding-left: 16px;
}
</style>
