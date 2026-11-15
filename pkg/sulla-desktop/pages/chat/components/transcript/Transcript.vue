<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Transcript — container. Iterates `controller.messages.value` and
  hands each to MessageRouter. Owns scroll behavior.
-->
<template>
  <div class="transcript">
    <div
      ref="scroller"
      class="scroller"
    >
      <div class="chat-dialogue">
        <!-- Time marker for today (phase-0 scaffold) -->
        <TimeMarker
          v-if="showTodayMarker"
          :label="todayLabel"
        />

        <template
          v-for="entry in transcriptEntries"
          :key="entry.id"
        >
          <ThinkingGroup
            v-if="entry.kind === 'thinking-group'"
            :messages="entry.messages"
            :line-id="entry.id"
          />
          <MessageRouter
            v-else
            :msg="entry"
          />
        </template>
        <TurnWaiting
          v-if="waiting"
          :key="waiting.since"
          :since="waiting.since"
          :can-resend="!waiting.message.attachments?.length"
          @stop="controller.stop()"
          @resend="resend"
        />
      </div>
    </div>

    <!--
      Outside the scroller so it stays put while the transcript scrolls,
      pinned just above the composer (see ScrollPill / --composer-h).
    -->
    <ScrollPill
      :visible="showPill"
      @jump="scrollToBottom"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, provide, ref } from 'vue';

import MessageRouter from './MessageRouter.vue';
import ScrollPill from './ScrollPill.vue';
import TimeMarker from './TimeMarker.vue';
import TurnWaiting from './TurnWaiting.vue';
import { groupTranscriptThinking } from './toolGroups';
import { useScrollAnchor } from '../../composables/useScrollAnchor';
import { useChatController } from '../../controller/useChatController';
import { returnCoveredByCard } from '../../messages/handoffCover';
import { LineTimeKey, LineTimes } from '../../messages/lineTime';
import { waitingOn } from '../../messages/waitingStatus';
import ThinkingGroup from '../thinking/ThinkingGroup.vue';

const controller = useChatController();
const scroller = ref<HTMLElement | null>(null);

const { showPill, scrollToBottom } = useScrollAnchor(scroller, controller.messages);
const transcriptEntries = computed(() => groupTranscriptThinking(controller.messages.value));

// Each line's time, shown once per minute (see lineTime.ts). Lines that are
// not shown don't count, or they would take the minute from the line below.
const times = computed(() => LineTimes.lineTimes(transcriptEntries.value.filter(entry =>
  !(entry.kind === 'subagent_exchange' && returnCoveredByCard(entry, controller.messages.value))).map(entry => ({
  id: entry.id,
  at: LineTimes.idTime(entry.id) ?? (entry.kind === 'thinking-group' ? Math.min(...entry.messages.map(m => m.createdAt)) : entry.createdAt),
}))));
provide(LineTimeKey, id => times.value.get(id));

// Sent but nothing back yet: show a live "working" row instead of nothing.
const waiting = computed(() => waitingOn(controller.messages.value, controller.isRunning.value));
function resend(): void {
  const text = waiting.value?.message.text;
  controller.stop();
  if (text) controller.send(text);
}

const showTodayMarker = computed(() => controller.messages.value.length > 0);
const todayLabel = computed(() => {
  const d = new Date();
  const h = d.getHours() % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
  return `Today · ${ h }:${ m } ${ ampm }`;
});

defineExpose({ scroller, scrollToBottom });
</script>

<style scoped>
.transcript {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
}
.scroller {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  overflow-y: auto; overflow-x: hidden;
  padding: 96px 12% var(--scroller-pad-b, 240px);
  scroll-behavior: smooth;
  /* Messages fade out just above the message box instead of running up
     against (or behind) it. --composer-h is the box's live height. */
  --tr-fade-end: calc(var(--composer-h, 140px) - 4px);
  mask-image: linear-gradient(to top, transparent var(--tr-fade-end), #000 calc(var(--tr-fade-end) + 56px));
}
.scroller::-webkit-scrollbar { width: 8px; }
.scroller::-webkit-scrollbar-track { background: transparent; }
.scroller::-webkit-scrollbar-thumb { background: var(--accent-dim); border-radius: 4px; }
.scroller::-webkit-scrollbar-thumb:hover { background: var(--accent-glow); }
</style>
