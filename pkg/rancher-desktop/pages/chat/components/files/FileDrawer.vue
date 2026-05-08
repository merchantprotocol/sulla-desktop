<template>
  <aside v-if="open" class="file-drawer">
    <div class="fd-header">
      <span class="fd-title">EXPLORER</span>
      <div class="fd-actions">
        <button class="fd-btn" title="New File" @click="newFileAtRoot">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" /><line x1="9" y1="15" x2="15" y2="15" />
          </svg>
        </button>
        <button class="fd-btn" title="New Folder" @click="newFolderAtRoot">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            <line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
          </svg>
        </button>
        <button class="fd-btn" title="Upload File" @click="triggerUpload">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </button>
        <button class="fd-btn" title="Close (⌘⇧E)" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <input ref="uploadInputRef" type="file" multiple style="display:none" @change="onUploadInput">
    </div>

    <div v-if="loading && entries.length === 0" class="fd-loading">Loading…</div>
    <div
      v-else
      class="fd-scroll"
      :class="{ 'drop-active': dropTargetPath === rootPath }"
      @dragover.prevent="onScrollDragOver"
      @dragleave="onScrollDragLeave"
      @drop.prevent="onScrollDrop"
    >
      <button
        v-if="canGoUp"
        class="fd-parent-row"
        type="button"
        :title="`Go to parent directory: ${parentPath}`"
        @click="goUp"
      >
        <span class="fd-parent-dots">..</span>
      </button>

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

    <FileContextMenu ref="contextMenuRef" :has-clipboard="!!fileClipboard" @action="onContextAction" />
    <InlinePrompt ref="inlinePromptRef" />
  </aside>
</template>

