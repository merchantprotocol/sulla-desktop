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
  border-left: 1px solid rgba(80, 150, 179, 0.22);
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 14px;
  font-family: var(--mono); font-size: 11.5px;
  color: var(--read-3); position: relative;
  transition: border-color 0.2s ease;
}
.tool:hover { border-left-color: rgba(106, 176, 204, 0.5); }
.tool::before {
  content: ""; position: absolute; left: -3px; top: 14px;
  width: 5px; height: 5px; border-radius: 50%;
  background: rgba(80, 150, 179, 0.45);
}
.tool .kind {
  font-weight: 700; font-size: 9.5px; letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--steel-200); padding: 2px 7px; border-radius: 3px;
  background: rgba(168, 192, 220, 0.1);
  border: 1px solid rgba(168, 192, 220, 0.22);
  flex-shrink: 0;
}
.tool .desc { color: var(--read-2); flex: 1; }
.tool .meta { color: var(--read-4); font-size: 10.5px; white-space: nowrap; }
.tool.ok::before { background: var(--ok); }
.tool.ok .meta  { color: var(--ok); opacity: 0.7; }
.tool.run::before {
  background: var(--steel-400); box-shadow: 0 0 12px var(--steel-400);
  animation: chat-pulse 1.5s infinite;
}
.tool.run .kind {
  background: rgba(106, 176, 204, 0.14); color: var(--steel-400);
  border-color: rgba(106, 176, 204, 0.38);
}
.tool.run .meta { color: var(--steel-400); }
.tool.err::before { background: var(--err); }
.tool.err .kind   { background: rgba(252,165,165,0.12); color: var(--err); border-color: rgba(252,165,165,0.3); }
.tool-output {
  flex-basis: 100%; margin-top: 6px;
  color: var(--read-3);
}
.tool-output summary { cursor: pointer; color: var(--steel-300); }
.tool-output span {
  display: block; margin-top: 8px;
  color: var(--read-4); font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase;
}
.tool-output pre {
  margin: 4px 0 0; padding: 8px 10px; max-height: 280px; overflow: auto;
  white-space: pre-wrap; overflow-wrap: anywhere;
  background: var(--surface-2); border: 1px solid var(--border-muted); border-radius: 5px;
  color: var(--read-2); font: 10.5px/1.45 var(--mono);
}
</style>
