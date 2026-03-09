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
