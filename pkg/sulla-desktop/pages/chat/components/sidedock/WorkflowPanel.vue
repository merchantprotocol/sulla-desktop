<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <section
    class="workflow"
    :aria-label="heading"
  >
    <header class="wf-heading">
      <h2>{{ heading }}</h2>
    </header>
    <p v-if="error && !editing" role="alert" class="wf-error">
      {{ error }} <button type="button" @click="reload()">Retry</button>
    </p>
    <p
      v-if="!threadId"
      class="wf-note"
    >
      {{ view === 'activity' ? 'Agent activity appears here after the chat starts.' : 'Team setup is available after the chat starts.' }}
    </p>

    <p v-else-if="view === 'team' && !plan?.canEdit && !error" class="wf-note">
      {{ plan ? 'Team setup is available in Product Owner chats.' : 'Loading team setup…' }}
    </p>
    <div v-else class="wf-layout">
      <template v-if="mode === 'plan' && plan?.canEdit">
        <div class="wf-list">
          <h3>Product Owner routing</h3>
          <p class="wf-note">Settings for future handoffs in this chat.</p>
          <ol
            class="wf-tree"
            aria-label="Feature path"
          >
            <li
              v-for="stage in stages"
              :key="stage.key"
              :class="{ 'wf-child': stage.child }"
            >
              <button
                class="wf-node"
                type="button"
                :aria-pressed="selectedTitle === stage.title"
                @click="pickStep(stage.id, stage.title)"
              >
                <span>
                  <b>{{ stage.title }}</b>
                  <small v-if="stage.optional" class="wf-optional">{{ stage.optional }}</small>
                  <small>{{ stage.agent }}</small>
                </span>
                <span><b>{{ stage.model }}</b><small v-if="stage.provider">{{ stage.provider }}</small></span>
              </button>
            </li>
          </ol>
        </div>
        <section v-if="planEntry" ref="planDetails" class="wf-detail" :aria-label="selectedTitle">
          <h3>{{ selectedTitle }}</h3>
          <p v-if="selectedStep === 'lead'" class="wf-note">Scoping and handoff share the chat lead’s model. Use the chat’s agent picker to change the lead.</p>
          <template v-if="!editing">
            <ModelLaunchPreview v-if="planEntry.preview" :preview="planEntry.preview" :providers="plan.providers" />
            <p v-else class="wf-note">Next launch details are unavailable.</p>
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
              <button type="button" :disabled="saving" @click="editing = false; reload()">Cancel</button>
              <button v-if="hasOverride" type="button" :disabled="saving" @click="save(null)">Use agent defaults</button>
            </div>
            <p v-if="error" role="alert" class="wf-error">{{ error }}</p>
          </form>
        </section>
      </template>

      <template v-else-if="mode === 'run'">
        <div class="wf-list">
          <button
            v-if="leadModels.length"
            type="button"
            class="wf-node"
            :aria-pressed="focusedRun === 'lead'"
            @click="selectedRun = 'lead'"
          >
            <span><b>Chat lead</b><small>{{ plan?.canEdit ? 'Product Owner' : 'Latest response' }}</small></span>
            <span>{{ AgentModelStatus.label(leadModels.at(-1)) }}<small v-if="leadAt"><AgentActivityTime :at="leadAt" event="Lead response" /></small></span>
          </button>

          <p
            v-if="historyError"
            class="wf-error"
            role="alert"
          >
            {{ savedHistory.length ? 'Couldn’t refresh saved handoffs.' : 'Couldn’t load saved handoffs.' }}
            <button type="button" @click="reloadHistory()">Retry</button>
          </p>
          <p
            v-else-if="!history.all.length"
            class="wf-note"
          >
            {{ historyLoading ? 'Loading handoffs…' : 'No agent handoffs in this chat yet.' }}
          </p>

          <div
            v-if="history.all.length"
            class="wf-summary"
            aria-label="Handoff totals"
          >
            <span v-if="counts.working">{{ counts.working }} in progress</span>
            <span v-if="counts.waiting">{{ counts.waiting }} waiting or blocked</span>
            <span v-if="counts.returned">{{ counts.returned }} returned</span>
            <span v-if="counts.ended">{{ counts.ended }} ended early</span>
          </div>

          <template v-for="group in groups" :key="group.title">
            <component
              :is="group.earlier ? 'details' : 'div'"
              v-if="group.nodes.length"
              :class="group.earlier ? 'wf-earlier' : 'wf-list'"
              :open="group.earlier && !history.active.length"
            >
              <summary v-if="group.earlier">{{ group.title }} · {{ group.nodes.length }}</summary>
              <h3 v-else>{{ group.title }}</h3>
              <ol class="wf-tree" :aria-label="group.title">
                <li
                  v-for="node in group.nodes"
                  :key="node.row.key"
                  :style="{ '--depth': Math.min(node.depth, 4) }"
                >
                  <button
                    class="wf-node"
                    type="button"
                    :aria-pressed="focusedRun === node.row.key"
                    @click="selectRun(node.row.key)"
                  >
                    <span><b>{{ node.row.label }}</b><small>{{ agentName(node.row.agentId) }}</small></span>
                    <span>
                      <b class="wf-status" :data-state="node.row.state">{{ status(node.row.state) }}</b>
                      <small v-if="latestResponse(node.row)">{{ AgentModelStatus.label(latestResponse(node.row)) }}</small>
                      <small v-else-if="isLive(node.row) && node.row.modelStatus?.model">{{ node.row.modelStatus.model }} · selected</small>
                      <small><AgentActivityTime :row="activityRow(node.row)" /></small>
                    </span>
                  </button>
                </li>
              </ol>
            </component>
          </template>
        </div>

        <section
          v-if="runRow || (focusedRun === 'lead' && leadModels.length)"
          ref="runDetails"
          class="wf-detail"
        >
          <h3>{{ runRow?.label ?? 'Chat lead' }}</h3>
          <p v-if="runRow" class="wf-note">
            {{ status(runRow.state) }}<template v-if="recordedStage"> · {{ recordedStage }}</template>
            <AgentActivityTime class="wf-detail-time" :row="activityRow(runRow)" />
          </p>
          <p v-if="parentLabel" class="wf-note">Delegated by {{ parentLabel }}</p>
          <p v-if="reviewedLabel" class="wf-note">Follows {{ reviewedLabel }}</p>
          <p v-if="currentUpdate" class="wf-note">{{ currentUpdate }}</p>
          <p v-if="runRow?.stateReason && runRow.stateReason !== currentUpdate" class="wf-note">{{ runRow.stateReason }}</p>
          <p v-if="liveRun?.state === 'parked' && liveRun.wakeAt" class="wf-note">
            Next check <AgentActivityTime :at="liveRun.wakeAt" event="Next check" />
          </p>
          <button
            v-if="runRow && outcomeKeys?.includes(runRow.key)"
            type="button"
            class="wf-primary wf-outcome-link"
            @click="emit('show-outcome', runRow.key)"
          >View outcome in Sulla</button>
          <template v-if="shownResponses.length">
            <p class="wf-label">Models that returned output</p>
            <ol class="wf-priority">
              <li v-for="model in shownResponses" :key="`${model.provider}/${model.model}/${model.effort}`">
                {{ AgentModelStatus.label(model) }} <small>{{ providerName(model.provider) }}</small>
                <small v-if="model.fallbackFrom">{{ fallbackReason(model.fallbackFrom) }}</small>
              </li>
            </ol>
          </template>
          <p v-else-if="receiptLoading" class="wf-note">Checking recorded model usage…</p>
          <p v-else-if="receiptError" class="wf-error" role="alert">{{ receiptError }}</p>
          <p v-else-if="runRow && isLive(runRow) && runRow.modelStatus?.model" class="wf-note">
            Selected model · {{ AgentModelStatus.label(runRow.modelStatus) }}
          </p>
          <p v-else class="wf-note">{{ runRow && isLive(runRow) ? 'Model details haven’t been recorded yet.' : 'Model and effort were not recorded for this run.' }}</p>
        </section>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, ref, watch, type Ref } from 'vue';

