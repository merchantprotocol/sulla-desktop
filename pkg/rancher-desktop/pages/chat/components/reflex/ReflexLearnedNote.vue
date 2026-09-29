<!-- "⚡ Learned: 'pull up the PM system' → Open Projects  [Undo]" — visible learning. -->
<template>
  <div :class="['reflex-learned', { undone: msg.undo?.state === 'done' }]">
    <span class="bolt" aria-hidden="true">⚡</span>
    <span class="text">
      {{ msg.undo?.state === 'done' ? 'Forgot' : 'Learned' }}:
      <q>{{ msg.utterance }}</q> → {{ msg.label }}<span v-if="msg.extraPhrasings" class="more"> · +{{ msg.extraPhrasings }} phrasing{{ msg.extraPhrasings === 1 ? '' : 's' }}</span>
    </span>
    <button
      v-if="!msg.undo || msg.undo.state === 'error'"
      class="undo"
      type="button"
      title="Forget this — Reflex won't use it"
      @click="controller.undoReflexLearned(msg.id)"
    >Undo</button>
    <span v-else-if="msg.undo.state === 'pending'" class="status">undoing…</span>
    <span v-if="msg.undo?.state === 'error'" class="error" role="alert">{{ msg.undo.error }}</span>
    <span class="ts">{{ timeLabel }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ReflexLearnedMessage } from '../../models/Message';
import { useChatController } from '../../controller/useChatController';

const props = defineProps<{ msg: ReflexLearnedMessage }>();
const controller = useChatController();
const timeLabel = computed(() => {
  const d = new Date(props.msg.createdAt);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
});
</script>

<style scoped>
.reflex-learned {
  padding: 6px 0 6px 22px;
  border-left: 1px dashed rgba(252, 211, 77, 0.35);
  position: relative;
  font-family: var(--mono); font-size: 11px;
  color: var(--steel-300);
  display: flex; align-items: center; gap: 10px;
}
.reflex-learned .bolt {
  position: absolute; left: -7px; top: 5px;
  font-size: 11px; color: var(--warn);
}
.reflex-learned .text { font-style: italic; }
.reflex-learned q { color: var(--read-2); }
.reflex-learned .more { color: var(--read-5); }
.reflex-learned.undone .text { text-decoration: line-through; color: var(--read-5); }
.reflex-learned .undo {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em;
  text-transform: uppercase; cursor: pointer;
  padding: 1px 8px; border-radius: 3px;
  background: transparent; color: var(--steel-400);
  border: 1px solid rgba(80, 150, 179, 0.3);
  transition: all 0.15s ease;
}
.reflex-learned .undo:hover { color: var(--read-1); border-color: var(--steel-400); }
.reflex-learned .status { color: var(--read-5); font-size: 10px; }
.reflex-learned .error { color: var(--warn); font-size: 10px; }
.reflex-learned .ts { margin-left: auto; color: var(--read-5); font-size: 10px; }
</style>
