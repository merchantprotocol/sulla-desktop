<template>
  <div class="h-screen overflow-hidden font-sans flex flex-col page-root" :class="{ dark: isDark }">
    <PostHogTracker page-name="AgentFilesystem" />
    <EditorHeader
      :is-dark="isDark"
      :toggle-theme="toggleTheme"
      :left-pane-visible="leftPaneVisible"
      :bottom-pane-visible="bottomPaneVisible"
      :right-pane-visible="rightPaneVisible"
      @toggle-left-pane="leftPaneVisible = !leftPaneVisible"
      @toggle-bottom-pane="bottomPaneVisible = !bottomPaneVisible"
      @toggle-right-pane="rightPaneVisible = !rightPaneVisible"
    />

    <div class="flex h-full min-h-0 overflow-hidden">
        <div class="main-content">
        <!-- Icon Panel -->
        <IconPanel
          :is-dark="isDark"
          :left-pane-visible="leftPaneVisible"
          :search-mode="searchMode"
          :git-mode="gitMode"
          @toggle-file-tree="toggleFileTree"
          @toggle-search="toggleSearch"
          @toggle-git="toggleGit"
        />
        </div>

        <!-- Left sidebar: File tree -->
        <div class="left-pane" v-show="leftPaneVisible" :class="{ dark: isDark }" :style="{ width: leftPaneWidth + 'px' }">
          <div class="file-tree-wrapper">
            <!-- Search -->
            <FileSearch
              v-show="searchMode"
              v-model="searchQuery"
              v-model:search-path="searchPath"
              :is-dark="isDark"
              :results="searchResults"
              :indexing="qmdIndexing"
              @file-selected="onFileSelected"
            />

            <!-- Git pane -->
            <GitPane
              v-show="gitMode"
              :git-changes="gitChanges"
              :is-dark="isDark"
            />

            <!-- File tree -->
            <FileTreeSidebar
              v-show="!searchMode && !gitMode"
              :root-path="rootPath"
              :highlight-path="highlightPath"
              :is-dark="isDark"
              @file-selected="onFileSelected"
            />
          </div>
        </div>

        <!-- Resize handle: left pane -->
        <div
          v-show="leftPaneVisible"
          class="resize-handle resize-handle-v"
          :class="{ dark: isDark }"
          @mousedown="startResize('left', $event)"
        ></div>

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
                @contextmenu.prevent="$emit('tab-context-menu', $event, tab)"
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
              <img :src="sullaMutedIconUrl" alt="Sulla" class="empty-icon-img">
              <p class="empty-text">Sulla Editor</p>
              <p class="empty-hint">an editor built for vibe coders</p>
            </div>

            <!-- Active tab content -->
            <template v-if="activeTab">
              <!-- Loading state -->
              <div v-if="activeTab?.loading" class="empty-state">
                <div class="loading-spinner"></div>
                <p class="empty-text">Loading {{ activeTab?.name }}…</p>
              </div>

              <!-- Error state -->
              <div v-else-if="activeTab?.error" class="empty-state">
                <p class="error-text">{{ activeTab?.error }}</p>
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
                    v-if="activeTab?.dirty"
                    class="save-button"
                    :class="{ dark: isDark }"
                    @click="saveActiveTab"
                    :disabled="activeTab?.loading"
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
                    :content="activeTab?.content || ''"
                    :file-path="activeTab?.path || ''"
                    :file-ext="activeTab?.ext || ''"
                    :is-dark="isDark"
                    :read-only="activeTab?.editorType === 'preview'"
                    @dirty="markActiveTabDirty"
                  />
                </div>
              </template>
            </template>
          </div>

          <!-- Resize handle: bottom pane -->
          <div
            v-show="bottomPaneVisible"
            class="resize-handle resize-handle-h"
            :class="{ dark: isDark }"
            @mousedown="startResize('bottom', $event)"
          ></div>

          <!-- Bottom center pane -->
          <div v-show="bottomPaneVisible" class="editor-bottom" :class="{ dark: isDark }" :style="{ height: bottomPaneHeight + 'px' }">
            <!-- Terminal tabs header -->
            <div class="terminal-tabs-header" :class="{ dark: isDark }">
              <div class="terminal-tabs">
                <div
                  v-for="tab in terminalTabs"
                  :key="tab.id"
                  class="terminal-tab"
                  :class="{ active: activeTerminalTab === tab.id, dark: isDark }"
                  @click="switchTerminalTab(tab.id)"
                >
                  <span>{{ tab.name }}</span>
                  <button
                    v-if="terminalTabs.length > 1"
                    class="terminal-tab-close"
                    :class="{ dark: isDark }"
                    @click.stop="closeTerminalTab(tab.id)"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                </div>
              </div>
              <button
                class="terminal-tab-add"
                :class="{ dark: isDark }"
                @click="createNewTerminalTab"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>
            </div>
            
            <!-- Terminal content -->
            <div class="terminal-content">
              <div
                v-for="tab in terminalTabs"
                :key="tab.id"
                v-show="activeTerminalTab === tab.id"
                class="terminal-pane"
              >
                <XTermTerminal :is-dark="isDark" :session-id="tab.sessionId" />
              </div>
            </div>
          </div>
        </div>

        <!-- Resize handle: right pane -->
        <div
          v-show="rightPaneVisible"
          class="resize-handle resize-handle-v"
          :class="{ dark: isDark }"
          @mousedown="startResize('right', $event)"
        ></div>

        <!-- Right pane: Chat -->
        <div class="right-pane" v-show="rightPaneVisible" :class="{ dark: isDark }" :style="{ width: rightPaneWidth + 'px' }">
          <EditorChat
            :is-dark="isDark"
            :messages="chatMessages"
            :query="chatQuery"
            :loading="chatLoading"
            :graph-running="chatGraphRunning"
            :model-selector="modelSelector"
            :total-tokens-used="chatTotalTokensUsed"
            @update:query="chatUpdateQuery"
            @send="chatSend"
            @stop="chatStop"
          />
        </div>
      </div>
    </div>

  <!-- Tab Context Menu -->
  <TabContextMenu
    :visible="tabContextMenu.visible"
    :x="tabContextMenu.x"
    :y="tabContextMenu.y"
    :tab="tabContextMenu.tab"
    :is-dark="isDark"
    @view-in-finder="viewInFinder"
    @open-with-editor="openWithEditor"
    @save-tab="saveTab"
    @close-tab="closeTab"
  />

