<template>
  <div class="file-tree-sidebar" :class="{ dark: isDark }">
    <div class="file-tree-header">
      <span class="file-tree-title">EXPLORER</span>
      <div class="file-tree-actions">
        <button class="action-btn" title="New File" @click="newFileAtRoot">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
        </button>
        <button class="action-btn" title="New Folder" @click="newFolderAtRoot">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            <line x1="12" y1="11" x2="12" y2="17" />
            <line x1="9" y1="14" x2="15" y2="14" />
          </svg>
        </button>
        <button class="action-btn" title="Upload File" @click="triggerUpload">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </button>
      </div>
      <input
        ref="uploadInputRef"
        type="file"
        multiple
        style="display: none"
        @change="onUploadInput"
      />
    </div>
    <div v-if="loading && entries.length === 0" class="file-tree-loading">
      Loading…
    </div>
    <div
      v-else
      class="file-tree-scroll"
      :class="{ 'drop-active': dropTargetPath === rootPath }"
      @dragover.prevent="onScrollDragOver"
      @dragleave="onScrollDragLeave"
      @drop.prevent="onScrollDrop"
    >
      <FileTreeNode
        v-for="entry in entries"
        :key="entry.path"
        :entry="entry"
        :depth="0"
        :expanded-dirs="expandedDirs"
        :children-map="childrenMap"
        :loading-dirs="loadingDirs"
        :selected-path="selectedPath"
        :drop-target-path="dropTargetPath"
        :highlight-path="highlightPath"
        @toggle-dir="toggleDir"
        @select-file="selectFile"
        @context-menu="onContextMenu"
        @drop-files="onDropFiles"
        @drag-hover="onDragHover"
      />
    </div>
    <FileContextMenu
      ref="contextMenuRef"
      :is-dark="isDark"
      :has-clipboard="!!fileClipboard"
      @action="onContextAction"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, watch } from 'vue';
import { ipcRenderer, clipboard } from 'electron';
import FileTreeNode from './FileTreeNode.vue';
import FileContextMenu from './FileContextMenu.vue';

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  ext: string;
  editorType?: 'code' | 'markdown';
}

