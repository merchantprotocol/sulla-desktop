<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div ref="pageRef" class="studio-page">
    <StudioTopbar
      ref="topbarRef"
      :crumbs="active ? ['Agents', active.name || 'New agent'] : directoryDetail ? ['Agents', directoryDetail.name] : ['Agents']"
      v-model:search="search"
      :search-placeholder="innerTab === 'dir' ? 'Search name, slug, when to call, model…' : 'Search custom agents'"
      @crumb="closeCurrentDetail"
    ><template #actions><button v-if="!active && !directoryDetail" class="btn pri" :disabled="!catalogLoaded" @click="newAgent">＋ New agent</button></template></StudioTopbar>
    <div class="studio-content">
      <template v-if="!active">
        <div v-if="!directoryDetail" class="tb"><h1>Agents</h1><span v-if="catalogLoaded">{{ agents.length }} installed on this Sulla</span><span v-if="refreshNotice" role="status">{{ refreshNotice }}</span></div>
        <div v-if="!directoryDetail" class="seg-tabs" ref="tabsRef">
          <i ref="tabIndRef" />
          <button :class="{ on: innerTab === 'dir' }" @click="selectTab('dir')">Directory</button>
          <button :class="{ on: innerTab === 'manage' }" @click="selectTab('manage')">Manage</button>
        </div>
        <ConfigurationLoadState v-if="!catalogLoaded" label="Loading agents…" :error="error ? 'Couldn’t load agents.' : ''" @retry="load" />
        <AgentDirectoryTab
          v-else-if="innerTab === 'dir'" ref="directoryRef" :agents="agents"
          :model-labels="configuredModelLabels" :loading="loading" v-model:search="search" @detail-change="directoryDetail = $event" @edit="editDirectoryAgent"
        />
        <template v-else>
          <div class="filters"><button :class="{ on: provider === 'all' }" @click="provider = 'all'">All {{ agents.length }}</button><button v-for="p in providers" :key="p.name" :class="{ on: provider === p.name }" @click="provider = p.name">{{ p.name }} {{ p.count }}</button></div>
          <div v-if="error" class="banner error"><div>{{ error }}</div><button class="btn sm" @click="load">Try again</button></div>
          <div v-else-if="loading" class="card empty">Loading custom agents…</div>
          <div v-else-if="filtered.length === 0" class="card empty"><b>Nothing here yet.</b><span>{{ search ? 'No agents match your search.' : 'Create an agent to get started.' }}</span></div>
          <div v-else class="card"><table><thead><tr><th>Agent</th><th>Model</th><th>Skills</th><th>Source</th><th></th></tr></thead><tbody><tr v-for="agent in filtered" :key="agent.id" class="click" @click="openAgent(agent)"><td><div class="name"><span class="fi blue">◉</span><div><b>{{ agent.name }}</b><small>{{ agent.description || 'No description' }}</small></div></div></td><td>{{ modelLabel(agent) }}</td><td>{{ skillsFor(agent).length }}</td><td>{{ sourceLabel(agent.sourceKind) }}</td><td class="right"><button class="btn sm" @click.stop="openAgent(agent)">Edit</button></td></tr></tbody></table></div>
        </template>
      </template>
      <template v-else>
        <button class="back" @click="closeDetail">‹ Agents</button>
        <div class="card hero"><span class="fi blue big">◉</span><div><h1>{{ form.name || 'New agent' }}</h1><p>{{ form.description || 'Configure a custom agent.' }}</p><div class="meta"><span>{{ editorSummary }}</span><span>{{ activeSkills.length }} skills</span><span>{{ form.enabled ? 'Enabled' : 'Disabled for new work' }}</span><span>{{ active.id ? sourceLabel(active.sourceKind) : 'You' }}</span></div></div><div class="acts"><button v-if="active.id" class="btn" :disabled="!canTry" :title="tryHint" @click="tryAgent">Try</button><button class="btn pri" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button></div></div>
        <div v-if="detailMessage" class="banner" :class="{ error: detailError }"><div>{{ detailMessage }}</div></div>
        <div class="dgrid"><div>
          <div class="tabs"><button :class="{ on: tab === 'profile' }" @click="tab = 'profile'">Profile</button><button :class="{ on: tab === 'routing' }" @click="tab = 'routing'">Routing</button><button :class="{ on: tab === 'prompt' }" @click="tab = 'prompt'">Prompt</button><button :class="{ on: tab === 'capabilities' }" @click="tab = 'capabilities'">Capabilities</button></div>
          <div v-if="tab === 'profile'" class="card box">
            <div class="frow"><div class="field"><label>Name</label><input v-model="form.name"></div><div class="field"><label>Slug</label><input v-model="form.slug" class="mono" :readonly="!!active.id"></div></div>
            <div class="field"><label>Description</label><textarea v-model="form.description" rows="3" /></div>
            <div class="field model-choice"><label>Model</label><AgentModelControls v-if="routing" v-model="editorChoice" v-model:fallbacks="editorFallbacks" :base-choice="editorBase" :state="routing" /><p v-else role="alert">Model settings could not be loaded. <button type="button" class="btn sm" @click="load">Retry</button></p></div>
            <label class="mt-4 flex items-center gap-2 text-sm"><input v-model="form.enabled" type="checkbox"><span>Enabled for new work</span><span class="text-xs text-content-muted">Existing jobs keep their launch settings.</span></label>
          </div>
          <div v-else-if="tab === 'routing'" class="card box"><AgentRoutingFields v-model="routingDraft" :agents="agents" /></div>
          <div v-else-if="tab === 'prompt'" class="card box"><h2>System prompt</h2><textarea v-model="form.prompt" class="editor" /></div>
          <div v-else class="card box"><AgentCapabilitiesFields v-model:allowed-tools="form.allowedTools" v-model:skill-refs="form.skillRefs" v-model:routine-refs="form.routineRefs" /></div>
        </div>
          <aside class="space-y-4">
            <AgentSetupSummary :form="form" :saved="!!active.id" :has-unsaved-edits="hasUnsavedEdits" :model-status="editorSummary" />
            <div class="card side"><h3>Details</h3><div class="kv"><span>Slug</span><b class="mono">{{ form.slug || '—' }}</b></div><div class="kv"><span>Source</span><b>{{ active.id ? sourceLabel(active.sourceKind) : 'You' }}</b></div><div class="kv"><span>Team</span><b>{{ teamLabel }}</b></div><div v-if="active.marketplaceVersion" class="kv"><span>Version</span><b class="mono">{{ active.marketplaceVersion }}</b></div><div v-if="active.id" class="side-foot"><button class="btn" @click="exportAgent">⤓ Export</button><button class="btn" :disabled="publishing" @click="publishAgent">↑ Publish to marketplace</button><button class="btn danger" @click="deleteAgent">Delete</button></div></div>
          </aside>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import AgentDirectoryTab from './AgentDirectoryTab.vue';
