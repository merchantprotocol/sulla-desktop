<template>
  <div class="w-error">
    <div class="head">Sulla · encountered an error</div>
    <p>{{ msg.text }}</p>
    <div v-if="msg.detail" class="detail">{{ msg.detail }}</div>
    <button
      v-if="msg.action"
      type="button"
      class="action"
      @click="$emit('action', msg.action.kind)"
    >
      {{ msg.action.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
import type { ErrorMessage } from '../../models/Message';
defineProps<{ msg: ErrorMessage }>();
defineEmits<{ (e: 'action', kind: 'retry' | 'continue' | 'dismiss'): void }>();
</script>

<style scoped>
.w-error {
  padding: 12px 0 12px 22px;
  border-left: 1px solid rgba(252, 165, 165, 0.35);
  position: relative;
  font-family: var(--serif); font-style: italic;
  font-size: 15px; line-height: 1.65;
  color: var(--err);
}
.w-error::before {
  content: ""; position: absolute; left: -4px; top: 18px;
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--err);
}
.head {
  font-family: var(--mono); font-style: normal;
  font-size: 10px; letter-spacing: 0.25em; text-transform: uppercase;
  color: var(--err); margin-bottom: 6px;
}
.detail {
  font-family: var(--mono); font-style: normal; font-size: 12px;
  color: var(--read-4); margin-top: 8px;
}
.action {
  margin-top: 12px;
  padding: 6px 14px; border-radius: 6px;
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--read-2);
  background: transparent; border: 1px solid rgba(168, 192, 220, 0.3);
  cursor: pointer;
}
.action:hover { color: white; border-color: var(--steel-400); background: rgba(80, 150, 179, 0.12); }
</style>
