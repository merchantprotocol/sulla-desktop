<template>
  <div class="tft-pane" :class="{ dark: isDark }">
    <div class="tft-header" :class="{ dark: isDark }">
      <span class="tft-header-title">Training Sources</span>
      <div class="tft-header-actions">
        <button
          class="tft-header-btn"
          :class="{ dark: isDark }"
          title="Save selections"
          :disabled="saving"
          @click="saveDocsConfig"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
            <polyline points="17 21 17 13 7 13 7 21"/>
            <polyline points="7 3 7 8 15 8"/>
          </svg>
        </button>
        <button class="tft-header-btn" :class="{ dark: isDark }" title="Close Panel" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Action bar (fixed, outside scrollable content) -->
    <div class="tft-action-bar" :class="{ dark: isDark }">
      <div class="tft-action-top">
        <span class="tft-selection-count">{{ selectedFolders.length + selectedFiles.length }} selected</span>
        <span v-if="configDirty" class="tft-dirty-dot" title="Unsaved changes" />
      </div>

      <!-- Save button -->
      <button
        class="tft-action-btn tft-save-btn"
        :class="{ dark: isDark }"
        :disabled="!configDirty || saving"
        @click="saveDocsConfig"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
          <polyline points="17 21 17 13 7 13 7 21"/>
          <polyline points="7 3 7 8 15 8"/>
        </svg>
        {{ saving ? 'Saving…' : 'Save Selections' }}
      </button>

      <!-- Prepare button -->
      <button
        class="tft-action-btn tft-prepare-btn"
        :class="{ dark: isDark }"
        :disabled="preprocessing"
        @click="prepareForTraining"
      >
        <svg v-if="!preprocessing" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="16 16 12 12 8 16"/>
          <line x1="12" y1="12" x2="12" y2="21"/>
          <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
        </svg>
        <span v-else class="tft-btn-spinner" />
        {{ preprocessing ? 'Processing…' : 'Prepare for Training' }}
      </button>

      <!-- Preprocessing result -->
      <div v-if="preprocessResult" class="tft-preprocess-result" :class="{ dark: isDark }">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        {{ preprocessResult.conversations }} conversation{{ preprocessResult.conversations !== 1 ? 's' : '' }} staged,
        {{ preprocessResult.filesProcessed }} file{{ preprocessResult.filesProcessed !== 1 ? 's' : '' }} processed
        <span v-if="preprocessResult.filesSkipped > 0">({{ preprocessResult.filesSkipped }} skipped)</span>
      </div>
    </div>

    <!-- Scrollable tree content -->
    <div class="tft-content">
      <!-- Loading -->
      <div v-if="treeLoading" class="tft-status">Loading…</div>

      <!-- Error -->
      <div v-else-if="loadError" class="tft-status tft-error">{{ loadError }}</div>

      <!-- Empty -->
      <div v-else-if="treeRoot.length === 0" class="tft-status">No training sources found.<br>Create skills, workflows, or projects in ~/sulla/ to get started.</div>

      <!-- File tree -->
      <div v-else class="tft-tree">
        <template v-for="node in treeRoot" :key="node.path">
          <TreeNode
            :node="node"
            :depth="0"
            :is-dark="isDark"
            :expanded-dirs="expandedDirs"
            :tree-children="treeChildren"
            :tree-loading="treeLoading"
            :selected-folders="selectedFolders"
            :selected-files="selectedFiles"
            @toggle-dir="toggleDir"
            @toggle-folder="toggleSelectFolder"
            @toggle-file="toggleSelectFile"
          />
        </template>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted } from 'vue';
import { ipcRenderer } from 'electron';

interface TreeEntry {
  path: string;
  name: string;
  isDir: boolean;
  hasChildren: boolean;
  size: number;
  ext: string;
  category?: string;
}

interface PreprocessResult {
  conversations: number;
  filesProcessed: number;
  filesSkipped: number;
}

/**
 * Recursive tree node component (defined inline to avoid a separate file).
 */
