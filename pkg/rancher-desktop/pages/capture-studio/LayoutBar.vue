<template>
  <div class="layout-bar">
    <button
      v-for="layout in layouts"
      :key="layout.id"
      class="layout-btn"
      :class="{ active: currentLayout === layout.id }"
      @click="$emit('select-layout', layout.id)"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="layout.icon"></svg>
      <span class="tip">{{ layout.tip }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
interface Layout {
  id: string;
  tip: string;
  icon: string;
}

defineProps<{
  currentLayout: string;
  layouts: Layout[];
}>();

defineEmits<{
  (e: 'select-layout', id: string): void;
}>();
</script>
