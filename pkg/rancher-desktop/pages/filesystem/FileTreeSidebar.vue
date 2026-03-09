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
        <button class="action-btn" title="Close Panel" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
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
        :selected-paths="selectedPaths"
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
    <InlinePrompt ref="inlinePromptRef" :is-dark="isDark" />
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { ipcRenderer, clipboard } from 'electron';
import FileTreeNode from './FileTreeNode.vue';
import FileContextMenu from './FileContextMenu.vue';
import InlinePrompt from '../editor/InlinePrompt.vue';

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  ext: string;
  editorType?: 'code';
}

export default defineComponent({
  name: 'FileTreeSidebar',

  components: { FileTreeNode, FileContextMenu, InlinePrompt },

  props: {
    isDark: { type: Boolean, default: false },
    highlightPath: { type: String, default: '' },
  },

  emits: ['file-selected', 'tree-changed', 'close'],

  setup(props, { emit }) {
    const entries = ref<FileEntry[]>([]);
    const expandedDirs = ref<Set<string>>(new Set());
    const childrenMap = ref<Record<string, FileEntry[]>>({});
    const loadingDirs = ref<Set<string>>(new Set());
    const loading = ref(true);
    const selectedPaths = ref<Set<string>>(new Set());
    const lastSelectedPath = ref('');
    const rootPath = ref('');
    const inlinePromptRef = ref<InstanceType<typeof InlinePrompt> | null>(null);

    async function loadRoot() {
      loading.value = true;
      try {
        rootPath.value = await ipcRenderer.invoke('filesystem-get-root');
        console.log('[FileTree] loadRoot rootPath:', rootPath.value);
        const result = await ipcRenderer.invoke('filesystem-read-dir', rootPath.value);
        console.log('[FileTree] loadRoot entries:', result.length, result.map((e: FileEntry) => `${e.isDir ? 'D' : 'F'} ${e.name} (ext: ${e.ext})`));
        entries.value = result;
      } catch (err) {
        console.error('[FileTree] Failed to load root:', err);
      } finally {
        loading.value = false;
      }
    }

    async function loadChildren(dirPath: string) {
      console.log('[FileTree] loadChildren:', dirPath);
      loadingDirs.value.add(dirPath);
      try {
        const result = await ipcRenderer.invoke('filesystem-read-dir', dirPath);
        console.log('[FileTree] loadChildren result for', dirPath, ':', result.length, 'entries:', result.map((e: FileEntry) => `${e.isDir ? 'D' : 'F'} ${e.name}`));
        childrenMap.value = { ...childrenMap.value, [dirPath]: result };
      } catch (err) {
        console.error('[FileTree] Failed to load dir:', dirPath, err);
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

    /** Build a flat list of all visible entry paths in tree order */
    function getVisiblePaths(): string[] {
      const result: string[] = [];
      function walk(items: FileEntry[]) {
        for (const item of items) {
          result.push(item.path);
          if (item.isDir && expandedDirs.value.has(item.path)) {
            const kids = childrenMap.value[item.path];
            if (kids) walk(kids);
          }
        }
      }
      walk(entries.value);
      return result;
    }

    function selectFile(payload: { entry: FileEntry; shiftKey: boolean; metaKey: boolean }) {
      const { entry, shiftKey, metaKey } = payload;

      if (shiftKey && lastSelectedPath.value) {
        // Range select: select everything between lastSelectedPath and this entry
        const visible = getVisiblePaths();
        const startIdx = visible.indexOf(lastSelectedPath.value);
        const endIdx = visible.indexOf(entry.path);
        if (startIdx !== -1 && endIdx !== -1) {
          const from = Math.min(startIdx, endIdx);
          const to = Math.max(startIdx, endIdx);
          const rangeSet = new Set(selectedPaths.value);
          for (let i = from; i <= to; i++) {
            rangeSet.add(visible[i]);
          }
          selectedPaths.value = rangeSet;
        }
      } else if (metaKey) {
        // Toggle individual item
        const next = new Set(selectedPaths.value);
        if (next.has(entry.path)) {
          next.delete(entry.path);
        } else {
          next.add(entry.path);
        }
        selectedPaths.value = next;
        lastSelectedPath.value = entry.path;
      } else {
        // Normal click — single select
        selectedPaths.value = new Set([entry.path]);
        lastSelectedPath.value = entry.path;
      }

      // Open the file in the editor (only for non-dir single clicks without meta)
      if (!entry.isDir && !metaKey && !shiftKey) {
        emit('file-selected', entry);
      }
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
          const name = await inlinePromptRef.value?.show('New file name:');
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
          const name = await inlinePromptRef.value?.show('New folder name:');
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
          const newName = await inlinePromptRef.value?.show('Rename to:', oldName);
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
        }
      } catch (err: any) {
        console.error(`Context action "${type}" failed:`, err);
        alert(err?.message || 'Operation failed');
      }
    }

    // ── Toolbar actions ──────────────────────────────────────
    const uploadInputRef = ref<HTMLInputElement | null>(null);

    async function newFileAtRoot() {
      const name = await inlinePromptRef.value?.show('New file name:');
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
      const name = await inlinePromptRef.value?.show('New folder name:');
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
      selectedPaths.value = new Set([newPath]);
      lastSelectedPath.value = newPath;
    }, { immediate: true });

    // ── Auto-refresh heartbeat ─────────────────────────────
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    async function heartbeat() {
      if (!rootPath.value) return;
      try {
        const freshRoot = await ipcRenderer.invoke('filesystem-read-dir', rootPath.value);
        const oldNames = entries.value.map(e => `${e.name}:${e.isDir}`).join(',');
        const newNames = freshRoot.map((e: FileEntry) => `${e.name}:${e.isDir}`).join(',');
        if (oldNames !== newNames) {
          entries.value = freshRoot;
        }
        // Also refresh any expanded directories
        for (const dirPath of expandedDirs.value) {
          const freshChildren = await ipcRenderer.invoke('filesystem-read-dir', dirPath);
          const oldChildNames = (childrenMap.value[dirPath] || []).map((e: FileEntry) => `${e.name}:${e.isDir}`).join(',');
          const newChildNames = freshChildren.map((e: FileEntry) => `${e.name}:${e.isDir}`).join(',');
          if (oldChildNames !== newChildNames) {
            childrenMap.value = { ...childrenMap.value, [dirPath]: freshChildren };
          }
        }
      } catch { /* ignore */ }
    }

    // Expose refresh for parent components
    function refresh() {
      loadRoot();
      // Also refresh expanded dirs
      for (const dirPath of expandedDirs.value) {
        refreshDir(dirPath);
      }
    }

    onMounted(() => {
      loadRoot();
      heartbeatTimer = setInterval(heartbeat, 3000);
    });

    onBeforeUnmount(() => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    });

    return {
      entries,
      expandedDirs,
      childrenMap,
      loadingDirs,
      loading,
      selectedPaths,
      rootPath,
      toggleDir,
      selectFile,
      contextMenuRef,
      inlinePromptRef,
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
      refresh,
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
  padding: 0 8px 0 12px;
  height: 35px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: #64748b;
  background: #f8fafc;
  border-bottom: 1px solid #cbd5e1;
  flex-shrink: 0;
}

.dark .file-tree-header {
  color: #94a3b8;
  background: #1e293b;
  border-bottom-color: #3c3c3c;
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