import AgentCapabilitiesFields from './AgentCapabilitiesFields.vue';
import AgentRoutingFields from './AgentRoutingFields.vue';
import AgentSetupSummary from './AgentSetupSummary.vue';
import { AgentModelConfiguration } from './AgentModelConfiguration';
import AgentModelControls from './AgentModelControls.vue';
import {
  editorCreateFromForm,
  editorDraftSignature,
  editorFormFromAgent,
  editorPatchFromForm,
  emptyAgentEditorForm,
  editorSnapshotSavedModel,
  editorSnapshotWithForm,
  editorSnapshotWithModel,
  normalizedModelChain,
  validateEditorDraft,
  type AgentEditorFormState,
} from './AgentEditorForm';
import StudioTopbar from './StudioTopbar.vue';
import ConfigurationLoadState from '@pkg/components/settings/ConfigurationLoadState.vue';
import type { ModelCandidate } from '@pkg/agent/languagemodels/modelRouter';
import { MODEL_ROUTING_IPC, type AgentModelChoice, type ModelRoutingState, type RoutingProviderInfo } from '@pkg/agent/languagemodels/modelRoutingTypes';
import { choiceLabel } from '@pkg/components/settings/sections/modelRouting/routingLogic';
import { ConfigurationLoadPolicy } from '@pkg/composables/useConfigurationLoad';
import { useDatabaseAvailableReload } from '@pkg/composables/useDatabaseAvailableReload';
import { openWorkspaceTab } from '@pkg/composables/useBrowserTabs';
import { agentEditorTeamLabel, agentTryTabPayload, cloneModelCandidates, type AgentEditorRoutingFields } from '@pkg/shared/agentEditor';
import { RefreshSequencer } from './live/RefreshSequencer';
import type { AgentDefinitionResponse } from '@pkg/main/agentsIpc';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type Agent = AgentDefinitionResponse & { modelChoice?: AgentModelChoice };
type Manifest = Awaited<ReturnType<typeof ipcRenderer.invoke<'agent-definitions:export'>>>;
const agents = ref<Agent[]>([]); const routing = ref<ModelRoutingState | null>(null); const manifests = ref(new Map<string, Manifest>()); const search = ref(''); const provider = ref('all'); const loading = ref(true); const error = ref(''); const active = ref<Agent | null>(null); const tab = ref<'profile'|'routing'|'prompt'|'capabilities'>('profile'); const saving = ref(false); const publishing = ref(false); const detailMessage = ref(''); const detailError = ref(false);
const innerTab = ref<'dir' | 'manage'>('dir');
const topbarRef = ref<InstanceType<typeof StudioTopbar> | null>(null);
const directoryRef = ref<InstanceType<typeof AgentDirectoryTab> | null>(null);
const directoryDetail = ref<Agent | null>(null);
const tabsRef = ref<HTMLElement | null>(null);
const tabIndRef = ref<HTMLElement | null>(null);

