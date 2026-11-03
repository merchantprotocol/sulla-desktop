<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <Transition name="veil">
    <div v-if="open" class="search-bar">
      <span class="ic">⌕</span>
      <input
        ref="input"
        v-model="query"
        type="text"
        placeholder="search this conversation…"
      >
      <span class="count">{{ resultsCount }} {{ resultsCount === 1 ? 'result' : 'results' }}</span>
      <button class="x" type="button" @click="controller.closeModal()">✕</button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useChatController } from '../../controller/useChatController';

const controller = useChatController();
const open = computed(() => controller.modals.value.which === 'search');
const query = ref('');
const input = ref<HTMLInputElement | null>(null);

watch(open, async (o) => {
  if (o) { await nextTick(); input.value?.focus(); query.value = ''; }
});

const resultsCount = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return 0;
  return controller.messages.value.filter(m => {
    const text = ('text' in m ? m.text : 'body' in m ? (m as any).body : '') as string;
    return (text || '').toLowerCase().includes(q);
  }).length;
});
</script>

<style scoped>
.search-bar {
  position: absolute; top: 78px; left: 50%;
  transform: translateX(-50%);
  z-index: 25; width: 480px; max-width: calc(100vw - 48px);
  padding: 10px 16px;
  background: var(--bg-elevated);
  border: 1px solid var(--accent-hover);
  border-radius: 100px;
  backdrop-filter: blur(14px);
  box-shadow: 0 14px 30px var(--bg-overlay), 0 0 24px var(--accent-dim);
  display: flex; align-items: center; gap: 12px;
}
.ic { color: var(--accent-hover); font-size: 14px; }
input {
  flex: 1; background: transparent; border: none; outline: none;
  font-family: var(--font-display); font-style: italic; font-size: 16px;
  color: var(--text-primary); caret-color: var(--accent-hover);
}
input::placeholder { color: var(--text-muted); }
.count {
  font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.1em;
  color: var(--text-muted);
}
.x { background: transparent; border: none; color: var(--text-muted); cursor: pointer; }

.veil-enter-active, .veil-leave-active { transition: opacity 0.18s ease; }
.veil-enter-from,   .veil-leave-to    { opacity: 0; }
</style>