const TreeNode = defineComponent({
  name: 'TreeNode',
  props: {
    node:            { type: Object as () => TreeEntry, required: true },
    depth:           { type: Number, default: 0 },
    isDark:          { type: Boolean, default: false },
    expandedDirs:    { type: Object as () => Set<string>, required: true },
    treeChildren:    { type: Object as () => Record<string, TreeEntry[]>, required: true },
    treeLoading:     { type: String, default: '' },
    selectedFolders: { type: Array as () => string[], required: true },
    selectedFiles:   { type: Array as () => string[], required: true },
  },
  emits: ['toggle-dir', 'toggle-folder', 'toggle-file'],
  template: `
    <div class="tft-node">
      <div
        class="tft-row"
        :class="{ dark: isDark, selected: isSelected }"
        :style="{ paddingLeft: (depth * 14 + 4) + 'px' }"
      >
        <span
          v-if="node.isDir"
          class="tft-arrow"
          :class="{ open: expandedDirs.has(node.path), empty: !node.hasChildren }"
          @click="$emit('toggle-dir', node.path)"
        />
        <span v-else class="tft-arrow-spacer" />
        <input
          type="checkbox"
          class="tft-checkbox"
          :checked="isSelected"
          @change="node.isDir ? $emit('toggle-folder', node.path) : $emit('toggle-file', node.path)"
        >
        <span
          class="tft-label"
          :class="{ dir: node.isDir }"
          @click="node.isDir ? $emit('toggle-dir', node.path) : $emit('toggle-file', node.path)"
        >{{ node.name }}</span>
        <span v-if="treeLoading === node.path" class="tft-spinner" />
      </div>
      <div v-if="node.isDir && expandedDirs.has(node.path) && treeChildren[node.path]" class="tft-children">
        <TreeNode
          v-for="child in treeChildren[node.path]"
          :key="child.path"
          :node="child"
          :depth="depth + 1"
          :is-dark="isDark"
          :expanded-dirs="expandedDirs"
          :tree-children="treeChildren"
          :tree-loading="treeLoading"
          :selected-folders="selectedFolders"
          :selected-files="selectedFiles"
          @toggle-dir="$emit('toggle-dir', $event)"
          @toggle-folder="$emit('toggle-folder', $event)"
          @toggle-file="$emit('toggle-file', $event)"
        />
      </div>
    </div>
  `,
  computed: {
    isSelected(): boolean {
      if (this.node.isDir) return this.selectedFolders.includes(this.node.path);
      return this.selectedFiles.includes(this.node.path);
    },
  },
});

export default defineComponent({
  name: 'TrainingFileTreePane',
  components: { TreeNode },

  props: {
    isDark: { type: Boolean, default: false },
  },

  emits: ['close', 'config-saved', 'files-preprocessed'],

  setup(_props, { emit }) {
    const treeRoot = ref<TreeEntry[]>([]);
    const treeChildren = ref<Record<string, TreeEntry[]>>({});
    const expandedDirs = ref<Set<string>>(new Set());
    const treeLoading = ref('');
    const selectedFolders = ref<string[]>([]);
    const selectedFiles = ref<string[]>([]);
    const saving = ref(false);
    const configDirty = ref(false);
    const preprocessing = ref(false);
    const preprocessResult = ref<PreprocessResult | null>(null);
    const loadError = ref('');

    async function loadTreeDir(dirPath?: string) {
      const key = dirPath || '__root__';
      treeLoading.value = key;
      loadError.value = '';
      try {
        const entries: TreeEntry[] = dirPath
          ? await ipcRenderer.invoke('training-content-tree', dirPath)
          : await ipcRenderer.invoke('training-content-tree');
        if (!dirPath) {
          treeRoot.value = entries;
        } else {
          treeChildren.value = { ...treeChildren.value, [dirPath]: entries };
        }
      } catch (err: any) {
        console.error('Failed to list training content:', dirPath, err);
        if (!dirPath) {
          loadError.value = err?.message || 'Failed to load training sources. Try restarting the app.';
        }
      } finally {
        treeLoading.value = '';
      }
    }

    async function toggleDir(dirPath: string) {
      if (expandedDirs.value.has(dirPath)) {
        expandedDirs.value.delete(dirPath);
        expandedDirs.value = new Set(expandedDirs.value);
      } else {
        expandedDirs.value.add(dirPath);
        expandedDirs.value = new Set(expandedDirs.value);
        if (!treeChildren.value[dirPath]) {
          await loadTreeDir(dirPath);
        }
      }
    }

    function toggleSelectFolder(folderPath: string) {
      const idx = selectedFolders.value.indexOf(folderPath);
      if (idx >= 0) {
        selectedFolders.value.splice(idx, 1);
      } else {
        selectedFolders.value.push(folderPath);
      }
      configDirty.value = true;
      preprocessResult.value = null;
    }

    function toggleSelectFile(filePath: string) {
      const idx = selectedFiles.value.indexOf(filePath);
      if (idx >= 0) {
        selectedFiles.value.splice(idx, 1);
      } else {
        selectedFiles.value.push(filePath);
      }
      configDirty.value = true;
      preprocessResult.value = null;
    }

    async function saveDocsConfig() {
      saving.value = true;
      try {
        await ipcRenderer.invoke(
          'training-docs-config-save',
          [...selectedFolders.value],
          [...selectedFiles.value],
          [],
        );
        configDirty.value = false;
        emit('config-saved');
      } catch (err) {
        console.error('Failed to save docs config:', err);
      } finally {
        saving.value = false;
      }
    }

    async function prepareForTraining() {
      preprocessing.value = true;
      preprocessResult.value = null;

      try {
        // Save config first if dirty
        if (configDirty.value) {
          await ipcRenderer.invoke(
            'training-docs-config-save',
            [...selectedFolders.value],
            [...selectedFiles.value],
            [],
          );
          configDirty.value = false;
        }

        // Run preprocessing
        const result: PreprocessResult = await ipcRenderer.invoke('training-preprocess');
        preprocessResult.value = result;
        emit('files-preprocessed');
      } catch (err) {
        console.error('Preprocessing failed:', err);
      } finally {
        preprocessing.value = false;
      }
    }

    onMounted(async () => {
      // Load existing config (remembered selections)
      try {
        const config = await ipcRenderer.invoke('training-docs-config-load');
        selectedFolders.value = config.folders || [];
        selectedFiles.value = config.files || [];
      } catch { /* ignore */ }

      // Load top-level Sulla content categories (skills, workflows, agents, etc.)
      await loadTreeDir();
    });

    return {
      treeRoot,
      treeChildren,
      expandedDirs,
      treeLoading,
      selectedFolders,
      selectedFiles,
      saving,
      configDirty,
      preprocessing,
      preprocessResult,
      loadError,
      toggleDir,
      toggleSelectFolder,
      toggleSelectFile,
      saveDocsConfig,
      prepareForTraining,
    };
  },
});
</script>

