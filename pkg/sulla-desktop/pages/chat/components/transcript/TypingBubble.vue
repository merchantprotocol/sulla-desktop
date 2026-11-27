<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div v-if="state.shouldRender" class="typing-indicator-tail">
    <div v-if="state.bubbleVisible" class="typing-indicator" role="status" :aria-label="bubbleLabel">
      <span
        class="typing-indicator__bubble"
        :class="`typing-indicator__bubble--${state.kind}`"
        :title="state.toolName ?? undefined"
        aria-hidden="true"
      >
        <span class="typing-indicator__layer typing-indicator__dots" :class="{ 'typing-indicator__layer--shown': !toolShown }">
          <i v-for="index in 3" :key="index" class="typing-indicator__dot" :style="{ '--dot-index': index - 1 }" />
        </span>
        <svg class="typing-indicator__layer typing-indicator__tool" :class="{ 'typing-indicator__layer--shown': toolShown }" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="1.8" />
          <circle cx="8" cy="8" r="4.2" />
          <path d="M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6M3.9 3.9l1.13 1.13M10.97 10.97l1.13 1.13M12.1 3.9l-1.13 1.13M5.03 10.97l-1.13 1.13" />
        </svg>
      </span>
    </div>

    <div v-else-if="state.kind === 'parked'" class="typing-indicator__parked" role="status">
      <span class="typing-indicator__root-avatar" aria-hidden="true">S</span>
      <strong>Waiting on {{ state.agents.length }} {{ state.agents.length === 1 ? 'agent' : 'agents' }}</strong>
      <span class="typing-indicator__avatar-stack" aria-hidden="true">
        <span v-for="agent in state.agents" :key="agent.key" class="typing-indicator__avatar" :title="agent.name">
          {{ agent.initials }}
        </span>
      </span>
      <span>Sulla resumes when they report back</span>
    </div>

    <div v-else-if="state.kind === 'error'" class="typing-indicator__error" role="alert">
      <strong><i aria-hidden="true" />Stopped</strong>
      <span>{{ state.errorMessage }}</span>
      <button v-if="state.retryAvailable" type="button" class="typing-indicator__retry" @click="$emit('retry')">Retry</button>
    </div>

    <div v-else-if="state.kind === 'stopped'" class="typing-indicator__stopped" role="status">
      You stopped this run.
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { TypingIndicatorSnapshot } from './TypingIndicatorState';

const props = defineProps<{ state: Readonly<TypingIndicatorSnapshot> }>();
defineEmits<{ retry: [] }>();

const bubbleLabel = computed(() => {
  if (props.state.kind === 'stalled') return 'Sulla has stalled';
  if (props.state.kind === 'tool') return `Sulla is using ${props.state.toolName ?? 'a tool'}`;
  return 'Sulla is thinking';
});
const toolShown = computed(() => Boolean(props.state.toolName) && (props.state.kind === 'tool' || props.state.kind === 'stalled'));
</script>

<style scoped>
.typing-indicator-tail { max-width: 900px; min-height: 26px; margin: 12px 0 0; }
.typing-indicator { display: flex; align-items: flex-end; gap: 8px; animation: typing-indicator-in 240ms cubic-bezier(.16, 1, .3, 1); }
.typing-indicator__bubble {
  display: inline-grid; grid-template: 1fr / 1fr; place-items: center; width: 42px; height: 26px;
  border-radius: 13px 13px 13px 4px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 9%, var(--bg-surface));
  transition: background-color 240ms cubic-bezier(.22, 1, .36, 1);
}
.typing-indicator__layer { grid-area: 1 / 1; display: inline-flex; align-items: center; gap: 4px; opacity: 0; transform: scale(.55); transition: opacity 160ms cubic-bezier(.7, 0, .84, 0), transform 160ms cubic-bezier(.7, 0, .84, 0); }
.typing-indicator__layer--shown { opacity: 1; transform: none; transition: opacity 240ms cubic-bezier(.16, 1, .3, 1) 60ms, transform 240ms cubic-bezier(.16, 1, .3, 1) 60ms; }
.typing-indicator__dots { display: inline-flex; }
.typing-indicator__dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); opacity: .3; }
.typing-indicator__layer--shown .typing-indicator__dot { animation: typing-indicator-dot 1.9s cubic-bezier(.45, 0, .55, 1) infinite; animation-delay: calc(var(--dot-index) * 190ms); }
.typing-indicator__tool { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
.typing-indicator__tool.typing-indicator__layer--shown { animation: typing-indicator-tool 1.9s cubic-bezier(.45, 0, .55, 1) infinite alternate; }
.typing-indicator__bubble--stalled { color: var(--status-warning); background: color-mix(in srgb, var(--status-warning) 16%, var(--bg-surface)); }
.typing-indicator__bubble--stalled .typing-indicator__layer--shown .typing-indicator__dot { animation: none; opacity: .95; background: var(--status-warning); }
.typing-indicator__bubble--stalled .typing-indicator__tool.typing-indicator__layer--shown { animation: none; opacity: .95; }
.typing-indicator__parked, .typing-indicator__error, .typing-indicator__stopped {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; min-width: 0;
  font-size: 13px; color: var(--text-muted);
}
.typing-indicator__parked strong { color: var(--text-secondary); font-weight: 500; white-space: nowrap; }
.typing-indicator__root-avatar, .typing-indicator__avatar {
  display: inline-grid; flex: none; place-items: center; width: 16px; height: 16px; border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 18%, var(--bg-surface)); color: var(--accent);
  font-size: 9px; font-weight: 600; line-height: 1;
}
.typing-indicator__root-avatar { background: var(--accent); color: var(--primary-color-on-override, var(--bg-page)); width: 18px; height: 18px; font-size: 10px; }
.typing-indicator__avatar-stack { display: inline-flex; gap: 3px; }
.typing-indicator__error strong { display: inline-flex; align-items: center; gap: 6px; color: var(--status-error); font-weight: 500; }
.typing-indicator__error strong i { width: 7px; height: 7px; border-radius: 50%; background: var(--status-error); }
.typing-indicator__retry { border: 0; padding: 0; border-radius: 4px; background: none; color: var(--text-secondary); font: inherit; font-size: 12.5px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.typing-indicator__retry:hover { color: var(--text-primary); }
.typing-indicator__retry:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@keyframes typing-indicator-in { from { opacity: 0; transform: translateY(4px) scale(.96); } }
@keyframes typing-indicator-dot { 0%, 56%, 100% { opacity: .3; transform: translateY(0); } 28% { opacity: .78; transform: translateY(-2px); } }
@keyframes typing-indicator-tool { from { opacity: .45; transform: scale(.9); } to { opacity: .88; transform: scale(1); } }
@media (prefers-reduced-motion: reduce) {
  .typing-indicator, .typing-indicator__dot, .typing-indicator__tool { animation: none; }
  .typing-indicator__layer { transform: none; transition: opacity 160ms cubic-bezier(.22, 1, .36, 1); }
  .typing-indicator__dot { opacity: .65; transform: none; }
}
</style>
