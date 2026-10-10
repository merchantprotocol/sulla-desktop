<!-- Staged attachments above the composer. Remove via ✕. -->
<template>
  <div :class="['attach-tray', { 'has-items': staged.length > 0 }]">
    <span v-for="a in staged" :key="a.id" class="att-chip">
      <span class="ic">{{ iconFor(a.kind) }}</span>
      <span class="name">{{ a.name }}</span>
      <span class="size">{{ a.size }}</span>
      <button
        class="rm"
        type="button"
        :aria-label="'Remove ' + a.name"
        @click="controller.unstageAttachment(a.id)"
      >✕</button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { useChatController } from '../../controller/useChatController';

const controller = useChatController();
const staged = computed(() => controller.staged.value);

function iconFor(kind: string): string {
  return ({ image: '▣', json: '◆', ts: '‹›', md: '¶', log: '≡' } as Record<string, string>)[kind] || '◇';
}
</script>

<style scoped>
.attach-tray { display: none; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.attach-tray.has-items { display: flex; }
.att-chip {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 6px 6px 6px 12px; border-radius: 100px;
  background: rgba(168, 192, 220, 0.08);
  border: 1px solid rgba(168, 192, 220, 0.22);
  font-family: var(--mono); font-size: 11px; color: var(--read-2);
}
.att-chip .ic   { color: var(--steel-400); font-size: 12px; }
.att-chip .name { font-weight: 600; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.att-chip .size { color: var(--read-4); font-size: 10.5px; }
.att-chip .rm {
  width: 22px; height: 22px; border-radius: 50%;
  background: transparent; border: none; color: var(--read-4); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; padding: 0; transition: all 0.15s ease;
}
.att-chip .rm:hover { background: rgba(252,165,165,0.12); color: var(--err); }
.theme-noir .attach-tray { gap: 6px; padding-top: 10px; margin: 0; }
.theme-noir .att-chip {
  height: 36px; gap: 8px; padding: 0 8px 0 6px; border: 0; border-radius: 12px;
  color: var(--nx-read-1); background: color-mix(in srgb, var(--nx-hair-strong) 37.5%, transparent);
  box-shadow: inset 0 0 0 1px var(--nx-hair);
  font-family: var(--font-body); font-size: 12px;
  animation: noir-file-in 0.5s linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013, 1) both;
}
.theme-noir .att-chip:nth-child(2) { animation-delay: 0.07s; }
.theme-noir .att-chip .ic {
  display: grid; place-items: center; width: 24px; height: 24px; border-radius: 7px;
  color: var(--bg-surface-alt); background: linear-gradient(135deg, var(--steel-200), var(--nx-accent));
  font: 800 8.5px var(--mono);
}
.theme-noir .att-chip .name { font-weight: 500; }
.theme-noir .att-chip .size { color: var(--nx-read-4); font-family: var(--mono); }
@keyframes noir-file-in { from { opacity: 0; transform: scale(0.85); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .theme-noir .att-chip { animation: none; } }
</style>
