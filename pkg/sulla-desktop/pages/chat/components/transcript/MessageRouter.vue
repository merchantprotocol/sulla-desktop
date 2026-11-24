<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  MessageRouter — picks the right component for a given Message.kind.

  To add a new kind:
    1. Add a type in models/Message.ts
    2. Add a case below
    3. Done.

  The dedicated `<component :is>` switch keeps the transcript free of
  v-if ladders and keeps kinds orthogonal.
-->
<template>
  <InlineFileMessage v-if="msg.kind === 'inline_file_reference'" :reference="{ fileId: msg.fileId, collectionId: msg.collectionId, toolCallId: msg.toolCallId, threadId: msg.threadId }" />
  <TurnUser        v-else-if="msg.kind === 'user'"          :msg="msg" @edit="onEdit" />
  <TurnSulla       v-else-if="msg.kind === 'sulla'"    :msg="msg"
    @regenerate="controller.regenerate(msg.id)"
    @pin="controller.togglePin(msg.id)"
  >
    <template v-if="$slots.sources" #sources><slot name="sources" /></template>
  </TurnSulla>
  <div v-else-if="msg.kind === 'html'" class="chat-turn sulla chat-fade-in">
    <InlineReplyBody class="chat-body" :text="msg.html" legacy-html />
    <slot name="sources" />
  </div>
  <TurnStreaming   v-else-if="msg.kind === 'streaming'" :msg="msg" :paragraph-break="streamingParagraphBreak">
    <template v-if="$slots.sources" #sources><slot name="sources" /></template>
  </TurnStreaming>
  <TurnInterim     v-else-if="msg.kind === 'interim'"   :msg="msg" />
  <div v-if="filesPublishApproval && !inlineRecord" class="approval-unavailable" role="status">
    <span>{{ checking ? 'Loading approval details…' : 'Approval details are unavailable.' }}</span>
    <button v-if="checking && decisions.inlineReadFailed.value" type="button" @click="decisions.refreshInline">Retry loading request</button>
  </div>
  <div v-else-if="decisionId && (mainDecisionTranscript || msg.kind === 'tool_approval') && (!inboxRecord || inlineRecord) && (msg.kind === 'tool_approval' || msg.kind === 'tool_question')">
    <ToolApproval
      v-if="msg.kind === 'tool_approval'"
      :msg="approvalMessage(msg)" :blocked="blocked"
      :state-label="decisionLabel" :decide="inlineRecord ? decide : undefined" :show-decide-link="Boolean(inlineRecord)"
    />
    <ToolTask
      v-else-if="TaskAsks.isTask(msg)"
      :key="decisionCardKey"
      :msg="questionMessage(msg)" :draft="questionDraft(msg)"
      :blocked="blocked" :state-label="decisionLabel"
      :submit-answer="inlineRecord ? taskAnswer : undefined"
    />
    <ToolQuestion
      v-else
      :key="decisionCardKey"
      :msg="questionMessage(msg)" :draft="questionDraft(msg)"
      :blocked="blocked" :state-label="decisionLabel"
      :retain-options="!!inlineRecord || checking" :submit-answers="inlineRecord ? answer : undefined"
    />
    <button v-if="checking && decisions.inlineReadFailed.value" type="button" @click="decisions.refreshInline">Retry loading request</button>
  </div>
  <DecisionReference v-else-if="inboxRecord && (msg.kind === 'tool_question' || msg.kind === 'tool_approval')" :msg="msg" />
  <ToolApproval v-else-if="msg.kind === 'tool_approval'" :msg="msg"
    :blocked="msg.origin?.kind === 'files_publish' && (!inlineRecord || checking)" />
  <ToolTask v-else-if="TaskAsks.isTask(msg)" :msg="msg" :draft="questionDraft(msg)" />
  <ToolQuestion v-else-if="msg.kind === 'tool_question'" :msg="msg" :draft="questionDraft(msg)" />
  <PatchBlock      v-else-if="msg.kind === 'patch'"     :msg="msg" />
  <ChannelMessage  v-else-if="msg.kind === 'channel'"   :msg="msg" />
  <CitationRow     v-else-if="msg.kind === 'citation'"  :msg="msg" />
  <MemoryNote      v-else-if="msg.kind === 'memory'"    :msg="msg" />
  <ProactiveCard   v-else-if="msg.kind === 'proactive'" :msg="msg" />
  <HeartbeatMessage v-else-if="msg.kind === 'heartbeat'" :msg="msg" />
  <TtsIndicator    v-else-if="msg.kind === 'tts'"       :msg="msg" />
  <ErrorCard       v-else-if="msg.kind === 'error'"     :msg="msg" @action="onErrorAction" />
  <NoticeCard
    v-else-if="msg.kind === 'notice'"
    :msg="msg" @action="onErrorAction"
  />
  <div v-else />
</template>

<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import { DecisionAttention } from '@pkg/shared/decisionAttention';
import DecisionReference from './DecisionReference.vue';
import InlineReplyBody from './InlineReplyBody.vue';
import InlineFileMessage from '../files/InlineFileMessage.vue';
import ErrorCard       from './ErrorCard.vue';
import NoticeCard      from './NoticeCard.vue';
import TtsIndicator    from './TtsIndicator.vue';
import TurnInterim     from './TurnInterim.vue';
import TurnStreaming   from './TurnStreaming.vue';
import TurnSulla       from './TurnSulla.vue';
import TurnUser        from './TurnUser.vue';
import { ChatDecisions } from '../../composables/useChatDecisions';
import { useChatController } from '../../controller/useChatController';
import { TaskAsks } from '../../messages/taskAsk';
import ChannelMessage  from '../channel/ChannelMessage.vue';
import CitationRow     from '../citation/CitationRow.vue';
import HeartbeatMessage from '../heartbeat/HeartbeatMessage.vue';
import MemoryNote      from '../memory/MemoryNote.vue';
import PatchBlock      from '../patch/PatchBlock.vue';
import ProactiveCard   from '../proactive/ProactiveCard.vue';
import ToolApproval    from '../tool/ToolApproval.vue';
import ToolQuestion    from '../tool/ToolQuestion.vue';
import ToolTask        from '../tool/ToolTask.vue';
import type { CardMessage } from './toolGroups';
import type { ToolApprovalMessage, ToolQuestionAnswerItem, ToolQuestionMessage } from '../../models/Message';

