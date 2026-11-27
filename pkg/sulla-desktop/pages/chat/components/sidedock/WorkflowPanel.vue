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
import AgentActivityTime from '../chrome/AgentActivityTime.vue';
import ModelLaunchPreview from '@pkg/components/ModelLaunchPreview.vue';
import { AgentModelStatus } from '@pkg/shared/agentState/AgentModelStatus';
import { WorkflowPanelBindings } from './useWorkflowPanel';

const props = defineProps<{ view: 'activity' | 'team'; outcomeKeys?: readonly string[]; leadAt?: number }>();
const emit = defineEmits<{ (event: 'show-outcome', key: string): void }>();
const {
  threadId, plan, error, saving, editing, mode, heading, selectedStep, selectedTitle, draft, planDetails,
  selectedRun, runDetails, receiptLoading, receiptError, savedHistory, historyLoading, historyError,
  planEntry, eligibleAgents, hasOverride, providerName, agentName, effortLabel, candidateKey, efforts,
  modelOptions, stages, history, groups, counts, leadModels, focusedRun, runRow, liveRun, recordedStage,
  currentUpdate, activityRow, parentLabel, reviewedLabel, shownResponses, isLive, status, fallbackReason,
  latestResponse, selectRun, reload, reloadHistory, pickStep, beginEdit, selectModel, moveUp, save,
} = WorkflowPanelBindings.use(props, emit);
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
