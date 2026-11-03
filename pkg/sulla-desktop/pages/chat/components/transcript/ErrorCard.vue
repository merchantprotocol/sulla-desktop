<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
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
defineEmits<{ (e: 'action', kind: 'retry' | 'continue' | 'dismiss' | 'connect'): void }>();
</script>

<style scoped>
.w-error {
  padding: 12px 0 12px 22px;
  border-left: 1px solid var(--status-warning);
  position: relative;
  font-family: var(--font-display); font-style: italic;
  font-size: 15px; line-height: 1.65;
  color: var(--status-error);
}
.w-error::before {
  content: ""; position: absolute; left: -4px; top: 18px;
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--status-error);
}
.head {
  font-family: var(--font-mono); font-style: normal;
  font-size: 10px; letter-spacing: 0.25em; text-transform: uppercase;
  color: var(--status-error); margin-bottom: 6px;
}
.detail {
  font-family: var(--font-mono); font-style: normal; font-size: 12px;
  color: var(--text-muted); margin-top: 8px;
}
.action {
  margin-top: 12px;
  padding: 6px 14px; border-radius: 6px;
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--text-primary);
  background: transparent; border: 1px solid var(--accent-glow);
  cursor: pointer;
}
.action:hover { color: var(--text-on-accent); border-color: var(--accent-hover); background: var(--accent-dim); }
</style>
