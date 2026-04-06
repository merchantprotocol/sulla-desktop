<template>
  <div
    v-if="visible"
    class="ctx-menu"
    :style="{ left: x + 'px', top: y + 'px' }"
    @click="$emit('close')"
  >
    <div class="ctx-menu-header">{{ title }}</div>
    <button
      v-for="item in items"
      :key="item.id"
      class="ctx-menu-item"
      :class="{ active: item.active }"
      @click="item.action()"
    >
      <img v-if="item.thumbnail" :src="item.thumbnail" class="ctx-menu-thumb" />
      {{ item.label }}
    </button>
  </div>
  <div v-if="visible" class="ctx-menu-backdrop" @click="$emit('close')"></div>
</template>

<script setup lang="ts">
interface CtxMenuItem {
  id: string;
  label: string;
  thumbnail?: string;
  active?: boolean;
  action: () => void;
}

defineProps<{
  visible: boolean;
  x: number;
  y: number;
  title: string;
  items: CtxMenuItem[];
}>();

defineEmits<{
  (e: 'close'): void;
}>();
</script>