import AgentActivityTime from '../chrome/AgentActivityTime.vue';

import { previewEffort } from '@pkg/shared/modelLaunchPreview';
import ModelLaunchPreview from '@pkg/components/ModelLaunchPreview.vue';
import { MODEL_ROUTING_IPC } from '@pkg/agent/languagemodels/modelRoutingTypes';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { AgentTreeBuilder } from '@pkg/services/agentState/AgentTreeBuilder';
import { AgentModelStatus, type AgentModelStatusValue } from '@pkg/shared/agentState/AgentModelStatus';
import { WORKFLOW_STEPS, type ChatModelPickerSelection, type ProductOwnerStep, type WorkflowChoice, type WorkflowPlan, type WorkflowRunRow } from '@pkg/shared/productOwnerWorkflow';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { ModelCandidate } from '@pkg/agent/languagemodels/modelRouter';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';

const props = defineProps<{ view: 'activity' | 'team'; outcomeKeys?: readonly string[]; leadAt?: number }>();
const emit = defineEmits<{ (event: 'show-outcome', key: string): void }>();

const client = inject(AGENT_STATE_CLIENT_KEY, null);
const { backendThreadId: threadId, modelPicker } = inject<{ backendThreadId: Ref<string | undefined>; modelPicker?: Ref<ChatModelPickerSelection | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });
const plan = ref<WorkflowPlan>();
const error = ref('');
const saving = ref(false);
const editing = ref(false);
const mode = computed(() => props.view === 'team' ? 'plan' : 'run');
const heading = computed(() => props.view === 'team' ? 'AI Team' : 'Full history');
const selectedStep = ref<ProductOwnerStep>('implementation');
const selectedTitle = ref('Implementation');
const draft = ref<WorkflowChoice>({ candidates: [] });
const planDetails = ref<HTMLElement>();
const selectedRun = ref('');
const runDetails = ref<HTMLElement>();
const refreshedLeadModels = ref<AgentModelStatusValue[]>();
const receipt = ref<AgentModelStatusValue[]>([]);
const receiptLoading = ref(false);
const receiptError = ref('');
const savedHistory = ref<WorkflowRunRow[]>([]);
const historyLoading = ref(false);
const historyError = ref(false);
let loadSequence = 0;
let historySequence = 0;

