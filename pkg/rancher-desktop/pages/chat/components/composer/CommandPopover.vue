<!-- Slash / mention autocomplete above the composer. Driven by popover state. -->
<template>
  <div v-if="popover.open" class="popover">
    <div class="phead">{{ popover.mode === 'slash' ? 'Commands' : 'Context' }}</div>
    <div
      v-for="(item, idx) in popover.items.slice(0, 8)"
      :key="idx"
      :class="['pitem', { selected: idx === popover.selected }]"
      @click="$emit('choose', idx)"
    >
      <span class="cmd">{{ 'name' in item ? item.name : item.token }}</span>
      <span class="desc">{{ item.label }}</span>
      <span class="hint">{{ 'hint' in item ? (item.hint ?? '') : '' }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useChatController } from '../../controller/useChatController';

defineEmits<{ (e: 'choose', idx: number): void }>();
const controller = useChatController();
const popover = computed(() => controller.popover.value);
</script>

<style scoped>
.popover {
  position: absolute;
  bottom: 100%; left: 0;
  margin-bottom: 12px;
  z-index: 30;
  background: rgba(20, 30, 42, 0.92);
  border: 1px solid rgba(80, 150, 179, 0.3);
  border-radius: 10px;
  backdrop-filter: blur(14px);
  box-shadow: 0 20px 50px rgba(0,0,0,0.5);
  min-width: 320px;
  overflow: hidden;
}
.phead {
  padding: 8px 14px;
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.25em;
  text-transform: uppercase; color: var(--steel-400);
  border-bottom: 1px solid rgba(80, 150, 179, 0.15);
}
.pitem {
  padding: 8px 14px;
  display: flex; align-items: baseline; gap: 12px;
  cursor: pointer; transition: background 0.1s ease;
}
.pitem:hover,
.pitem.selected { background: rgba(80, 150, 179, 0.14); }
.pitem .cmd {
  font-family: var(--mono); font-size: 12px;
  color: var(--steel-300); font-weight: 600;
  min-width: 92px;
}
.pitem .desc {
  font-family: var(--serif); font-style: italic;
  font-size: 13px; color: var(--read-3); flex: 1;
}
.pitem.selected .cmd  { color: white; }
.pitem.selected .desc { color: var(--read-1); }
.pitem .hint {
  font-family: var(--mono); font-size: 9.5px; color: var(--read-5);
  letter-spacing: 0.1em;
}
</style>