</template>

<script lang="ts">
import { defineComponent, ref, computed, reactive, markRaw, onMounted, onBeforeUnmount, nextTick, watch, type Component } from 'vue';
import { ipcRenderer } from 'electron';

import PostHogTracker from '@pkg/components/PostHogTracker.vue';
import EditorHeader from './editor/EditorHeader.vue';
import FileTreeSidebar from './filesystem/FileTreeSidebar.vue';
import MarkdownEditor from './filesystem/MarkdownEditor.vue';
import CodeEditor from './filesystem/CodeEditor.vue';
import XTermTerminal from './editor/XTermTerminal.vue';
import TabContextMenu from './editor/TabContextMenu.vue';
import GitChanges from './editor/GitChanges.vue';
import IconPanel from './editor/IconPanel.vue';
import FileSearch from './editor/FileSearch.vue';
import GitPane from './editor/GitPane.vue';
import EditorChat from './editor/EditorChat.vue';
import { EditorChatInterface } from './editor/EditorChatInterface';
import { FrontendGraphWebSocketService } from '@pkg/agent/services/FrontendGraphWebSocketService';
import { AgentModelSelectorController } from './agent/AgentModelSelectorController';
import { getAgentPersonaRegistry } from '@pkg/agent';

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
    EditorHeader,
    FileTreeSidebar,
    MarkdownEditor,
    CodeEditor,
    XTermTerminal,
    TabContextMenu,
    GitChanges,
    IconPanel,
    FileSearch,
    GitPane,
    EditorChat,
  },

  setup(props, { emit }) {
    const isDark = ref(false);
    const THEME_STORAGE_KEY = 'agentTheme';
    const sullaMutedIconUrl = new URL('../../../resources/icons/sulla-muted-icon.png', import.meta.url).toString();
    const rootPath = ref('');
    const openTabs = ref<TabState[]>([]);
    const activeTabKey = ref('');
    const leftPaneVisible = ref(true);
    const centerPaneVisible = ref(true);
    const rightPaneVisible = ref(true);
    const bottomPaneVisible = ref(true);

    // Editor chat (dev-editor channel)
    const editorCurrentThreadId = ref<string | null>(null);
    const editorGraphWs = new FrontendGraphWebSocketService({ currentThreadId: editorCurrentThreadId }, 'dev-editor');
    const editorChat = new EditorChatInterface();
    const chatMessages = editorChat.messages;
    const chatQuery = editorChat.query;
    const chatLoading = editorChat.loading;
    const chatGraphRunning = editorChat.graphRunning;
    const chatSend = () => editorChat.send();
    const chatStop = () => editorChat.stop();
    const chatUpdateQuery = (val: string) => { editorChat.query.value = val; };

    // Model selector for editor chat
    const editorModelName = ref('');
    const editorModelMode = ref<'local' | 'remote'>('local');
    const editorSystemReady = ref(true);
    const editorModelLoading = ref(false);
    const editorIsRunning = chatGraphRunning;

    const modelSelector = new AgentModelSelectorController({
      systemReady: editorSystemReady,
      loading:     editorModelLoading,
      isRunning:   editorIsRunning,
      modelName:   editorModelName,
      modelMode:   editorModelMode,
    });

    // Token usage from the dev-editor persona
    const registry = getAgentPersonaRegistry();
    const chatTotalTokensUsed = computed(() => {
      const persona = registry.getPersonaService('dev-editor');
      return persona?.state.totalTokensUsed ?? 0;
    });

    // Resizable pane sizes (persisted to localStorage)
    const PANE_STORAGE_KEY = 'agentEditorPaneSizes';
    const savedSizes = (() => {
      try {
        return JSON.parse(localStorage.getItem(PANE_STORAGE_KEY) || '{}');
      } catch { return {}; }
    })();
    const leftPaneWidth = ref<number>(savedSizes.left ?? 280);
    const rightPaneWidth = ref<number>(savedSizes.right ?? 280);
    const bottomPaneHeight = ref<number>(savedSizes.bottom ?? 200);

    function savePaneSizes() {
      localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify({
        left:   leftPaneWidth.value,
        right:  rightPaneWidth.value,
        bottom: bottomPaneHeight.value,
      }));
    }

    type ResizeTarget = 'left' | 'right' | 'bottom';
    let resizeTarget: ResizeTarget | null = null;
    let resizeStartPos = 0;
    let resizeStartSize = 0;

    function startResize(target: ResizeTarget, e: MouseEvent) {
      e.preventDefault();
      resizeTarget = target;
      if (target === 'bottom') {
        resizeStartPos = e.clientY;
        resizeStartSize = bottomPaneHeight.value;
      } else if (target === 'left') {
        resizeStartPos = e.clientX;
        resizeStartSize = leftPaneWidth.value;
      } else {
        resizeStartPos = e.clientX;
        resizeStartSize = rightPaneWidth.value;
      }
      document.addEventListener('mousemove', onResizeMove);
      document.addEventListener('mouseup', onResizeEnd);
      document.body.style.cursor = target === 'bottom' ? 'row-resize' : 'col-resize';
      document.body.style.userSelect = 'none';
    }

    function onResizeMove(e: MouseEvent) {
      if (!resizeTarget) return;
      if (resizeTarget === 'bottom') {
        const delta = resizeStartPos - e.clientY;
        bottomPaneHeight.value = Math.max(100, Math.min(600, resizeStartSize + delta));
      } else if (resizeTarget === 'left') {
        const delta = e.clientX - resizeStartPos;
        leftPaneWidth.value = Math.max(150, Math.min(600, resizeStartSize + delta));
      } else {
        const delta = resizeStartPos - e.clientX;
        rightPaneWidth.value = Math.max(150, Math.min(600, resizeStartSize + delta));
      }
    }

    function onResizeEnd() {
      resizeTarget = null;
      document.removeEventListener('mousemove', onResizeMove);
      document.removeEventListener('mouseup', onResizeEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      savePaneSizes();
    }
    const searchMode = ref(false);
    const gitMode = ref(false);
    const searchQuery = ref('');
    const searchPath = ref('');
    const searchResults = ref<Array<{ path: string; name: string; line: number; preview: string; score: number; source: 'fts' | 'filename' }>>([]);
    const qmdIndexing = ref(false);
    const gitChanges = ref<{status: string, file: string}[]>([]);

    // Terminal tabs state
    const terminalTabs = ref([
      { id: 'terminal-1', name: 'Terminal 1', sessionId: '' }
    ]);
    const activeTerminalTab = ref('terminal-1');
    let terminalCounter = 1;

    // Terminal tab functions
    function createNewTerminalTab() {
      terminalCounter++;
      const newTab = {
        id: `terminal-${terminalCounter}`,
        name: `Terminal ${terminalCounter}`,
        sessionId: ''
      };
      terminalTabs.value.push(newTab);
      activeTerminalTab.value = newTab.id;
    }

    function closeTerminalTab(tabId: string) {
      if (terminalTabs.value.length <= 1) return; // Don't close last tab
      
      const index = terminalTabs.value.findIndex(tab => tab.id === tabId);
      if (index === -1) return;
      
      const wasActive = activeTerminalTab.value === tabId;
      terminalTabs.value.splice(index, 1);
      
      if (wasActive) {
        // Switch to the last tab
        const lastTab = terminalTabs.value[terminalTabs.value.length - 1];
        activeTerminalTab.value = lastTab.id;
      }
    }

    function switchTerminalTab(tabId: string) {
      activeTerminalTab.value = tabId;
    }

    const getGitChanges = async () => {
      if (rootPath.value) {
        gitChanges.value = await (window as any).sulla.getGitChanges(rootPath.value);
      }
    };

    onMounted(async () => {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);

      if (stored === 'dark') {
        isDark.value = true;
      } else if (stored === 'light') {
        isDark.value = false;
      } else {
        isDark.value = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
      }

      await modelSelector.start();
    });

    function toggleTheme() {
      isDark.value = !isDark.value;
      localStorage.setItem(THEME_STORAGE_KEY, isDark.value ? 'dark' : 'light');
    }

    function toggleFileTree() {
      if (!leftPaneVisible.value) {
        leftPaneVisible.value = true;
        searchMode.value = false;
        gitMode.value = false;
      } else if (searchMode.value || gitMode.value) {
        searchMode.value = false;
        gitMode.value = false;
      } else {
        leftPaneVisible.value = false;
      }
    }

    function toggleSearch() {
      if (!leftPaneVisible.value) {
        leftPaneVisible.value = true;
        searchMode.value = true;
        gitMode.value = false;
      } else if (!searchMode.value) {
        searchMode.value = true;
        gitMode.value = false;
      } else {
        leftPaneVisible.value = false;
      }
    }

    function toggleGit() {
      if (!leftPaneVisible.value) {
        leftPaneVisible.value = true;
        searchMode.value = false;
        gitMode.value = true;
      } else if (!gitMode.value) {
        searchMode.value = false;
        gitMode.value = true;
      } else {
        leftPaneVisible.value = false;
      }
    }

    async function loadRootPath() {
      try {
        rootPath.value = await ipcRenderer.invoke('filesystem-get-root');
        searchPath.value = rootPath.value;
        await getGitChanges();
        // Index the root directory in the background for qmd search
        qmdIndexing.value = true;
        ipcRenderer.invoke('qmd-index', rootPath.value).catch(() => {}).finally(() => {
          qmdIndexing.value = false;
        });
      } catch { /* ignore */ }
    }
    loadRootPath();

    // Debounced search via qmd
    let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    watch(searchQuery, (query) => {
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
      }
      if (!query.trim()) {
        searchResults.value = [];
        return;
      }
      searchDebounceTimer = setTimeout(async() => {
        try {
          const dir = searchPath.value || rootPath.value;
          searchResults.value = await ipcRenderer.invoke('qmd-search', query, dir);
        } catch {
          searchResults.value = [];
        }
      }, 300);
    });

    // Re-index when the search path changes
    watch(searchPath, (newPath) => {
      if (!newPath.trim()) {
        return;
      }
      qmdIndexing.value = true;
      ipcRenderer.invoke('qmd-index', newPath).catch(() => {}).finally(() => {
        qmdIndexing.value = false;
      });
    });

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
        console.log('Loading file content for path:', tab.path);
        tab.content = await ipcRenderer.invoke('filesystem-read-file', tab.path);
        console.log('File content loaded successfully, length:', tab.content?.length);
      } catch (err: any) {
        console.error('Failed to load file content:', err);
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

    // Functions needed by FileTree component
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

    // Tab context menu removed - now in FileTree component

    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', () => {});
      editorChat.dispose();
      editorGraphWs.dispose();
      modelSelector.dispose();
    });

    return {
      isDark,
      sullaMutedIconUrl,
      chatMessages,
      chatQuery,
      chatLoading,
      chatGraphRunning,
      chatSend,
      chatStop,
      chatUpdateQuery,
      modelSelector,
      chatTotalTokensUsed,
      toggleTheme,
      toggleFileTree,
      toggleSearch,
      toggleGit,
      openTabs,
      activeTabKey,
      activeTab,
      rootPath,
      leftPaneVisible,
      centerPaneVisible,
      rightPaneVisible,
      bottomPaneVisible,
      leftPaneWidth,
      rightPaneWidth,
      bottomPaneHeight,
      startResize,
      searchMode,
      gitMode,
      searchQuery,
      searchPath,
      searchResults,
      qmdIndexing,
      gitChanges,
      terminalTabs,
      activeTerminalTab,
      createNewTerminalTab,
      closeTerminalTab,
      switchTerminalTab,
      MARKDOWN_EXTS,
      highlightPath,
      loadTabContent,
      switchTab,
      onTabContextMenu,
      getIconColor,
      closeTab,
      activeBreadcrumbs,
      saveActiveTab,
      activeEditorComponent,
      markActiveTabDirty,
      viewInFinder,
      openWithEditor,
      saveTab,
      onFileSelected,
      editorRef,
      tabContextMenu,
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

.editor-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.editor-bottom {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid #cbd5e1;
  overflow: hidden;
  background: #f8fafc;
}

.editor-bottom.dark {
  border-top-color: #3c3c3c;
  background: #1e293b;
}

.right-pane {
  flex-shrink: 0;
  border-left: 1px solid #cbd5e1;
  border-right: 1px solid #cbd5e1;
  overflow: hidden;
  background: #f8fafc;
}

.right-pane.dark {
  border-left-color: #3c3c3c;
  border-right-color: #3c3c3c;
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

.empty-icon-img {
  width: 48px;
  height: 48px;
  object-fit: contain;
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
  border-bottom: 1px solid #cbd5e1;
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
  border-right: 1px solid #cbd5e1;
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
  border-bottom: 1px solid #cbd5e1;
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

<style scoped>
.page-root {
  background: #ffffff;
  color: #0d0d0d;
}

.main-content {
  display: flex;
  height: 100%;
}

/* Resize handles */
.resize-handle {
  flex-shrink: 0;
  background: transparent;
  position: relative;
  z-index: 10;
}

.resize-handle-v {
  width: 5px;
  cursor: col-resize;
  margin: 0 -2px;
}

.resize-handle-h {
  height: 5px;
  cursor: row-resize;
  margin: -2px 0;
}

.resize-handle:hover,
.resize-handle:active {
  background: #0078d4;
  opacity: 0.5;
}

.resize-handle:active {
  opacity: 0.8;
}

.resize-handle.dark:hover,
.resize-handle.dark:active {
  background: #4fa3e0;
}

.left-pane {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #cbd5e1;
}

.file-tree-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.git-container {
  padding: 12px;
}

.git-change {
  padding: 4px 0;
  font-size: 13px;
  color: #333;
  cursor: pointer;
}

.dark .git-change {
  color: #ccc;
}
</style>

<style scoped>
.terminal-tabs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  height: 35px;
  background: #f8fafc;
  border-bottom: 1px solid #cbd5e1;
  flex-shrink: 0;
}

.terminal-tabs-header.dark {
  background: #1e293b;
  border-bottom-color: #3c3c3c;
}

.terminal-tabs {
  display: flex;
  gap: 4px;
}

.terminal-tab {
  padding: 0 12px;
  height: 28px;
  display: flex;
  align-items: center;
  background: #eef2f6;
  border-radius: 4px 4px 0 0;
  cursor: pointer;
  font-size: 13px;
  color: #333;
}

.terminal-tab:hover {
  background: #e8ecf0;
}

.terminal-tab.active {
  background: #ffffff;
  color: #333;
  border-bottom: 1px solid #ffffff;
  margin-bottom: -1px;
}

.dark .terminal-tab {
  background: #2d2d2d;
  color: #999;
}

.dark .terminal-tab:hover {
  background: #323232;
  color: #ccc;
}

.dark .terminal-tab.active {
  background: #0f172a;
  border-bottom-color: #0f172a;
  color: #ccc;
}

.terminal-tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: 6px;
  padding: 2px;
  border: none;
  background: none;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.1s;
}

.terminal-tab-close:hover {
  opacity: 1;
}

.terminal-tab-close.dark {
  color: #ccc;
}

.terminal-tab-add {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: none;
  background: none;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.1s;
  color: #666;
}

.terminal-tab-add:hover {
  opacity: 1;
}

.terminal-tab-add.dark {
  color: #ccc;
}

.terminal-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.terminal-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.add-terminal-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: #0078d4;
  color: white;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.add-terminal-btn:hover {
  background: #005a9e;
}

.close-tab-btn {
  margin-left: auto;
  border: none;
  background: none;
  color: #999;
  cursor: pointer;
  font-size: 14px;
  padding: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
}

.close-tab-btn:hover {
  color: #fff;
  background: #d32f2f;
}

.terminal-container {
  flex: 1;
  overflow: hidden;
}

.terminal-wrapper {
  width: 100%;
  height: 100%;
}

.terminal-wrapper .xterm {
  height: 100%;
}
</style>
