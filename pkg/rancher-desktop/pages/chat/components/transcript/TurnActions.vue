<!--
  Hover actions that appear below a turn: Copy, Edit, Regenerate, Pin, Quote, Fork.
  Parent decides which to show via flags.
-->
<template>
  <div class="turn-actions">
    <button v-if="show.edit"       type="button" @click="$emit('edit')">Edit</button>
    <button v-if="show.copy"       type="button" @click="$emit('copy')">Copy</button>
    <button v-if="show.regenerate" type="button" @click="$emit('regenerate')">Regenerate</button>
    <button v-if="show.quote"      type="button" @click="$emit('quote')">Quote</button>
    <button v-if="show.pin"        type="button" @click="$emit('pin')">{{ pinned ? 'Unpin' : 'Pin' }}</button>
    <button v-if="show.fork"       type="button" @click="$emit('fork')">Fork</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  role:      'you' | 'sulla';
  pinned?:   boolean;
  // Explicit toggles; default shows sensible defaults for each role.
  actions?:  { edit?: boolean; copy?: boolean; regenerate?: boolean; quote?: boolean; pin?: boolean; fork?: boolean };
}>();

defineEmits<{
  (e: 'edit'): void; (e: 'copy'): void; (e: 'regenerate'): void;
  (e: 'quote'): void; (e: 'pin'): void; (e: 'fork'): void;
}>();

const show = computed(() => {
  if (props.actions) return { edit: false, copy: false, regenerate: false, quote: false, pin: false, fork: false, ...props.actions };
  return props.role === 'you'
    ? { edit: true, copy: true, regenerate: false, quote: false, pin: false, fork: false }
    : { edit: false, copy: true, regenerate: true, quote: true, pin: true, fork: true };
});
</script>

<style scoped>
.turn-actions {
  position: absolute; bottom: -28px;
  display: flex; gap: 3px;
  opacity: 0; transition: opacity 0.2s ease;
  font-family: var(--mono); font-size: 10px;
  letter-spacing: 0.14em; text-transform: uppercase;
}
:deep(.chat-turn.you)   .turn-actions { right: 0; }
:deep(.chat-turn.sulla) .turn-actions { left: 0; }
:deep(.chat-turn:hover) .turn-actions { opacity: 1; }
.turn-actions button {
  padding: 4px 9px; border-radius: 6px;
  background: rgba(20, 30, 42, 0.55);
  border: 1px solid rgba(168, 192, 220, 0.15);
  color: var(--read-3); cursor: pointer;
  backdrop-filter: blur(8px);
  font: inherit;
  transition: all 0.15s ease;
}
.turn-actions button:hover {
  background: rgba(80, 150, 179, 0.14);
  color: var(--steel-100);
  border-color: rgba(80, 150, 179, 0.35);
}
</style>
