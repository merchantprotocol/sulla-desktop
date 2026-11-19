<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <section class="workflow" aria-label="Chat workflow">
    <header class="wf-heading">
      <h2>{{ plan?.canEdit ? 'Product Owner workflow' : 'Workflow' }}</h2>
      <div class="wf-switch" aria-label="Workflow view">
        <button v-if="plan?.canEdit" type="button" :aria-pressed="mode === 'plan'" @click="mode = 'plan'">Workflow</button>
        <button type="button" :aria-pressed="mode === 'run'" @click="mode = 'run'">Run history</button>
      </div>
    </header>
    <p v-if="error && !editing" role="alert" class="wf-error">
      {{ error }} <button type="button" @click="reload()">Retry</button>
    </p>
    <p v-if="loading && !plan" class="wf-note" role="status">Loading workflow…</p>
    <p v-if="!threadId" class="wf-note">Send a message to start this chat’s workflow.</p>

    <div v-else class="wf-layout">
      <template v-if="mode === 'plan' && plan?.canEdit">
        <ol class="wf-tree" aria-label="Feature path">
          <li v-for="stage in stages" :key="stage.key" :class="{ 'wf-child': stage.child }">
            <button class="wf-node" type="button" :aria-pressed="selectedTitle === stage.title" @click="pickStep(stage.id, stage.title)">
              <span><b>{{ stage.title }}</b><small v-if="stage.optional" class="wf-optional">{{ stage.optional }}</small>
                <small>{{ stage.agent }}</small></span>
              <span><b>{{ stage.model }}</b><small v-if="stage.provider">{{ stage.provider }}</small></span>
            </button>
          </li>
        </ol>
        <section v-if="planEntry" ref="planDetails" class="wf-detail" :aria-label="selectedTitle">
          <h3>{{ selectedTitle }}</h3>
          <p v-if="selectedStep === 'lead'" class="wf-note">Scoping and handoff share the chat lead’s model. Use the chat’s agent picker to change the lead.</p>
          <template v-if="!editing">
            <p class="wf-label">Model priority</p>
            <ol v-if="effectiveChoices.length" class="wf-priority">
              <li v-for="candidate in effectiveChoices" :key="`${candidateKey(candidate)}/${candidate.effort ?? ''}`">
                {{ candidateText(candidate) }} <small>{{ providerName(candidate.provider) }}</small>
              </li>
            </ol>
            <p v-else class="wf-note">Uses the agent’s existing routing.</p>
            <p v-if="planEntry.choice.independentReview" class="wf-optional">Different provider required</p>
            <button class="wf-primary" type="button" @click="beginEdit()">Change for this chat</button>
          </template>
          <form v-else @submit.prevent="save(draft)">
            <label v-if="selectedStep !== 'lead'" class="wf-label" for="workflow-agent">Assigned agent</label>
            <select v-if="selectedStep !== 'lead'" id="workflow-agent" v-model="draft.agentSlug">
              <option :value="undefined">Use the delegating agent’s choice</option>
              <option v-for="agent in eligibleAgents" :key="agent.slug" :value="agent.slug">{{ agent.name }}</option>
            </select>
            <p class="wf-label">Models in priority order</p>
            <p v-if="!draft.candidates.length" class="wf-note">Uses the assigned agent’s existing model routing.</p>
            <div v-for="(candidate, index) in draft.candidates" :key="index" class="wf-edit-row">
              <label :for="`workflow-model-${index}`">{{ index ? `Fallback ${index}` : 'First choice' }}</label>
              <div class="wf-inputs">
                <select :id="`workflow-model-${index}`" :value="candidateKey(candidate)" @change="selectModel(index, $event)">
                  <option value="" disabled>Choose a model</option>
                  <option v-if="candidate.model && !modelOptions.some(model => model.key === candidateKey(candidate))" :value="candidateKey(candidate)">
                    {{ candidate.model }} · unavailable
                  </option>
                  <option v-for="model in modelOptions" :key="model.key" :value="model.key">{{ model.label }}</option>
                </select>
                <select v-model="candidate.effort" :aria-label="`Effort for model ${index + 1}`">
                  <option :value="undefined">Default</option>
                  <option v-if="candidate.effort && !efforts(candidate).includes(candidate.effort)" :value="candidate.effort">{{ candidate.effort }} · unavailable</option>
                  <option v-for="effort in efforts(candidate)" :key="effort" :value="effort">{{ effortLabel(effort) }}</option>
                </select>
              </div>
              <div class="wf-actions">
                <button v-if="index" type="button" :aria-label="`Move model ${index + 1} up`" @click="moveUp(index)">↑</button>
                <button type="button" :aria-label="`Remove model ${index + 1}`" @click="draft.candidates.splice(index, 1)">Remove</button>
              </div>
            </div>
            <button type="button" :disabled="draft.candidates.length >= 10 || !modelOptions.length" @click="draft.candidates.push({ provider: '', model: '' })">
              {{ draft.candidates.length ? 'Add fallback' : 'Choose a model' }}
            </button>
            <label v-if="selectedStep === 'review'" class="wf-check">
              <input v-model="draft.independentReview" type="checkbox"> Require a different provider from implementation
            </label>
            <p class="wf-note">Applies when this step is next assigned.</p>
            <div class="wf-actions">
              <button class="wf-primary" type="submit" :disabled="saving">Apply to this chat</button>
              <button type="button" :disabled="saving" @click="editing = false; error = ''">Cancel</button>
              <button v-if="hasOverride" type="button" :disabled="saving" @click="save(null)">Use agent defaults</button>
            </div>
            <p v-if="error" role="alert" class="wf-error">{{ error }}</p>
          </form>
        </section>
      </template>

      <template v-else-if="mode === 'run'">
        <div>
          <p class="wf-note wf-history-label">Live work and recent handoffs</p>
          <button v-if="plan?.leadModels.length" type="button" class="wf-node wf-lead" :aria-pressed="selectedRun === 'lead'" @click="selectedRun = 'lead'">
            <span><b>Chat lead</b><small>{{ plan.canEdit ? 'Product Owner' : 'Conversation' }}</small></span>
            <span>{{ AgentModelStatus.label(plan.leadModels.at(-1)) }}</span>
          </button>
          <p v-if="historyError" class="wf-error" role="alert">{{ historyError }} <button type="button" @click="reloadHistory()">Retry</button></p>
          <p v-if="!history.length" class="wf-note">{{ historyLoading ? 'Loading handoffs…' : 'No recorded agent handoffs in this chat.' }}</p>
          <ol v-else class="wf-tree" aria-label="Recorded handoffs">
            <li v-for="node in history" :key="node.row.key" :style="{ '--depth': Math.min(node.depth, 4) }">
              <button class="wf-node" type="button" :aria-pressed="selectedRun === node.row.key" @click="selectedRun = node.row.key">
                <span><b>{{ node.row.label }}</b><small>{{ agentName(node.row.agentId) }} · {{ status(node.row.state) }}</small></span>
                <span>{{ runModel(node.row) }}</span>
              </button>
            </li>
          </ol>
        </div>
        <section v-if="runRow || (selectedRun === 'lead' && plan?.leadModels.length)" class="wf-detail">
          <h3>{{ runRow?.label ?? 'Chat lead' }}</h3>
          <p v-if="runRow && parentLabel" class="wf-note">Delegated by {{ parentLabel }}</p>
          <p v-if="reviewedLabel" class="wf-note">Follows {{ reviewedLabel }}</p>
          <p class="wf-label">Models that returned output</p>
          <ol v-if="shownResponses.length" class="wf-priority">
            <li v-for="model in shownResponses" :key="`${model.provider}/${model.model}/${model.effort}`">
              {{ AgentModelStatus.label(model) }} <small>{{ providerName(model.provider) }}</small>
              <small v-if="model.fallbackFrom">{{ fallbackReason(model.fallbackFrom) }}</small>
            </li>
          </ol>
          <p v-else-if="receiptLoading" class="wf-note">Checking recorded model usage…</p>
          <p v-else-if="receiptError" class="wf-error" role="alert">{{ receiptError }}</p>
          <p v-else class="wf-note">Model usage was not recorded for this run.</p>
          <p v-if="runRow?.stateReason" class="wf-note">{{ runRow.stateReason }}</p>
        </section>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, ref, watch, type Ref } from 'vue';

