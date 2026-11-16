<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="studio-page">
    <StudioTopbar
      ref="topbarRef"
      :crumbs="active ? ['Agents', active.name || 'New agent'] : directoryDetail ? ['Agents', directoryDetail.name] : ['Agents']"
      v-model:search="search"
      :search-placeholder="innerTab === 'dir' ? 'Search name, slug, when to call, model…' : 'Search custom agents'"
      @crumb="closeCurrentDetail"
    ><template #actions><button v-if="!active && !directoryDetail" class="btn pri" @click="newAgent">＋ New agent</button></template></StudioTopbar>
    <div class="studio-content">
      <template v-if="!active">
        <div v-if="!directoryDetail" class="tb"><h1>Agents</h1><span>{{ agents.length }} installed on this Sulla</span></div>
        <div v-if="!directoryDetail" class="seg-tabs" ref="tabsRef">
          <i ref="tabIndRef" />
          <button :class="{ on: innerTab === 'dir' }" @click="selectTab('dir')">Directory</button>
          <button :class="{ on: innerTab === 'manage' }" @click="selectTab('manage')">Manage</button>
        </div>
        <AgentDirectoryTab v-if="innerTab === 'dir'" ref="directoryRef" :agents="agents" :loading="loading" v-model:search="search" @detail-change="directoryDetail = $event" @edit="editDirectoryAgent" />
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
        <div class="card hero"><span class="fi blue big">◉</span><div><h1>{{ form.name || 'New agent' }}</h1><p>{{ form.description || 'Configure a custom agent.' }}</p><div class="meta"><span>{{ choiceLabel(formModelChoice(), routing) }}</span><span>{{ activeSkills.length }} skills</span><span>{{ active.id ? sourceLabel(active.sourceKind) : 'You' }}</span></div></div><div class="acts"><button class="btn pri" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button></div></div>
        <div v-if="detailMessage" class="banner" :class="{ error: detailError }"><div>{{ detailMessage }}</div></div>
        <div class="dgrid"><div><div class="tabs"><button :class="{ on: tab === 'profile' }" @click="tab = 'profile'">Profile</button><button :class="{ on: tab === 'prompt' }" @click="tab = 'prompt'">Prompt</button></div><div v-if="tab === 'profile'" class="card box"><div class="frow"><div class="field"><label>Name</label><input v-model="form.name"></div><div class="field"><label>Slug</label><input v-model="form.slug" class="mono" :readonly="!!active.id"></div></div><div class="field"><label>Description</label><textarea v-model="form.description" rows="3" /></div><div class="field model-choice"><label>Model</label><div class="mc"><div class="mc-set"><div class="mc-l"><small>By default an agent walks your Agents list. Ask for a class to walk that class’s model list instead.</small><div class="mc-resolve" :class="{ warn: !form.pinned && modelNow.warn }"><template v-if="form.pinned">Ignored while a model is pinned.</template><template v-else-if="!routing">Set the Agents list in Preferences → AI models.</template><template v-else>Right now: <code v-if="modelNow.model">{{ modelNow.model }}</code> {{ modelNow.text }}</template></div></div><select v-model="form.modelBase" class="mc-sel" aria-label="Model" :disabled="form.pinned"><option value="list">Agents list (default)</option><option v-for="c in MODEL_CLASSES" :key="c" :value="c">Class: {{ CLASS_LABELS[c] }}</option></select></div><div class="mc-set"><div class="mc-l"><b>Pin a specific model</b><small>Optional. Use one exact model every time.</small></div><button type="button" class="mc-tog" :class="{ on: form.pinned }" role="switch" :aria-checked="form.pinned" aria-label="Pin a specific model" @click="togglePin" /></div><div class="mc-pin" :class="{ open: form.pinned }" v-bind="form.pinned ? {} : { inert: '' }"><div><div class="mc-set"><div class="mc-l"><b>Pinned model</b><small>Only connected providers are listed.</small></div><div class="mc-c"><select v-model="form.pinProvider" class="mc-sel" aria-label="Pinned provider" @change="form.pinModel = pinModels[0]?.id ?? ''"><option v-for="p in pinProviders" :key="p.id" :value="p.id">{{ providerName(routing, p.id) }}</option></select><select v-model="form.pinModel" class="mc-sel" aria-label="Pinned model"><option v-for="m in pinModels" :key="m.id" :value="m.id">{{ m.label }}</option></select></div></div><div v-if="pinNow" class="mc-warn"><span aria-hidden="true">⚠</span><span>{{ pinNow.text }}</span></div></div></div><div class="mc-note"><span aria-hidden="true">ⓘ</span><span>Subconscious agents (memory curators, observers, background watchers and the Brain) use the <b>Subconscious</b> list instead.</span></div></div></div><div class="field"><label>Skills</label><div><span v-for="skill in activeSkills" :key="skill" class="chipx">{{ skill }}</span><span v-if="activeSkills.length === 0" class="tag">No skills configured</span></div></div></div><div v-else class="card box"><h2>System prompt</h2><textarea v-model="form.prompt" class="editor" /></div></div>
          <aside class="card side"><h3>Details</h3><div class="kv"><span>Slug</span><b class="mono">{{ form.slug || '—' }}</b></div><div class="kv"><span>Source</span><b>{{ active.id ? sourceLabel(active.sourceKind) : 'You' }}</b></div><div v-if="active.marketplaceVersion" class="kv"><span>Version</span><b class="mono">{{ active.marketplaceVersion }}</b></div><div v-if="active.id" class="side-foot"><button class="btn" @click="exportAgent">⤓ Export</button><button class="btn" :disabled="publishing" @click="publishAgent">↑ Publish</button><button class="btn danger" @click="deleteAgent">Delete</button></div></aside>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { AgentDefinitionResponse } from '@pkg/main/agentsIpc';