<script lang="ts">
import { ipcRenderer, clipboard } from 'electron';
import { defineComponent, ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';

import FileContextMenu from './FileContextMenu.vue';
import FileTreeNode    from './FileTreeNode.vue';
import InlinePrompt    from './InlinePrompt.vue';

export interface FileEntry {
  name:        string;
  path:        string;
  isDir:       boolean;
  size:        number;
  ext:         string;
  editorType?: 'code';
  line?:       number;
}

export default defineComponent({
  name: 'FileDrawer',
  components: { FileTreeNode, FileContextMenu, InlinePrompt },

  props: {
    open:          { type: Boolean, default: false },
    highlightPath: { type: String,  default: '' },
  },

  emits: ['file-selected', 'tree-changed', 'close'],

  setup(props, { emit }) {
    const entries       = ref<FileEntry[]>([]);
    const expandedDirs  = ref<Set<string>>(new Set());
    const childrenMap   = ref<Record<string, FileEntry[]>>({});
    const loadingDirs   = ref<Set<string>>(new Set());
    const loading       = ref(true);
    const selectedPaths = ref<Set<string>>(new Set());
    const lastSelectedPath = ref('');
    const rootPath      = ref('');
    const inlinePromptRef  = ref<InstanceType<typeof InlinePrompt> | null>(null);

    async function loadRoot() {
      loading.value = true;
      try {
        const initialRoot = await ipcRenderer.invoke('filesystem-get-root');
        if (!homePath.value) homePath.value = initialRoot;
        rootPath.value = initialRoot;
        entries.value  = await ipcRenderer.invoke('filesystem-read-dir', rootPath.value);
      } catch (err) {
        console.error('[FileDrawer] loadRoot failed:', err);
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
        console.error('[FileDrawer] loadChildren failed:', dirPath, err);
      } finally {
        loadingDirs.value.delete(dirPath);
      }
    }

    const parentPath = computed(() => {
      const current = rootPath.value;
      if (!current || current === '/') return '';
      const normalized = current.endsWith('/') && current.length > 1 ? current.slice(0, -1) : current;
      const lastSlash = normalized.lastIndexOf('/');
      if (lastSlash <= 0) return '/';
      return normalized.slice(0, lastSlash);
    });

    const canGoUp = computed(() => !!rootPath.value && rootPath.value !== '/' && rootPath.value !== homePath.value);

    async function navigateTo(dirPath: string) {
      loading.value = true;
      try {
        rootPath.value = dirPath;
        entries.value = await ipcRenderer.invoke('filesystem-read-dir', dirPath);
        childrenMap.value = {};
        expandedDirs.value = new Set();
        selectedPaths.value = new Set();
        lastSelectedPath.value = '';
      } catch (err) {
        console.error('[FileDrawer] navigateTo failed:', dirPath, err);
      } finally {
        loading.value = false;
      }
    }

    async function goUp() {
      if (!canGoUp.value || !parentPath.value) return;
      await navigateTo(parentPath.value);
    }

    async function toggleDir(dirPath: string) {
      const expanded = new Set(expandedDirs.value);
      if (expanded.has(dirPath)) {
        expanded.delete(dirPath);
      } else {
        expanded.add(dirPath);
        if (!childrenMap.value[dirPath]) await loadChildren(dirPath);
      }
      expandedDirs.value = expanded;
    }

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
        const visible  = getVisiblePaths();
        const startIdx = visible.indexOf(lastSelectedPath.value);
        const endIdx   = visible.indexOf(entry.path);
        if (startIdx !== -1 && endIdx !== -1) {
          const from = Math.min(startIdx, endIdx);
          const to   = Math.max(startIdx, endIdx);
          const rangeSet = new Set(selectedPaths.value);
          for (let i = from; i <= to; i++) rangeSet.add(visible[i]);
          selectedPaths.value = rangeSet;
        }
      } else if (metaKey) {
        const next = new Set(selectedPaths.value);
        if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path);
        selectedPaths.value = next;
        lastSelectedPath.value = entry.path;
      } else {
        selectedPaths.value = new Set([entry.path]);
        lastSelectedPath.value = entry.path;
      }
      if (!entry.isDir && !metaKey && !shiftKey) emit('file-selected', entry);
    }

    const contextMenuRef  = ref<InstanceType<typeof FileContextMenu> | null>(null);
    const fileClipboard   = ref<{ path: string; operation: 'copy' | 'cut' } | null>(null);

    function onContextMenu(payload: { event: MouseEvent; entry: FileEntry }) {
      contextMenuRef.value?.show(payload.event, payload.entry.path, payload.entry.isDir);
    }

    async function refreshDir(dirPath: string) {
      try {
        const result = await ipcRenderer.invoke('filesystem-read-dir', dirPath);
        childrenMap.value = { ...childrenMap.value, [dirPath]: result };
      } catch { /* ignore */ }
    }

    async function refreshParentOrRoot(targetPath: string) {
      const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
      if (parentDir === rootPath.value) await loadRoot(); else await refreshDir(parentDir);
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
            if (!expandedDirs.value.has(targetPath)) expandedDirs.value = new Set([...expandedDirs.value, targetPath]);
            emit('tree-changed'); break;
          }
          case 'new-folder': {
            const name = await inlinePromptRef.value?.show('New folder name:');
            if (!name) return;
            await ipcRenderer.invoke('filesystem-create-dir', targetPath, name);
            await refreshDir(targetPath);
            if (!expandedDirs.value.has(targetPath)) expandedDirs.value = new Set([...expandedDirs.value, targetPath]);
            emit('tree-changed'); break;
          }
          case 'cut':   fileClipboard.value = { path: targetPath, operation: 'cut' }; break;
          case 'copy':  fileClipboard.value = { path: targetPath, operation: 'copy' }; break;
          case 'paste': {
            if (!fileClipboard.value) return;
            const { path: srcPath, operation } = fileClipboard.value;
            if (operation === 'copy') await ipcRenderer.invoke('filesystem-copy', srcPath, targetPath);
            else { await ipcRenderer.invoke('filesystem-move', srcPath, targetPath); await refreshParentOrRoot(srcPath); fileClipboard.value = null; }
            await refreshDir(targetPath);
            if (!expandedDirs.value.has(targetPath)) expandedDirs.value = new Set([...expandedDirs.value, targetPath]);
            emit('tree-changed'); break;
          }
          case 'rename': {
            const oldName = targetPath.substring(targetPath.lastIndexOf('/') + 1);
            const newName = await inlinePromptRef.value?.show('Rename to:', oldName);
            if (!newName || newName === oldName) return;
            await ipcRenderer.invoke('filesystem-rename', targetPath, newName);
            await refreshParentOrRoot(targetPath); emit('tree-changed'); break;
          }
          case 'delete': {
            const name = targetPath.substring(targetPath.lastIndexOf('/') + 1);
            if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
            await ipcRenderer.invoke('filesystem-delete', targetPath);
            await refreshParentOrRoot(targetPath);
            if (fileClipboard.value?.path.startsWith(targetPath)) fileClipboard.value = null;
            emit('tree-changed'); break;
          }
          case 'copy-path':          clipboard.writeText(targetPath); break;
          case 'copy-relative-path': clipboard.writeText(targetPath.replace(rootPath.value, '').replace(/^\//, '')); break;
          case 'reveal':             await ipcRenderer.invoke('filesystem-reveal', targetPath); break;
          case 'open-external':      await ipcRenderer.invoke('filesystem-open-external', targetPath); break;
          case 'open-code-editor':
            emit('file-selected', { name: targetPath.split('/').pop() || '', path: targetPath, isDir: false, size: 0, ext: targetPath.split('.').pop() || '', editorType: 'code' });
            break;
        }
      } catch (err: any) {
        console.error(`[FileDrawer] context action "${type}" failed:`, err);
        alert(err?.message || 'Operation failed');
      }
    }

    const uploadInputRef = ref<HTMLInputElement | null>(null);

    async function newFileAtRoot() {
      const name = await inlinePromptRef.value?.show('New file name:');
      if (!name) return;
      try { await ipcRenderer.invoke('filesystem-create-file', rootPath.value, name); await loadRoot(); emit('tree-changed'); }
      catch (err: any) { alert(err?.message || 'Failed to create file'); }
    }
    async function newFolderAtRoot() {
      const name = await inlinePromptRef.value?.show('New folder name:');
      if (!name) return;
      try { await ipcRenderer.invoke('filesystem-create-dir', rootPath.value, name); await loadRoot(); emit('tree-changed'); }
      catch (err: any) { alert(err?.message || 'Failed to create folder'); }
    }
    function triggerUpload() { uploadInputRef.value?.click(); }

    async function uploadFiles(files: FileList | File[], destDir: string) {
      for (const file of Array.from(files)) {
        try {
          const buffer = await file.arrayBuffer();
          const base64 = btoa(new Uint8Array(buffer).reduce((d, b) => d + String.fromCharCode(b), ''));
          await ipcRenderer.invoke('filesystem-upload', destDir, file.name, base64);
        } catch (err: any) { console.error(`[FileDrawer] upload failed for ${file.name}:`, err); }
      }
    }
    async function onUploadInput(event: Event) {
      const input = event.target as HTMLInputElement;
      if (!input.files?.length) return;
      await uploadFiles(input.files, rootPath.value);
      input.value = '';
      await loadRoot(); emit('tree-changed');
    }

    const dropTargetPath = ref('');
    function onScrollDragOver(event: DragEvent) {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.dataTransfer.dropEffect = 'copy';
      dropTargetPath.value = rootPath.value;
    }
    function onScrollDragLeave() { dropTargetPath.value = ''; }
    async function onScrollDrop(event: DragEvent) {
      dropTargetPath.value = '';
      if (!event.dataTransfer?.files.length) return;
      await uploadFiles(event.dataTransfer.files, rootPath.value);
      await loadRoot(); emit('tree-changed');
    }
    function onDragHover(dirPath: string) { dropTargetPath.value = dirPath; }
    async function onDropFiles(payload: { dirPath: string; files: FileList }) {
      dropTargetPath.value = '';
      await uploadFiles(payload.files, payload.dirPath);
      await refreshDir(payload.dirPath);
      if (!expandedDirs.value.has(payload.dirPath)) expandedDirs.value = new Set([...expandedDirs.value, payload.dirPath]);
      emit('tree-changed');
    }

    watch(() => props.highlightPath, async (newPath: string) => {
      if (!newPath) return;
      const segments = newPath.split('/').filter((s: string) => s);
      let currentPath = '';
      for (const segment of segments) {
        currentPath += '/' + segment;
        if (currentPath === newPath) break;
        if (!expandedDirs.value.has(currentPath)) {
          expandedDirs.value = new Set([...expandedDirs.value, currentPath]);
          if (!childrenMap.value[currentPath]) await loadChildren(currentPath);
        }
      }
      selectedPaths.value = new Set([newPath]);
      lastSelectedPath.value = newPath;
    }, { immediate: true });

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    async function heartbeat() {
      if (!rootPath.value) return;
      try {
        const freshRoot = await ipcRenderer.invoke('filesystem-read-dir', rootPath.value);
        const oldNames  = entries.value.map(e => `${e.name}:${e.isDir}`).join(',');
        const newNames  = freshRoot.map((e: FileEntry) => `${e.name}:${e.isDir}`).join(',');
        if (oldNames !== newNames) entries.value = freshRoot;
        for (const dirPath of expandedDirs.value) {
          const freshChildren = await ipcRenderer.invoke('filesystem-read-dir', dirPath);
          const oldChildNames = (childrenMap.value[dirPath] || []).map((e: FileEntry) => `${e.name}:${e.isDir}`).join(',');
          const newChildNames = freshChildren.map((e: FileEntry) => `${e.name}:${e.isDir}`).join(',');
          if (oldChildNames !== newChildNames) childrenMap.value = { ...childrenMap.value, [dirPath]: freshChildren };
        }
      } catch { /* ignore */ }
    }

    onMounted(() => { loadRoot(); heartbeatTimer = setInterval(heartbeat, 3000); });
    onBeforeUnmount(() => { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } });

    return {
      entries, expandedDirs, childrenMap, loadingDirs, loading,
      selectedPaths, rootPath, parentPath, canGoUp, goUp, toggleDir, selectFile,
      contextMenuRef, inlinePromptRef, fileClipboard,
      onContextMenu, onContextAction,
      uploadInputRef, newFileAtRoot, newFolderAtRoot, triggerUpload, onUploadInput,
      dropTargetPath, onScrollDragOver, onScrollDragLeave, onScrollDrop, onDragHover, onDropFiles,
    };
  },
});
</script>

