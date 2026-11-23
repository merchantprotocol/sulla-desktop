<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- Sulla reaching out unprompted (build done, brief ready, etc.) -->
<template>
  <AgentResultCard
    v-if="msg.result"
    :data="msg.result"
    :message-id="msg.id"
    :standard="reportingLevel === 'info'"
  />
  <!-- An old text notice about finished agents: one compact line, hidden once a result card covers its job. -->
  <div
    v-else-if="legacy && !legacyCovered"
    class="pc-legacy"
  >
    <span
      class="pc-chip"
      :class="`pc-${legacy.tone}`"
    ><span class="pc-dot" />{{ legacy.verdict }}</span>
    <span class="pc-text"><b>{{ legacy.label }}</b> · finished before result cards existed</span>
    <button
      v-if="legacyConversation"
      type="button"
      class="pc-link"
      @click="openLegacy"
    >
      Open agent
    </button>
  </div>
  <div
    v-else-if="!legacy"
    class="proactive"
  >
    <div class="head">
      Sulla · proactive
    </div>
    <div class="body">
      <strong>{{ msg.headline }}</strong> {{ msg.body }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue';

import AgentResultCard from './AgentResultCard.vue';
import { useChatController } from '../../controller/useChatController';
import { LegacyAgentNotices } from '../../messages/legacyAgentNotice';

import type { ProactiveMessage, SubAgentExchangeMessage } from '../../models/Message';
import type { ReportingLevel } from '../../models/ReportingLevel';
import type { OpenSubAgentConversation } from '../subagent/subAgentConversation';

const props = withDefaults(defineProps<{ msg: ProactiveMessage; reportingLevel?: ReportingLevel }>(), { reportingLevel: 'debug' });
const open = inject<OpenSubAgentConversation | undefined>('chat:open-subagent-conversation', undefined);
let controller: ReturnType<typeof useChatController> | undefined;
try { controller = useChatController() } catch { /* outside a chat page */ }

const legacy = computed(() => (props.msg.result ? undefined : LegacyAgentNotices.parseLegacyAgentNotice(props.msg.headline, props.msg.body)));
const others = computed(() => controller?.messages.value ?? []);
/** A result card for the same job already says everything this notice did. */
const legacyCovered = computed(() => !!legacy.value?.jobId && others.value.some(message =>
  message.kind === 'proactive' && (message).result?.items.some(item => item.jobId === legacy.value!.jobId)));
const legacyConversation = computed(() => {
  if (!legacy.value?.jobId) return undefined;
  const handoff = others.value.find((message): message is SubAgentExchangeMessage =>
    message.kind === 'subagent_exchange' && (message).jobId === legacy.value!.jobId && !!(message).conversationId);
  return handoff ? { agentId: handoff.agentId, label: handoff.label, conversationId: handoff.conversationId! } : undefined;
});
function openLegacy(): void {
  if (legacyConversation.value) open?.(legacyConversation.value);
}
</script>

<style scoped>
.proactive {
  padding: 14px 18px; border-radius: 12px;
  background:
    radial-gradient(ellipse at top right, var(--accent-dim), transparent 70%),
    var(--accent-glow);
  border: 1px solid var(--accent-dim);
  border-right-width: 3px; border-right-color: var(--accent-hover);
}
.head {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.28em;
  text-transform: uppercase; color: var(--accent-hover);
  margin-bottom: 8px;
  display: flex; align-items: center; gap: 10px;
}
.head::before {
  content: "◇"; color: var(--accent-hover); font-size: 14px;
  filter: drop-shadow(0 0 6px var(--accent-hover));
}
.body {
  font-family: var(--font-display); font-size: 16px; line-height: 1.55;
  color: var(--text-primary);
  white-space: pre-wrap;
}
.body strong { color: var(--text-on-accent); font-style: italic; font-weight: 600; margin-right: 4px; }
.pc-legacy {
  --pc-ink-2: color-mix(in srgb, var(--text-primary) 78%, var(--bg-surface));
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center;
  padding: 8px 12px; border: 1px dashed var(--border-strong); border-radius: 9px;
  color: var(--pc-ink-2); font-family: var(--font-body); font-size: 13px;
}
.pc-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-text b { color: var(--text-primary); font-weight: 600; }
.pc-chip { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: 6px; font-size: 11px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; }
.pc-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pc-ok { background: color-mix(in srgb, var(--status-success) 16%, transparent); color: var(--status-success); }
.pc-warn { background: color-mix(in srgb, var(--status-warning) 16%, transparent); color: var(--status-warning); }
.pc-bad { background: color-mix(in srgb, var(--status-error) 16%, transparent); color: var(--status-error); }
.pc-dim { background: color-mix(in srgb, var(--text-primary) 8%, transparent); color: var(--pc-ink-2); }
.pc-link { padding: 0; border: 0; background: none; color: var(--pc-ink-2); font: inherit; font-size: 12.5px; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.pc-link:hover { color: var(--text-primary); }
.pc-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
</style>
