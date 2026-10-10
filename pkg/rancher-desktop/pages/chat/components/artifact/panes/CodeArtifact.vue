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
  font-family: var(--font-mono, var(--mono)); font-size: 12.5px; line-height: 1.75;
  color: var(--text, var(--text-primary, var(--read-2)));
  padding: 4px 0;
}
.l { display: flex; gap: 14px; padding: 0 12px; }
.l .n { color: var(--text-muted, var(--read-5)); min-width: 30px; text-align: right; user-select: none; font-size: 11px; }
.l.add { background: var(--bg-success, color-mix(in srgb, var(--success, #3fb950) 10%, transparent)); }
.l.add .n { color: var(--success, var(--text-success, var(--ok))); }
.l.remove { background: var(--bg-error, color-mix(in srgb, var(--danger, #f85149) 10%, transparent)); }
.l.cursor-line { background: var(--accent-dim, var(--bg-accent, rgba(80, 150, 179, 0.08))); position: relative; }
.l.cursor-line::before {
  content: ""; position: absolute; right: 14px; top: 50%;
  width: 7px; height: 14px;
  background: var(--accent, var(--steel-400)); box-shadow: 0 0 10px var(--accent-glow, var(--steel-400));
  margin-top: -7px; animation: chat-blink 0.9s step-end infinite;
}
</style>
