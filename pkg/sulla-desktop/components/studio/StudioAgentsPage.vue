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
    ><template #actions>
      <template v-if="!active && !directoryDetail">
        <input ref="importInput" type="file" accept=".json,application/json" hidden @change="importAgent">
        <button type="button" class="btn" :disabled="!catalogLoaded || importing" @click="importInput?.click()">{{ importing ? 'Importing…' : 'Import' }}</button>
        <button type="button" class="btn pri" :disabled="!catalogLoaded || importing" @click="newAgent">＋ New agent</button>
      </template>
    </template></StudioTopbar>
    <div class="studio-content">
      <div v-if="importMessage && !active" class="banner" :class="{ error: importError }" :role="importError ? 'alert' : 'status'">{{ importMessage }}</div>
      <template v-if="!active">
        <div v-if="!directoryDetail" class="tb"><h1>Agents</h1><span v-if="catalogLoaded">{{ agents.length }} installed on this Sulla</span><span v-if="refreshNotice" role="status">{{ refreshNotice }}</span></div>
        <div v-if="!directoryDetail" class="seg-tabs" ref="tabsRef">
          <i ref="tabIndRef" />
          <button :class="{ on: innerTab === 'dir' }" @click="selectTab('dir')">Directory</button>
          <button :class="{ on: innerTab === 'manage' }" @click="selectTab('manage')">Manage</button>
        </div>
        <ConfigurationLoadState v-if="!catalogLoaded" label="Loading agents…" :error="error ? 'Couldn’t load agents.' : ''" @retry="load()" />
        <AgentDirectoryTab
          v-else-if="innerTab === 'dir'" ref="directoryRef" :agents="agents"
          :model-labels="configuredModelLabels" :model-routes="configuredModelRoutes" :loading="loading" v-model:search="search" @detail-change="directoryDetail = $event" @edit="editDirectoryAgent"
        />
        <template v-else>
          <div class="filters"><button :class="{ on: provider === 'all' }" @click="provider = 'all'">All {{ agents.length }}</button><button v-for="p in providers" :key="p.name" :class="{ on: provider === p.name }" @click="provider = p.name">{{ p.name }} {{ p.count }}</button></div>
          <div v-if="error" class="banner error"><div>{{ error }}</div><button class="btn sm" @click="load()">Try again</button></div>
          <div v-else-if="loading" class="card empty">Loading custom agents…</div>
          <div v-else-if="filtered.length === 0" class="card empty"><b>Nothing here yet.</b><span>{{ search ? 'No agents match your search.' : 'Create an agent to get started.' }}</span></div>
          <div v-else class="card"><table><thead><tr><th>Agent</th><th>Model</th><th>Skills</th><th>Source</th><th></th></tr></thead><tbody><tr v-for="agent in filtered" :key="agent.id" class="click" @click="openAgent(agent)"><td><div class="name"><span class="fi blue">◉</span><div><b>{{ agent.name }}</b><small>{{ agent.description || 'No description' }}</small></div></div></td><td>{{ modelLabel(agent) }}</td><td>{{ skillsFor(agent).length }}</td><td>{{ sourceLabel(agent.sourceKind) }}</td><td class="right"><button class="btn sm" @click.stop="openAgent(agent)">Edit</button></td></tr></tbody></table></div>
        </template>
      </template>
      <template v-else>
        <button class="back" @click="closeDetail">‹ Agents</button>
        <div class="card hero"><span class="fi blue big">◉</span><div class="agent-identity"><h1>{{ form.name || 'New agent' }}</h1><p>{{ form.description || 'Configure a custom agent.' }}</p><div class="meta"><span>{{ editorSummary }}</span><span>{{ activeSkills.length }} skills</span><span>{{ form.enabled ? 'Enabled' : 'Disabled for new work' }}</span><span>{{ active.id ? sourceLabel(active.sourceKind) : 'You' }}</span></div></div><div class="acts"><button type="button" class="btn" :disabled="saving || reloading" @click="closeDetail">Cancel</button><button v-if="active.id" type="button" class="btn" :disabled="saving || reloading" @click="reloadEditor">{{ reloading ? 'Reloading…' : 'Reload' }}</button><button v-if="active.id" class="btn" :disabled="!canTry" :title="tryHint" @click="tryAgent">Try</button><button class="btn pri" :disabled="saving || reloading" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button></div></div>
        <div v-if="detailMessage" class="banner" :class="{ error: detailError }"><div>{{ detailMessage }}</div></div>
        <div class="dgrid"><div>
          <div class="tabs"><button :class="{ on: tab === 'profile' }" @click="tab = 'profile'">Profile</button><button :class="{ on: tab === 'routing' }" @click="tab = 'routing'">Routing</button><button v-if="active.id" :class="{ on: tab === 'team' }" @click="tab = 'team'">Team</button><button :class="{ on: tab === 'prompt' }" @click="tab = 'prompt'">Prompt</button><button :class="{ on: tab === 'capabilities' }" @click="tab = 'capabilities'">Capabilities</button></div>
          <div v-if="tab === 'profile'" class="card box">
            <div class="frow"><div class="field"><label>Name</label><input v-model="form.name"></div><div class="field"><label>Slug</label><input v-model="form.slug" class="mono" :readonly="!!active.id"></div></div>
            <div class="field"><label>Description</label><textarea v-model="form.description" rows="3" /></div>
            <div class="field model-choice">
              <label>Model</label>
              <AgentModelControls v-if="routing" v-model="editorChoice" v-model:tiers="editorTiers" :source="editorModelSource" :state="routing" />
              <p v-else role="alert">Model settings could not be loaded. <button type="button" class="btn sm" @click="load()">Retry</button></p>
              <div v-if="routing" class="model-preview" aria-live="polite">
                <ModelLaunchPreview v-if="launchPreview" :preview="launchPreview" :providers="routing.providers" />
                <p v-else>Checking next launch…</p>
                <button v-if="previewFailed" type="button" class="btn sm" @click="previewRetry++">Retry preview</button>
              </div>
            </div>
            <label class="mt-4 flex items-center gap-2 text-sm"><input v-model="form.enabled" type="checkbox"><span>Enabled for new work</span><span class="text-xs text-content-muted">Existing jobs keep their launch settings.</span></label>
          </div>
          <div v-else-if="tab === 'routing'" class="card box"><AgentRoutingFields v-model="routingDraft" :agents="agents" /></div>
          <div v-else-if="tab === 'team'" class="card box team-box">
            <AgentTeamFields
              v-if="routing && active.id"
              :owner="{ ...active, canCall: [...form.canCall] }"
              :agents="agents"
              :routing="routing"
              :drafts="teamModelViews"
              @update-tiers="setTeamTiers"
            />
            <p v-else role="alert">Team model settings could not be loaded. <button type="button" class="btn sm" @click="load(true)">Retry</button></p>
          </div>
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
import AgentTeamFields from './AgentTeamFields.vue';
import type { AgentTeamModelDraft } from './AgentTeamFields.types';
import { AgentModelConfiguration, copyModelTiers } from './AgentModelConfiguration';
import AgentModelControls from './AgentModelControls.vue';
import {
  editorCreateFromForm,
  editorFormFromAgent,
  editorPatchFromForm,
  editorProfileSignature,
  emptyAgentEditorForm,
  validateEditorDraft,
  type AgentEditorFormState,
} from './AgentEditorForm';
import StudioTopbar from './StudioTopbar.vue';
import ModelLaunchPreview from '@pkg/components/ModelLaunchPreview.vue';
import ConfigurationLoadState from '@pkg/components/settings/ConfigurationLoadState.vue';
import { cleanAgentModelTiers, type AgentModelTiers } from '@pkg/agent/languagemodels/agentModelTiers';
import type { AgentPreviewRequest, ModelLaunchPreview as LaunchPreview } from '@pkg/shared/modelLaunchPreview';
import { MODEL_ROUTING_IPC, type AgentModelChoice, type ModelRoutingState, type RoutingProviderInfo } from '@pkg/agent/languagemodels/modelRoutingTypes';
import { CLASS_LABELS, choiceLabel } from '@pkg/components/settings/sections/modelRouting/routingLogic';
import { ConfigurationLoadPolicy } from '@pkg/composables/useConfigurationLoad';
import { useDatabaseAvailableReload } from '@pkg/composables/useDatabaseAvailableReload';
import { openWorkspaceTab } from '@pkg/composables/useBrowserTabs';
import { agentEditorTeamLabel, agentTryTabPayload, type AgentEditorRoutingFields } from '@pkg/shared/agentEditor';
import { RefreshSequencer } from './live/RefreshSequencer';
import type { AgentDefinitionResponse } from '@pkg/main/agentsIpc';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type Agent = AgentDefinitionResponse & { modelChoice?: AgentModelChoice };
type Manifest = Awaited<ReturnType<typeof ipcRenderer.invoke<'agent-definitions:export'>>>;
const agents = ref<Agent[]>([]); const routing = ref<ModelRoutingState | null>(null); const manifests = ref(new Map<string, Manifest>()); const search = ref(''); const provider = ref('all'); const loading = ref(true); const error = ref(''); const active = ref<Agent | null>(null); const tab = ref<'profile'|'routing'|'team'|'prompt'|'capabilities'>('profile'); const saving = ref(false); const publishing = ref(false); const detailMessage = ref(''); const detailError = ref(false);
const innerTab = ref<'dir' | 'manage'>('dir');
const topbarRef = ref<InstanceType<typeof StudioTopbar> | null>(null);
const directoryRef = ref<InstanceType<typeof AgentDirectoryTab> | null>(null);
const directoryDetail = ref<Agent | null>(null);
const importInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const importMessage = ref('');
const importError = ref(false);
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
const editorTiers = ref<AgentModelTiers | null>(null);
const modelConfiguration = shallowRef<AgentModelConfiguration>();
const pendingModel = ref(false);
const reloading = ref(false);
const savedChoice = ref<AgentModelChoice>({ mode: 'list' });
const savedTiers = ref<AgentModelTiers | null>(null);
const savedForm = ref('');
interface TeamModelState extends AgentTeamModelDraft { configuration: AgentModelConfiguration }
const teamModels = ref<Record<string, TeamModelState>>({});
const teamModelViews = computed<Record<string, AgentTeamModelDraft>>(() => Object.fromEntries(Object.entries(teamModels.value).map(([slug, draft]) => [slug, {
  choice: draft.choice, savedTiers: draft.savedTiers, tiers: draft.tiers,
}])));
const teamModelChanged = computed(() => Object.values(teamModels.value).some(draft => JSON.stringify(draft.tiers) !== JSON.stringify(draft.savedTiers)));
const tierChanged = computed(() => JSON.stringify(editorTiers.value) !== JSON.stringify(savedTiers.value));
const choiceChanged = computed(() => JSON.stringify(editorChoice.value) !== JSON.stringify(savedChoice.value));
const modelChanged = computed(() => tierChanged.value || choiceChanged.value);
const editorModelSource = computed(() => {
  if (editorTiers.value) return modelChanged.value ? 'Unsaved model tiers' : modelConfiguration.value?.isLegacyFlat() ? 'Saved model order' : 'Saved model tiers';
  if (editorChoice.value.mode === 'class') return `Inherits ${ CLASS_LABELS[editorChoice.value.class] } class from AI Models`;
  return editorChoice.value.mode === 'pin' ? 'Saved model pin' : 'Inherits the Agents list from AI Models';
});
function selectionLabel(choice: AgentModelChoice): string { return `${choiceLabel(choice, routing.value)}${choice.mode === 'pin' ? ` · ${choice.effort || 'Provider default'}` : ''}`; }
const editorSummary = computed(() => {
  const first = editorTiers.value?.tiers[0]?.candidates[0];
  return selectionLabel(first ? { ...first, mode: 'pin' } : editorChoice.value);
});
const configuredModelLabels = computed(() => Object.fromEntries(agents.value.filter(agent => routing.value?.workerBindings?.[agent.slug]?.agentId === agent.id).map(agent => [agent.slug, selectionLabel(new AgentModelConfiguration(agent.id, agent.slug, routing.value).choice(agent.modelChoice ?? { mode: 'list' }))])));
const configuredModelRoutes = computed<Record<string, string[]>>(() => Object.fromEntries(agents.value.map(agent => {
  const configuration = new AgentModelConfiguration(agent.id, agent.slug, routing.value, disabledOwnerDefinition(agent));
  const tiers = configuration.tiers();
  if (!tiers) return [agent.slug, [configuredModelLabels.value[agent.slug] ?? modelLabel(agent)]];
  return [agent.slug, tiers.tiers.map((tier, index) => `Tier ${ index + 1 } · ${ tier.candidates.map(candidate => selectionLabel({ ...candidate, mode: 'pin' })).join(' or ') }`)];
})));