import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { AgentTreeBuilder } from '@pkg/services/agentState/AgentTreeBuilder';
import { AgentModelStatus, type AgentModelStatusValue } from '@pkg/shared/agentState/AgentModelStatus';
import { WORKFLOW_STEPS, type ProductOwnerStep, type WorkflowChoice, type WorkflowPlan, type WorkflowRunRow } from '@pkg/shared/productOwnerWorkflow';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { ModelCandidate } from '@pkg/agent/languagemodels/modelRouter';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';

const client = inject(AGENT_STATE_CLIENT_KEY, null);
const { backendThreadId: threadId } = inject<{ backendThreadId: Ref<string | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });
const plan = ref<WorkflowPlan>();
const error = ref('');
const loading = ref(false);
const saving = ref(false);
const editing = ref(false);
const mode = ref<'plan' | 'run'>('run');
const selectedStep = ref<ProductOwnerStep>('implementation');
const selectedTitle = ref('Implementation');
const draft = ref<WorkflowChoice>({ candidates: [] });
const planDetails = ref<HTMLElement>();
const selectedRun = ref('lead');
const receipt = ref<AgentModelStatusValue[]>([]);
const receiptLoading = ref(false);
const receiptError = ref('');
const savedHistory = ref<WorkflowRunRow[]>([]);
const historyLoading = ref(false);
const historyError = ref('');
let loadSequence = 0;