function moveTabIndicator() {
  const on = tabsRef.value?.querySelector<HTMLButtonElement>('button.on');
  if (!on || !tabIndRef.value) return;
  tabIndRef.value.style.width = `${ on.offsetWidth }px`;
  tabIndRef.value.style.transform = `translateX(${ on.offsetLeft }px)`;
}
function selectTab(next: 'dir' | 'manage') { innerTab.value = next; nextTick(moveTabIndicator); }
watch(innerTab, () => nextTick(moveTabIndicator));

function onKeydown(e: KeyboardEvent) {
  if (e.key !== '/' || active.value || innerTab.value !== 'dir') return;
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
  e.preventDefault();
  topbarRef.value?.focusSearch();
}
onMounted(() => { document.addEventListener('keydown', onKeydown); window.addEventListener('resize', moveTabIndicator); nextTick(moveTabIndicator); });
onBeforeUnmount(() => { document.removeEventListener('keydown', onKeydown); window.removeEventListener('resize', moveTabIndicator); });
const form = reactive<AgentEditorFormState>(emptyAgentEditorForm());
const editorChoice = ref<AgentModelChoice>({ mode: 'list' });
const editorBase = ref<AgentModelChoice>({ mode: 'list' });
const editorFallbacks = ref<ModelCandidate[]>([]);
// Unpin restores the latest unpinned class or list from this session, not the choice from open.
watch(editorChoice, choice => { if (choice.mode !== 'pin') editorBase.value = { ...choice }; });
const modelConfiguration = shallowRef<AgentModelConfiguration>();
function formModelChoice(): AgentModelChoice { return { ...editorChoice.value }; }
function selectionLabel(choice: AgentModelChoice): string { return `${choiceLabel(choice, routing.value)}${choice.mode === 'pin' ? ` · ${choice.effort || 'Provider default'}` : ''}`; }
const editorSummary = computed(() => selectionLabel(editorChoice.value));
const configuredModelLabels = computed(() => Object.fromEntries(agents.value.filter(agent => routing.value?.workerBindings?.[agent.slug]?.agentId === agent.id).map(agent => [agent.slug, selectionLabel(new AgentModelConfiguration(agent.id, agent.slug, routing.value).choice(agent.modelChoice ?? { mode: 'list' }))])));

