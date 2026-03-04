<template>
  <div class="file-tree-node">
    <div
      class="file-tree-row"
      :class="{
        'is-dir': entry.isDir,
        'is-selected': selectedPath === entry.path,
      }"
      :style="{ paddingLeft: (depth * 16 + 8) + 'px' }"
      @click="handleClick"
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
        <svg v-if="entry.isDir && isExpanded" width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M1.5 3C1.5 2.44772 1.94772 2 2.5 2H5.79289C6.0581 2 6.31246 2.10536 6.5 2.29289L7.70711 3.5H13.5C14.0523 3.5 14.5 3.94772 14.5 4.5V12C14.5 12.5523 14.0523 13 13.5 13H2.5C1.94772 13 1.5 12.5523 1.5 12V3Z" fill="#C09553" stroke="#C09553" stroke-width="0.5"/>
        </svg>
        <svg v-else-if="entry.isDir" width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M1.5 3C1.5 2.44772 1.94772 2 2.5 2H5.79289C6.0581 2 6.31246 2.10536 6.5 2.29289L7.70711 3.5H13.5C14.0523 3.5 14.5 3.94772 14.5 4.5V12C14.5 12.5523 14.0523 13 13.5 13H2.5C1.94772 13 1.5 12.5523 1.5 12V3Z" fill="#C09553" stroke="#C09553" stroke-width="0.5"/>
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M3.5 1C2.94772 1 2.5 1.44772 2.5 2V14C2.5 14.5523 2.94772 15 3.5 15H12.5C13.0523 15 13.5 14.5523 13.5 14V5L9.5 1H3.5Z" :fill="fileIconColor" stroke-width="0.5" :stroke="fileIconColor"/>
          <path d="M9.5 1V5H13.5" :stroke="fileIconColor" stroke-width="0.8" fill="none"/>
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
        :selected-path="selectedPath"
        @toggle-dir="$emit('toggle-dir', $event)"
        @select-file="$emit('select-file', $event)"
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

const EXT_COLORS: Record<string, string> = {
  '.ts':       '#3178c6',
  '.tsx':      '#3178c6',
  '.js':       '#f0db4f',
  '.jsx':      '#f0db4f',
  '.vue':      '#41b883',
  '.json':     '#f0db4f',
  '.md':       '#519aba',
  '.markdown': '#519aba',
  '.py':       '#3572A5',
  '.yaml':     '#cb171e',
  '.yml':      '#cb171e',
  '.toml':     '#9c4121',
  '.sh':       '#89e051',
  '.bash':     '#89e051',
  '.css':      '#563d7c',
  '.scss':     '#c6538c',
  '.html':     '#e34c26',
  '.xml':      '#f34b7d',
  '.svg':      '#ff9900',
  '.txt':      '#999',
  '.log':      '#999',
  '.gitignore':'#f54d27',
};

export default defineComponent({
  name: 'FileTreeNode',

  props: {
    entry:        { type: Object as PropType<FileEntry>, required: true },
    depth:        { type: Number, required: true },
    expandedDirs: { type: Object as PropType<Set<string>>, required: true },
    childrenMap:  { type: Object as PropType<Record<string, FileEntry[]>>, required: true },
    loadingDirs:  { type: Object as PropType<Set<string>>, required: true },
    selectedPath: { type: String, default: '' },
  },

  emits: ['toggle-dir', 'select-file'],

  setup(props, { emit }) {
    const isExpanded = computed(() => props.expandedDirs.has(props.entry.path));
    const isLoading = computed(() => props.loadingDirs.has(props.entry.path));
    const children = computed(() => props.childrenMap[props.entry.path] || []);

    const fileIconColor = computed(() => {
      if (props.entry.isDir) return '#C09553';
      return EXT_COLORS[props.entry.ext] || '#999';
    });

    function handleClick() {
      if (props.entry.isDir) {
        emit('toggle-dir', props.entry.path);
      } else {
        emit('select-file', props.entry);
      }
    }

    return { isExpanded, isLoading, children, fileIconColor, handleClick };
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
  background: rgba(0, 0, 0, 0.04);
}

:global(.dark) .file-tree-row:hover {
  background: rgba(255, 255, 255, 0.06);
}

.file-tree-row.is-selected {
  background: rgba(0, 120, 212, 0.1);
}

:global(.dark) .file-tree-row.is-selected {
  background: rgba(0, 120, 212, 0.3);
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
  color: #888;
}

.chevron.expanded {
  transform: rotate(90deg);
}

:global(.dark) .chevron {
  color: #aaa;
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
}

.node-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 22px;
}

.loading-text {
  color: #999;
  font-size: 12px;
  font-style: italic;
}
</style>