const planEntry = computed(() => plan.value?.steps[selectedStep.value]);
const eligibleAgents = computed(() => plan.value?.agents.filter(agent =>
  planEntry.value?.allowedAgents.includes(agent.slug) || planEntry.value?.choice.agentSlug === agent.slug) ?? []);
const effectiveChoices = computed(() => planEntry.value?.choice.candidates.length ? planEntry.value.choice.candidates : planEntry.value?.inherited ?? []);
const hasOverride = computed(() => Boolean(planEntry.value?.choice.agentSlug || planEntry.value?.choice.candidates.length));
const providerNames: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'OpenAI Codex', grok: 'Grok OAuth' };
const providerName = (id?: string) => id ? plan.value?.providers.find(provider => provider.id === id)?.name || providerNames[id] || id : '';
const agentName = (id?: string | null) => id ? plan.value?.agents.find(agent => agent.slug === id)?.name || id : 'Sulla';
const effortLabel = (value?: string) => value ? value === 'xhigh' ? 'Extra high' : value[0].toUpperCase() + value.slice(1) : 'Default';
const candidateKey = (candidate: ModelCandidate) => `${ candidate.provider }/${ candidate.model }`;
const findModel = (candidate: ModelCandidate) => plan.value?.providers.find(provider => provider.id === candidate.provider)?.models.find(model => model.id === candidate.model);
const candidateText = (candidate: ModelCandidate) => `${ findModel(candidate)?.label ?? candidate.model } · ${ effortLabel(candidate.effort) }`;
const efforts = (candidate: ModelCandidate) => findModel(candidate)?.efforts?.map(effort => effort.id) ?? [];
const modelOptions = computed(() => (plan.value?.providers ?? []).filter(provider => provider.connected && Object.hasOwn(providerNames, provider.id)
  && (!provider.accessMethod || ['subscription-cli', 'subscription', 'oauth-account', 'cli-account'].includes(provider.accessMethod))).flatMap(provider => provider.models.filter(model => !model.unverified).map(model => ({
  model: model.id, provider: provider.id, label: `${ model.label } · ${ provider.name }`, key: `${ provider.id }/${ model.id }`,
}))));
const stages = computed(() => {
  const base = WORKFLOW_STEPS.map(step => {
    const data = plan.value?.steps[step.id];
    const configured = data?.choice.candidates[0] ?? data?.inherited[0];
    return {
      id: step.id, key: step.id as string, title: step.title,
      child: step.id === 'implementation' || step.id === 'review',
      optional: step.id === 'mockup' ? 'If UI design is needed' : step.id === 'review' ? 'Optional' : '',
      agent: data?.choice.agentSlug || step.agent ? agentName(data?.choice.agentSlug ?? step.agent) : 'Chosen by the build lead',
      model: configured ? candidateText(configured) : 'Agent routing',
      provider: providerName(configured?.provider),
    };
  });
  return [...base, { ...base[0], key: 'handoff', title: 'Demo & handoff' }];
});
const history = computed(() => {
  if (!threadId.value) return [];
  const rows = new Map(savedHistory.value.map(row => [row.key, row]));
  for (const row of client?.snapshot.value.rows ?? []) {
    if (row.rootThreadId === threadId.value) {
      const saved = rows.get(row.key);
      rows.set(row.key, { ...saved, ...row, responseModels: row.responseModels ?? saved?.responseModels });
    }
  }
  const tree = new AgentTreeBuilder<WorkflowRunRow>([...rows.values()]);
  return tree.flatten(tree.forThread(threadId.value));
});
const runRow = computed(() => history.value.find(node => node.row.key === selectedRun.value)?.row);
const parentLabel = computed(() => {
  const row = runRow.value;
  if (!row) return '';
  if (!row.parentJobId) return plan.value?.canEdit ? 'Product Owner' : 'the chat lead';
  return history.value.find(node => node.row.key === `${ row.parentJobId }:${ row.parentTaskIndex }`)?.row.label ?? 'an earlier agent job';
});
const reviewedLabel = computed(() => {
  const previous = runRow.value?.followUpOf;
  return previous ? history.value.find(node => node.row.key === `${ previous.jobId }:${ previous.taskIndex }`)?.row.label ?? 'an earlier recorded task' : '';
});
const shownResponses = computed(() => selectedRun.value === 'lead' ? plan.value?.leadModels ?? [] : runRow.value?.responseModels ?? receipt.value);
function status(state: AgentStateRow['state']): string {
  return { queued: 'Queued', working: 'Working', parked: 'Waiting', quiet: 'Quiet', blocked: 'Blocked', failed: 'Failed', lost: 'Unreachable', stopped: 'Stopped', done: 'Done' }[state];
}
function fallbackReason(fallback: NonNullable<AgentModelStatusValue['fallbackFrom']>): string {
  const reason = fallback.reason === 'quota' ? 'reached its usage limit' : fallback.reason === 'rate_limit' ? 'was rate-limited' : fallback.reason === 'timeout' ? 'timed out' : 'could not finish the request';
  return `Fallback after ${ fallback.model || providerName(fallback.provider) } ${ reason }.`;
}
function runModel(row: WorkflowRunRow): string {
  if (row.responseModels?.length) return AgentModelStatus.label(row.responseModels.at(-1));
  if (row.key === selectedRun.value && receipt.value.length) return AgentModelStatus.label(receipt.value.at(-1));
  if (row.modelStatus?.model && row.state !== 'done') return `${ row.modelStatus.model } · selected`;
  return 'Model usage unavailable';
}