const providers = computed(() => Array.from(new Set(agents.value.map(a => a.provider).filter(Boolean) as string[])).sort().map(name => ({ name, count: agents.value.filter(a => a.provider === name).length })));
const filtered = computed(() => { const q = search.value.trim().toLowerCase(); return agents.value.filter(a => (provider.value === 'all' || a.provider === provider.value) && (!q || `${a.name} ${a.description} ${a.slug} ${a.provider} ${a.modelSlot}`.toLowerCase().includes(q))); });
const activeSkills = computed(() => form.skillRefs);
const teamLabel = computed(() => agentEditorTeamLabel(form.canCall));
const routingDraft = computed<AgentEditorRoutingFields>({
  get: () => ({ whenToCall: form.whenToCall, whenNotToCall: form.whenNotToCall, send: form.send, returns: form.returns, costTier: form.costTier, canCall: [...form.canCall], frontDoor: form.frontDoor }),
  set: value => Object.assign(form, { ...value, canCall: [...value.canCall] }),
});
const openedEditorSnapshot = ref('');
const currentEditorSnapshot = computed(() => editorDraftSignature(form, editorChoice.value, editorFallbacks.value));
const hasUnsavedEdits = computed(() => !!active.value?.id && currentEditorSnapshot.value !== openedEditorSnapshot.value);
const canTry = computed(() => !!active.value?.id && form.enabled && !hasUnsavedEdits.value && !saving.value);
const tryHint = computed(() => {
  if (!active.value?.id) return 'Save this definition before trying it.';
  if (!form.enabled) return 'Enable and save this definition before trying it.';
  if (hasUnsavedEdits.value) return 'Save or discard edits before trying it.';
  return 'Opens a separate empty normal chat with this agent selected.';
});
function skillsFor(agent: Agent) { return manifests.value.get(agent.slug)?.spec.skills ?? []; }
function slotLabel(tier: Agent['modelSlot']) { return tier === 'primary' ? 'Primary' : tier === 'subconscious' ? 'Subconscious' : 'Secondary'; }
function modelLabel(agent: Agent | null) { if (agent && configuredModelLabels.value[agent.slug]) return configuredModelLabels.value[agent.slug]; if (agent?.modelChoice) return choiceLabel(agent.modelChoice, routing.value); return agent?.model ? `${agent.provider ?? 'Unknown'} / ${agent.model}` : slotLabel(agent?.modelSlot ?? null); }
function sourceLabel(source: string) { return source === 'local' ? 'You' : source === 'builtin' || source === 'built-in' ? 'Built-in' : source || '—'; }
// Every catalog read (load, save reload, periodic refresh) takes a ticket; an older read never overwrites a newer one.
const catalogReads = new RefreshSequencer();
const pageRef = ref<HTMLElement | null>(null);
const refreshNotice = ref('');
const catalogLoaded = ref(false);
const loadPolicy = new ConfigurationLoadPolicy();
let catalogKey = ''; let refreshing = false; let disposed = false; let latestCatalogRead = 0; let latestLoad = 0;
let providerStatusVersion = 0; let latestProviderStatus: RoutingProviderInfo[] | null = null;
const catalogSignature = (list: Agent[]) => JSON.stringify(list);
function nextCatalogRead(): number {
  latestCatalogRead = catalogReads.next();
  return latestCatalogRead;
}
async function readDetails(list: Agent[], includeManifests = true, routingStatusVersion = providerStatusVersion) {
  const nextRouting = await ipcRenderer.invoke(MODEL_ROUTING_IPC.get).catch(cause => {
    if (loadPolicy.isTransient(cause)) throw cause;
    return null;
  });
  const pairs = includeManifests
    ? await Promise.all(list.map(async a => [a.slug, await ipcRenderer.invoke('agent-definitions:export', a.slug)] as const).map(p => p.catch(() => null)))
    : [];
  return { nextRouting, routingStatusVersion, nextManifests: includeManifests ? new Map(pairs.filter((x): x is readonly [string, Manifest] => x !== null)) : undefined };
}
function applyRouting(nextRouting: ModelRoutingState | null, routingStatusVersion: number): void {
  if (!nextRouting) return;
  const providers = routingStatusVersion !== providerStatusVersion && latestProviderStatus ? latestProviderStatus : nextRouting.providers;
  latestProviderStatus = providers;
  // The open editor keeps its revision/token in its own AgentModelConfiguration snapshot, so routing mirrors the server.
  routing.value = { ...nextRouting, providers };
  restorePendingEditorModel();
}
function applyCatalog(list: Agent[], details: Awaited<ReturnType<typeof readDetails>>) {
  applyRouting(details.nextRouting, details.routingStatusVersion);
  const nextKey = catalogSignature(list);
  if (nextKey !== catalogKey) { agents.value = list; catalogKey = nextKey; }
  if (details.nextManifests) manifests.value = details.nextManifests;
  catalogLoaded.value = true;
  refreshNotice.value = ''; error.value = '';
}
function onRoutingStatus(_: unknown, providers: RoutingProviderInfo[]): void {
  if (disposed || !Array.isArray(providers)) return;
  providerStatusVersion += 1;
  latestProviderStatus = providers.slice();
  if (routing.value) routing.value = { ...routing.value, providers: latestProviderStatus };
}
// Strict reads: a database outage is reported as an error, never as an empty catalog.
const readCatalog = (): Promise<Agent[]> => ipcRenderer.invoke('agent-definitions:list', { strict: true });
const REFRESH_FAILED = 'Could not refresh agents; showing the last loaded list.';
/** True only when this read's fresh catalog was applied. */
async function load(): Promise<boolean> { if (disposed) return false; const ticket = nextCatalogRead(); const routingStatusVersion = providerStatusVersion; latestLoad = ticket; let applied = false; loading.value = true; error.value = ''; try { const list = await readCatalog(); const details = await readDetails(list, true, routingStatusVersion); if (!disposed && ticket === latestCatalogRead && catalogReads.tryApply(ticket)) { applyCatalog(list, details); applied = true; } } catch (e) { if (!disposed && ticket === latestCatalogRead && !catalogReads.hasAppliedNewerThan(ticket)) { if (catalogLoaded.value) refreshNotice.value = REFRESH_FAILED; else if (!loadPolicy.isTransient(e)) error.value = e instanceof Error ? e.message : String(e); } } finally { if (latestLoad === ticket) loading.value = false; } return applied; }
/** Native tabs stay mounted while hidden (v-show), so the document being visible is not enough. */
function pageVisible(): boolean {
  if (document.hidden || !pageRef.value?.isConnected) return false;
  for (let node: Element | null = pageRef.value; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}
/** Read-only inventory check while visible; routing is refreshed each time, manifests only when the inventory changes. */
async function refreshCatalog() {
  if (disposed || refreshing || loading.value || saving.value || error.value || !pageVisible()) return;
  refreshing = true; const ticket = nextCatalogRead(); const routingStatusVersion = providerStatusVersion;
  try {
    const list = await readCatalog();
    if (disposed || ticket !== latestCatalogRead || catalogReads.hasAppliedNewerThan(ticket)) return;
    const details = await readDetails(list, catalogSignature(list) !== catalogKey, routingStatusVersion);
    if (!disposed && ticket === latestCatalogRead && catalogReads.tryApply(ticket)) applyCatalog(list, details);
  } catch (cause) {
    if (!disposed && ticket === latestCatalogRead && !catalogReads.hasAppliedNewerThan(ticket)) {
      if (catalogLoaded.value) refreshNotice.value = REFRESH_FAILED;
      else if (!loadPolicy.isTransient(cause)) error.value = cause instanceof Error ? cause.message : String(cause);
    }
  } finally { refreshing = false; }
}
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const onDocumentVisibility = () => { void refreshCatalog(); };
onMounted(() => { refreshTimer = setInterval(() => { void refreshCatalog(); }, 5_000); document.addEventListener('visibilitychange', onDocumentVisibility); ipcRenderer.on(MODEL_ROUTING_IPC.status, onRoutingStatus); });
onBeforeUnmount(() => { disposed = true; if (refreshTimer) clearInterval(refreshTimer); refreshTimer = undefined; document.removeEventListener('visibilitychange', onDocumentVisibility); ipcRenderer.removeListener(MODEL_ROUTING_IPC.status, onRoutingStatus); });
function editDirectoryAgent(agent: Agent) { directoryDetail.value = null; innerTab.value = 'manage'; openAgent(agent); }
function closeCurrentDetail() { if (active.value) closeDetail(); else directoryRef.value?.closeDetail(); }
/** Bumped whenever the editor switches agents; a save only touches the editor it started in. */
let editorGeneration = 0;
/** Editor generation opened before model settings loaded; its saved model is shown once they arrive. */
let routingPendingEditor = 0; let openedModelDraft = '';
const modelDraft = () => JSON.stringify([editorChoice.value, editorFallbacks.value]);
/** A saved disabled definition is not in the runnable workers list, yet its owner may configure its model chain. */
const disabledOwnerDefinition = (agent: Agent) => !!agent.id && agent.enabled === false && agent.status !== 'archive';
function openAgent(agent: Agent) {
  editorGeneration++;
  active.value = agent;
  const configuration = new AgentModelConfiguration(agent.id, agent.slug, routing.value, agent.modelChoice ?? { mode: 'list' }, disabledOwnerDefinition(agent));
  modelConfiguration.value = configuration;
  editorBase.value = agent.modelChoice ? { ...agent.modelChoice } : { mode: 'list' };
  editorChoice.value = configuration.choice(editorBase.value);
  editorFallbacks.value = cloneModelCandidates(configuration.fallbacks());
  routingPendingEditor = routing.value ? 0 : editorGeneration; openedModelDraft = modelDraft();
  Object.assign(form, editorFormFromAgent(agent));
  openedEditorSnapshot.value = editorDraftSignature(form, editorChoice.value, editorFallbacks.value);
  tab.value = 'profile'; detailMessage.value = '';
}
/** First model settings for an editor opened without them: show the saved model unless the model was already edited. Profile and prompt drafts are never touched. */
function restorePendingEditorModel(): void {
  if (!routingPendingEditor || routingPendingEditor !== editorGeneration || !routing.value || !active.value?.id) return;
  routingPendingEditor = 0;
  const base = active.value.modelChoice ?? { mode: 'list' };
  const configuration = new AgentModelConfiguration(active.value.id, active.value.slug, routing.value, base, disabledOwnerDefinition(active.value));
  if (modelDraft() !== openedModelDraft && JSON.stringify([configuration.choice(base), configuration.fallbacks()]) !== modelDraft()) {
    detailError.value = true; detailMessage.value = 'Saved model settings loaded after the model was changed here. Your changes are kept; reopen this agent to review the saved model before saving.';
    return;
  }
  modelConfiguration.value = configuration;
  editorBase.value = base;
  editorChoice.value = configuration.choice(base);
  editorFallbacks.value = cloneModelCandidates(configuration.fallbacks());
  openedEditorSnapshot.value = editorSnapshotWithModel(
    openedEditorSnapshot.value,
    editorChoice.value,
    editorFallbacks.value,
  );
}
function newAgent() {
  editorGeneration++;
  active.value = {
    id: '', slug: '', name: '', description: '', provider: null, model: null, modelSlot: 'secondary', modelChoice: { mode: 'list' }, prompt: '',
    sourceKind: 'local', marketplaceVersion: null, status: 'production', enabled: true, runLocation: 'vm', whenToCall: '', whenNotToCall: '', send: '', returns: '', costTier: null, canCall: [],
    isBuiltin: false, frontDoor: null, updatedAt: '', type: null, allowedTools: [], skillRefs: [], routineRefs: [],
  };
  Object.assign(form, emptyAgentEditorForm());
  editorChoice.value = { mode: 'list' }; editorBase.value = { mode: 'list' }; editorFallbacks.value = []; modelConfiguration.value = undefined;
  openedEditorSnapshot.value = editorDraftSignature(form, editorChoice.value, editorFallbacks.value);
  tab.value = 'profile'; detailMessage.value = '';
}
const MODEL_SETTINGS_UNAVAILABLE = 'Model settings for this agent could not be loaded, so nothing was saved. Your edits are kept; Save again when model settings are available.';
const MODEL_SETTINGS_CHANGED = 'This agent\'s model settings changed elsewhere, so nothing was saved. Your edits are kept; reopen this agent to review the saved model before saving.';
/**
 * A saved agent whose owner model metadata is missing (for example, created while the agent list
 * could not be read back). Read the routing authority directly and adopt its mapping only if it still
 * holds exactly the chain this editor's saved baseline records; never a newer or foreign revision.
 */
async function recoverModelConfiguration(id: string, slug: string, disabled: boolean): Promise<{ configuration?: AgentModelConfiguration; refusal?: string }> {
  const saved = editorSnapshotSavedModel(openedEditorSnapshot.value);
  const statusVersion = providerStatusVersion;
  const fresh = await ipcRenderer.invoke(MODEL_ROUTING_IPC.get).catch(() => null);
  if (!fresh || !saved) return { refusal: MODEL_SETTINGS_UNAVAILABLE };
  applyRouting(fresh, statusVersion);
  const binding = fresh.workerBindings?.[slug];
  const owned = binding?.agentId === id ? normalizedModelChain(binding.candidates ?? []) : null;
  if (JSON.stringify(owned) !== JSON.stringify(saved.chain)) return { refusal: MODEL_SETTINGS_CHANGED };
  return { configuration: new AgentModelConfiguration(id, slug, fresh, saved.modelChoice, disabled) };
}
function closeDetail() { editorGeneration++; active.value = null; openedEditorSnapshot.value = ''; detailMessage.value = ''; }
async function tryAgent(): Promise<void> {
  if (!canTry.value || !active.value?.id || !active.value.slug) return;
  // Chat selection and runtime routing resolve agents by their saved slug, never by definition id.
  const payload = agentTryTabPayload(active.value.slug, `${ form.name || active.value.name } · Chat`);
  try {
    await openWorkspaceTab(payload);
  } catch (error) {
    detailMessage.value = error instanceof Error ? error.message : String(error);
  }
}
async function save() {
  if (!active.value) return;
  const validationError = validateEditorDraft(form);
  if (validationError) { detailError.value = true; detailMessage.value = validationError; return; }
  // Everything this save writes is fixed before its first await: the editor may move to another agent meanwhile.
  const origin = { editor: editorGeneration, id: active.value.id, slug: form.slug, updatedAt: active.value.updatedAt };
  const isOriginEditor = () => editorGeneration === origin.editor;
  const profile = editorPatchFromForm(form);
  const choice = formModelChoice();
  const createInput = editorCreateFromForm(form, choice, editorFallbacks.value);
  const submittedForm = JSON.parse(JSON.stringify(form)) as AgentEditorFormState;
  const submittedFallbacks = cloneModelCandidates(editorFallbacks.value);
  /** Move only the persisted parts into the saved baseline; anything edited meanwhile stays unsaved. */
  const markPersisted = (formPersisted: boolean, modelPersisted: boolean) => {
    if (!isOriginEditor()) return;
    let next = openedEditorSnapshot.value;
    if (formPersisted) next = editorSnapshotWithForm(next, submittedForm);
    if (modelPersisted) next = editorSnapshotWithModel(next, choice, submittedFallbacks);
    openedEditorSnapshot.value = next;
  };
  let configuration = modelConfiguration.value;
  const originDisabled = disabledOwnerDefinition(active.value);
  const draft = () => editorDraftSignature(form, editorChoice.value, editorFallbacks.value);
  const submitted = draft();
  // The model portion still equals what is saved: a profile-only save needs no owner model write.
  const modelUnchanged = editorSnapshotWithForm(openedEditorSnapshot.value, submittedForm) === submitted;
  saving.value = true; detailMessage.value = '';
  let modelSaved = false; let profileSaved = false;
  try {
    if (origin.id && !configuration) {
      const recovered = await recoverModelConfiguration(origin.id, origin.slug, originDisabled);
      if (recovered.configuration) {
        configuration = recovered.configuration;
        if (isOriginEditor()) modelConfiguration.value = configuration;
      } else if (!modelUnchanged || recovered.refusal === MODEL_SETTINGS_CHANGED) {
        // Never let a saved subscription role bypass its binding through the profile.
        throw new Error(recovered.refusal);
      }
    }
    // Click-time fallbacks. Edits made while recoverModelConfiguration awaits must not mix into this write.
    const change = configuration?.change(choice, submittedFallbacks, routing.value);
    if (change?.candidates) {
      routing.value = await ipcRenderer.invoke(MODEL_ROUTING_IPC.workerSet, change);
      configuration?.adopt(routing.value); modelSaved = true; markPersisted(false, true);
    }
    if (origin.id) {
      const updated = await ipcRenderer.invoke('agent-definitions:update', origin.id, { ...profile, ...(routing.value && configuration && !configuration.usesBinding(choice, routing.value) ? { modelChoice: choice } : {}), ...(origin.updatedAt ? { expectedUpdatedAt: origin.updatedAt } : {}) });
      if (!updated) throw new Error('This agent changed elsewhere. Reload before saving to review the conflict.');
      // Adopt this write's timestamp so the next save's CAS compares against it, even without a fresh readback.
      if (isOriginEditor() && active.value?.id === origin.id) active.value = { ...active.value, updatedAt: updated.updated_at || active.value.updatedAt };
      markPersisted(true, change === undefined);
    }
    else {
      const created = await ipcRenderer.invoke('agent-definitions:create', createInput);
      // Only the editor that created it adopts the persisted identity, so its next save updates instead of creating again.
      if (created?.id && isOriginEditor() && active.value) {
        active.value = { ...active.value, id: created.id, slug: created.slug || origin.slug, enabled: created.enabled !== false, updatedAt: created.updated_at || active.value.updatedAt };
        // Create persists the profile and its whole model chain together.
        markPersisted(true, true);
      }
    }
    profileSaved = true;
    if (change?.candidates === null) {
      routing.value = await ipcRenderer.invoke(MODEL_ROUTING_IPC.workerSet, change);
      configuration?.adopt(routing.value); modelSaved = true; markPersisted(false, true);
    }
    const fresh = await load();
    // The editor now shows another agent: leave its form and message alone.
    if (!isOriginEditor()) return;
    // Reopen only from a fresh readback, and only if nothing was edited while saving; otherwise keep the open form.
    const saved = fresh && draft() === submitted ? agents.value.find(a => a.slug === origin.slug) : undefined; if (saved) openAgent(saved);
    detailError.value = false; detailMessage.value = `Saved. Model changes apply to new work; running jobs keep their launch settings.${ fresh ? '' : ' The agent list will refresh when the database is reachable.' }`;
  } catch (e) {
    if (!isOriginEditor()) return;
    detailError.value = true;
    const reason = e instanceof Error ? e.message : String(e);
    detailMessage.value = `${modelSaved ? 'Model settings were saved; profile could not be saved. ' : profileSaved ? 'Profile was saved; model settings could not be saved. ' : ''}${ reason }`;
  } finally { saving.value = false; }
}
async function exportAgent() { if (!active.value) return; const manifest = await ipcRenderer.invoke('agent-definitions:export', active.value.slug); const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${ active.value.slug }.json`; a.click(); URL.revokeObjectURL(url); }
async function publishAgent() { if (!active.value) return; publishing.value = true; const check = await ipcRenderer.invoke('agent-definitions:publish-check', active.value.slug); if ('error' in check) { detailError.value = true; detailMessage.value = check.error; publishing.value = false; return; } if (check.warnings.length && !window.confirm(`${ check.warnings.join('\n') }\n\nPublish anyway?`)) { publishing.value = false; return; } const res = await ipcRenderer.invoke('agent-definitions:publish', active.value.slug); publishing.value = false; detailError.value = 'error' in res; detailMessage.value = 'error' in res ? res.error : `Submitted as ${ res.templateId }.`; }
async function deleteAgent() {
  const agent = active.value;
  if (!agent?.id || saving.value || publishing.value || !window.confirm(`Delete ${ agent.name }?`)) return;
  const generation = editorGeneration;
  saving.value = true;
  detailMessage.value = '';
  try {
    const removed = await ipcRenderer.invoke('agent-definitions:delete', agent.id);
    if (!removed) throw new Error('This agent has already been removed.');
    if (generation === editorGeneration) closeDetail();
    await load();
  } catch (cause) {
    if (generation === editorGeneration) {
      detailError.value = true;
      detailMessage.value = cause instanceof Error ? cause.message : String(cause);
    }
  } finally {
    saving.value = false;
  }
}
onMounted(load);
useDatabaseAvailableReload(load, 'StudioAgentsPage');
</script>

<style scoped lang="scss">
@import '@pkg/assets/styles/studio-ui.scss';

.seg-tabs { position: relative; display: inline-flex; gap: 2px; margin-bottom: 16px; padding: 3px; border: 1px solid var(--uc-line); border-radius: 10px; background: var(--uc-paper); }
.seg-tabs button { position: relative; z-index: 1; padding: 5px 14px; border: 0; border-radius: 7px; background: transparent; color: var(--uc-muted); font: inherit; cursor: pointer; transition: color 160ms ease; }
.seg-tabs button.on { color: var(--uc-text); font-weight: 500; }
.seg-tabs i { position: absolute; top: 3px; bottom: 3px; left: 0; border-radius: 7px; background: var(--uc-card); box-shadow: var(--uc-shadow), inset 0 0 0 1px var(--uc-line); transition: transform 240ms cubic-bezier(.22, 1, .36, 1), width 240ms cubic-bezier(.22, 1, .36, 1); }
</style>
