<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="dtr-conversation" aria-label="Detailed conversation timeline">
    <template v-for="segment in segments" :key="segment.id">
      <div
        v-for="item in segment.leading"
        :key="item.id"
        :ref="element => item.kind === 'message' && registerLine(item.entry.id, element)"
        class="dtr-message"
        data-kind="user"
      >
        <div v-if="item.kind === 'message' && item.entry.kind === 'card'" class="dtr-message-content">
          <MessageRouter :msg="item.entry.message" :streaming-paragraph-break="item.streamingParagraphBreak" />
        </div>
      </div>
      <section v-if="segment.header || segment.items.length" class="dtr-turn" :aria-label="segment.header ? `${segment.header.header.agent} turn at ${segment.header.header.time}` : 'Detailed activity'">
        <div v-if="segment.header" class="dtr-th">
          <strong>{{ segment.header.header.agent }}</strong>
          <time>{{ segment.header.header.time }}</time>
          <code v-if="segment.header.header.model">{{ segment.header.header.model }}</code>
          <span v-for="metadata in segment.header.header.metadata" :key="metadata">{{ metadata }}</span>
        </div>
        <ol v-if="segment.items.length" class="dtr-trace">
          <template v-for="item in segment.items" :key="item.id">
            <TraceRow
              v-if="item.kind === 'trace'"
              :ref="element => registerTrace(item.row, element)"
              :row="item.row"
            />
            <li
              v-else-if="item.kind === 'waiting'"
              :ref="element => registerLine(item.id, element)"
              class="dtr-waiting"
            >
              <span class="dtr-waiting-ic" aria-hidden="true"><span /></span>
              <div class="dtr-waiting-content">
                <TurnWaiting
                  :since="item.since"
                  :can-resend="!item.message.attachments?.length"
                  @stop="$emit('stop')"
                  @resend="$emit('resend')"
                />
              </div>
            </li>
            <li
              v-else-if="item.kind === 'message' && item.entry.kind === 'activity'"
              :ref="element => registerLine(item.entry.id, element)"
              class="dtr-activity"
            >
              <span class="dtr-activity-label">{{ item.entry.label }}</span>
              <span>{{ item.entry.text }}</span>
            </li>
            <li
              v-else-if="item.kind === 'message' && item.entry.kind === 'card'"
              :ref="element => registerLine(item.entry.id, element)"
              class="dtr-message"
              :data-kind="item.entry.message.kind"
            >
              <div class="dtr-message-content">
                <span
                  v-if="item.entry.message.kind !== 'user' && item.entry.message.kind !== 'sulla' && item.entry.label && !['Message', 'Reply', 'Evidence', 'Handoff'].includes(item.entry.label)"
                  class="dtr-message-label"
                >{{ item.entry.label }}</span>
                <MessageRouter :msg="item.entry.message" :streaming-paragraph-break="item.streamingParagraphBreak" />
              </div>
            </li>
          </template>
        </ol>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MessageRouter from './MessageRouter.vue';
import TraceRow from './TraceRow.vue';
import TurnWaiting from './TurnWaiting.vue';
import { DetailedTimelineSegmenter, type DetailedTimelineItem } from './DetailedTimelineProjection';
import type { TraceRow as TraceRowModel } from './traceTypes';

const props = defineProps<{
  items: readonly DetailedTimelineItem[];
  registerElement: (id: string, element: unknown) => void;
}>();
defineEmits<{ (event: 'stop'): void; (event: 'resend'): void }>();
const segmenter = new DetailedTimelineSegmenter();
const segments = computed(() => segmenter.segment(props.items));
const ownedMessageIds = computed(() => {
  const ids = new Set<string>();
  for (const item of props.items) if (item.kind === 'message') {
    ids.add(item.entry.id);
    ids.add(item.entry.sourceId);
  }
  return ids;
});

function registerTrace(row: TraceRowModel, element: unknown): void {
  props.registerElement(row.id, element);
  if (row.sourceMessageId && !ownedMessageIds.value.has(row.sourceMessageId)) {
    props.registerElement(row.sourceMessageId, element);
  }
}

function registerLine(id: string, element: unknown): void { props.registerElement(id, element); }
</script>

