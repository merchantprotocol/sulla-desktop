<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <ToolApproval
    v-if="routedRecord && msg.kind === 'tool_approval' && approvalMessage"
    :msg="approvalMessage"
    :decision="routedRecord"
    :blocked="routeBusy"
    :decide="decide"
    show-decide-link
  />
  <ToolQuestion
    v-else-if="routedRecord && msg.kind === 'tool_question' && questionMessage"
    :msg="questionMessage"
    :decision="routedRecord"
    :blocked="routeBusy"
    :submit-answers="answerQuestion"
  />
  <div v-else class="decision-reference">
    <span>{{ label }}</span>
    <button type="button" @click="store.show(decisionId)">Open For You</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ChatDecisions } from '../../composables/useChatDecisions';
import type { ToolApprovalMessage, ToolQuestionAnswerItem, ToolQuestionMessage } from '../../models/Message';
import { DecisionAttention } from '@pkg/shared/decisionAttention';
import type { DecisionRecord } from '@pkg/shared/decisions';
import ToolApproval from '../tool/ToolApproval.vue';
import ToolQuestion from '../tool/ToolQuestion.vue';

const props = defineProps<{ msg: ToolApprovalMessage | ToolQuestionMessage }>();
const store = ChatDecisions.useChatDecisions();
const decisionId = computed(() => props.msg.kind === 'tool_question' ? props.msg.questionId : props.msg.approvalId);
const routedRecord = computed(() => store.decisions.value.find(item => item.id === decisionId.value && item.route));
const active = computed(() => !!routedRecord.value && DecisionAttention.active(routedRecord.value, store.now.value));
const routeBusy = computed(() => !!routedRecord.value && store.busy(routedRecord.value.id));
const label = computed(() => {
  const record = store.decisions.value.find(item => item.id === decisionId.value);
  return record ? `${DecisionAttention.label(record, store.now.value)} · For You` : 'Request saved in For You';
});
const approvalMessage = computed(() => {
  if (props.msg.kind !== 'tool_approval') return undefined;
  const record = routedRecord.value;
  if (!record) return props.msg;
  const decision = record.status === 'approved' || record.status === 'denied' ? record.status : active.value ? 'pending' : 'timed_out';
  return {
    ...props.msg,
    title: record.title,
    expiresAt: record.expiresAt,
    reason: record.approvalPresentation?.reason ?? `Approval details for ${record.toolName || record.title}.`,
    command: record.approvalPresentation?.command ?? record.toolName ?? record.title,
    requestedBy: record.requestedBy ? { agentId: record.requestedBy.agentId || record.requestedBy.label || 'default agent', label: record.requestedBy.label } : undefined,
    decision,
    resolutionError: store.actionError(record.id),
  } satisfies ToolApprovalMessage;
});
const questionMessage = computed(() => {
  if (props.msg.kind !== 'tool_question') return undefined;
  const record = routedRecord.value;
  if (!record) return props.msg;
  const answered = record.status === 'answered' || record.attention === 'answered' || !!record.answers?.length;
  return {
    ...props.msg,
    status: active.value ? 'pending' : answered ? 'answered' : 'timed_out',
    expiresAt: record.expiresAt,
    answers: active.value ? undefined : record.answers,
    resolutionError: store.actionError(record.id),
  } satisfies ToolQuestionMessage;
});

function answerQuestion(answers: ToolQuestionAnswerItem[]): Promise<void> {
  const record = routedRecord.value;
  return record
    ? store.resolve(record, 'answered', answers.map(answer => ({ question: answer.question, selected: [...answer.selected] })))
    : Promise.reject(new Error('Request unavailable.'));
}

async function decide(action: 'approved' | 'denied'): Promise<void> {
  const record = routedRecord.value;
  if (!record) return;
  try { await store.resolve(record, action) } catch { /* The shared store displays the error. */ }
}
</script>

<style scoped>
.decision-reference { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; color: var(--text-secondary); font-size: 12px; padding: 5px 0; }
.decision-reference button { font: inherit; border: 0; background: none; color: var(--primary-color-text-override, var(--accent)); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.decision-reference button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
</style>