import { MODEL_CLASSES, MODEL_ROUTING_IPC, type AgentModelChoice, type ModelClass, type ModelRoutingState } from '@pkg/agent/languagemodels/modelRoutingTypes';
import { CLASS_LABELS, choiceLabel, modelName, providerName, providerOrder, resolveChoice } from '@pkg/components/settings/sections/modelRouting/routingLogic';
import { useDatabaseAvailableReload } from '@pkg/composables/useDatabaseAvailableReload';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import AgentDirectoryTab from './AgentDirectoryTab.vue';
import StudioTopbar from './StudioTopbar.vue';

type Agent = AgentDefinitionResponse & { modelChoice?: AgentModelChoice }; type Manifest = Awaited<ReturnType<typeof ipcRenderer.invoke<'agent-definitions:export'>>>;
const agents = ref<Agent[]>([]); const routing = ref<ModelRoutingState | null>(null); const manifests = ref(new Map<string, Manifest>()); const search = ref(''); const provider = ref('all'); const loading = ref(true); const error = ref(''); const active = ref<Agent | null>(null); const tab = ref<'profile'|'prompt'>('profile'); const saving = ref(false); const publishing = ref(false); const detailMessage = ref(''); const detailError = ref(false);
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
const form = reactive({ slug: '', name: '', description: '', provider: '', modelSlot: 'secondary' as 'primary'|'secondary'|'subconscious', modelBase: 'list' as 'list' | ModelClass, pinned: false, pinProvider: '', pinModel: '', prompt: '' });
type PinOption = { id: string; models: { id: string; label: string }[] };
/** Connected providers in Agents-list order, plus the agent's current pin if it isn't connected any more. */
const pinProviders = computed<PinOption[]>(() => { const r = routing.value; const list: PinOption[] = r ? providerOrder(r).flatMap(id => { const p = r.providers.find(x => x.id === id); return p?.connected ? [{ id, models: p.models.map(m => ({ id: m.id, label: modelName(r, id, m.id) })) }] : []; }) : []; if (form.pinProvider && !list.some(p => p.id === form.pinProvider)) list.push({ id: form.pinProvider, models: [] }); return list; });
const pinModels = computed(() => { const models = pinProviders.value.find(p => p.id === form.pinProvider)?.models ?? []; return form.pinModel && !models.some(m => m.id === form.pinModel) ? [{ id: form.pinModel, label: form.pinModel }, ...models] : models; });
function baseChoice(): AgentModelChoice { return form.modelBase === 'list' ? { mode: 'list' } : { mode: 'class', class: form.modelBase }; }
function formModelChoice(): AgentModelChoice { return form.pinned && form.pinProvider && form.pinModel ? { mode: 'pin', provider: form.pinProvider, model: form.pinModel } : baseChoice(); }
const modelNow = computed(() => routing.value ? resolveChoice(routing.value, baseChoice()) : { text: '', model: undefined, warn: false });
const pinNow = computed(() => routing.value && form.pinProvider ? resolveChoice(routing.value, { mode: 'pin', provider: form.pinProvider, model: form.pinModel }) : null);
function togglePin() { form.pinned = !form.pinned; if (!form.pinned) return; if (!form.pinProvider) form.pinProvider = pinProviders.value[0]?.id ?? ''; if (!form.pinModel) form.pinModel = pinModels.value[0]?.id ?? ''; }
const providers = computed(() => Array.from(new Set(agents.value.map(a => a.provider).filter(Boolean) as string[])).sort().map(name => ({ name, count: agents.value.filter(a => a.provider === name).length })));
const filtered = computed(() => { const q = search.value.trim().toLowerCase(); return agents.value.filter(a => (provider.value === 'all' || a.provider === provider.value) && (!q || `${a.name} ${a.description} ${a.slug} ${a.provider} ${a.modelSlot}`.toLowerCase().includes(q))); });
const activeSkills = computed(() => active.value ? skillsFor(active.value) : []);
function skillsFor(agent: Agent) { return manifests.value.get(agent.slug)?.spec.skills ?? []; }
function slotLabel(tier: Agent['modelSlot']) { return tier === 'primary' ? 'Primary' : tier === 'subconscious' ? 'Subconscious' : 'Secondary'; }
function modelLabel(agent: Agent | null) { if (agent?.modelChoice) return choiceLabel(agent.modelChoice, routing.value); return agent?.model ? `${agent.provider ?? 'Unknown'} / ${agent.model}` : slotLabel(agent?.modelSlot ?? null); }
function sourceLabel(source: string) { return source === 'local' ? 'You' : source === 'builtin' || source === 'built-in' ? 'Built-in' : source || '—'; }
async function load() { loading.value = true; error.value = ''; try { routing.value = await ipcRenderer.invoke(MODEL_ROUTING_IPC.get).catch(() => null); agents.value = await ipcRenderer.invoke('agent-definitions:list'); const pairs = await Promise.all(agents.value.map(async a => [a.slug, await ipcRenderer.invoke('agent-definitions:export', a.slug)] as const).map(p => p.catch(() => null))); manifests.value = new Map(pairs.filter((x): x is readonly [string, Manifest] => x !== null)); } catch (e) { error.value = e instanceof Error ? e.message : String(e); } finally { loading.value = false; } }
function editDirectoryAgent(agent: Agent) { directoryDetail.value = null; innerTab.value = 'manage'; openAgent(agent); }
function closeCurrentDetail() { if (active.value) closeDetail(); else directoryRef.value?.closeDetail(); }
function openAgent(agent: Agent) { active.value = agent; const choice = agent.modelChoice ?? { mode: 'list' as const }; Object.assign(form, { slug: agent.slug, name: agent.name, description: agent.description, provider: agent.provider ?? '', modelSlot: agent.modelSlot ?? 'secondary', modelBase: choice.mode === 'class' ? choice.class : 'list', pinned: choice.mode === 'pin', pinProvider: choice.mode === 'pin' ? choice.provider : '', pinModel: choice.mode === 'pin' ? choice.model : '', prompt: agent.prompt }); tab.value = 'profile'; detailMessage.value = ''; }
function newAgent() { active.value = { id: '', slug: '', name: '', description: '', provider: null, model: null, modelSlot: 'secondary', prompt: '', sourceKind: 'local', marketplaceVersion: null, status: 'production', enabled: true, runLocation: 'vm', whenToCall: '', whenNotToCall: '', send: '', returns: '', costTier: null, canCall: [], isBuiltin: false, frontDoor: null, updatedAt: '', type: null }; Object.assign(form, { slug: '', name: '', description: '', provider: '', modelSlot: 'secondary', modelBase: 'list', pinned: false, pinProvider: '', pinModel: '', prompt: '' }); tab.value = 'profile'; detailMessage.value = ''; }
function closeDetail() { active.value = null; detailMessage.value = ''; }
async function save() { if (!active.value || !form.name.trim() || !form.slug.trim()) { detailError.value = true; detailMessage.value = 'Name and slug are required.'; return; } saving.value = true; detailMessage.value = ''; try { if (active.value.id) await ipcRenderer.invoke('agent-definitions:update', active.value.id, { name: form.name, description: form.description, modelSlot: form.modelSlot, modelChoice: formModelChoice(), prompt: form.prompt }); else await ipcRenderer.invoke('agent-definitions:create', { slug: form.slug, name: form.name, description: form.description, modelSlot: form.modelSlot, modelChoice: formModelChoice(), prompt: form.prompt }); await load(); const saved = agents.value.find(a => a.slug === form.slug); if (saved) openAgent(saved); detailError.value = false; detailMessage.value = 'Saved.'; } catch (e) { detailError.value = true; detailMessage.value = e instanceof Error ? e.message : String(e); } finally { saving.value = false; } }
async function exportAgent() { if (!active.value) return; const manifest = await ipcRenderer.invoke('agent-definitions:export', active.value.slug); const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${active.value.slug}.json`; a.click(); URL.revokeObjectURL(url); }
async function publishAgent() { if (!active.value) return; publishing.value = true; const check = await ipcRenderer.invoke('agent-definitions:publish-check', active.value.slug); if ('error' in check) { detailError.value = true; detailMessage.value = check.error; publishing.value = false; return; } if (check.warnings.length && !window.confirm(`${check.warnings.join('\n')}\n\nPublish anyway?`)) { publishing.value = false; return; } const res = await ipcRenderer.invoke('agent-definitions:publish', active.value.slug); publishing.value = false; detailError.value = 'error' in res; detailMessage.value = 'error' in res ? res.error : `Submitted as ${res.templateId}.`; }
async function deleteAgent() { if (!active.value?.id || !window.confirm(`Delete ${active.value.name}?`)) return; await ipcRenderer.invoke('agent-definitions:delete', active.value.id); closeDetail(); await load(); }
onMounted(load);
useDatabaseAvailableReload(load, 'StudioAgentsPage');
</script>

<style scoped lang="scss">
@import '@pkg/assets/styles/studio-ui.scss';

.seg-tabs { position: relative; display: inline-flex; gap: 2px; margin-bottom: 16px; padding: 3px; border: 1px solid var(--uc-line); border-radius: 10px; background: var(--uc-paper); }
.seg-tabs button { position: relative; z-index: 1; padding: 5px 14px; border: 0; border-radius: 7px; background: transparent; color: var(--uc-muted); font: inherit; cursor: pointer; transition: color 160ms ease; }
.seg-tabs button.on { color: var(--uc-text); font-weight: 500; }
.seg-tabs i { position: absolute; top: 3px; bottom: 3px; left: 0; border-radius: 7px; background: var(--uc-card); box-shadow: var(--uc-shadow), inset 0 0 0 1px var(--uc-line); transition: transform 240ms cubic-bezier(.22, 1, .36, 1), width 240ms cubic-bezier(.22, 1, .36, 1); }
/* Model setting: the approved model routing mockup's agent-settings preview. */
.mc { overflow: hidden; border: 1px solid var(--uc-line); border-radius: 10px; background: var(--uc-card); }
.mc-set { display: flex; align-items: center; gap: 24px; padding: 13px 16px; border-top: 1px solid var(--uc-line); }
.mc-set:first-child { border-top: 0; }
.mc-l { flex: 1; min-width: 0; }
.mc-l b { display: block; color: var(--uc-text); font-weight: 600; }
.mc-l small { display: block; margin-top: 2px; color: var(--uc-dim); font-size: 12px; }
.mc-resolve { margin-top: 3px; color: var(--uc-dim); font-size: 12px; }
.mc-resolve code { color: var(--uc-text); font: 11.5px var(--font-mono); }
.mc-resolve.warn { color: var(--status-warning); }
.mc-c { display: flex; flex: none; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.mc .mc-sel { width: auto; min-width: 180px; max-width: 100%; height: 30px; padding: 0 10px; }
.mc .mc-sel:disabled { opacity: .5; }
.mc-tog { position: relative; flex: none; width: 34px; height: 20px; padding: 0; border: 0; border-radius: 999px; background: var(--uc-line-strong); cursor: pointer; transition: background 160ms cubic-bezier(.22, 1, .36, 1); }
.mc-tog::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--bg-surface); box-shadow: 0 1px 2px rgb(0 0 0 / 25%); transition: transform 240ms cubic-bezier(.22, 1, .36, 1); }
.mc-tog.on { background: var(--uc-accent); }
.mc-tog.on::after { transform: translateX(14px); }
.mc-tog:focus-visible { outline: 0; box-shadow: 0 0 0 3px var(--uc-accent-soft); }
.mc-pin { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 480ms cubic-bezier(.22, 1, .36, 1); }
.mc-pin.open { grid-template-rows: 1fr; }
.mc-pin > div { overflow: hidden; min-height: 0; }
.mc-pin .mc-set { opacity: 0; transition: opacity 240ms cubic-bezier(.22, 1, .36, 1); }
.mc-pin.open .mc-set { opacity: 1; }
.mc-warn { display: flex; align-items: flex-start; gap: 8px; padding: 0 16px 13px; color: var(--status-warning); font-size: 12px; }
.mc-note { display: flex; align-items: flex-start; gap: 8px; padding: 11px 16px 13px; border-top: 1px solid var(--uc-line); color: var(--uc-muted); font-size: 12px; }
.mc-note b { color: var(--uc-text); font-weight: 600; }
@media (max-width: 720px) { .mc-set { flex-direction: column; align-items: stretch; gap: 10px; } .mc-c { justify-content: flex-start; } }
@media (prefers-reduced-motion: reduce) { .mc-pin, .mc-pin .mc-set, .mc-tog, .mc-tog::after { transition-duration: 1ms; } }
</style>
