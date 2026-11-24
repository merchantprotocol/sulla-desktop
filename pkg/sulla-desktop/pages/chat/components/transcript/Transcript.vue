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
  <div class="transcript transcript-standard">
    <div
      ref="scroller"
      class="scroller"
      :class="{ 'has-scroll-pill': showPill, 'has-aside': Boolean($slots.aside) }"
    >
      <!--
        Sticky layer inside the scroller (the worker chart): it stays put
        over the right gutter while the messages scroll under it, and the
        scroller's scrollbar stays at the far right, after it.
      -->
      <div v-if="$slots.aside" class="scroller-aside">
        <slot name="aside" />
      </div>
      <div class="chat-dialogue">
        <!-- Time marker for today (phase-0 scaffold) -->
        <TimeMarker
          v-if="showTodayMarker"
          :label="todayLabel"
        />

        <template v-for="(entry, index) in transcriptEntries" :key="entry.id">
          <TraceTurn
            v-for="turn in traceTurns.filter(item => item.anchorEntryId === entry.id)"
            :key="turn.id"
            :turn="turn" :now="traceNow"
          />
        <div
          :ref="el => jumper.register(entry.id, el)"
          v-if="!replyCitations.attached.has(entry.id)"
          class="report-entry"
        >
          <span
            v-if="reportLabelVisible(entry)"
            class="report-label"
            :class="{ 'report-label-user': entry.kind === 'card' && entry.message.kind === 'user' }"
          >{{ entry.label }}</span>
          <MessageRouter
            v-if="entry.kind === 'card'"
            :msg="entry.message"
            :streaming-paragraph-break="reporting.isStreamingContinuation(transcriptEntries, index)"
          >
            <template v-if="replyCitations.byReply.has(entry.id)" #sources>
              <div
                v-for="citation in replyCitations.byReply.get(entry.id)"
                :key="citation.id"
                :ref="el => jumper.register(citation.id, el)"
              >
                <CitationRow :msg="citation" />
              </div>
            </template>
          </MessageRouter>
          <div v-else class="report-activity">
            <span class="report-activity-text">{{ entry.text }}</span>

          </div>
        </div>
        </template>
        <TraceTurn v-for="turn in trailingTraceTurns" :key="turn.id" :turn="turn" :now="traceNow" />
        <div v-if="waiting" :key="waiting.since" class="report-entry">
          <span class="report-label">Status</span>
          <TurnWaiting
            :since="waiting.since"
            :can-resend="!waiting.message.attachments?.length"
            @stop="controller.stop()"
            @resend="resend"
          />
        </div>
      </div>
    </div>

    <!--
      Outside the scroller so it stays put while the transcript scrolls,
      pinned just above the composer (see ScrollPill / --composer-h).
    -->
    <ScrollPill
      :visible="showPill"
      standard
      @jump="scrollToBottom"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import MessageRouter from './MessageRouter.vue';
import TraceTurn from './TraceTurn.vue';
import CitationRow from '../citation/CitationRow.vue';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { ReplyCitationProjection } from './ReplyCitationProjection';
import { DetailedTraceProjection } from './DetailedTraceProjection';
import { TraceDisclosureController } from './traceDisclosure';
import ScrollPill from './ScrollPill.vue';
import TimeMarker from './TimeMarker.vue';
import TurnWaiting from './TurnWaiting.vue';
import { TranscriptReporting, type TranscriptEntry } from './toolGroups';
import { useResultActivity } from '../../composables/useResultActivity';
import { useScrollAnchor } from '../../composables/useScrollAnchor';
import { useChatController } from '../../controller/useChatController';
import { LineTimeKey, LineTimes } from '../../messages/lineTime';
import { TranscriptJump } from '../../messages/transcriptJump';
import { waitingOn } from '../../messages/waitingStatus';
import type { ReportingLevel } from '../../models/ReportingLevel';

const props = defineProps<{ reportingLevel: ReportingLevel }>();
const controller = useChatController();
const scroller = ref<HTMLElement | null>(null);
const reporting = new TranscriptReporting();
const traceProjection = new DetailedTraceProjection();
const citationProjection = new ReplyCitationProjection();
const agentState = inject(AGENT_STATE_CLIENT_KEY, undefined);
const traceNow = ref(Date.now());
watch(() => props.reportingLevel === 'debug', (detailed, _, onCleanup) => {
  if (!detailed) return;
  traceNow.value = Date.now();
  const timer = setInterval(() => { traceNow.value = Date.now() }, 1_000);
  onCleanup(() => clearInterval(timer));
}, { immediate: true });
const { activity: resultActivity } = useResultActivity();
const traceDisclosure = inject('chat:trace-disclosure', new TraceDisclosureController());

const transcriptEntries = computed(() => reporting.standardEntries(controller.messages.value, props.reportingLevel, item => !!resultActivity(item).decision));
const replyCitations = computed(() => citationProjection.project(transcriptEntries.value));
const traceTurns = computed(() => props.reportingLevel === 'debug'
  ? traceProjection.project(controller.messages.value, transcriptEntries.value, { agents: agentState?.snapshot.value.rows })
  : []);
const trailingTraceTurns = computed(() => traceTurns.value.filter(turn => !transcriptEntries.value.some(entry => entry.id === turn.anchorEntryId)));
function reportLabelVisible(entry: TranscriptEntry): boolean {
  if (entry.kind !== 'card') return true;
  if (entry.message.kind === 'proactive' && entry.message.result) return false;
  return !['Message', 'Reply', 'Evidence', 'Handoff'].includes(entry.label);
}
const { showPill, scrollToBottom } = useScrollAnchor(scroller, transcriptEntries);