<style scoped>
.file-drawer {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--surface-1);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: var(--fs-code);
  user-select: none;
  overflow: hidden;
  border-right: 1px solid var(--border-muted);
}

.fd-header {
  display: flex;
  align-items: center;
  padding: 0 8px 0 12px;
  height: 35px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-muted);
  background: var(--surface-1);
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}

.fd-title { flex: 1; }

.fd-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.fd-btn {
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px;
  border: none; background: none;
  border-radius: 4px; cursor: pointer;
  color: var(--text-muted);
  transition: color 0.15s, background 0.15s;
}
.fd-btn:hover { background: var(--surface-3); color: var(--text); }

.fd-loading {
  padding: 16px 12px;
  color: var(--text-muted);
  font-size: var(--fs-body-sm);
}

.fd-parent-row {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-bottom: 1px solid var(--border-muted);
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s ease, color 0.15s ease;
}

.fd-parent-row:hover {
  background: var(--surface-2);
  color: var(--text);
}

.fd-parent-dots {
  padding-left: 8px;
}

.fd-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 2px 0;
}
.fd-scroll::-webkit-scrollbar { width: 4px; }
.fd-scroll::-webkit-scrollbar-track { background: transparent; }
.fd-scroll::-webkit-scrollbar-thumb { background: var(--border-muted); border-radius: 2px; }

.fd-scroll.drop-active {
  background: var(--accent-dim);
  outline: 2px dashed var(--accent-border);
  outline-offset: -2px;
}
</style>
