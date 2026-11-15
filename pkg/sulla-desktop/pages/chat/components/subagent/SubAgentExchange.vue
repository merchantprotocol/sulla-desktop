<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  One line per handoff between Sulla and a sub-agent. "Sent to" carries the
  agent's live status and, on demand, the brief Sulla gave it. A return is
  shown only when no result card covers the same job: the card is the return,
  so repeating it here added a second and third copy of the same news.
-->
<template>
  <div
    v-if="!coveredByCard"
    class="sx"
  >
    <div class="sx-line">
      <span
        class="sx-arrow"
        aria-hidden="true"
      >{{ msg.direction === 'to_agent' ? '→' : '←' }}</span>
      <span class="sx-text">
        {{ msg.direction === 'to_agent' ? 'Sent to' : 'Returned from' }}
        <button
          v-if="msg.conversationId"
          type="button"
          class="sx-agent"
          title="Open this agent's conversation"
          @click="openConversation"
        >{{ msg.agentId }}</button>
        <b v-else>{{ msg.agentId }}</b>
        · {{ msg.label }}
      </span>
      <span
        class="sx-status"
        :class="`sx-${status.tone}`"
      ><span class="sx-dot" />{{ status.text }}</span>
      <button
        v-if="msg.detail"
        type="button"
        class="sx-link"
        :aria-expanded="showDetail"
        @click="showDetail = !showDetail"
      >
        {{ msg.direction === 'to_agent' ? 'Brief' : 'Report' }}
      </button>
    </div>
    <pre
      v-if="showDetail"
      class="sx-detail"
    >{{ msg.detail }}</pre>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref } from 'vue';

import { useChatController } from '../../controller/useChatController';
import { parseLegacyAgentNotice } from '../../messages/legacyAgentNotice';

import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';

import type { OpenSubAgentConversation } from './subAgentConversation';
import type { ProactiveMessage, SubAgentExchangeMessage } from '../../models/Message';

const props = defineProps<{ msg: SubAgentExchangeMessage }>();
const open = inject<OpenSubAgentConversation | undefined>('chat:open-subagent-conversation', undefined);
const live = inject(AGENT_STATE_CLIENT_KEY, undefined);
let controller: ReturnType<typeof useChatController> | undefined;
try { controller = useChatController() } catch { /* outside a chat page */ }

const showDetail = ref(false);

const sameTask = (jobId?: string, taskIndex?: number) => !!props.msg.jobId && jobId === props.msg.jobId && (props.msg.taskIndex ?? 0) === (taskIndex ?? 0);

/** The result card for this job, if one is in the chat. */
const card = computed(() => {
  for (const message of controller?.messages.value ?? []) {
    if (message.kind !== 'proactive') continue;
    const item = (message).result?.items.find(entry => sameTask(entry.jobId, entry.taskIndex));
    if (item) return item;
  }
  return undefined;
});

const coveredByCard = computed(() => props.msg.direction === 'from_agent' && !!card.value);

const STATE: Record<string, { text: string; tone: string }> = {
  queued:  { text: 'Starting', tone: 'run' },
  working: { text: 'Working', tone: 'run' },
  quiet:   { text: 'No check-in', tone: 'bad' },
  parked:  { text: 'Waiting', tone: 'wait' },
  blocked: { text: 'Blocked', tone: 'warn' },
  done:    { text: 'Done', tone: 'ok' },
  failed:  { text: 'Failed', tone: 'bad' },
  lost:    { text: 'Lost', tone: 'bad' },
  stopped: { text: 'Stopped', tone: 'dim' },
};
const CARD_TONE: Record<string, string> = { ok: 'ok', warn: 'warn', bad: 'bad', info: 'wait', dim: 'dim' };

/** Live state first, then the result card, then what the handoff itself recorded. */
const status = computed(() => {
  const row = live?.snapshot.value.rows.find(entry => sameTask(entry.jobId, entry.taskIndex));
  if (row && STATE[row.state]) return STATE[row.state];
  if (card.value) return { text: card.value.verdict, tone: CARD_TONE[card.value.tone] ?? 'dim' };
  // A job that finished before result cards existed: its old text notice says how it ended.
  for (const message of controller?.messages.value ?? []) {
    if (message.kind !== 'proactive' || (message).result) continue;
    const notice = parseLegacyAgentNotice((message).headline, (message).body);
    if (notice?.jobId && notice.jobId === props.msg.jobId) return { text: notice.verdict, tone: CARD_TONE[notice.tone] ?? 'dim' };
  }
  if (props.msg.status === 'running') return props.msg.direction === 'to_agent' ? { text: 'Started', tone: 'run' } : STATE.working;
  return STATE[props.msg.status === 'failed' ? 'failed' : props.msg.status] ?? STATE.done;
});

function openConversation(): void {
  if (!props.msg.conversationId) return;
  open?.({ agentId: props.msg.agentId, label: props.msg.label, conversationId: props.msg.conversationId });
}
</script>

<style scoped>
/* Component-prefixed classes: themes restyle generic names like .label. */
.sx {
  --sx-ink-2: color-mix(in srgb, var(--text-primary) 78%, var(--bg-surface));
  --sx-ink-3: color-mix(in srgb, var(--text-primary) 58%, var(--bg-surface));
  margin: 8px 0;
  font-family: var(--font-body);
}
.sx-line {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 10px; align-items: center;
  padding: 7px 12px; border: 1px solid var(--border-default); border-radius: 9px;
  background: color-mix(in srgb, var(--bg-page) 55%, transparent); color: var(--sx-ink-2); font-size: 13px;
}
.sx-arrow {
  display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-size: 12px;
}
.sx-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sx-text b, .sx-agent { color: var(--text-primary); font-weight: 600; }
.sx-agent { padding: 0; border: 0; background: none; font: inherit; cursor: pointer; text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--text-primary) 30%, transparent); text-underline-offset: 2px; }
.sx-agent:hover { text-decoration-color: currentColor; }
.sx-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--sx-ink-3); white-space: nowrap; }
.sx-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--sx-ink-3); }
.sx-run .sx-dot { background: var(--accent); }
.sx-ok .sx-dot { background: var(--status-success); }
.sx-warn .sx-dot { background: var(--status-warning); }
.sx-bad .sx-dot { background: var(--status-error); }
.sx-wait .sx-dot { background: color-mix(in srgb, var(--accent) 55%, var(--sx-ink-3)); }
.sx-link { padding: 0; border: 0; background: none; color: var(--sx-ink-2); font: inherit; font-size: 12.5px; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.sx-link:hover { color: var(--text-primary); }
.sx-agent:focus-visible, .sx-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
.sx-detail {
  max-height: 320px; overflow: auto; margin: 6px 0 0 32px; padding: 10px 12px; border-radius: 9px;
  background: color-mix(in srgb, var(--bg-surface) 55%, var(--bg-page)); color: var(--sx-ink-2);
  font: 12.5px/1.6 var(--font-mono, ui-monospace, monospace); white-space: pre-wrap; overflow-wrap: anywhere;
}
@media (max-width: 560px) {
  .sx-line { grid-template-columns: auto minmax(0, 1fr); }
  .sx-status, .sx-link { grid-column: 2; }
}
</style>
