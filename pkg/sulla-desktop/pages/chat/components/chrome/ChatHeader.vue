<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Chat header: the editable chat title centred, with the agent-origin chip on
  the left when an agent launched this tab. Sub-agents, files and history live
  in the side panel, the left rail, and the header ⋯ menu; Find chat is in the
  menu bar (⌘P).
-->
<template>
  <header class="chat-header">
    <!-- Empty left column keeps the title centred. -->
    <div class="ch-left">
      <button
        v-if="origin"
        class="ch-origin"
        type="button"
        :title="`Return to ${origin.name}`"
        @click="origin.back()"
      >
        <span aria-hidden="true">↩</span>
        <span class="ch-origin-t">Launched by {{ origin.name }}</span>
      </button>
    </div>

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

    <select v-model="reportingLevel" class="ch-reporting" aria-label="Reporting" title="Reporting">
      <option value="fatal">Brief</option>
      <option value="info">Standard</option>
      <option value="debug">Detailed</option>
    </select>
  </header>
</template>

<script setup lang="ts">
import { inject, ref, type Ref } from 'vue';

import { useChatController } from '../../controller/useChatController';

import type { ReportingLevel } from '../../models/ReportingLevel';

const reportingLevel = defineModel<ReportingLevel>('reportingLevel', { default: 'info' });
const controller = useChatController();
/** Set when this chat is an agent's own tab: who launched it, and a way back. */
const origin = inject<Ref<{ name: string; back: () => void } | null>>('chat:agent-origin', ref(null));
const titleEl = ref<HTMLElement | null>(null);

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
  display: grid; grid-template-columns: fit-content(32%) minmax(0, 1fr) auto; align-items: center;
  /* Keep the previous 52px outer height and content alignment without the 1px border. */
  box-sizing: border-box; height: 52px; padding: 0 20px 1px;
  background: transparent;
  font-family: var(--font-body);
}
.ch-left { display: flex; align-items: center; gap: 10px; min-width: 0; justify-self: start; }
.ch-center { display: flex; min-width: 0; }
.ch-title {
  min-width: 0; padding: 3px 8px; text-align: left;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  border-radius: 6px; outline: none; cursor: text;
  color: var(--text-primary); font-size: 15px; font-weight: normal; letter-spacing: 0;
}
.ch-title:hover { background: color-mix(in srgb, var(--text-primary) 6%, transparent); }
.ch-title:focus { text-overflow: clip; background: var(--bg-surface); box-shadow: inset 0 0 0 1px var(--accent); }
.ch-origin {
  display: inline-flex; align-items: center; gap: 7px; min-width: 0; max-width: 100%; height: 28px; padding: 0 10px;
  border: 1px solid var(--border-default); border-radius: 999px; background: var(--bg-surface);
  color: color-mix(in srgb, var(--text-primary) 72%, var(--bg-surface)); font: 11px var(--font-mono, ui-monospace, monospace); letter-spacing: .06em; cursor: pointer;
}
.ch-origin:hover { color: var(--accent); border-color: var(--accent); }
.ch-origin:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ch-origin-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-reporting {
  justify-self: end; margin-left: 8px; max-width: 100%; height: 28px; padding: 0 6px;
  color: var(--text-primary); background: var(--bg-surface);
  border: 1px solid var(--border-default); border-radius: 6px; font: inherit; font-size: 12px;
}
.ch-reporting:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
