<template>
  <div class="file-tree-sidebar" :class="{ dark: isDark }">
    <div class="file-tree-header">
      <span class="file-tree-title">EXPLORER</span>
    </div>
    <div v-if="loading && entries.length === 0" class="file-tree-loading">
      Loading…
    </div>
    <div v-else class="file-tree-scroll">
      <FileTreeNode
        v-for="entry in entries"
        :key="entry.path"
        :entry="entry"
        :depth="0"
        :expanded-dirs="expandedDirs"
        :children-map="childrenMap"
        :loading-dirs="loadingDirs"
        :selected-path="selectedPath"
        @toggle-dir="toggleDir"
        @select-file="selectFile"
      />
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted } from 'vue';
import { ipcRenderer } from 'electron';
import FileTreeNode from './FileTreeNode.vue';

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  ext: string;
}

export default defineComponent({
  name: 'FileTreeSidebar',

  components: { FileTreeNode },

  props: {
    isDark: { type: Boolean, default: false },
  },

  emits: ['file-selected'],

  setup(props, { emit }) {
    const entries = ref<FileEntry[]>([]);
    const expandedDirs = ref<Set<string>>(new Set());
    const childrenMap = ref<Record<string, FileEntry[]>>({});
    const loadingDirs = ref<Set<string>>(new Set());
    const loading = ref(true);
    const selectedPath = ref('');
    const rootPath = ref('');

    async function loadRoot() {
      loading.value = true;
      try {
        rootPath.value = await ipcRenderer.invoke('filesystem-get-root');
        const result = await ipcRenderer.invoke('filesystem-read-dir', rootPath.value);
        entries.value = result;
      } catch (err) {
        console.error('Failed to load root:', err);
      } finally {
        loading.value = false;
      }
    }

    async function loadChildren(dirPath: string) {
      loadingDirs.value.add(dirPath);
      try {
        const result = await ipcRenderer.invoke('filesystem-read-dir', dirPath);
        childrenMap.value = { ...childrenMap.value, [dirPath]: result };
      } catch (err) {
        console.error('Failed to load dir:', dirPath, err);
      } finally {
        loadingDirs.value.delete(dirPath);
      }
    }

    async function toggleDir(dirPath: string) {
      const expanded = new Set(expandedDirs.value);
      if (expanded.has(dirPath)) {
        expanded.delete(dirPath);
      } else {
        expanded.add(dirPath);
        if (!childrenMap.value[dirPath]) {
          await loadChildren(dirPath);
        }
      }
      expandedDirs.value = expanded;
    }

    function selectFile(entry: FileEntry) {
      selectedPath.value = entry.path;
      emit('file-selected', entry);
    }

    onMounted(loadRoot);

    return {
      entries,
      expandedDirs,
      childrenMap,
      loadingDirs,
      loading,
      selectedPath,
      toggleDir,
      selectFile,
    };
  },
});
</script>

<style scoped>
.file-tree-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #f8fafc;
  color: #333;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  user-select: none;
  overflow: hidden;
}

.file-tree-sidebar.dark {
  background: #252526;
  color: #ccc;
}

.file-tree-header {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  color: #6f6f6f;
  border-bottom: 1px solid #e0e0e0;
  flex-shrink: 0;
}

.dark .file-tree-header {
  color: #999;
  border-bottom-color: #3c3c3c;
}

.file-tree-loading {
  padding: 16px 12px;
  color: #999;
  font-size: 12px;
}

.file-tree-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 2px 0;
}

.file-tree-scroll::-webkit-scrollbar {
  width: 6px;
}

.file-tree-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.file-tree-scroll::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.15);
  border-radius: 3px;
}

.dark .file-tree-scroll::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
}
</style>
