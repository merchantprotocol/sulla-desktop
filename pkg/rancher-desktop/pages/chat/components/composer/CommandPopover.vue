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
:global(.theme-noir) .popover {
  bottom: calc(100% - 4px); left: 0; min-width: 340px; margin: 0; padding: 6px;
  border: 1px solid var(--nx-hair-strong); border-radius: 18px;
  background: rgba(12, 18, 28, 0.98); box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6);
  transform-origin: bottom left; animation: noir-pop-in 0.5s linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013) both;
}
:global(.theme-noir-light) .popover { background: color-mix(in srgb, var(--nx-surface) 98%, transparent); box-shadow: var(--nx-shadow-lg); }
:global(.theme-noir) .phead {
  padding: 6px 10px; border: 0; color: var(--nx-accent-2); font-size: 10px; letter-spacing: 0.14em;
}
:global(.theme-noir) .pitem { gap: 10px; margin: 0; padding: 8px 10px; border-radius: 12px; }
:global(.theme-noir) .pitem:hover,
:global(.theme-noir) .pitem.selected { color: var(--nx-read-1); background: color-mix(in srgb, var(--nx-accent) 14%, transparent); }
:global(.theme-noir) .pitem .cmd { min-width: 84px; color: var(--nx-read-1); font-weight: 500; }
:global(.theme-noir) .pitem .desc { color: var(--nx-read-2); font-family: var(--font-body); font-size: 13px; font-style: normal; }
:global(.theme-noir) .pitem .hint { color: var(--nx-read-5); }
@keyframes noir-pop-in { from { opacity: 0; transform: translateY(8px) scale(0.97); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { :global(.theme-noir) .popover { animation: none; } }
</style>