const planEntry = computed(() => plan.value?.steps[selectedStep.value]);
const eligibleAgents = computed(() => plan.value?.agents.filter(agent =>
  planEntry.value?.allowedAgents.includes(agent.slug) || planEntry.value?.choice.agentSlug === agent.slug) ?? []);
let draftRevision = '';
const hasOverride = computed(() => Boolean(planEntry.value?.choice.agentSlug || planEntry.value?.choice.candidates.length));
const providerNames: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'OpenAI Codex', grok: 'Grok OAuth' };
const providerName = (id?: string) => id ? plan.value?.providers.find(provider => provider.id === id)?.name || providerNames[id] || id : '';
const agentName = (id?: string | null) => id ? plan.value?.agents.find(agent => agent.slug === id)?.name || id : 'Sulla';
const effortLabel = (value?: string) => value ? value === 'xhigh' ? 'Extra high' : value[0].toUpperCase() + value.slice(1) : 'Default';
const candidateKey = (candidate: ModelCandidate) => `${ candidate.provider }/${ candidate.model }`;
const findModel = (candidate: ModelCandidate) => plan.value?.providers.find(provider => provider.id === candidate.provider)?.models.find(model => model.id === candidate.model);
const candidateText = (candidate: ModelCandidate) => (findModel(candidate)?.label ?? candidate.model) + ' · ' + previewEffort(candidate, plan.value?.providers);
const efforts = (candidate: ModelCandidate) => findModel(candidate)?.efforts?.map(effort => effort.id) ?? [];
const modelOptions = computed(() => (plan.value?.providers ?? []).filter(provider => provider.connected && Object.hasOwn(providerNames, provider.id)
  && (!provider.accessMethod || ['subscription-cli', 'subscription', 'oauth-account', 'cli-account'].includes(provider.accessMethod))).flatMap(provider => provider.models.filter(model => !model.unverified).map(model => ({
  model: model.id, provider: provider.id, label: `${ model.label } · ${ provider.name }`, key: `${ provider.id }/${ model.id }`,
}))));
const stages = computed(() => {
  const base = WORKFLOW_STEPS.map(step => {
    const data = plan.value?.steps[step.id];
    const preview = data?.preview;
    const configured = preview?.candidates[0];
    const state = preview?.status;
    return {
      id: step.id, key: step.id as string, title: step.title,
      child: step.id === 'implementation' || step.id === 'review',
      optional: step.id === 'mockup' ? 'If UI design is needed' : step.id === 'review' ? 'Optional' : '',
      agent: data?.choice.agentSlug || step.agent ? agentName(data?.choice.agentSlug ?? step.agent) : 'Chosen by the build lead',
      model: state === 'waiting' ? 'Waiting for connection' : state === 'blocked' ? 'Launch blocked' : state === 'deferred' ? 'At handoff' : configured ? candidateText(configured) : 'Preview unavailable',
      provider: state === 'deferred' && configured ? 'Conditional · ' + candidateText(configured) : configured ? [providerName(configured.provider), preview!.candidates.length > 1 ? (preview!.candidates.length - 1) + ' fallback' + (preview!.candidates.length > 2 ? 's' : '') : ''].filter(Boolean).join(' · ') : '',
    };
  });
  return [...base, { ...base[0], key: 'handoff', title: 'Demo & handoff' }];
});
const liveRows = computed(() => new Map((client?.snapshot.value.rows ?? [])
  .filter(row => row.rootThreadId === threadId.value)
  .map(row => [row.key, row])));