const providers = computed(() => Array.from(new Set(agents.value.map(a => a.provider).filter(Boolean) as string[])).sort().map(name => ({ name, count: agents.value.filter(a => a.provider === name).length })));
const filtered = computed(() => { const q = search.value.trim().toLowerCase(); return agents.value.filter(a => (provider.value === 'all' || a.provider === provider.value) && (!q || `${a.name} ${a.description} ${a.slug} ${a.provider} ${a.modelSlot}`.toLowerCase().includes(q))); });
const activeSkills = computed(() => form.skillRefs);
const teamLabel = computed(() => agentEditorTeamLabel(form.canCall));
const routingDraft = computed<AgentEditorRoutingFields>({
  get: () => ({ whenToCall: form.whenToCall, whenNotToCall: form.whenNotToCall, send: form.send, returns: form.returns, costTier: form.costTier, canCall: [...form.canCall], frontDoor: form.frontDoor }),
  set: value => Object.assign(form, { ...value, canCall: [...value.canCall] }),
});
const profileSignature = () => editorProfileSignature(form);
const teamSignature = () => Object.entries(teamModels.value).sort(([left], [right]) => left.localeCompare(right)).map(([slug, draft]) => [slug, draft.tiers]);
const draftSignature = () => JSON.stringify([profileSignature(), editorChoice.value, editorTiers.value, teamSignature()]);
const hasUnsavedEdits = computed(() => !!active.value?.id && (profileSignature() !== savedForm.value || modelChanged.value || teamModelChanged.value));
const canTry = computed(() => !!active.value?.id && form.enabled && !hasUnsavedEdits.value && !saving.value && !reloading.value);
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
  syncTeamModels();
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
async function load(requireRouting = false): Promise<boolean> { if (disposed) return false; const ticket = nextCatalogRead(); const routingStatusVersion = providerStatusVersion; latestLoad = ticket; let applied = false; loading.value = true; error.value = ''; try { const list = await readCatalog(); const details = await readDetails(list, true, routingStatusVersion); if (requireRouting && !details.nextRouting) throw new Error('Model settings are unavailable.'); if (!disposed && ticket === latestCatalogRead && catalogReads.tryApply(ticket)) { applyCatalog(list, details); applied = true; } } catch (e) { if (!disposed && ticket === latestCatalogRead && !catalogReads.hasAppliedNewerThan(ticket)) { if (catalogLoaded.value) refreshNotice.value = REFRESH_FAILED; else if (!loadPolicy.isTransient(e)) error.value = e instanceof Error ? e.message : String(e); } } finally { if (latestLoad === ticket) loading.value = false; } return applied; }
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
  if (disposed || refreshing || loading.value || saving.value || reloading.value || importing.value || error.value || !pageVisible()) return;
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
/** A saved disabled definition is not in the runnable workers list, yet its owner may configure its model chain. */
const disabledOwnerDefinition = (agent: Agent) => !!agent.id && agent.enabled === false && agent.status !== 'archive';
function openAgent(agent: Agent) {
  editorGeneration++;
  active.value = agent;
  pendingModel.value = !routing.value;
  restoreEditorModel(agent);
  restoreTeamModels();
  Object.assign(form, editorFormFromAgent(agent));
  savedForm.value = profileSignature();
  tab.value = 'profile';
  detailMessage.value = '';
}
function restoreEditorModel(agent: Agent) {
  const configuration = agent.id && routing.value ? new AgentModelConfiguration(agent.id, agent.slug, routing.value, disabledOwnerDefinition(agent)) : undefined;
  modelConfiguration.value = configuration;
  savedChoice.value = editorChoice.value = { ...(agent.modelChoice ?? { mode: 'list' }) };
  savedTiers.value = configuration?.tiers() ?? null;
  editorTiers.value = copyModelTiers(savedTiers.value);
}
/** Controls stay hidden until the first model settings read. Profile edits remain intact when it arrives. */
function restorePendingEditorModel(): void {
  if (!pendingModel.value || !routing.value || !active.value) return;
  pendingModel.value = false;
  restoreEditorModel(active.value);
  restoreTeamModels();
}
function modelConfigurationFor(agent: Agent): AgentModelConfiguration | undefined {
  if (!agent.id || !routing.value) return undefined;
  return new AgentModelConfiguration(agent.id, agent.slug, routing.value, disabledOwnerDefinition(agent));
}
function teamModelState(agent: Agent): TeamModelState | undefined {
  const configuration = modelConfigurationFor(agent);
  if (!configuration) return undefined;
  const savedTiers = configuration.tiers();
  return {
    configuration,
    choice: { ...(agent.modelChoice ?? { mode: 'list' }) },
    savedTiers,
    tiers: copyModelTiers(savedTiers),
  };
}
function restoreTeamModels(): void {
  if (!active.value?.id || !routing.value) { teamModels.value = {}; return; }
  teamModels.value = Object.fromEntries(agents.value
    .filter(agent => agent.id && agent.id !== active.value?.id && agent.status !== 'archive')
    .map(agent => [agent.slug, teamModelState(agent)] as const)
    .filter((entry): entry is readonly [string, TeamModelState] => !!entry[1]));
}
/** Provider refreshes may update availability, but never overwrite an unsaved team edit. */
function syncTeamModels(): void {
  if (!active.value?.id || !routing.value) return;
  const next: Record<string, TeamModelState> = {};
  for (const agent of agents.value.filter(row => row.id && row.id !== active.value?.id && row.status !== 'archive')) {
    const prior = teamModels.value[agent.slug];
    if (prior && JSON.stringify(prior.tiers) !== JSON.stringify(prior.savedTiers)) next[agent.slug] = prior;
    else {
      const fresh = teamModelState(agent);
      if (fresh) next[agent.slug] = fresh;
    }
  }
  teamModels.value = next;
}
function setTeamTiers(slug: string, tiers: AgentModelTiers | null): void {
  const draft = teamModels.value[slug];
  if (!draft) return;
  teamModels.value = { ...teamModels.value, [slug]: { ...draft, tiers: copyModelTiers(tiers) } };
}
function newAgent() {
  const agent: Agent = {
    id: '', slug: '', name: '', description: '', provider: null, model: null, modelSlot: 'secondary', modelChoice: { mode: 'list' }, prompt: '',
    sourceKind: 'local', marketplaceVersion: null, status: 'production', enabled: true, runLocation: 'vm', whenToCall: '', whenNotToCall: '', send: '', returns: '', costTier: null, canCall: [],
    isBuiltin: false, frontDoor: null, updatedAt: '', type: null, allowedTools: [], skillRefs: [], routineRefs: [],
  };
  openAgent(agent);
}
function closeDetail() {
  editorGeneration++;
  active.value = null;
  pendingModel.value = false;
  teamModels.value = {};
  detailMessage.value = '';
}
async function reloadEditor() {
  if (saving.value || reloading.value || !active.value?.id) return;
  const generation = editorGeneration;
  const id = active.value.id;
  const submitted = draftSignature();
  reloading.value = true;
  try {
    const fresh = await load(true);
    if (editorGeneration !== generation || draftSignature() !== submitted) return;
    const agent = fresh && agents.value.find(row => row.id === id);
    if (agent) openAgent(agent);
    else {
      detailError.value = true;
      detailMessage.value = fresh ? 'This agent is no longer available.' : 'Could not reload the agent. Your edits are kept.';
    }
  } finally { reloading.value = false; }
}