<style scoped>
.tft-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.tft-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}
.tft-header.dark {
  border-bottom-color: #334155;
}
.tft-header-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
}
.tft-header.dark .tft-header-title {
  color: #94a3b8;
}
.tft-header-actions {
  display: flex;
  gap: 2px;
}
.tft-header-btn {
  background: none;
  border: none;
  padding: 3px;
  border-radius: 4px;
  cursor: pointer;
  color: #64748b;
  display: flex;
  align-items: center;
}
.tft-header-btn:hover {
  background: #f1f5f9;
  color: #0f172a;
}
.tft-header-btn.dark:hover {
  background: #1e293b;
  color: #e2e8f0;
}
.tft-header-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* Action bar */
.tft-action-bar {
  padding: 8px;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tft-action-bar.dark {
  border-bottom-color: #334155;
}
.tft-action-top {
  display: flex;
  align-items: center;
  gap: 4px;
}
.tft-selection-count {
  font-size: 11px;
  color: #64748b;
}
.tft-dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f59e0b;
  flex-shrink: 0;
}

.tft-action-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 5px 8px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  cursor: pointer;
  background: #fff;
  color: #334155;
  transition: background 0.1s, border-color 0.1s;
}
.tft-action-btn.dark {
  background: #1e293b;
  border-color: #334155;
  color: #cbd5e1;
}
.tft-action-btn:hover:not(:disabled) {
  background: #f1f5f9;
  border-color: #cbd5e1;
}
.tft-action-btn.dark:hover:not(:disabled) {
  background: #334155;
  border-color: #475569;
}
.tft-action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tft-prepare-btn {
  background: #0284c7;
  border-color: #0284c7;
  color: #fff;
}
.tft-prepare-btn.dark {
  background: #0369a1;
  border-color: #0369a1;
  color: #fff;
}
.tft-prepare-btn:hover:not(:disabled) {
  background: #0369a1;
  border-color: #0369a1;
}
.tft-prepare-btn.dark:hover:not(:disabled) {
  background: #075985;
  border-color: #075985;
}

.tft-btn-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: tft-spin 0.6s linear infinite;
  flex-shrink: 0;
}

/* Preprocess result */
.tft-preprocess-result {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  font-size: 10px;
  line-height: 1.4;
  color: #16a34a;
  padding: 4px 6px;
  background: #f0fdf4;
  border-radius: 4px;
  border: 1px solid #bbf7d0;
}
.tft-preprocess-result.dark {
  background: #14532d;
  border-color: #166534;
  color: #4ade80;
}
.tft-preprocess-result svg {
  flex-shrink: 0;
  margin-top: 1px;
}

.tft-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.tft-status {
  padding: 1rem;
  text-align: center;
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.5;
}
.tft-error {
  color: #ef4444;
}

.tft-tree {
  padding: 4px 0;
}

/* Row styles */
.tft-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  font-size: 12px;
  cursor: default;
  color: #334155;
}
.tft-row.dark {
  color: #cbd5e1;
}
.tft-row:hover {
  background: #f1f5f9;
}
.tft-row.dark:hover {
  background: #1e293b;
}
.tft-row.selected {
  background: #eff6ff;
}
.tft-row.dark.selected {
  background: #1e3a5f;
}

.tft-arrow {
  display: inline-flex;
  width: 14px;
  height: 14px;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: pointer;
  font-size: 10px;
  color: #94a3b8;
  transition: transform 0.1s;
}
.tft-arrow::before {
  content: '\25B6'; /* right triangle */
}
.tft-arrow.open {
  transform: rotate(90deg);
}
.tft-arrow.empty {
  visibility: hidden;
}
.tft-arrow-spacer {
  display: inline-block;
  width: 14px;
  flex-shrink: 0;
}

.tft-checkbox {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  cursor: pointer;
  accent-color: #0284c7;
}

.tft-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.tft-label.dir {
  font-weight: 500;
}

.tft-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid #94a3b8;
  border-top-color: transparent;
  border-radius: 50%;
  animation: tft-spin 0.6s linear infinite;
  flex-shrink: 0;
}
@keyframes tft-spin {
  to { transform: rotate(360deg); }
}
</style>
