<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Chat header: the left-aligned editable title, preceded by the agent-origin
  chip when an agent launched this tab. Sub-agents, files and history live
  in the side panel, the left rail, and the header ⋯ menu; Find chat is in the
  menu bar (⌘P).
-->
<template>
  <header class="chat-header">
    <div class="ch-left">
      <button
        v-if="origin"
        class="ch-origin"
        type="button"
        :title="`Launched by ${origin.name} — return to launcher`"
        :aria-label="`Launched by ${origin.name} — return to launcher`"
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

    <div
      ref="reportingGroup"
      class="ch-reporting"
      role="radiogroup"
      aria-label="Reporting"
      @keydown="onReportingKeydown"
    >
      <button
        v-for="mode in reportingModes"
        :key="mode.value"
        :data-reporting-level="mode.value"
        class="ch-reporting-option"
        type="button"
        role="radio"
        :aria-label="mode.label"
        :aria-checked="activeReportingLevel === mode.value"
        :tabindex="activeReportingLevel === mode.value ? 0 : -1"
        :title="mode.label"
        @click="reportingLevel = mode.value"
      >
        <span class="ch-reporting-label">{{ mode.label }}</span>
        <span class="ch-reporting-short" aria-hidden="true">{{ mode.shortLabel }}</span>
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, ref, type Ref } from 'vue';

import { useChatController } from '../../controller/useChatController';

import type { ReportingLevel } from '../../models/ReportingLevel';

const reportingLevel = defineModel<ReportingLevel>('reportingLevel', { default: 'info' });
const controller = useChatController();
const reportingModes: Array<{ value: ReportingLevel; label: string; shortLabel: string }> = [
  { value: 'fatal', label: 'Brief', shortLabel: 'B' },
  { value: 'info', label: 'Standard', shortLabel: 'S' },
  { value: 'debug', label: 'Detailed', shortLabel: 'D' },
];
const activeReportingLevel = computed(() =>
  reportingModes.some(({ value }) => value === reportingLevel.value) ? reportingLevel.value : 'info',
);
const reportingGroup = ref<HTMLDivElement | null>(null);
/** Set when this chat is an agent's own tab: who launched it, and a way back. */
const origin = inject<Ref<{ name: string; back: () => void } | null>>('chat:agent-origin', ref(null));
const titleEl = ref<HTMLElement | null>(null);

async function onReportingKeydown(event: KeyboardEvent): Promise<void> {
  const currentIndex = reportingModes.findIndex(({ value }) => value === activeReportingLevel.value);
  let nextIndex: number;

  switch (event.key) {
    case 'ArrowLeft':
      nextIndex = (currentIndex + reportingModes.length - 1) % reportingModes.length;
      break;
    case 'ArrowRight':
      nextIndex = (currentIndex + 1) % reportingModes.length;
      break;
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = reportingModes.length - 1;
      break;
    default:
      return;
  }

  event.preventDefault();
  const nextLevel = reportingModes[nextIndex].value;
  reportingLevel.value = nextLevel;
  await nextTick();
  reportingGroup.value?.querySelector<HTMLButtonElement>(`[data-reporting-level="${nextLevel}"]`)?.focus();
}

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
  container: chat-header / inline-size;
  position: absolute; top: 0; left: 0; right: 0; z-index: 21;
  display: flex; align-items: center;
  /* Match the approved thread-title row; workerChart.css anchors to this 48px height. */
  box-sizing: border-box; height: 48px; padding-block: 10px;
  /* Recover space when a wide dock leaves a narrow chat pane. */
  padding-inline: clamp(6px, calc(10% - 15px), 16px);
  background: var(--bg-surface);
  font-family: var(--font-body);
}
.ch-left { display: flex; flex: 0 1 auto; min-width: 0; max-width: 32%; }
/* Let the title fill the remainder, but make the chip give up space at this floor. */
.ch-center { display: flex; flex: 1 1 0; min-width: 4rem; }
.ch-title {
  /* Fit the title and its padding, then shrink to the available space. */
  flex: 0 1 auto; min-width: 0; height: auto; margin: 0; padding: 4px 10px; text-align: left;
  --chat-title-chip-bg: #f3f6f9;
  --chat-title-chip-text: #1c2630;
  background: var(--chat-title-chip-bg);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  border: 0; border-radius: 8px; outline: none; cursor: text;
  color: var(--chat-title-chip-text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 13px; font-weight: 400; line-height: 1.5; letter-spacing: -.005em;
}
.ch-title:focus {
  text-overflow: clip;
  background: var(--chat-title-chip-bg);
  box-shadow: inset 0 0 0 1px var(--accent);
}
html.dark .ch-title { --chat-title-chip-bg: #1d2126; --chat-title-chip-text: #e8ecf0; }
.ch-origin {
  display: inline-flex; align-items: center; gap: 7px; min-width: 0; height: 28px; padding: 0 10px;
  border: 1px solid var(--border-default); border-radius: 999px; background: var(--bg-surface);
  color: color-mix(in srgb, var(--text-primary) 72%, var(--bg-surface)); font: 11px var(--font-mono, ui-monospace, monospace); letter-spacing: .06em; cursor: pointer;
}
.ch-origin:hover { color: var(--primary-color-text-override, var(--accent)); border-color: var(--accent); }
.ch-origin:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ch-origin > [aria-hidden] { flex: none; }
.ch-origin-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-reporting {
  display: flex; align-items: center; gap: 2px; min-width: 0; padding: 2px;
  flex: none; margin-left: 8px;
  border: 1px solid var(--border-default); border-radius: 9px;
  background: var(--bg-surface);
}
.ch-reporting-option {
  flex: none; min-width: 0; padding: 3px 10px; border: 0; border-radius: 7px;
  background: transparent; color: var(--text-secondary);
  font: inherit; font-size: 12px; font-weight: 500; line-height: 1.25; white-space: nowrap; cursor: pointer;
}
.ch-reporting-option:hover { color: var(--text-primary); }
.ch-reporting-option[aria-checked="true"] {
  background: var(--accent-dim); color: var(--text-primary);
}
.ch-reporting-option:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ch-reporting-short { display: none; }
@container chat-header (max-width: 480px) {
  .ch-reporting-option { padding-inline: 6px; min-width: 24px; }
  .ch-reporting-label { display: none; }
  .ch-reporting-short { display: inline; }
}
</style>
