<template>
  <div class="file-tree-node">
    <div
      class="file-tree-row"
      :class="{
        'is-dir': entry.isDir,
        'is-selected': selectedPaths.has(entry.path),
        'is-highlighted': highlightPath === entry.path,
        'drop-target': entry.isDir && dropTargetPath === entry.path,
      }"
      :style="{ paddingLeft: (depth * 16 + 8) + 'px' }"
      @click="handleClick($event)"
      @contextmenu.prevent="handleContextMenu"
      @dragover.prevent.stop="handleDragOver"
      @dragleave.stop="handleDragLeave"
      @drop.prevent.stop="handleDrop"
    >
      <!-- Chevron for directories -->
      <span v-if="entry.isDir" class="chevron" :class="{ expanded: isExpanded }">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M6 4l4 4-4 4" />
        </svg>
      </span>
      <span v-else class="chevron-spacer"></span>

      <!-- File/folder icon -->
      <span class="node-icon">
        <!-- Folder open -->
        <svg v-if="entry.isDir && isExpanded" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon-folder">
          <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2V7" />
          <path d="M8 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
          <path d="M21 15H9.5a2 2 0 0 0-1.9 1.4L6 21h11.5a2 2 0 0 0 1.9-1.4L21 15Z" />
        </svg>
        <!-- Folder closed -->
        <svg v-else-if="entry.isDir" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon-folder">
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
        </svg>
        <!-- File -->
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon-file">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="currentColor" opacity="0.08" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </span>

      <!-- Label -->
      <span class="node-label" :title="entry.path">{{ entry.name }}</span>
    </div>

    <!-- Children (if expanded directory) -->
    <div v-if="entry.isDir && isExpanded">
      <div v-if="isLoading" class="file-tree-row" :style="{ paddingLeft: ((depth + 1) * 16 + 8) + 'px' }">
        <span class="loading-text">Loading…</span>
      </div>
      <FileTreeNode
        v-for="child in children"
        :key="child.path"
        :entry="child"
        :depth="depth + 1"
        :expanded-dirs="expandedDirs"
        :children-map="childrenMap"
        :loading-dirs="loadingDirs"
        :selected-paths="selectedPaths"
        :drop-target-path="dropTargetPath"
        :highlight-path="highlightPath"
        @toggle-dir="$emit('toggle-dir', $event)"
        @select-file="$emit('select-file', $event)"
        @context-menu="$emit('context-menu', $event)"
        @drop-files="$emit('drop-files', $event)"
        @drag-hover="$emit('drag-hover', $event)"
      />
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, type PropType } from 'vue';

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  ext: string;
}


export default defineComponent({
  name: 'FileTreeNode',

  props: {
    entry:        { type: Object as PropType<FileEntry>, required: true },
    depth:        { type: Number, required: true },
    expandedDirs: { type: Object as PropType<Set<string>>, required: true },
    childrenMap:  { type: Object as PropType<Record<string, FileEntry[]>>, required: true },
    loadingDirs:  { type: Object as PropType<Set<string>>, required: true },
    selectedPaths:  { type: Object as PropType<Set<string>>, default: () => new Set() },
    dropTargetPath: { type: String, default: '' },
    highlightPath:  { type: String, default: '' },
  },

  emits: ['toggle-dir', 'select-file', 'context-menu', 'drop-files', 'drag-hover'],

  setup(props, { emit }) {
    const isExpanded = computed(() => props.expandedDirs.has(props.entry.path));
    const isLoading = computed(() => props.loadingDirs.has(props.entry.path));
    const children = computed(() => props.childrenMap[props.entry.path] || []);

    function handleClick(event: MouseEvent) {
      if (props.entry.isDir) {
        emit('toggle-dir', props.entry.path);
      }
      emit('select-file', { entry: props.entry, shiftKey: event.shiftKey, metaKey: event.metaKey || event.ctrlKey });
    }

    function handleContextMenu(event: MouseEvent) {
      emit('context-menu', { event, entry: props.entry });
    }

    function handleDragOver(event: DragEvent) {
      if (!props.entry.isDir) return;
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.dataTransfer.dropEffect = 'copy';
      emit('drag-hover', props.entry.path);
    }

    function handleDragLeave() {
      if (!props.entry.isDir) return;
      emit('drag-hover', '');
    }

    function handleDrop(event: DragEvent) {
      if (!props.entry.isDir) return;
      if (!event.dataTransfer?.files.length) return;
      emit('drop-files', { dirPath: props.entry.path, files: event.dataTransfer.files });
    }

    return { isExpanded, isLoading, children, handleClick, handleContextMenu, handleDragOver, handleDragLeave, handleDrop };
  },
});
</script>

<style scoped>
.file-tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding-right: 8px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-tree-row:hover {
  background: var(--bg-hover);
}

.file-tree-row.is-selected {
  background: var(--bg-surface,rgba(0, 120, 212, 0.1));
}

:global(.dark) .file-tree-row.is-selected {
  background: var(--bg-surface,rgba(0, 120, 212, 0.3));
}

.file-tree-row.is-highlighted {
  background: var(--bg-surface, rgba(0, 120, 212, 0.1));
  border-left: 3px solid var(--accent-primary, rgba(0, 120, 212, 0.4));
}

:global(.dark) .file-tree-row.is-highlighted {
  background: var(--bg-surface, rgba(0, 120, 212, 0.2));
  border-left-color: var(--accent-primary, rgba(0, 120, 212, 0.5));
}

.chevron {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  transition: transform 0.1s ease;
  transform: rotate(0deg);
  color: var(--text-muted);
}

.chevron.expanded {
  transform: rotate(90deg);
}

.chevron-spacer {
  display: inline-block;
  width: 16px;
  flex-shrink: 0;
}

.node-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  color: var(--text-secondary);
}

.icon-folder {
  color: inherit;
}

.icon-file {
  color: var(--text-muted);
}

.node-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-code);
  line-height: 22px;
}

.loading-text {
  color: var(--text-muted);
  font-size: var(--fs-body-sm);
  font-style: italic;
}

.file-tree-row.drop-target {
  background: var(--bg-surface);
}

:global(.dark) .file-tree-row.drop-target {
  background: var(--bg-surface);
}
</style>
