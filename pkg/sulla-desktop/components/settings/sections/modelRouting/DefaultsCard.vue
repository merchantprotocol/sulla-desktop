<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AgentModelChoice } from '@pkg/agent/languagemodels/modelRoutingTypes';
import type { ModelDefaultChoice, ModelDefaults } from '@pkg/agent/languagemodels/modelDefaultsTypes';

type Agent = { slug: string; name: string; whenToCall: string; enabled: boolean };
type Provider = { id: string; name: string; connected: boolean; models: { id: string; label: string }[] };
type State = { defaults: ModelDefaults; agents: Agent[]; resolved: Record<keyof ModelDefaults, string> };
const state = ref<State>(); const providers = ref<Provider[]>([]); const saved = ref(false);
const rememberedAgent = { chat: 'sulla', heartbeat: 'heartbeat' };
const rememberedModel: Record<keyof ModelDefaults, AgentModelChoice> = { chat: { mode: 'list' }, heartbeat: { mode: 'list' } };
const rows = [{ key: 'chat' as const, title: 'New chats', help: 'Who answers a new chat when you don’t pick someone in the chat’s selector.' }, { key: 'heartbeat' as const, title: 'Heartbeat', help: 'Who runs Sulla’s periodic background check-ins on your goals.' }];
const connected = computed(() => providers.value.filter(p => p.connected));
async function invoke(channel: string, value?: unknown) { return window.ipcRenderer.invoke(channel, value) }
async function load() { state.value = await invoke('model-defaults:get'); providers.value = (await invoke('model-routing:get')).providers }
async function save(key: keyof ModelDefaults, value: ModelDefaultChoice) { state.value = await invoke('model-defaults:set', { [key]: value }); saved.value = true; setTimeout(() => saved.value = false, 1800) }
function setKind(key: keyof ModelDefaults, kind: 'agent'|'model') { const current = state.value!.defaults[key]; if (current.kind === 'agent') rememberedAgent[key] = current.agentId; else rememberedModel[key] = current.choice; void save(key, kind === 'agent' ? { kind, agentId: rememberedAgent[key] } : { kind, choice: rememberedModel[key] }) }
function modelValue(choice: AgentModelChoice) { return choice.mode === 'class' ? `class:${choice.class}` : choice.mode }
function choice(raw: string, current: AgentModelChoice): AgentModelChoice { if (raw === 'list') return { mode: 'list' }; if (raw.startsWith('class:')) return { mode: 'class', class: raw.slice(6) as any }; const p = connected.value[0]; return current.mode === 'pin' ? current : { mode: 'pin', provider: p?.id || '', model: p?.models[0]?.id || '' } }
function pin(key: keyof ModelDefaults, field: 'provider'|'model', value: string) { const current = state.value!.defaults[key]; if (current.kind !== 'model' || current.choice.mode !== 'pin') return; const provider = field === 'provider' ? value : current.choice.provider; const model = field === 'provider' ? providers.value.find(p => p.id === value)?.models[0]?.id || '' : value; void save(key, { kind: 'model', choice: { mode: 'pin', provider, model } }) }
onMounted(load);
</script>
<template>
  <section class="defaults-card">
    <header><div><h2>Defaults</h2><p>Choose who answers when no agent or model is picked.</p></div><span v-if="saved" role="status">Saved</span></header>
    <div v-for="row in rows" :key="row.key" class="default-row">
      <div class="copy"><strong>{{ row.title }}</strong><small>{{ row.help }}</small><p class="resolved">{{ state?.resolved[row.key] }}</p></div>
      <template v-if="state"><div class="controls">
        <div class="segments"><button :class="{ active: state.defaults[row.key].kind === 'agent' }" @click="setKind(row.key, 'agent')">Agent</button><button :class="{ active: state.defaults[row.key].kind === 'model' }" @click="setKind(row.key, 'model')">Model</button></div>
        <select v-if="state.defaults[row.key].kind === 'agent'" :value="(state.defaults[row.key] as any).agentId" @change="save(row.key, { kind: 'agent', agentId: ($event.target as HTMLSelectElement).value })"><option v-for="agent in state.agents" :key="agent.slug" :value="agent.slug">{{ agent.name }} — {{ agent.whenToCall }}</option></select>
        <template v-else><select :value="modelValue((state.defaults[row.key] as any).choice)" @change="save(row.key, { kind: 'model', choice: choice(($event.target as HTMLSelectElement).value, (state.defaults[row.key] as any).choice) })"><option value="list">Agents list (default)</option><option v-for="c in ['frontier','standard','fast','coding','local']" :key="c" :value="`class:${c}`">Class: {{ c }}</option><option value="pin">Pin a specific model</option></select>
          <div v-if="(state.defaults[row.key] as any).choice.mode === 'pin'" class="pin"><select :value="(state.defaults[row.key] as any).choice.provider" @change="pin(row.key, 'provider', ($event.target as HTMLSelectElement).value)"><option v-for="p in connected" :key="p.id" :value="p.id">{{ p.name }}</option></select><select :value="(state.defaults[row.key] as any).choice.model" @change="pin(row.key, 'model', ($event.target as HTMLSelectElement).value)"><option v-for="m in providers.find(p => p.id === (state!.defaults[row.key] as any).choice.provider)?.models || []" :key="m.id" :value="m.id">{{ m.label }}</option></select></div>
        </template>
      </div></template>
    </div>
    <button class="reset" type="button" @click="invoke('model-defaults:reset').then(v => state = v)">Reset to default</button>
  </section>
</template>
<style scoped>
.defaults-card{background:var(--preferences-card-bg,var(--surface-1));border:1px solid var(--preferences-border,var(--border));border-radius:12px;padding:20px;color:var(--text)}header,.default-row{display:flex;justify-content:space-between;gap:24px}header{align-items:flex-start;border-bottom:1px solid var(--border-muted);padding-bottom:16px}h2,p{margin:0}header p,.copy small{color:var(--text-muted)}.default-row{padding:18px 0;border-bottom:1px solid var(--border-muted)}.copy{display:flex;flex-direction:column;gap:5px;min-width:260px}.resolved{font-size:12px;color:var(--text-muted)}.controls{width:min(480px,55%);display:flex;flex-direction:column;gap:8px}.segments{display:grid;grid-template-columns:1fr 1fr;background:var(--surface-2);padding:3px;border-radius:8px}.segments button{border:0;background:transparent;padding:7px;border-radius:6px;color:var(--text-muted)}.segments .active{background:var(--surface-1);color:var(--text);box-shadow:0 1px 3px var(--border)}select{width:100%;border:1px solid var(--border);border-radius:8px;background:var(--surface-1);color:var(--text);padding:8px}.pin{display:grid;grid-template-columns:1fr 1fr;gap:8px}.reset{margin-top:16px;border:0;background:transparent;color:var(--accent);padding:0}@media(max-width:700px){.default-row{flex-direction:column}.controls{width:100%}}
</style>
