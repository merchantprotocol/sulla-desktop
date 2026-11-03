<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- "Saved memory · w9oK · 2:36" — subtle stage direction. -->
<template>
  <div class="memory-note">
    <span class="id">{{ msg.memId }}</span>
    <span>{{ verb }}<span v-if="msg.summary"> · {{ msg.summary }}</span></span>
    <span class="ts">{{ timeLabel }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { MemoryMessage } from '../../models/Message';

const props = defineProps<{ msg: MemoryMessage }>();
const verb = computed(() => ({ saved: 'saved memory', updated: 'updated memory', removed: 'removed memory' }[props.msg.action]));
const timeLabel = computed(() => {
  const d = new Date(props.msg.createdAt);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
});
</script>

<style scoped>
.memory-note {
  padding: 6px 0 6px 22px;
  border-left: 1px dashed var(--accent-glow);
  position: relative;
  font-family: var(--font-mono); font-size: 11px;
  color: var(--accent-hover); font-style: italic;
  display: flex; align-items: center; gap: 10px;
}
.memory-note::before {
  content: "◈"; position: absolute; left: -4px; top: 4px;
  color: var(--accent-hover); font-style: normal;
  font-size: 11px;
}
.memory-note .id {
  font-style: normal; color: var(--accent-hover);
  padding: 1px 6px; border-radius: 3px;
  background: var(--accent-dim);
  border: 1px solid var(--accent-dim);
  font-size: 10px; letter-spacing: 0.08em;
}
.memory-note .ts { margin-left: auto; color: var(--text-dim); font-size: 10px; font-style: normal; }
</style>
