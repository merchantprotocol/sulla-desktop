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
  background: rgba(20, 30, 42, 0.92);
  border: 1px solid var(--steel-400);
  border-radius: 100px;
  backdrop-filter: blur(14px);
  box-shadow: 0 14px 30px rgba(0,0,0,0.4), 0 0 24px rgba(106, 176, 204, 0.2);
  display: flex; align-items: center; gap: 12px;
}
.ic { color: var(--steel-400); font-size: 14px; }
input {
  flex: 1; background: transparent; border: none; outline: none;
  font-family: var(--serif); font-style: italic; font-size: 16px;
  color: var(--read-1); caret-color: var(--steel-400);
}
input::placeholder { color: var(--read-4); }
.count {
  font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em;
  color: var(--read-4);
}
.x { background: transparent; border: none; color: var(--read-4); cursor: pointer; }

.veil-enter-active, .veil-leave-active { transition: opacity 0.18s ease; }
.veil-enter-from,   .veil-leave-to    { opacity: 0; }
</style>