export default defineComponent({
  name: 'FileTreeSidebar',

  components: { FileTreeNode, FileContextMenu },

  props: {
    isDark: { type: Boolean, default: false },
    highlightPath: { type: String, default: '' },
  },

  emits: ['file-selected', 'tree-changed'],

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

    const contextMenuRef = ref<any>(null);
    const fileClipboard = ref<{ path: string; operation: 'copy' | 'cut' } | null>(null);

    function onContextMenu(payload: { event: MouseEvent; entry: FileEntry }) {
      contextMenuRef.value?.show(payload.event, payload.entry.path, payload.entry.isDir, payload.entry.ext);
    }

    async function refreshDir(dirPath: string) {
      try {
        const result = await ipcRenderer.invoke('filesystem-read-dir', dirPath);
        childrenMap.value = { ...childrenMap.value, [dirPath]: result };
      } catch { /* ignore */ }
    }

    async function refreshParentOrRoot(targetPath: string) {
      const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
      if (parentDir === rootPath.value) {
        await loadRoot();
      } else {
        await refreshDir(parentDir);
      }
    }

    async function onContextAction(payload: { type: string; path: string; isDir: boolean }) {
      const { type, path: targetPath } = payload;

      try {
        switch (type) {
        case 'new-file': {
          const name = prompt('New file name:');
          if (!name) return;
          await ipcRenderer.invoke('filesystem-create-file', targetPath, name);
          await refreshDir(targetPath);
          if (!expandedDirs.value.has(targetPath)) {
            expandedDirs.value = new Set([...expandedDirs.value, targetPath]);
          }
          emit('tree-changed');
          break;
        }
        case 'new-folder': {
          const name = prompt('New folder name:');
          if (!name) return;
          await ipcRenderer.invoke('filesystem-create-dir', targetPath, name);
          await refreshDir(targetPath);
          if (!expandedDirs.value.has(targetPath)) {
            expandedDirs.value = new Set([...expandedDirs.value, targetPath]);
          }
          emit('tree-changed');
          break;
        }
        case 'cut':
          fileClipboard.value = { path: targetPath, operation: 'cut' };
          break;
        case 'copy':
          fileClipboard.value = { path: targetPath, operation: 'copy' };
          break;
        case 'paste': {
          if (!fileClipboard.value) return;
          const { path: srcPath, operation } = fileClipboard.value;
          if (operation === 'copy') {
            await ipcRenderer.invoke('filesystem-copy', srcPath, targetPath);
          } else {
            await ipcRenderer.invoke('filesystem-move', srcPath, targetPath);
            // Refresh source parent after move
            await refreshParentOrRoot(srcPath);
            fileClipboard.value = null;
          }
          await refreshDir(targetPath);
          if (!expandedDirs.value.has(targetPath)) {
            expandedDirs.value = new Set([...expandedDirs.value, targetPath]);
          }
          emit('tree-changed');
          break;
        }
        case 'rename': {
          const oldName = targetPath.substring(targetPath.lastIndexOf('/') + 1);
          const newName = prompt('Rename to:', oldName);
          if (!newName || newName === oldName) return;
          await ipcRenderer.invoke('filesystem-rename', targetPath, newName);
          await refreshParentOrRoot(targetPath);
          emit('tree-changed');
          break;
        }
        case 'delete': {
          const name = targetPath.substring(targetPath.lastIndexOf('/') + 1);
          const confirmed = confirm(`Delete "${name}"? This cannot be undone.`);
          if (!confirmed) return;
          await ipcRenderer.invoke('filesystem-delete', targetPath);
          await refreshParentOrRoot(targetPath);
          // Clear clipboard if the deleted item was in it
          if (fileClipboard.value?.path.startsWith(targetPath)) {
            fileClipboard.value = null;
          }
          emit('tree-changed');
          break;
        }
        case 'copy-path':
          clipboard.writeText(targetPath);
          break;
        case 'copy-relative-path': {
          const relative = targetPath.replace(rootPath.value, '').replace(/^\//, '');
          clipboard.writeText(relative);
          break;
        }
        case 'reveal':
          await ipcRenderer.invoke('filesystem-reveal', targetPath);
          break;
        case 'open-external':
          await ipcRenderer.invoke('filesystem-open-external', targetPath);
          break;
        case 'open-code-editor':
          // Emit file-selected with forced code editor
          emit('file-selected', {
            name: targetPath.split('/').pop() || '',
            path: targetPath,
            isDir: false,
            size: 0,
            ext: targetPath.split('.').pop() || '',
            editorType: 'code'
          });
          break;
        case 'open-markdown-editor':
          // Emit file-selected with forced markdown editor
          emit('file-selected', {
            name: targetPath.split('/').pop() || '',
            path: targetPath,
            isDir: false,
            size: 0,
            ext: targetPath.split('.').pop() || '',
            editorType: 'markdown'
          });
          break;
        }
      } catch (err: any) {
        console.error(`Context action "${type}" failed:`, err);
        alert(err?.message || 'Operation failed');
      }
    }

    // ── Toolbar actions ──────────────────────────────────────
    const uploadInputRef = ref<HTMLInputElement | null>(null);

    async function newFileAtRoot() {
      const name = prompt('New file name:');
      if (!name) return;
      try {
        await ipcRenderer.invoke('filesystem-create-file', rootPath.value, name);
        await loadRoot();
        emit('tree-changed');
      } catch (err: any) {
        alert(err?.message || 'Failed to create file');
      }
    }

    async function newFolderAtRoot() {
      const name = prompt('New folder name:');
      if (!name) return;
      try {
        await ipcRenderer.invoke('filesystem-create-dir', rootPath.value, name);
        await loadRoot();
        emit('tree-changed');
      } catch (err: any) {
        alert(err?.message || 'Failed to create folder');
      }
    }

    function triggerUpload() {
      uploadInputRef.value?.click();
    }

    async function uploadFiles(files: FileList | File[], destDir: string) {
      for (const file of Array.from(files)) {
        try {
          const buffer = await file.arrayBuffer();
          const base64 = btoa(
            new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
          );
          await ipcRenderer.invoke('filesystem-upload', destDir, file.name, base64);
        } catch (err: any) {
          console.error(`Upload failed for ${file.name}:`, err);
        }
      }
    }

    async function onUploadInput(event: Event) {
      const input = event.target as HTMLInputElement;
      if (!input.files || input.files.length === 0) return;
      await uploadFiles(input.files, rootPath.value);
      input.value = '';
      await loadRoot();
      emit('tree-changed');
    }

    // ── Drag and drop ────────────────────────────────────────
    const dropTargetPath = ref('');

    function onScrollDragOver(event: DragEvent) {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.dataTransfer.dropEffect = 'copy';
      dropTargetPath.value = rootPath.value;
    }

    function onScrollDragLeave() {
      dropTargetPath.value = '';
    }

    async function onScrollDrop(event: DragEvent) {
      dropTargetPath.value = '';
      if (!event.dataTransfer?.files.length) return;
      await uploadFiles(event.dataTransfer.files, rootPath.value);
      await loadRoot();
      emit('tree-changed');
    }

    function onDragHover(dirPath: string) {
      dropTargetPath.value = dirPath;
    }

    async function onDropFiles(payload: { dirPath: string; files: FileList }) {
      dropTargetPath.value = '';
      await uploadFiles(payload.files, payload.dirPath);
      await refreshDir(payload.dirPath);
      if (!expandedDirs.value.has(payload.dirPath)) {
        expandedDirs.value = new Set([...expandedDirs.value, payload.dirPath]);
      }
      emit('tree-changed');
    }

    // Watch for highlightPath changes to expand directories
    watch(() => props.highlightPath, async (newPath: string) => {
      if (!newPath) return;

      // Split the path into segments to expand each directory
      const segments = newPath.split('/').filter((s: string) => s);
      let currentPath = '';

      for (const segment of segments) {
        currentPath += '/' + segment;

        // Skip if this is the file itself (last segment)
        if (currentPath === newPath) break;

        // Expand this directory if not already expanded
        if (!expandedDirs.value.has(currentPath)) {
          expandedDirs.value = new Set([...expandedDirs.value, currentPath]);
          // Load children if not already loaded
          if (!childrenMap.value[currentPath]) {
            await loadChildren(currentPath);
          }
        }
      }

      // Set as selected path to highlight it
      selectedPath.value = newPath;
    }, { immediate: true });

    onMounted(loadRoot);

    return {
      entries,
      expandedDirs,
      childrenMap,
      loadingDirs,
      loading,
      selectedPath,
      rootPath,
      toggleDir,
      selectFile,
      contextMenuRef,
      fileClipboard,
      onContextMenu,
      onContextAction,
      uploadInputRef,
      newFileAtRoot,
      newFolderAtRoot,
      triggerUpload,
      onUploadInput,
      dropTargetPath,
      onScrollDragOver,
      onScrollDragLeave,
      onScrollDrop,
      onDragHover,
      onDropFiles,
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
  background: #1e293b;
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

.file-tree-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: none;
  border-radius: 4px;
  cursor: pointer;
  color: #666;
}

.action-btn:hover {
  background: rgba(0, 0, 0, 0.08);
  color: #333;
}

.dark .action-btn {
  color: #999;
}

.dark .action-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ccc;
}

.dark .file-tree-header {
  color: #999;
  border-bottom-color: #3c3c3c;
}

.file-tree-scroll.drop-active {
  background: rgba(0, 120, 212, 0.06);
  outline: 2px dashed rgba(0, 120, 212, 0.3);
  outline-offset: -2px;
}

.dark .file-tree-scroll.drop-active {
  background: rgba(0, 120, 212, 0.1);
  outline-color: rgba(0, 120, 212, 0.4);
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
