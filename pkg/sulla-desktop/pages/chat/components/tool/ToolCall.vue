<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  One row in the "stage directions" stream. Running / ok / error states.
-->
<template>
  <div :class="['tool', statusClass]">
    <span class="kind">{{ msg.tool }}</span>
    <span class="desc">{{ msg.desc }}</span>
    <span class="meta">{{ metaLabel }}</span>
    <details
      v-if="msg.input || msg.output || msg.error"
      class="tool-output"
      @click.stop
    >
      <summary>Details</summary>
      <template v-if="msg.input">
        <span>Input</span>
        <pre>{{ msg.input }}</pre>
      </template>
      <template v-if="msg.output">
        <span>Output</span>
        <pre>{{ msg.output }}</pre>
      </template>
      <template v-if="msg.error">
        <span>Error</span>
        <pre>{{ msg.error }}</pre>
      </template>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { ToolMessage } from '../../models/Message';

const props = defineProps<{ msg: ToolMessage }>();

const statusClass = computed(() => ({ running: 'run', ok: 'ok', error: 'err' }[props.msg.status]));
const metaLabel = computed(() => props.msg.meta ?? (props.msg.status === 'running' ? 'running…' : ''));
</script>

<style scoped>
.tool {
  padding: 10px 0 10px 22px;
  border-left: 1px solid var(--accent-dim);
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 14px;
  font-family: var(--font-mono); font-size: 11.5px;
  color: var(--text-secondary); position: relative;
  transition: border-color 0.2s ease;
}
.tool:hover { border-left-color: var(--accent-glow); }
.tool::before {
  content: ""; position: absolute; left: -3px; top: 14px;
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--accent-glow);
}
.tool .kind {
  font-weight: 700; font-size: 9.5px; letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--text-muted); padding: 2px 7px; border-radius: 3px;
  background: var(--accent-dim);
  border: 1px solid var(--accent-dim);
  flex-shrink: 0;
}
.tool .desc { color: var(--text-primary); flex: 1; }
.tool .meta { color: var(--text-muted); font-size: 10.5px; white-space: nowrap; }
.tool.ok::before { background: var(--status-success); }
.tool.ok .meta  { color: var(--status-success); opacity: 0.7; }
.tool.run::before {
  background: var(--accent-hover); box-shadow: 0 0 12px var(--accent-hover);
  animation: chat-pulse 1.5s infinite;
}
.tool.run .kind {
  background: var(--accent-dim); color: var(--accent-hover);
  border-color: var(--accent-glow);
}
.tool.run .meta { color: var(--accent-hover); }
.tool.err::before { background: var(--status-error); }
.tool.err .kind   { background: var(--status-warning-soft); color: var(--status-error); border-color: var(--status-warning); }
.tool-output {
  flex-basis: 100%; margin-top: 6px;
  color: var(--text-secondary);
}
.tool-output summary { cursor: pointer; color: var(--accent-hover); }
.tool-output span {
  display: block; margin-top: 8px;
  color: var(--text-muted); font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase;
}
.tool-output pre {
  margin: 4px 0 0; padding: 8px 10px; max-height: 280px; overflow: auto;
  white-space: pre-wrap; overflow-wrap: anywhere;
  background: var(--surface-2); border: 1px solid var(--border-muted); border-radius: 5px;
  color: var(--text-primary); font: 10.5px/1.45 var(--font-mono);
}
</style>