async function reload(resetView = false): Promise<void> {
  const sequence = ++loadSequence;
  const id = threadId.value;
  error.value = '';
  loading.value = Boolean(id);
  if (!id) return;
  try {
    const data = await ipcRenderer.invoke('chat-workflow:get', id);
    if (sequence !== loadSequence) return;
    plan.value = data;
    if (resetView || !data.canEdit) mode.value = data.canEdit ? 'plan' : 'run';
  } catch (cause) {
    if (sequence === loadSequence) error.value = errorMessage(cause);
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}
async function reloadHistory(): Promise<void> {
  const id = threadId.value;
  if (!id || historyLoading.value) return;
  historyLoading.value = true;
  try {
    const rows = await ipcRenderer.invoke('chat-workflow:history', id);
    if (threadId.value !== id) return;
    savedHistory.value = rows;
    historyError.value = '';
  } catch (cause) {
    if (threadId.value === id) historyError.value = errorMessage(cause);
  } finally {
    if (threadId.value === id) historyLoading.value = false;
  }
}
watch(threadId, () => {
  plan.value = undefined; editing.value = false; selectedRun.value = 'lead';
  savedHistory.value = []; historyLoading.value = false; historyError.value = '';
  void reload(true);
}, { immediate: true });
watch([mode, threadId], ([view, id], _, onCleanup) => {
  if (view !== 'run' || !id) return;
  let active = true;
  const refresh = () => {
    void reloadHistory();
    void ipcRenderer.invoke('chat-workflow:execution', id, null).then(models => {
      if (active && plan.value) plan.value = { ...plan.value, leadModels: models };
    }).catch(cause => { if (active) receiptError.value = errorMessage(cause) });
  };
  refresh();
  const timer = setInterval(refresh, 6_000);
  onCleanup(() => { active = false; clearInterval(timer) });
}, { immediate: true });
watch(() => [threadId.value, runRow.value?.key, runRow.value?.state] as const, async(_, __, onCleanup) => {
  receipt.value = [];
  receiptError.value = '';
  receiptLoading.value = false;
  const id = threadId.value;
  const row = runRow.value;
  if (!id || !row || row.responseModels?.length) return;
  let current = true;
  onCleanup(() => { current = false });
  receiptLoading.value = true;
  try {
    const models = await ipcRenderer.invoke('chat-workflow:execution', id, { jobId: row.jobId, taskIndex: row.taskIndex });
    if (current) receipt.value = models;
  } catch (cause) {
    if (current) receiptError.value = errorMessage(cause);
  } finally {
    if (current) receiptLoading.value = false;
  }
});
function errorMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
function pickStep(id: ProductOwnerStep, title: string): void {
  selectedStep.value = id;
  selectedTitle.value = title;
  editing.value = false;
  error.value = '';
  void nextTick(() => {
    const details = planDetails.value;
    const width = details?.closest('.workflow')?.clientWidth;
    if (details && width && width < 710) details.scrollIntoView?.({ block: 'nearest' });
  });
}
function beginEdit(): void {
  const choice = planEntry.value?.choice;
  if (!choice) return;
  draft.value = { ...choice, candidates: choice.candidates.map(candidate => ({ ...candidate })) };
  editing.value = true;
}
function selectModel(index: number, event: Event): void {
  const found = modelOptions.value.find(model => model.key === (event.target as HTMLSelectElement).value);
  if (found) draft.value.candidates[index] = { model: found.model, provider: found.provider };
}
function moveUp(index: number): void {
  const [candidate] = draft.value.candidates.splice(index, 1);
  draft.value.candidates.splice(index - 1, 0, candidate);
}
async function save(choice: WorkflowChoice | null): Promise<void> {
  const id = threadId.value;
  const entry = planEntry.value;
  const step = selectedStep.value;
  if (!id || !entry || saving.value) return;
  if (choice?.candidates.some(candidate => !candidate.model)) { error.value = 'Choose a model for each row.'; return }
  saving.value = true;
  error.value = '';
  try {
    const data = await ipcRenderer.invoke('chat-workflow:save', { threadId: id, step, expectedRevision: entry.revision,
      choice: choice ? { ...choice, candidates: choice.candidates.map(candidate => ({ ...candidate })) } : null });
    if (threadId.value !== id) return;
    plan.value = data;
    if (selectedStep.value === step) editing.value = false;
  } catch (cause) {
    if (threadId.value === id) error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.workflow { container-type: inline-size; display: grid; align-content: start; gap: 12px; padding: 14px; }
.wf-heading,.wf-actions,.wf-switch { display: flex; flex-wrap: wrap; gap: 7px; align-items:center; }
.wf-heading { justify-content:space-between; }
h2,h3,p { margin:0; }
h2,h3 { font-family:inherit; font-weight:650; }
h2 { font-size:17px; } h3 { font-size:15px; }
button,select { color:var(--text-primary); background:var(--bg-page); border:1px solid var(--border-default); border-radius:6px; padding:5px 8px; font:inherit; }
button { cursor:pointer; }
button:hover,button[aria-pressed="true"] { border-color:var(--accent); }
button[aria-pressed="true"] { background:color-mix(in srgb,var(--accent) 14%,var(--bg-surface)); }
button:focus-visible,select:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
button:disabled { opacity:.55; cursor:default; }
.wf-layout { display:grid; gap:12px; min-width:0; }
.wf-tree { list-style:none; margin:0; padding:0 0 0 10px; border-left:1px solid var(--border-strong); display:grid; gap:6px; }
.wf-tree > li { margin-left:calc(var(--depth, 0) * 12px); position:relative; min-width:0; }
.wf-tree > li::before { content:""; position:absolute; width:8px; border-top:1px solid var(--border-strong); top:22px; left:-8px; }
.wf-tree > .wf-child { margin-left:14px; }
.wf-node { width:100%; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,auto); gap:8px; text-align:left; padding:8px; overflow-wrap:anywhere; }
.wf-node > span:last-child { text-align:right; font-size:11px; max-width:145px; }
.wf-node small,.wf-priority small { display:block; color:var(--text-muted); font-size:11px; }
.wf-node b { font-size:12px; }
.wf-lead,.wf-history-label { margin-bottom:8px; }
.wf-detail { display:grid; align-content:start; gap:8px; overflow-wrap:anywhere; background:var(--bg-page); border:1px solid var(--border-default); border-radius:8px; padding:12px; }
.wf-label,.wf-note { font-size:12px; color:var(--text-muted); }
.wf-optional { color:var(--status-warning) !important; font-size:11px; }
.wf-error { color:var(--status-error); font-size:12px; }
.wf-priority { margin:0; padding-left:19px; display:grid; gap:5px; font-size:12px; }
.wf-primary { background:var(--accent); color:var(--bg-page); font-weight:700; justify-self:start; }
form { display:grid; gap:8px; }
.wf-edit-row { display:grid; gap:4px; min-width:0; border-bottom:1px solid var(--border-default); padding-bottom:5px; }
.wf-edit-row label,.wf-check { font-size:12px; }
.wf-inputs { display:grid; grid-template-columns:minmax(0,1fr) minmax(88px,auto); gap:5px; }
select { min-width:0; max-width:100%; }
.wf-check { display:flex; gap:6px; align-items:start; }
@container (min-width:710px) { .wf-layout { grid-template-columns:minmax(0,1fr) minmax(260px,.65fr); align-items:start; } }
@container (max-width:320px) { .wf-node { grid-template-columns:minmax(0,1fr); } .wf-node > span:last-child { max-width:none; text-align:left; } }
</style>