<style scoped>
.dtr-conversation { box-sizing: border-box; width: 100%; max-width: 948px; margin: 0 auto; padding: 8px 24px 28px; }
.dtr-turn { margin: 0 0 8px; }
/* Approved row geometry: 24px icon column plus 10px text gap; the opaque icon backplate masks the centered rail. */
.dtr-trace { position: relative; margin: 6px 0 0; padding: 0; list-style: none; }
.dtr-trace::before { content: ''; position: absolute; left: 11.5px; top: 14px; bottom: 14px; width: 1px; background: var(--border-muted); }
.dtr-th { position: relative; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 14px; padding-left: 34px; color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.dtr-th strong { color: var(--text-primary); font-size: 13px; font-weight: 600; }
.dtr-th time { white-space: nowrap; }
.dtr-th code { font: 11.5px var(--font-mono, ui-monospace, monospace); }
.dtr-th span { white-space: nowrap; }
.dtr-message { position: relative; min-width: 0; padding: 2px 0; list-style: none; }
.dtr-message-content { min-width: 0; margin-left: 34px; }
.dtr-message-label { display: block; margin: 0 0 4px; color: var(--text-muted); font: 10px var(--font-mono, ui-monospace, monospace); letter-spacing: .06em; text-transform: uppercase; }
.dtr-message[data-kind="user"] { display: flex; justify-content: flex-end; margin: 24px 0 16px; padding: 0; }
.dtr-message[data-kind="user"] .dtr-message-content { margin-left: 0; }
.dtr-message[data-kind="user"] :deep(.chat-turn.you) { box-sizing: border-box; width: fit-content; max-width: min(620px, 86%); padding: 9px 14px; border-radius: 16px 16px 4px 16px; background: var(--accent); box-shadow: 0 1px 2px rgb(20 40 60 / 12%); text-align: left; }
.dtr-message[data-kind="user"] :deep(.chat-turn.you .chat-body) { color: var(--text-on-accent, #fff); font-family: var(--font-body); font-size: 14px; font-style: normal; line-height: 1.5; }
.dtr-message[data-kind="user"] :deep(.chat-turn.you .noir-time) { display: none; }
.dtr-message:is([data-kind="sulla"], [data-kind="streaming"], [data-kind="html"], [data-kind="proactive"]) { display: grid; grid-template-columns: 24px minmax(0, 1fr); column-gap: 10px; margin-top: 10px; }
.dtr-message:is([data-kind="sulla"], [data-kind="streaming"], [data-kind="html"], [data-kind="proactive"])::before { content: ''; grid-column: 1; grid-row: 1; z-index: 1; width: 24px; height: 24px; margin: 0 auto; border-radius: 50%; background: var(--bg-page); }
.dtr-message:is([data-kind="sulla"], [data-kind="streaming"], [data-kind="html"], [data-kind="proactive"])::after { content: ''; grid-column: 1; grid-row: 1; z-index: 2; width: 9px; height: 9px; margin: 7.5px auto; border-radius: 50%; background: var(--accent); }
.dtr-message:is([data-kind="sulla"], [data-kind="streaming"], [data-kind="html"], [data-kind="proactive"]) .dtr-message-content { grid-column: 2; margin-left: 0; max-width: 720px; padding-top: 1px; color: var(--text-primary); font-size: 15px; line-height: 1.6; }
.dtr-message[data-kind="sulla"] :deep(.chat-turn.sulla) { margin: 0; max-width: none; gap: 0; }
.dtr-message[data-kind="sulla"] :deep(.chat-turn.sulla .chat-body) { color: var(--text-primary); font-family: var(--font-body); font-size: 15px; line-height: 1.6; letter-spacing: 0; }
.dtr-message[data-kind="sulla"] :deep(.chat-turn.sulla .chat-body p) { margin: 0 0 8px; }
.dtr-message[data-kind="sulla"] :deep(.chat-turn.sulla .chat-body p:last-child) { margin-bottom: 0; }
.dtr-activity { display: flex; gap: 8px; padding: 2px 0 2px 34px; color: var(--text-secondary); font-size: 13px; line-height: 20px; list-style: none; overflow-wrap: anywhere; }
.dtr-activity-label { color: var(--text-muted); font: 10px var(--font-mono, ui-monospace, monospace); letter-spacing: .06em; text-transform: uppercase; }
.dtr-waiting { display: grid; grid-template-columns: 24px minmax(0, 1fr); column-gap: 10px; align-items: start; padding: 2px 0; list-style: none; }
.dtr-waiting-ic { position: relative; z-index: 1; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--bg-page); color: var(--accent); }
.dtr-waiting-ic span { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.dtr-waiting-content { min-width: 0; padding: 2px 0; }
@media (max-width: 600px) { .dtr-conversation { padding: 4px 12px 20px; } .dtr-th { padding-right: 34px; } }
</style>
