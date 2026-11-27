<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <section ref="root" class="fy" aria-label="Decide">
    <header class="fy-head">
      <div>
        <h2>Decide</h2>
        <p class="fy-muted fy-count">{{ active.length ? `${active.length} active` : 'Questions and approvals for this chat' }}</p>
      </div>
      <button class="fy-refresh" type="button" :disabled="store.loading.value" @click="store.refresh">
        {{ store.loading.value ? 'Refreshing…' : 'Refresh' }}
      </button>
    </header>
    <p v-if="store.error.value" class="fy-state fy-error" role="alert">{{ store.error.value }} <button type="button" @click="store.refresh">Try again</button></p>
    <p v-if="store.loading.value && !store.decisions.value.length" class="fy-state" role="status">Loading your requests…</p>
    <div v-else-if="!active.length && !store.error.value" class="fy-empty">
      <span class="fy-empty-mark" aria-hidden="true">✓</span>
      <div><h3>Nothing needs you</h3><p>New questions and approvals will appear here automatically.</p></div>
    </div>
    <article v-for="record in active" :key="record.id" :data-decision-id="record.id" class="fy-request">
      <div class="fy-meta"><span>{{ record.conversationId === owner ? 'Sulla' : 'Linked agent' }} · {{ LineTimes.shortTime(record.createdAt) }}</span><button v-if="messageFor(record) || record.conversationId !== owner" type="button" @click="jump(record)">View in chat</button></div>
      <p v-if="showRequestTitle(record)">{{ record.title }}</p>
      <p v-if="record.answerDelivery === 'interrupted'" role="status">Your answer is saved, but Sulla could not confirm it finished handling it. Check the original chat before submitting the saved answer again.</p>
      <p v-else-if="record.kind === 'question' && record.status === 'expired'" class="fy-muted">Sulla stopped waiting. Your answer will be queued in the original chat without interrupting running work.</p>
      <p v-if="store.actionError(record.id)" role="alert">{{ store.actionError(record.id) }}</p>
      <!-- View in chat is navigation; it must not replace the durable answer controls. -->
      <DecisionReference v-if="record.route && record.kind === 'approval'" :msg="routedApproval(record)" />
      <template v-else-if="record.kind === 'question'">
        <pre v-if="record.questions?.length !== 1 || !record.questions[0].task" v-for="question in record.questions?.filter(question => question.command)" :key="question.question" class="fy-command">{{ question.command }}</pre>
        <DecisionHolderLine v-if="record.route && record.questions?.length === 1 && record.questions[0].task" :presentation="presenter.present(record)" compact />
        <ToolTask v-if="record.questions?.length === 1 && record.questions[0].task" :msg="questionMessage(record)" :draft="store.draft(record)" :blocked="store.busy(record.id)" :submit-answer="value => taskAnswer(record, value)" />
        <ToolQuestion v-else :msg="questionMessage(record)" :decision="record" persistent :draft="store.draft(record)" :blocked="store.busy(record.id)" :submit-answers="answers => answer(record, answers)" />
      </template>
      <template v-else>
        <p v-if="record.toolName" class="fy-muted">Approval for {{ record.toolName }}</p>
        <pre v-if="approvalCommand(record)" class="fy-command">{{ approvalCommand(record) }}</pre>
        <div class="fy-actions"><button type="button" class="fy-primary" :disabled="store.busy(record.id)" @click="decide(record, 'approved')">Approve</button><button type="button" :disabled="store.busy(record.id)" @click="decide(record, 'denied')">Deny</button></div>
      </template>
      <button type="button" class="fy-dismiss" :disabled="store.busy(record.id)" @click="dismiss(record)">Dismiss</button>
      <p class="fy-hint">Dismiss removes this request from your active list. It does not grant approval or change running work.</p>
    </article>
    <details class="fy-past" :open="pastOpen" @toggle="pastOpen = ($event.target as HTMLDetailsElement).open">
      <summary>Past · {{ past.length }}{{ store.hasMore.value ? '+' : '' }}</summary>
      <article v-for="record in past" :key="record.id" :data-decision-id="record.id" class="fy-past-item">
        <div class="fy-meta"><span>{{ DecisionAttention.label(record, store.now.value) }} · {{ LineTimes.shortTime(record.createdAt) }}</span><button v-if="messageFor(record) || record.conversationId !== owner" type="button" @click="jump(record)">View in chat</button></div>
        <h3>{{ record.title }}</h3>
        <p v-if="record.supersededBy" class="fy-muted">These same questions have a saved answer on a newer request. This older copy does not need another answer.</p>
        <p v-for="answer in record.answers" :key="answer.question" class="fy-answer"><b>{{ record.questions?.find(question => question.question === answer.question)?.header || answer.question }}</b><br>{{ answer.selected.join(', ') }}</p>
        <p v-if="record.answerDelivery === 'processing'" class="fy-muted">Sulla is handling your saved answer in the original chat.</p>
        <p v-if="record.answerDelivery === 'queued'" class="fy-muted">Saved to the original chat’s inbox. It will be handled when that chat can continue.</p>
        <p v-if="record.kind === 'approval' && record.status === 'expired'" class="fy-muted">This permission is closed. A fresh approval is required before the operation can run.</p>
        <details v-if="record.questions?.length" class="fy-original"><summary>Original questions and options</summary><div v-for="question in record.questions" :key="question.question"><h4>{{ question.header }}</h4><p>{{ question.question }}</p><pre v-if="question.command" class="fy-command">{{ question.command }}</pre><ul><li v-for="option in question.options" :key="option.label"><b>{{ option.label }}</b><p v-if="option.description">{{ option.description }}</p></li></ul></div></details>
      </article>
      <p
        v-if="!past.length"
        class="fy-muted"
      >
        Answered and dismissed requests will appear here.
      </p>
      <button v-if="store.hasMore.value" type="button" :disabled="store.loading.value" @click="store.loadMore">Load earlier requests</button>
    </details>
  </section>