const props = defineProps<{ msg: CardMessage; streamingParagraphBreak?: boolean }>();
const streamingParagraphBreak = computed(() => props.streamingParagraphBreak ?? false);
const controller = useChatController();
const decisions = ChatDecisions.useChatDecisions();
const mainDecisionTranscript = inject('chat:main-decision-transcript', ref(false));
const decisionId = computed(() => props.msg.kind === 'tool_question' ? props.msg.questionId :
  props.msg.kind === 'tool_approval' ? props.msg.approvalId : undefined);
const inboxRecord = computed(() => decisions.decisions.value.find(record => record.id === decisionId.value));
const inlineRecord = computed(() => {
  const kind = props.msg.kind === 'tool_question' ? 'question' : 'approval';
  const canInline = mainDecisionTranscript.value || props.msg.kind === 'tool_approval';
  return canInline && decisionId.value ? decisions.inlineRecord(decisionId.value, kind) : undefined;
});
const filesPublishApproval = computed(() => props.msg.kind === 'tool_approval' && props.msg.origin?.kind === 'files_publish');
const checking = computed(() => !!((mainDecisionTranscript.value || props.msg.kind === 'tool_approval') && decisionId.value && decisions.checkingInline(decisionId.value)));
const decisionCardKey = computed(() => inlineRecord.value ? 'saved' : checking.value ? 'loading' : 'original');
const blocked = computed(() => checking.value || (filesPublishApproval.value && !inlineRecord.value) || !!(inlineRecord.value && decisions.busy(inlineRecord.value.id)));
const active = computed(() => !!inlineRecord.value && DecisionAttention.active(inlineRecord.value, decisions.now.value));
const decisionLabel = computed(() => {
  const record = inlineRecord.value;
  if (!record) return undefined;
  if (record.kind === 'approval' && (record.status === 'expired' || record.expiresAt <= decisions.now.value)) return 'Expired';
  // Keep the original Done/Replied or Answered state for a finished answer.
  if (record.status === 'answered' || record.answerDelivery === 'delivered') return undefined;
  if (active.value && record.status === 'expired' && !record.answerDelivery) return 'Sulla stopped waiting. Your answer will be queued in this chat.';
  return !active.value || record.answerDelivery ? DecisionAttention.label(record, decisions.now.value) : undefined;
});
function approvalMessage(message: ToolApprovalMessage): ToolApprovalMessage {
  const record = inlineRecord.value;
  if (!record) return message;
  const decision = record.status === 'approved' || record.status === 'denied' ? record.status : active.value ? 'pending' : 'timed_out';
  const presentation = record.approvalPresentation;
  return {
    ...message,
    title: record.title,
    expiresAt: record.expiresAt,
    ...(presentation ? { reason: presentation.reason, command: presentation.command, origin: presentation.origin } : {}),
    requestedBy: record.requestedBy ? { agentId: record.requestedBy.agentId, label: record.requestedBy.label } : undefined,
    decision,
    resolutionError: decisions.actionError(record.id),
  };
}
function questionMessage(message: ToolQuestionMessage): ToolQuestionMessage {
  const record = inlineRecord.value;
  if (!record) return message;
  const status = active.value ? 'pending' : (record.status === 'answered' || record.attention === 'answered' || record.answers?.length) ? 'answered' : 'timed_out';
  return {
    ...message,
    status,
    expiresAt: record.expiresAt,
    answers: active.value ? undefined : record.answers,
    resolutionError: decisions.actionError(record.id),
    resolutionNote: undefined,
  };
}
function questionDraft(message: ToolQuestionMessage) {
  if (checking.value) return undefined;
  return decisions.draft(inlineRecord.value ?? { id: message.questionId ?? message.id, questions: message.questions });
}
function answer(answers: ToolQuestionAnswerItem[]) {
  const record = inlineRecord.value;
  if (!record) return Promise.reject(new Error('Request unavailable.'));
  return decisions.resolve(record, 'answered', answers.map(item => ({ question: item.question, selected: [...item.selected] })));
}
function taskAnswer(value: string) {
  if (props.msg.kind !== 'tool_question') return Promise.reject(new Error('Task unavailable.'));
  return answer([{ question: props.msg.questions[0].question, selected: [value] }]);
}
async function decide(action: 'approved' | 'denied') {
  const record = inlineRecord.value;
  if (record) await decisions.resolve(record, action).catch(() => { /* The shared store displays the error. */ });
}

function onEdit(): void {
  // Placeholder — a future EditMessageOverlay fires this; wire into
  // controller.editMessage(msg.id, newText) from there.
}

function onErrorAction(kind: 'retry' | 'continue' | 'dismiss' | 'connect'): void {
  if (kind === 'connect') window.dispatchEvent(new CustomEvent('sulla:open-ai-connections'));
}
</script>

<style scoped>
.approval-unavailable { display: flex; align-items: center; gap: 10px; color: var(--text-secondary); font-size: 12px; padding: 8px 0; }
.approval-unavailable button { border: 0; padding: 0; background: none; color: var(--accent); font: inherit; text-decoration: underline; cursor: pointer; }
</style>