const history = computed(() => {
  if (!threadId.value) return { all: [], active: [], past: [] };
  const rows = new Map(savedHistory.value.map(row => [row.key, row]));
  for (const row of liveRows.value.values()) {
    const saved = rows.get(row.key);
    // A delayed live snapshot can still say Working after the job's terminal return is saved.
    if (saved && ['done', 'failed', 'stopped'].includes(saved.state)) {
      rows.set(row.key, { ...row, ...saved, responseModels: saved.responseModels?.length ? saved.responseModels : row.responseModels });
    } else {
      rows.set(row.key, { ...saved, ...row, responseModels: row.responseModels?.length ? row.responseModels : saved?.responseModels });
    }
  }
  const tree = new AgentTreeBuilder<WorkflowRunRow>([...rows.values()]);
  const branches = tree.forThread(threadId.value).map(root => tree.flatten([root]));
  return {
    all:    branches.flat(),
    active: branches.filter(branch => branch.some(({ row }) => isLive(row))).flat(),
    past:   branches.filter(branch => !branch.some(({ row }) => isLive(row))).reverse().flat(),
  };
});
const groups = computed(() => [
  { title: 'Active handoffs', nodes: history.value.active, earlier: false },
  { title: 'Earlier handoffs', nodes: history.value.past, earlier: true },
]);
const counts = computed(() => {
  const result = { working: 0, waiting: 0, returned: 0, ended: 0 };
  for (const { row } of history.value.all) {
    if (row.state === 'parked' || row.state === 'blocked') result.waiting++;
    else if (isLive(row)) result.working++;
    else if (row.state === 'done') result.returned++;
    else result.ended++;
  }
  return result;
});
const leadModels = computed(() => refreshedLeadModels.value ?? plan.value?.leadModels ?? []);
const focusedRun = computed(() => {
  if (selectedRun.value && (selectedRun.value === 'lead' || history.value.all.some(node => node.row.key === selectedRun.value))) return selectedRun.value;
  const active = history.value.active;
  const current = active.find(node => node.row.state === 'working') ?? active.find(node => isLive(node.row));
  return current?.row.key || (leadModels.value.length ? 'lead' : '') || history.value.past[0]?.row.key;
});
const runRow = computed(() => history.value.all.find(node => node.row.key === focusedRun.value)?.row);
const liveRun = computed(() => runRow.value && isLive(runRow.value) ? liveRows.value.get(runRow.value.key) : undefined);
const recordedStage = computed(() => WORKFLOW_STEPS.find(step => step.id === runRow.value?.workflowStep)?.title);
const currentUpdate = computed(() => liveRun.value?.waitReason || liveRun.value?.lastCheckinSummary);
function activityRow(row: WorkflowRunRow) {
  return { ...row, lastActivityAt: liveRows.value.get(row.key)?.lastActivityAt };
}
const parentLabel = computed(() => {
  const row = runRow.value;
  if (!row) return '';
  if (!row.parentJobId) return plan.value?.canEdit ? 'Product Owner' : 'the chat lead';
  return history.value.all.find(node => node.row.key === `${ row.parentJobId }:${ row.parentTaskIndex }`)?.row.label ?? 'an earlier agent job';
});
const reviewedLabel = computed(() => {
  const previous = runRow.value?.followUpOf;
  return previous ? history.value.all.find(node => node.row.key === `${ previous.jobId }:${ previous.taskIndex }`)?.row.label ?? 'an earlier recorded task' : '';
});
const shownResponses = computed(() => focusedRun.value === 'lead' ? leadModels.value : runRow.value?.responseModels?.length ? runRow.value.responseModels : receipt.value);
function isLive(row: WorkflowRunRow): boolean {
  return ['queued', 'working', 'parked', 'quiet', 'blocked'].includes(row.state);
}
function status(state: AgentStateRow['state']): string {
  return { queued: 'Queued', working: 'Working', parked: 'Waiting', quiet: 'Quiet', blocked: 'Blocked', failed: 'Failed', lost: 'Unreachable', stopped: 'Stopped', done: 'Returned' }[state];
}
function fallbackReason(fallback: NonNullable<AgentModelStatusValue['fallbackFrom']>): string {
  const reason = fallback.reason === 'quota' ? 'reached its usage limit' : fallback.reason === 'rate_limit' ? 'was rate-limited' : fallback.reason === 'timeout' ? 'timed out' : 'could not finish the request';
  return `Fallback after ${ fallback.model || providerName(fallback.provider) } ${ reason }.`;
}
function latestResponse(row: WorkflowRunRow): AgentModelStatusValue | undefined {
  return row.key === focusedRun.value ? shownResponses.value.at(-1) : row.responseModels?.at(-1);
}
function selectRun(key: string): void {
  selectedRun.value = key;
  nextTick(() => {
    const details = runDetails.value;
    const width = details?.closest('.workflow')?.clientWidth;
    if (details && width && width < 710) details.scrollIntoView?.({ block: 'nearest' });
  });
}