const launchPreview = ref<LaunchPreview>();
const previewRetry = ref(0);
const previewFailed = ref(false);
const previewKey = computed(() => {
  const agent = active.value;
  if (!agent || !routing.value || tab.value !== 'profile') return '';
  const identity = agent.id ? { slug: agent.slug, agentId: agent.id } : { slug: form.slug || undefined };
  const input: AgentPreviewRequest = !agent.id || modelChanged.value
    ? { ...identity, choice: editorChoice.value, modelTiers: editorTiers.value }
    : identity;
  // The editor retains its original CAS token. Preview the latest route and provider readiness.
  const state = routing.value;
  const binding = state.workerBindings?.[agent.slug];
  return JSON.stringify({
    input,
    retry: previewRetry.value,
    routing: [binding?.revision, binding?.editToken, state.providers, state.agentsList, state.classes, state.followProviderOrder, state.neverUse, agent.modelChoice],
  });
});
watch(previewKey, (key, _, onCleanup) => {
  launchPreview.value = undefined;
  previewFailed.value = false;
  if (!key) return;
  const { input } = JSON.parse(key) as { input: AgentPreviewRequest };
  let current = true;
  const timer = setTimeout(async() => {
    try {
      const result = await ipcRenderer.invoke('model-routing:preview', input);
      if (!Array.isArray(result?.candidates)) throw new Error('Preview unavailable.');
      if (current) launchPreview.value = result;
    } catch {
      if (current) {
        previewFailed.value = true;
        launchPreview.value = { status: 'waiting', reason: 'Model preview is temporarily unavailable.', candidates: [] };
      }
    }
  }, 200);
  onCleanup(() => { current = false; clearTimeout(timer); });
});

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
  if (!active.value || saving.value || reloading.value) return;
  const validationError = validateEditorDraft(form);
  if (validationError) { detailError.value = true; detailMessage.value = validationError; return; }
  // Capture the submitted data before awaiting. Edits made during a save stay in the editor.
  const origin = { editor: editorGeneration, id: active.value.id, slug: form.slug, updatedAt: active.value.updatedAt };
  const submittedTab = tab.value;
  const isOriginEditor = () => editorGeneration === origin.editor;
  const profile = editorPatchFromForm(form);
  const choice = { ...editorChoice.value };
  const tiers = copyModelTiers(editorTiers.value);
  const writeChoice = choiceChanged.value;
  const writeTiers = tierChanged.value;
  const configuration = modelConfiguration.value;
  let teamChanges: { slug: string; tiers: AgentModelTiers | null; configuration: AgentModelConfiguration; change: NonNullable<ReturnType<AgentModelConfiguration['change']>> }[] = [];
  const submittedForm = profileSignature();
  const submitted = draftSignature();
  saving.value = true;
  detailMessage.value = '';
  let modelSaved = false;
  let profileSaved = false;
  let teamSaved = 0;
  try {
    teamChanges = Object.entries(teamModels.value).flatMap(([slug, draft]) => {
      if (JSON.stringify(draft.tiers) === JSON.stringify(draft.savedTiers)) return [];
      const tiers = copyModelTiers(draft.tiers);
      const change = draft.configuration.change(tiers, routing.value);
      return change ? [{ slug, tiers, configuration: draft.configuration, change }] : [];
    });
    if (origin.id && (writeChoice || writeTiers) && !configuration) throw new Error('Model settings could not be loaded. Reload to review the saved settings before saving your model edits.');
    const change = writeTiers ? configuration?.change(tiers, routing.value) : undefined;
    const markModelSaved = () => {
      configuration?.adopt(routing.value);
      if (!isOriginEditor()) return;
      const saved = configuration?.tiers() ?? null;
      if (JSON.stringify(editorTiers.value) === JSON.stringify(tiers)) editorTiers.value = copyModelTiers(saved);
      savedTiers.value = saved;
    };
    if (change?.modelTiers) {
      const statusVersion = providerStatusVersion;
      const next = await ipcRenderer.invoke(MODEL_ROUTING_IPC.workerSet, change);
      applyRouting(next, statusVersion);
      modelSaved = true;
      markModelSaved();
    }
    if (origin.id) {
      const updated = await ipcRenderer.invoke('agent-definitions:update', origin.id, { ...profile, ...(writeChoice ? { modelChoice: choice } : {}), ...(origin.updatedAt ? { expectedUpdatedAt: origin.updatedAt } : {}) });
      if (!updated) throw new Error('This agent changed elsewhere. Reload before saving to review the conflict.');
      if (isOriginEditor() && active.value?.id === origin.id) {
        active.value = { ...active.value, modelChoice: writeChoice ? choice : active.value.modelChoice, updatedAt: updated.updated_at || active.value.updatedAt };
        savedForm.value = submittedForm;
        if (writeChoice) savedChoice.value = choice;
      }
    } else {
      const submittedTiers = tiers && cleanAgentModelTiers(tiers);
      const created = await ipcRenderer.invoke('agent-definitions:create', editorCreateFromForm(form, choice, submittedTiers));
      if (created?.id && isOriginEditor() && active.value) {
        const slug = created.slug || origin.slug;
        active.value = { ...active.value, id: created.id, slug, modelChoice: choice, enabled: created.enabled !== false, updatedAt: created.updated_at || active.value.updatedAt };
        savedForm.value = submittedForm;
        savedChoice.value = choice;
        savedTiers.value = tiers;
        const installed = new AgentModelConfiguration(created.id, slug, routing.value, created.enabled === false);
        if (submittedTiers && created.modelBindingReceipt) installed.adoptCreated(submittedTiers, created.modelBindingReceipt);
        modelConfiguration.value = submittedTiers && !created.modelBindingReceipt ? undefined : installed;
      }
    }
    profileSaved = true;
    if (change?.candidates === null) {
      const statusVersion = providerStatusVersion;
      const next = await ipcRenderer.invoke(MODEL_ROUTING_IPC.workerSet, change);
      applyRouting(next, statusVersion);
      modelSaved = true;
      markModelSaved();
    }
    for (const item of teamChanges) {
      const statusVersion = providerStatusVersion;
      const next = await ipcRenderer.invoke(MODEL_ROUTING_IPC.workerSet, item.change);
      applyRouting(next, statusVersion);
      item.configuration.adopt(next);
      const saved = item.configuration.tiers();
      const current = teamModels.value[item.slug];
      if (current) teamModels.value = {
        ...teamModels.value,
        [item.slug]: {
          ...current,
          configuration: item.configuration,
          savedTiers: copyModelTiers(saved),
          tiers: JSON.stringify(current.tiers) === JSON.stringify(item.tiers) ? copyModelTiers(saved) : current.tiers,
        },
      };
      teamSaved += 1;
    }
    const fresh = await load();
    if (!isOriginEditor()) return;
    const saved = fresh && (draftSignature() === submitted || !hasUnsavedEdits.value) ? agents.value.find(row => row.id === active.value?.id) : undefined;
    if (saved) {
      openAgent(saved);
      tab.value = submittedTab;
    }
    detailError.value = false;
    const savedMessage = modelSaved || writeChoice || teamSaved || (!origin.id && tiers) ? 'Saved. Model changes apply to new work.' : 'Saved.';
    detailMessage.value = fresh ? savedMessage : `${ savedMessage } The agent list will refresh when the database is reachable.`;
  } catch (e) {
    if (!isOriginEditor()) return;
    detailError.value = true;
    const reason = e instanceof Error ? e.message : String(e);
    const partial = modelSaved && !profileSaved
      ? 'Model settings were saved; profile could not be saved. '
      : profileSaved && teamChanges.length
        ? 'Profile was saved; team model settings could not all be saved. '
        : profileSaved
          ? 'Profile was saved; model settings could not be saved. '
          : '';
    detailMessage.value = `${ partial }${teamSaved ? `${ teamSaved } team mapping${ teamSaved === 1 ? '' : 's' } saved. ` : ''}${ reason }`;
  } finally { saving.value = false; }
}
async function importAgent(event: Event) {
  const picker = event.target as HTMLInputElement;
  const file = picker.files?.[0];
  picker.value = '';
  if (!file || importing.value) return;
  const generation = editorGeneration;
  importing.value = true;
  importMessage.value = '';
  importError.value = false;
  try {
    if (file.size > 1024 * 1024) throw new Error('Choose an agent JSON file under 1 MiB.');
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await file.text());
    } catch {
      throw new Error('Could not read this agent JSON file.');
    }
    const imported = await ipcRenderer.invoke('agent-definitions:import', manifest);
    const refreshed = await load(true);
    const agent = refreshed && agents.value.find(row => row.id === imported.id && row.slug === imported.slug);
    if (agent && generation === editorGeneration && !active.value && !directoryDetail.value) {
      innerTab.value = 'manage';
      openAgent(agent);
      detailError.value = false;
      detailMessage.value = 'Agent imported.';
    } else {
      importMessage.value = agent ? 'Agent imported.' : 'Agent imported. Reload the agent list to open its profile.';
    }
  } catch (error) {
    importError.value = true;
    importMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    importing.value = false;
  }
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
.model-preview { margin-top: .75rem; padding-top: .65rem; border-top: 1px solid var(--uc-line); min-width: 0; }
.agent-identity { min-width: 0; overflow-wrap: anywhere; }
.hero .acts { flex-wrap: wrap; }
@media (max-width: 720px) {
  .hero { flex-wrap: wrap; }
  .hero .agent-identity { flex: 1 1 0; }
  .hero .acts { flex: 1 0 100%; margin-left: 0; }
}
</style>
