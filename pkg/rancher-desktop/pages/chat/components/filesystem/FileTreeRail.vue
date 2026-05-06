<template>
  <aside
    v-if="open"
    class="file-tree-rail"
  >
    <FileTreeSidebar
      :is-dark="isDark"
      @file-selected="$emit('file-selected', $event)"
      @tree-changed="$emit('tree-changed')"
      @close="$emit('close')"
    />
  </aside>
</template>

<script setup lang="ts">
import FileTreeSidebar from '@pkg/pages/filesystem/FileTreeSidebar.vue';
import { useTheme } from '@pkg/composables/useTheme';

defineProps<{
  open: boolean;
}>();

defineEmits<{
  (e: 'file-selected', entry: unknown): void;
  (e: 'tree-changed'): void;
  (e: 'close'): void;
}>();

const { isDark } = useTheme();
</script>

<style scoped>
.file-tree-rail {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 260px;
  z-index: 6;
  border-right: 1px solid var(--border);
  overflow: hidden;
}
</style>