// Detailed activity has its own timestamps; only cards participate in
// the existing shared card-minute stamps.
const times = computed(() => LineTimes.lineTimes(transcriptEntries.value.filter(entry => entry.kind === 'card').map(entry => ({
  id: entry.id,
  at: LineTimes.idTime(entry.sourceId) ?? entry.createdAt,
}))));
provide(LineTimeKey, id => times.value.get(id));

// "Jump to" from the side dock, status line or quick switcher: whichever
// transcript shows the message scrolls to it.
const jumper = new TranscriptJump();
function onJump(event: Event): void {
  const messageId = (event as CustomEvent<{ messageId?: string }>).detail?.messageId;
  if (messageId) jumper.jump(transcriptEntries.value, String(messageId), matchMedia('(prefers-reduced-motion: reduce)').matches);
}
let loadingOlder = false;
let historyExhausted = false;
let pageEpoch = 0;
watch(() => controller.thread.value.id, () => {
  pageEpoch++;
  loadingOlder = false;
  historyExhausted = false;
}, { flush: 'sync' });
async function loadOlderOnScroll(): Promise<void> {
  const el = scroller.value;
  if (!el) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) controller.releaseOlderPages();
  if (loadingOlder || historyExhausted || el.scrollTop >= 200) return;
  const messages = controller.messages.value;
  const oldest = messages[0];
  if (!oldest) return;
  const threadId = controller.thread.value.id;
  const epoch = pageEpoch;
  loadingOlder = true;
  try {
    const count = await ipcRenderer.invoke('chat-messages:message-count', threadId);
    if (epoch !== pageEpoch) return;
    if (!count.success || count.count <= messages.length) { historyExhausted = true; return; }
    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    const page = await ipcRenderer.invoke('chat-messages:load-before', { threadId, beforeMessageId: oldest.id, limit: 50 });
    if (epoch !== pageEpoch || !page.success) return;
    const older = page.data ?? [];
    controller.prependOlder(older);
    if (older.length < 50) historyExhausted = true;
    await nextTick();
    if (epoch === pageEpoch) el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
  } finally { if (epoch === pageEpoch) loadingOlder = false; }
}
onMounted(() => { window.addEventListener('chat:jump-to-message', onJump); scroller.value?.addEventListener('scroll', loadOlderOnScroll, { passive: true }); });
onBeforeUnmount(() => { pageEpoch++; window.removeEventListener('chat:jump-to-message', onJump); scroller.value?.removeEventListener('scroll', loadOlderOnScroll); });

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
  padding: 96px 8% var(--scroller-pad-b, 240px);
  scroll-behavior: smooth;
  /* Messages fade out just above the message box instead of running up
     against (or behind) it. --composer-h is the box's live height. */
  --tr-fade-end: calc(var(--composer-h, 140px) - 4px);
  mask-image: linear-gradient(to top, transparent var(--tr-fade-end), #000 calc(var(--tr-fade-end) + 56px));
}
.scroller.has-scroll-pill {
  /* Reserve a lane between the transcript and composer for the jump control. */
  bottom: calc(var(--composer-h, 140px) + 72px);
  mask-image: none;
}
.transcript-standard .scroller {
  padding-top: 112px;
}
/*
 * With an aside the scroller drops its side padding so the aside can reach
 * the right edge; the messages get the same 8% inset as margins instead.
 * --chart-gutter-w (set by ChatPage while the chart sits in the gutter)
 * keeps the messages exactly where they were when the chart was a column
 * beside the transcript: 8% of the narrower column on each side, plus the
 * gutter on the right.
 */
.scroller.has-aside { padding-right: 0; padding-left: 0; }
.scroller.has-aside > .chat-dialogue {
  margin-right: calc(8% + 0.92 * var(--chart-gutter-w, 0px));
  margin-left: calc(8% - 0.08 * var(--chart-gutter-w, 0px));
}
/*
 * The aside layer covers the visible transcript from the top edge down to
 * the bottom padding, pinned with sticky. Floated with no width so it takes
 * no room from the messages; its children position against it.
 */
.scroller-aside {
  position: sticky;
  top: 0;
  z-index: 20;
  float: right;
  width: 0;
  height: calc(100% + 96px);
  margin-top: -96px;
}
.transcript-standard .scroller-aside {
  height: calc(100% + 112px);
  margin-top: -112px;
}
/* The jump pill stays centred over the messages, not the gutter. */
.transcript :deep(.scroll-pill) { left: calc(50% - var(--chart-gutter-w, 0px) / 2); }
.report-entry { display: flex; flex-direction: column; min-width: 0; }
.report-label {
  color: var(--text-muted); margin-bottom: 4px;
  font: 10px var(--font-mono, ui-monospace, monospace); letter-spacing: .06em;
  text-transform: uppercase;
}
.report-label-user { align-self: flex-end; }
.report-activity { color: var(--text-secondary); font-size: 13px; }
.report-activity-time { margin-inline-start: 8px; color: var(--text-muted); }
.scroller::-webkit-scrollbar { width: 8px; }
.scroller::-webkit-scrollbar-track { background: transparent; }
.scroller::-webkit-scrollbar-thumb { background: var(--accent-dim); border-radius: 4px; }
.scroller::-webkit-scrollbar-thumb:hover { background: var(--accent-glow); }
</style>