async function reload(): Promise<void> {
  const sequence = ++loadSequence;
  const id = threadId.value;
  error.value = '';
  if (!id) return;
  try {
    const includePreview = mode.value === 'plan';
    const picker = includePreview ? modelPicker?.value : undefined;
    const data = await ipcRenderer.invoke('chat-workflow:get', id, includePreview, picker && { ...picker });
    if (sequence !== loadSequence) return;
    plan.value = data;
  } catch (cause) {
    if (sequence === loadSequence) error.value = errorMessage(cause);
  }
}
async function reloadHistory(): Promise<void> {
  const id = threadId.value;
  if (!id || historyLoading.value) return;
  const sequence = ++historySequence;
  historyLoading.value = true;
  try {
    const rows = await ipcRenderer.invoke('chat-workflow:history', id);
    if (sequence !== historySequence) return;
    savedHistory.value = rows;
    historyError.value = false;
  } catch {
    if (sequence === historySequence) historyError.value = true;
  } finally {
    if (sequence === historySequence) historyLoading.value = false;
  }
}
watch(threadId, () => {
  historySequence++;
  plan.value = undefined;
  refreshedLeadModels.value = undefined;
  editing.value = false;
  selectedRun.value = '';
  savedHistory.value = [];
  historyLoading.value = false;
  historyError.value = false;
  void reload();
}, { immediate: true });
watch([
  () => modelPicker?.value?.modelSelection,
  () => modelPicker?.value?.providerId,
  () => modelPicker?.value?.modelSelection === 'explicit' ? modelPicker.value.modelId : undefined,
  () => modelPicker?.value?.agentId,
  () => modelPicker?.value?.chatThreadId,
], () => {
  if (mode.value === 'plan') void reload();
});
watch([mode, threadId], ([view, id], [previousView, previousId], onCleanup) => {
  if (!id) return;
  if (view === 'plan') {
    if (previousView === 'run' && previousId === id) void reload();
    let timer: ReturnType<typeof setTimeout>;
    const refreshPlan = () => {
      clearTimeout(timer);
      if (!editing.value && !saving.value) timer = setTimeout(() => { if (!editing.value && !saving.value) void reload() }, 250);
    };
    ipcRenderer.on?.(MODEL_ROUTING_IPC.status, refreshPlan);
    ipcRenderer.on?.(MODEL_ROUTING_IPC.changed, refreshPlan);
    window.addEventListener('focus', refreshPlan);
    onCleanup(() => {
      clearTimeout(timer);
      ipcRenderer.removeListener?.(MODEL_ROUTING_IPC.status, refreshPlan);
      ipcRenderer.removeListener?.(MODEL_ROUTING_IPC.changed, refreshPlan);
      window.removeEventListener('focus', refreshPlan);
    });
    return;
  }
  let active = true;
  let leadLoading = false;
  const refresh = async() => {
    reloadHistory();
    if (leadLoading) return;
    leadLoading = true;
    try {
      const models = await ipcRenderer.invoke('chat-workflow:execution', id, null);
      if (active) refreshedLeadModels.value = models;
    } catch {
      // Keep the last recorded lead model available during a transient read failure.
    } finally {
      leadLoading = false;
    }
  };
  refresh();
  const timer = setInterval(refresh, 6_000);
  onCleanup(() => { active = false; clearInterval(timer) });
}, { immediate: true });
watch(() => [mode.value, threadId.value, runRow.value?.key, runRow.value?.state] as const, async(_, __, onCleanup) => {
  receipt.value = [];
  receiptError.value = '';
  receiptLoading.value = false;
  const id = threadId.value;
  const row = runRow.value;
  if (mode.value !== 'run' || !id || !row || row.responseModels?.length) return;
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
  draftRevision = planEntry.value!.revision;
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
    const data = await ipcRenderer.invoke('chat-workflow:save', { threadId: id, step, expectedRevision: draftRevision,
      choice: choice ? { ...choice, candidates: choice.candidates.map(candidate => ({ ...candidate })) } : null });
    if (threadId.value !== id) return;
    loadSequence++;
    plan.value = data;
    if (selectedStep.value === step) editing.value = false;
    if (mode.value === 'plan' && modelPicker?.value) await reload();
  } catch (cause) {
    if (threadId.value === id) error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.workflow { container-type: inline-size; display: grid; align-content: start; gap: 12px; padding: 14px; }
.wf-heading,.wf-actions { display: flex; flex-wrap: wrap; gap: 7px; align-items:center; }
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
.wf-detail-time { margin-inline-start: 5px; font-size: 11px; }
.wf-node small,.wf-priority small { display:block; color:var(--text-muted); font-size:11px; }
.wf-node b { font-size:12px; }
.wf-list { display:grid; gap:8px; min-width:0; }
.wf-earlier summary { font-size:13px; font-weight:650; cursor:pointer; }
.wf-earlier summary:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.wf-earlier[open] summary { margin-bottom:8px; }
.wf-status[data-state="working"] { color:var(--accent); }
.wf-status[data-state="parked"],.wf-status[data-state="blocked"] { color:var(--status-warning); }
.wf-status[data-state="done"] { color:var(--status-success); }
.wf-status[data-state="failed"],.wf-status[data-state="lost"] { color:var(--status-error); }
.wf-summary { display:flex; flex-wrap:wrap; gap:6px; }
.wf-summary span { font-size:11px; color:var(--text-muted); background:var(--bg-page); border:1px solid var(--border-default); border-radius:6px; padding:3px 7px; }
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
.wf-outcome-link { margin-block: 8px; }
</style>
