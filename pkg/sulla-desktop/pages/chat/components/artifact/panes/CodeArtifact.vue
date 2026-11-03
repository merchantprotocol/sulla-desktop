<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- Code file view — simple syntax-highlight via payload.lines. -->
<template>
  <div class="code-view">
    <div
      v-for="line in payload.lines"
      :key="line.n"
      :class="['l', line.op || 'context', isCursor(line) ? 'cursor-line' : null]"
    >
      <span class="n">{{ line.n }}</span>
      <span v-html="line.text" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { CodePayload } from '../../../models/Artifact';

const props = defineProps<{ payload: CodePayload }>();
function isCursor(line: { n: number }): boolean {
  return !!props.payload.cursor && props.payload.cursor.line === line.n;
}
</script>

<style scoped>
.code-view {
  font-family: var(--font-mono); font-size: 12.5px; line-height: 1.75;
  color: var(--text, var(--text-primary, var(--text-primary)));
  padding: 4px 0;
}
.l { display: flex; gap: 14px; padding: 0 12px; }
.l .n { color: var(--text-muted, var(--text-dim)); min-width: 30px; text-align: right; user-select: none; font-size: 11px; }
.l.add { background: var(--status-success-soft); }
.l.add .n { color: var(--status-success); }
.l.remove { background: var(--status-error-soft); }
.l.cursor-line { background: var(--accent-dim, var(--accent-dim, var(--accent-dim))); position: relative; }
.l.cursor-line::before {
  content: ""; position: absolute; right: 14px; top: 50%;
  width: 7px; height: 14px;
  background: var(--accent, var(--accent-hover)); box-shadow: 0 0 10px var(--accent-glow, var(--accent-hover));
  margin-top: -7px; animation: chat-blink 0.9s step-end infinite;
}
</style>