</template>
<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, watch, type Ref } from 'vue';
import DecisionReference from '../transcript/DecisionReference.vue';
import DecisionHolderLine from '../tool/DecisionHolderLine.vue';
import { useDecisionRoutePresenter } from '../../decisions/useDecisionRoutePresenter';
import { asMessageId } from '../../types/chat';
import ToolQuestion from '../tool/ToolQuestion.vue';
import ToolTask from '../tool/ToolTask.vue';
import { AgentResultActions } from '../../composables/useAgentResultActions';
import { ChatDecisions } from '../../composables/useChatDecisions';
import { useChatController } from '../../controller/useChatController';
import { LineTimes } from '../../messages/lineTime';
import type { ToolApprovalMessage, ToolQuestionAnswerItem, ToolQuestionMessage } from '../../models/Message';
import { DecisionAttention } from '@pkg/shared/decisionAttention';
import type { DecisionRecord } from '@pkg/shared/decisions';
const store = ChatDecisions.useChatDecisions();
onMounted(() => {
  if (!store.loading.value) void store.refresh();
});
const presenter = useDecisionRoutePresenter({ now: () => store.now.value });
const root = ref<HTMLElement>();
const actions = AgentResultActions.useAgentResultActions();
const controller = useChatController();
const context = inject<{ backendThreadId: Ref<string | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });
const owner = context.backendThreadId;
const active = computed(() => store.decisions.value.filter(record => DecisionAttention.active(record, store.now.value)));
const past = computed(() => store.decisions.value.filter(record => !DecisionAttention.active(record, store.now.value)));
const pastOpen = ref(false);
watch(owner, () => { pastOpen.value = false; });
let focusedVersion = -1;
watch(() => [store.openVersion.value, store.decisions.value] as const, async() => {
  const id = store.selectedId.value; if (!id || focusedVersion === store.openVersion.value) return;
  const record = store.decisions.value.find(record => record.id === id); if (!record) return;
  if (!DecisionAttention.active(record, store.now.value)) pastOpen.value = true;
  await nextTick();
  const card = [...(root.value?.querySelectorAll<HTMLElement>('[data-decision-id]') ?? [])].find(element => element.dataset.decisionId === id);
  if (card) { focusedVersion = store.openVersion.value; card.scrollIntoView?.({ block: 'nearest' }); card.querySelector<HTMLElement>('button,input,summary')?.focus({ preventScroll: true }); }
}, { immediate: true });
function showRequestTitle(record: DecisionRecord): boolean {
  const question = record.questions?.[0];
  return record.title !== question?.question && (record.questions?.length !== 1 || record.title !== question?.header);
}

