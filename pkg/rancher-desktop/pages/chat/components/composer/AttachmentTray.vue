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
</style>
