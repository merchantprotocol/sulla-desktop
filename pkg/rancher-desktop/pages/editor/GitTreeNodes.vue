<template>
  <template
    v-for="node in nodes"
    :key="section + '-' + node.path"
  >
    <!-- Directory node -->
    <div v-if="node.isDir">
      <button
        class="git-tree-dir"
        :class="{ dark: isDark }"
        :style="{ paddingLeft: (32 + depth * 16) + 'px' }"
        @click="toggle(node.path)"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="currentColor"
          :class="{ rotated: isOpen(node.path) }"
        >
          <path d="M3 1l4 4-4 4z" />
        </svg>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="git-tree-folder-icon"
        >
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span class="git-tree-dir-name">{{ node.name }}</span>
      </button>
      <div v-show="isOpen(node.path)">
        <git-tree-nodes
          :nodes="node.children"
          :repo="repo"
          :section="section"
          :badge-type="badgeType"
          :action-type="actionType"
          :depth="depth + 1"
          :is-dark="isDark"
          @open-file="$emit('open-file', $event)"
          @stage="$emit('stage', $event)"
          @unstage="$emit('unstage', $event)"
          @contextmenu="(ev: MouseEvent, file: string) => $emit('contextmenu', ev, file)"
        />
      </div>
    </div>
    <!-- File node -->
    <div
      v-else
      class="git-file-row"
      :class="{ dark: isDark }"
      :style="{ paddingLeft: (32 + depth * 16) + 'px' }"
      @click="$emit('open-file', node.entry?.file || node.path)"
      @contextmenu.prevent="$emit('contextmenu', $event, node.entry?.file || node.path)"
    >
      <span
        class="git-status-badge"
        :class="fileBadgeClass(node.entry)"
      >{{ fileBadgeText(node.entry) }}</span>
      <span class="git-file-name">{{ node.name }}</span>
      <button
        class="git-file-action"
        :class="{ dark: isDark }"
        :title="actionType === 'unstage' ? 'Unstage' : 'Stage'"
        @click.stop="$emit(actionType, node.entry?.file || node.path)"
      >
        <svg
          v-if="actionType === 'unstage'"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
        >
          <line
            x1="5"
            y1="12"
            x2="19"
            y2="12"
          />
        </svg>
        <svg
          v-else
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
        >
          <line
            x1="12"
            y1="5"
            x2="12"
            y2="19"
          />
          <line
            x1="5"
            y1="12"
            x2="19"
            y2="12"
          />
        </svg>
      </button>
    </div>
  </template>
</template>

<script lang="ts">
import { defineComponent, reactive, type PropType } from 'vue';

interface GitStatusEntry {
  index:    string;
  worktree: string;
  file:     string;
}

interface TreeNode {
  name:     string;
  path:     string;
  isDir:    boolean;
  children: TreeNode[];
  entry?:   GitStatusEntry;
}

// Shared state for expanded dirs across all instances
const expandedDirs = reactive<Record<string, boolean>>({});

export default defineComponent({
  name: 'GitTreeNodes',

  props: {
    nodes:      { type: Array as PropType<TreeNode[]>, required: true },
    repo:       { type: Object as PropType<{ root: string }>, required: true },
    section:    { type: String, required: true },
    badgeType:  { type: String, required: true }, // 'staged' | 'worktree' | 'untracked'
    actionType: { type: String, required: true }, // 'stage' | 'unstage'
    depth:      { type: Number, default: 0 },
    isDark:     { type: Boolean, default: false },
  },

  emits: ['open-file', 'stage', 'unstage', 'contextmenu'],

  setup(props) {
    function dirKey(dirPath: string): string {
      return `${ props.repo.root }::${ props.section }::${ dirPath }`;
    }

    function isOpen(dirPath: string): boolean {
      return expandedDirs[dirKey(dirPath)] ?? true;
    }

    function toggle(dirPath: string) {
      const key = dirKey(dirPath);
      expandedDirs[key] = !(expandedDirs[key] ?? true);
    }

    function fileBadgeClass(entry?: GitStatusEntry): string {
      if (!entry) return 'added';
      if (props.badgeType === 'staged') return 'staged';
      if (props.badgeType === 'untracked') return 'added';
      switch (entry.worktree) {
      case 'M': return 'modified';
      case 'D': return 'deleted';
      case 'A': return 'added';
      case 'R': return 'renamed';
      default: return 'modified';
      }
    }

    function fileBadgeText(entry?: GitStatusEntry): string {
      if (!entry) return 'A';
      if (props.badgeType === 'staged') return entry.index;
      if (props.badgeType === 'untracked') return 'A';
      return entry.worktree;
    }

    return { isOpen, toggle, fileBadgeClass, fileBadgeText };
  },
});
</script>

<style scoped>
.git-tree-dir {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 2px 10px 2px 32px;
  border: none;
  background: transparent;
  font-size: var(--fs-code);
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
}

.git-tree-dir:hover {
  background: var(--bg-hover);
}

.git-tree-dir svg {
  flex-shrink: 0;
  transition: transform 0.15s;
}

.git-tree-dir svg.rotated {
  transform: rotate(90deg);
}

.git-tree-folder-icon {
  color: var(--text-muted);
}

.git-tree-dir-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Re-declare file row styles since scoped CSS doesn't inherit from parent */
.git-file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 32px;
  font-size: var(--fs-code);
  cursor: pointer;
  color: var(--text-primary);
}

.git-file-row:hover {
  background: var(--bg-hover);
}

.git-status-badge {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-caption);
  font-weight: var(--weight-bold);
  font-family: var(--font-mono);
  border-radius: 3px;
}

.git-status-badge.staged   { color: var(--text-success); background: var(--bg-success); }
.git-status-badge.modified { color: var(--text-warning); background: var(--bg-warning); }
.git-status-badge.deleted  { color: var(--text-error); background: var(--bg-error); }
.git-status-badge.added    { color: var(--text-success); background: var(--bg-success); }
.git-status-badge.renamed  { color: var(--text-info); background: var(--bg-info); }
.git-status-badge.untracked { color: var(--text-secondary); background: var(--bg-hover); }

.git-file-name {
  flex-shrink: 0;
  white-space: nowrap;
}

.git-file-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.1s;
  margin-left: auto;
}

.git-file-row:hover .git-file-action {
  opacity: 1;
}

.git-file-action:hover {
  background: var(--bg-hover);
}

.git-file-action.dark {
  color: var(--text-muted);
}
</style>
