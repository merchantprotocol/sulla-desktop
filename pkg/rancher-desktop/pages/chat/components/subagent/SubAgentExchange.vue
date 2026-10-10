<template>
  <details
    class="exchange"
    :class="`is-${msg.status}`"
  >
    <summary>
      <span
        class="direction"
        aria-hidden="true"
      >{{ msg.direction === 'to_agent' ? '→' : '←' }}</span>
      <button
        type="button"
        class="agent"
        :disabled="!msg.conversationId"
        @click.prevent.stop="openConversation"
      >
        {{ msg.agentId }}
      </button>
      <span class="label">{{ msg.label }}</span>
      <span class="summary">{{ msg.summary }}</span>
      <span
        class="chevron"
        aria-hidden="true"
      >⌄</span>
    </summary>
    <pre>{{ msg.detail }}</pre>
  </details>
</template>

<script setup lang="ts">
import { inject } from 'vue';

import type { OpenSubAgentConversation } from './subAgentConversation';
import type { SubAgentExchangeMessage } from '../../models/Message';

const props = defineProps<{ msg: SubAgentExchangeMessage }>();
const open = inject<OpenSubAgentConversation>('chat:open-subagent-conversation');

function openConversation(): void {
  if (!props.msg.conversationId) return;
  open?.({
    agentId:        props.msg.agentId,
    label:          props.msg.label,
    conversationId: props.msg.conversationId,
  });
}
</script>

<style scoped>
.exchange {
  margin: 8px 0;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-surface-alt);
  color: var(--text-primary);
  font-family: var(--mono);
  font-size: 11px;
}
summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 6px 10px;
  cursor: pointer;
  list-style: none;
}
summary::-webkit-details-marker { display: none; }
.direction { color: var(--accent-primary); font-size: 16px; }
.agent {
  padding: 0;
  color: var(--accent-primary);
  font: inherit;
  font-weight: 700;
}
.agent:disabled { color: var(--text-secondary); cursor: default; }
.label { color: var(--text-secondary); }
.summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chevron { margin-left: auto; color: var(--text-muted); transition: transform 0.15s ease; }
.exchange[open] .chevron { transform: rotate(180deg); }
pre {
  margin: 0;
  padding: 10px;
  overflow: auto;
  white-space: pre-wrap;
  border-top: 1px solid var(--border-default);
  color: var(--text-secondary);
  font: 11px/1.5 var(--mono);
}
.is-done, .is-failed, .is-stopped { opacity: 0.78; }
</style>
