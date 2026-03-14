<template>
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
        v-if="!node.isDir && node.ext"
        class="tft-ext"
      >{{ node.ext }}</span>
      <span
        class="tft-label"
        :class="{ dir: node.isDir }"
        @click="node.isDir ? $emit('toggle-dir', node.path) : $emit('toggle-file', node.path)"
      >{{ node.name }}</span>
      <span
        v-if="!node.isDir && node.size > 0"
        class="tft-size"
      >{{ fmtSize(node.size) }}</span>
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
</template>

<script lang="ts">
import { defineComponent } from 'vue';

interface TreeEntry {
  path: string;
  name: string;
  isDir: boolean;
  hasChildren: boolean;
  size: number;
  ext: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default defineComponent({
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
  computed: {
    isSelected(): boolean {
      if (this.node.isDir) return this.selectedFolders.includes(this.node.path);
      return this.selectedFiles.includes(this.node.path);
    },
  },
  methods: {
    fmtSize(bytes: number): string {
      return formatFileSize(bytes);
    },
  },
});
</script>

<style>
.tft-node {
  user-select: none;
}
.tft-row {
  display: flex;
  align-items: center;
  padding: 3px 8px;
  cursor: default;
  font-size: 12px;
  line-height: 1.4;
  color: #334155;
  transition: background 0.1s;
  gap: 2px;
}
.tft-row.dark {
  color: #cbd5e1;
}
.tft-row:hover {
  background: #f1f5f9;
}
.tft-row.dark:hover {
  background: var(--bg-surface, #1e293b);
}
.tft-row.selected {
  background: #eff6ff;
}
.tft-row.selected.dark {
  background: #1e3a5f;
}

/* Caret arrow for folders */
.tft-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  cursor: pointer;
  color: #94a3b8;
  transition: transform 0.15s;
}
.tft-arrow::before {
  content: '';
  display: block;
  width: 0;
  height: 0;
  border-left: 5px solid currentColor;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transition: transform 0.15s;
}
.tft-arrow.open::before {
  transform: rotate(90deg);
}
.tft-arrow.empty {
  visibility: hidden;
}
.tft-arrow:hover {
  color: #475569;
}
.dark .tft-arrow:hover {
  color: #e2e8f0;
}
.tft-arrow-spacer {
  display: inline-block;
  width: 16px;
  flex-shrink: 0;
}

/* Checkbox */
.tft-checkbox {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  margin: 0 6px 0 0;
  cursor: pointer;
  accent-color: #0284c7;
}

/* File extension badge */
.tft-ext {
  display: inline-block;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 0 4px;
  border-radius: 3px;
  background: #f1f5f9;
  color: #64748b;
  flex-shrink: 0;
  margin-right: 4px;
}
.dark .tft-ext {
  background: var(--border-default, #334155);
  color: #94a3b8;
}

/* Label */
.tft-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.tft-label.dir {
  font-weight: 600;
}
.tft-label:hover {
  color: #0284c7;
}
.dark .tft-label:hover {
  color: #38bdf8;
}

/* File size */
.tft-size {
  font-size: 10px;
  color: #94a3b8;
  flex-shrink: 0;
  margin-left: 6px;
}

/* Loading spinner */
.tft-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid #0284c7;
  border-top-color: transparent;
  border-radius: 50%;
  animation: tft-spin 0.6s linear infinite;
  flex-shrink: 0;
  margin-left: 4px;
}
@keyframes tft-spin {
  to { transform: rotate(360deg); }
}

.tft-children {
  /* children are indented via paddingLeft on tft-row */
}
</style>
