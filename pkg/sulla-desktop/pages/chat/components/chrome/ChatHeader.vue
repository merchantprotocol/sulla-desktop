<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Chat header: the editable chat title centred (the agent picker lives in the
  message box, so the header does not repeat it),
  and sub-agents, files and history toggles on the right. Replaces the centred italic
  SessionMark and the StatusBadges pills (connection status now lives as a
  dot in the app's top bar).
-->
<template>
  <header class="chat-header">
    <!-- Empty left column keeps the title centred. -->
    <div class="ch-left" />

    <div class="ch-center">
      <span
        ref="titleEl"
        class="ch-title"
        contenteditable="true"
        spellcheck="false"
        role="textbox"
        aria-label="Chat title"
        title="Rename chat"
        @keydown.enter.prevent="commitTitle"
        @keydown.esc.prevent="cancelTitle"
        @blur="commitTitle"
      >{{ controller.thread.value.title }}</span>
    </div>

    <div class="ch-actions">
      <button
        class="ch-btn"
        type="button"
        :class="{ on: subAgentsOpen && subAgents.total > 0, off: subAgents.total === 0 }"
        :aria-pressed="subAgentsOpen && subAgents.total > 0"
        :title="subAgents.total ? (subAgentsOpen ? 'Hide sub-agents' : 'Show sub-agents') : 'No sub-agents in this chat yet'"
        @click="subAgents.total && emit('toggle-subagents')"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
        ><rect
          x="3.5"
          y="4.5"
          width="17"
          height="15"
          rx="3"
        /><path d="M9.5 4.5v15" /></svg>
        Sub-agents
        <span
          v-if="subAgents.total"
          class="ch-count"
          :class="{ live: subAgents.live > 0 }"
        >{{ subAgents.live ? `${subAgents.live} live` : subAgents.total }}</span>
        <span
          v-else
          class="ch-none"
        >none yet</span>
      </button>
      <button
        class="ch-btn"
        type="button"
        :class="{ on: filesOpen }"
        :aria-pressed="filesOpen"
        title="Files in this chat"
        @click="emit('toggle-files')"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
        ><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5" /></svg>
        Files
      </button>
      <button
        class="ch-btn"
        type="button"
        :class="{ on: historyOpen }"
        :aria-pressed="historyOpen"
        title="Chat history"
        @click="controller.toggleHistory()"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
        ><path d="M12 3a9 9 0 109 9M3 3v6h6M12 7v5l3 2" /></svg>
        History
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { useChatController } from '../../controller/useChatController';

defineProps<{
  subAgents:     { total: number; live: number };
  subAgentsOpen: boolean;
  filesOpen:     boolean;
}>();
const emit = defineEmits<{ (e: 'toggle-subagents'): void; (e: 'toggle-files'): void }>();

const controller = useChatController();
const titleEl = ref<HTMLElement | null>(null);
const historyOpen = computed(() => controller.sidebar.value.historyOpen);

function commitTitle(): void {
  const next = (titleEl.value?.textContent || '').trim() || 'New chat';
  if (next !== controller.thread.value.title) controller.renameThread(next);
  if (titleEl.value) titleEl.value.textContent = next;
  titleEl.value?.blur();
}

function cancelTitle(): void {
  if (titleEl.value) titleEl.value.textContent = controller.thread.value.title;
  titleEl.value?.blur();
}
</script>

<style scoped>
.chat-header {
  position: absolute; top: 0; left: 0; right: 0; z-index: 21;
  /* Equal outer columns keep the title truly centred whatever the sides hold. */
  display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 16px;
  height: 52px; padding: 0 20px;
  border-bottom: 1px solid var(--border-subtle, var(--border-default));
  background: color-mix(in srgb, var(--bg-page) 88%, transparent);
  backdrop-filter: blur(12px);
  font-family: var(--font-body);
}
.ch-left { display: flex; align-items: center; gap: 10px; min-width: 0; justify-self: start; }
.ch-center { display: flex; justify-content: center; min-width: 0; }
.ch-title {
  min-width: 2ch; max-width: 36vw; padding: 3px 8px; text-align: center;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  border-radius: 6px; outline: none; cursor: text;
  color: var(--text-primary); font-size: 15px; font-weight: 600; letter-spacing: 0;
}
.ch-title:hover { background: color-mix(in srgb, var(--text-primary) 6%, transparent); }
.ch-title:focus { text-overflow: clip; background: var(--bg-surface); box-shadow: inset 0 0 0 1px var(--accent); }
.ch-actions { display: flex; align-items: center; gap: 6px; justify-self: end; }
.ch-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px;
  border-radius: 8px; cursor: pointer;
  border: 1px solid var(--border-default); background: var(--bg-surface);
  color: var(--text-primary); font: 500 12.5px var(--font-body);
}
.ch-btn:hover { border-color: var(--accent); }
.ch-btn.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--bg-surface)); }
.ch-btn.off { color: var(--text-muted); cursor: default; }
.ch-btn.off:hover { border-color: var(--border-default); }
.ch-btn svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.ch-count { padding: 0 7px; border-radius: 999px; font-size: 11px; background: color-mix(in srgb, var(--text-primary) 10%, transparent); }
.ch-count.live { color: var(--status-success); background: color-mix(in srgb, var(--status-success) 15%, transparent); }
.ch-none { font-size: 11px; color: var(--text-muted); }
@media (max-width: 760px) {
  .ch-btn { padding: 0 8px; }
}
</style>