function messageFor(record: DecisionRecord) { return controller.messages.value.find(message => (message.kind === 'tool_question' && message.questionId === record.id) || (message.kind === 'tool_approval' && message.approvalId === record.id)); }
function jump(record: DecisionRecord) { const message = messageFor(record); if (!message) { actions.openAgent({ threadId: record.conversationId, agentId: record.channel, label: record.title }); return; } window.dispatchEvent(new CustomEvent('chat:jump-to-message', { detail: { messageId: message.id } })); }
function approvalCommand(record: DecisionRecord): string { const message = messageFor(record); return message?.kind === 'tool_approval' ? message.command : ''; }
function routedApproval(record: DecisionRecord): ToolApprovalMessage {
  return { id: asMessageId(record.id), kind: 'tool_approval', approvalId: record.id, createdAt: record.createdAt,
    decision: 'pending', reason: record.approvalPresentation?.reason ?? record.title, command: record.approvalPresentation?.command ?? record.toolName ?? record.title };
}
function questionMessage(record: DecisionRecord): ToolQuestionMessage { return { id: record.id as ToolQuestionMessage['id'], kind: 'tool_question', role: 'assistant', createdAt: record.createdAt, questionId: record.id, questions: record.questions ?? [], status: 'pending', text: '' } as ToolQuestionMessage; }
function answer(record: DecisionRecord, answers: ToolQuestionAnswerItem[]) { return store.resolve(record, 'answered', answers.map(answer => ({ question: answer.question, selected: [...answer.selected] }))); }
function taskAnswer(record: DecisionRecord, value: string) { return answer(record, [{ question: record.questions![0].question, selected: [value] }]); }
function decide(record: DecisionRecord, action: 'approved' | 'denied') { return store.resolve(record, action).catch(() => { /* The shared store displays the error. */ }); }
function dismiss(record: DecisionRecord) { return store.dismiss(record).catch(() => { /* The shared store displays the error. */ }); }
</script>
<style scoped>
.fy {
  --fy-muted: color-mix(in srgb, var(--text-primary) 64%, var(--bg-surface));
  display: grid; align-content: start; gap: 12px; padding: 14px;
  color: var(--text-primary); font-family: var(--font-body);
}
.fy-head,.fy-meta,.fy-actions { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.fy-head h2 { margin:0; font-size:17px; font-weight:650; line-height:1.2; }
.fy-head .fy-count { margin:3px 0 0; }
.fy h3 { margin:0; font-size:14px; font-weight:650; overflow-wrap:anywhere; }
.fy p { margin:0; line-height:1.5; overflow-wrap:anywhere; }
.fy-muted,.fy-meta { color:var(--fy-muted); font-size:12px; }
.fy-state { padding:10px 12px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-page); color:var(--fy-muted); font-size:12px; }
.fy-error { border-color:color-mix(in srgb,var(--status-error) 45%,var(--border-default)); color:var(--status-error); }
.fy-empty { display:flex; align-items:center; gap:11px; padding:16px; border:1px solid var(--border-default); border-radius:10px; background:var(--bg-page); }
.fy-empty-mark { display:grid; place-items:center; flex:none; width:28px; height:28px; border-radius:50%; background:color-mix(in srgb,var(--status-success) 15%,transparent); color:var(--status-success); font-weight:700; }
.fy-empty p { margin-top:3px; color:var(--fy-muted); font-size:12px; }
.fy-request { display:grid; gap:10px; padding:12px; border:1px solid var(--border-default); border-radius:10px; background:var(--bg-page); }
.fy-request > p:not(.fy-muted,.fy-hint) { font-size:13px; }
.fy-command { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; background:var(--bg-surface); padding:10px; border:1px solid var(--border-default); border-radius:7px; }
.fy button { min-height:30px; font:inherit; font-size:12px; cursor:pointer; border:1px solid var(--border-strong); border-radius:7px; padding:5px 9px; background:var(--bg-surface); color:inherit; }
.fy button:focus-visible,.fy summary:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.fy button:disabled { opacity:.5; cursor:default; }
.fy button:hover { border-color:var(--accent); }
.fy-refresh { align-self:start; }
.fy-primary { background:var(--accent)!important; color:var(--text-on-accent)!important; }
.fy-dismiss { justify-self:start; margin-top:2px; }
.fy-hint { font-size:11px; color:var(--fy-muted); }
.fy-past { border:1px solid var(--border-default); border-radius:10px; background:var(--bg-page); }
.fy-past > summary { padding:10px 12px; color:var(--text-primary); font-size:13px; font-weight:650; }
.fy-past[open] > summary { border-bottom:1px solid var(--border-default); }
.fy summary { cursor:pointer; }
.fy-past-item { margin:0 10px; padding:12px 2px; border-bottom:1px solid var(--border-default); }
.fy-past-item:last-of-type { border-bottom:0; }
.fy-answer { margin-top:8px!important; font-size:13px; padding-left:10px; border-left:2px solid var(--border-strong); }
.fy-original { font-size:12px; margin-top:12px; }
.fy-original li p { margin-top:4px; color:var(--fy-muted); }
.fy-actions { justify-content:flex-start; }
.fy :deep(.qc) { margin:0; padding:12px; border-radius:8px; background:var(--bg-surface); }
</style>
