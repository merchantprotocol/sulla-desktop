<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <section ref="root" class="fy" aria-label="For You">
    <header class="fy-head"><h2>For You</h2><button type="button" :disabled="store.loading.value" @click="store.refresh">Refresh</button></header>
    <p v-if="store.error.value" role="alert">{{ store.error.value }} <button type="button" @click="store.refresh">Retry</button></p>
    <p v-if="store.loading.value && !store.decisions.value.length" role="status">Loading your requests…</p>
    <div v-else-if="!active.length && !store.error.value" class="fy-empty"><h3>You’re all caught up</h3><p>No active requests in this chat.</p></div>
    <p v-else-if="active.length" class="fy-muted">Active · {{ active.length }}</p>
    <article v-for="record in active" :key="record.id" :data-decision-id="record.id" class="fy-request">
      <div class="fy-meta"><span>{{ record.conversationId === owner ? 'Sulla' : 'Linked agent' }} · {{ LineTimes.shortTime(record.createdAt) }}</span><button v-if="messageFor(record) || record.conversationId !== owner" type="button" @click="jump(record)">View in chat</button></div>
      <p v-if="record.title !== record.questions?.[0]?.question">{{ record.title }}</p>
      <p v-if="record.answerDelivery === 'interrupted'" role="status">Your answer is saved, but Sulla could not confirm it finished handling it. Check the original chat before submitting the saved answer again.</p>
      <p v-else-if="record.kind === 'question' && record.status === 'expired'" class="fy-muted">Sulla stopped waiting. Your answer will be queued in the original chat without interrupting running work.</p>
      <p v-if="errors[record.id]" role="alert">{{ errors[record.id] }}</p>
      <template v-if="record.kind === 'question'">
        <pre v-if="record.questions?.length !== 1 || !record.questions[0].task" v-for="question in record.questions?.filter(question => question.command)" :key="question.question" class="fy-command">{{ question.command }}</pre>
        <ToolTask v-if="record.questions?.length === 1 && record.questions[0].task" :msg="questionMessage(record)" :draft="store.draft(record)" :submit-answer="value => taskAnswer(record, value)" />
        <ToolQuestion v-else :msg="questionMessage(record)" persistent :draft="store.draft(record)" :submit-answers="answers => answer(record, answers)" />
      </template>
      <template v-else>
        <p v-if="record.toolName" class="fy-muted">Approval for {{ record.toolName }}</p>
        <pre v-if="approvalCommand(record)" class="fy-command">{{ approvalCommand(record) }}</pre>
        <div class="fy-actions"><button type="button" class="fy-primary" :disabled="busy.has(record.id)" @click="decide(record, 'approved')">Approve</button><button type="button" :disabled="busy.has(record.id)" @click="decide(record, 'denied')">Deny</button></div>
      </template>
      <button type="button" class="fy-dismiss" :disabled="busy.has(record.id)" @click="dismiss(record)">Dismiss</button>
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
import { computed, inject, nextTick, onMounted, reactive, ref, watch, type Ref } from 'vue';
import ToolQuestion from '../tool/ToolQuestion.vue';
import ToolTask from '../tool/ToolTask.vue';
import { AgentResultActions } from '../../composables/useAgentResultActions';
import { ChatDecisions } from '../../composables/useChatDecisions';
import { useChatController } from '../../controller/useChatController';
import { LineTimes } from '../../messages/lineTime';
import type { ToolQuestionAnswerItem, ToolQuestionMessage } from '../../models/Message';
import { DecisionAttention } from '@pkg/shared/decisionAttention';
import type { DecisionRecord } from '@pkg/shared/decisions';
const store = ChatDecisions.useChatDecisions();
onMounted(() => {
  if (!store.loading.value) void store.refresh();
});
const root = ref<HTMLElement>();
const actions = AgentResultActions.useAgentResultActions();
const controller = useChatController();
const context = inject<{ backendThreadId: Ref<string | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });
const owner = context.backendThreadId;
const active = computed(() => store.decisions.value.filter(record => DecisionAttention.active(record, store.now.value)));
const past = computed(() => store.decisions.value.filter(record => !DecisionAttention.active(record, store.now.value)));
const pastOpen = ref(false); const errors = reactive<Record<string, string>>({}); const busy = reactive(new Set<string>());
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
function messageFor(record: DecisionRecord) { return controller.messages.value.find(message => (message.kind === 'tool_question' && message.questionId === record.id) || (message.kind === 'tool_approval' && message.approvalId === record.id)); }
function jump(record: DecisionRecord) { const message = messageFor(record); if (!message) { actions.openAgent({ threadId: record.conversationId, agentId: record.channel, label: record.title }); return; } window.dispatchEvent(new CustomEvent('chat:jump-to-message', { detail: { messageId: message.id } })); }
function approvalCommand(record: DecisionRecord): string { const message = messageFor(record); return message?.kind === 'tool_approval' ? message.command : ''; }
function questionMessage(record: DecisionRecord): ToolQuestionMessage { return { id: record.id as ToolQuestionMessage['id'], kind: 'tool_question', role: 'assistant', createdAt: record.createdAt, questionId: record.id, questions: record.questions ?? [], status: 'pending', text: '' } as ToolQuestionMessage; }
async function run(record: DecisionRecord, operation: () => Promise<void>): Promise<void> {
  if (busy.has(record.id)) return; busy.add(record.id); errors[record.id] = '';
  try { await operation() } catch (error) { errors[record.id] = error instanceof Error ? error.message : 'Request could not be saved.'; } finally { busy.delete(record.id); }
}
async function answer(record: DecisionRecord, answers: ToolQuestionAnswerItem[]) { await run(record, () => store.resolve(record, 'answered', answers.map(answer => ({ question: answer.question, selected: [...answer.selected] })))); if (errors[record.id]) throw new Error(errors[record.id]); }
function taskAnswer(record: DecisionRecord, value: string) { return answer(record, [{ question: record.questions![0].question, selected: [value] }]); }
function decide(record: DecisionRecord, action: 'approved' | 'denied') { return run(record, () => store.resolve(record, action)); }
function dismiss(record: DecisionRecord) { return run(record, () => store.dismiss(record)); }
</script>
<style scoped>
.fy{--fy-muted:color-mix(in srgb,var(--text-primary) 72%,var(--bg-surface));padding:20px;color:var(--text-primary);font-family:var(--font-body)}.fy-head,.fy-meta,.fy-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.fy-head h2{font-size:21px;margin:0}.fy h3{font-size:15px;margin:12px 0 8px;overflow-wrap:anywhere}.fy p{line-height:1.6;overflow-wrap:anywhere}.fy-muted,.fy-meta{color:var(--fy-muted);font-size:12px}.fy-empty{padding:24px 0 36px}.fy-empty h3{font-size:18px;font-weight:550}.fy-request{border-top:1px solid var(--border-default);padding:18px 0}.fy-command{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;background:var(--bg-page);padding:12px;border-radius:6px}.fy button{font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--border-strong);border-radius:7px;padding:7px 10px;background:transparent;color:inherit}.fy button:focus-visible,.fy summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.fy button:disabled{opacity:.5;cursor:default}.fy button:hover{border-color:var(--accent)}.fy-primary{background:var(--accent)!important;color:var(--text-on-accent)!important}.fy-dismiss{margin-top:12px}.fy-hint{font-size:11px;color:var(--fy-muted)}.fy-past{border-top:1px solid var(--border-default);margin-top:24px;padding-top:18px}.fy summary{cursor:pointer}.fy-past-item{padding:16px 0;border-bottom:1px solid var(--border-default)}.fy-answer{font-size:13px;padding-left:10px;border-left:2px solid var(--border-strong)}.fy-original{font-size:12px;margin-top:12px}.fy-original li p{margin-top:4px;color:var(--fy-muted)}.fy-actions{justify-content:flex-start}
</style>
