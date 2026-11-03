<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="ad-root">
    <template v-if="!selectedAgent">
      <div class="ad-bar">
        <button v-for="f in chips" :key="f.key" class="ad-chip" :class="{ on: filter === f.key }" :aria-pressed="filter === f.key" @click="filter = f.key">{{ f.label }} <em>{{ f.count }}</em></button>
        <span class="ad-sum">{{ frontDoorCount }} front door · <button v-if="missingCount" class="ad-missing" :aria-pressed="missingOnly" @click="missingOnly = !missingOnly">{{ missingOnly ? 'Showing' : '' }} {{ missingCount }} without a routing card</button><template v-else>every agent has a routing card</template></span>
      </div>
      <div class="ad-grid" aria-live="polite">
        <template v-if="loading"><div v-for="n in 6" :key="n" class="ad-skel"><i /><i /><i /><i /></div></template>
        <div v-else-if="filteredList.length === 0" class="ad-empty"><b>No agents match “{{ search || currentFilterLabel }}”.</b><span>Try a slug like <code>codex-luna-worker</code> or a job like “mockup”.</span><button class="btn sm" @click="clearAll">Clear search and filters</button></div>
        <template v-else><template v-for="group in groups" :key="group.title ?? 'flat'">
          <div v-if="group.title" class="ad-group">{{ group.title }} <span>{{ group.agents.length }} · {{ group.hint }}</span></div>
          <button v-for="agent in group.agents" :key="agent.slug" class="ad-card" :class="{ 'ad-off': !agent.enabled }" :aria-label="`Open ${ agent.name }`" @click="openDetail(agent.slug)">
            <div class="ad-ch"><span class="ad-ico" :class="{ 'ad-mgr': isManager(agent) }"><UseCaseIcon :name="isManager(agent) ? 'manager' : 'agent'" /></span><span class="ad-tt"><span class="ad-name">{{ agent.name }}</span><span class="ad-slug">{{ agent.slug }}</span></span><span class="ad-badges"><span v-if="agent.frontDoor" class="ad-tag ad-door" title="Can be the first agent the human talks to">Front door</span><span v-if="agent.isBuiltin" class="ad-tag">Built-in</span><span v-else class="ad-tag ad-custom">Custom</span><span v-if="!agent.enabled" class="ad-tag ad-dis">Disabled</span></span></div>
            <p class="ad-desc">{{ agent.description }}</p><div v-if="hasRoutingCard(agent)" class="ad-when"><small>When to call</small><p>{{ agent.whenToCall }}</p></div><div v-else class="ad-warn"><UseCaseIcon name="warn" /><span>No routing card yet: managers only see the description.</span></div>
            <div class="ad-foot"><span :title="`Cost tier: ${ costLabel(agent.costTier) }`"><span class="ad-cost" :data-t="agent.costTier || ''"><i /><i /><i /></span>{{ costLabel(agent.costTier) }}</span><span class="ad-model" :title="modelLabel(agent)">{{ modelLabel(agent) }}</span><span class="ad-calls"><i class="ad-dot" :class="{ 'ad-dot-off': !agent.enabled }" />{{ agent.enabled ? 'Enabled' : 'Disabled' }}</span></div>
          </button>
        </template></template>
      </div>
    </template>
    <article v-else class="ad-detail">
      <button class="ad-back" @click="closeDetail"><UseCaseIcon name="back" /> Back to Agents</button>
      <header class="ad-dhead"><span class="ad-ico ad-lg" :class="{ 'ad-mgr': isManager(selectedAgent) }"><UseCaseIcon :name="isManager(selectedAgent) ? 'manager' : 'agent'" /></span><div class="ad-tt"><h1>{{ selectedAgent.name }}</h1><span class="ad-slug">{{ selectedAgent.slug }}</span><div class="ad-pbadges"><span v-if="selectedAgent.isBuiltin" class="ad-tag">Built-in</span><span v-else class="ad-tag ad-custom">Custom</span><span class="ad-tag">{{ isManager(selectedAgent) ? 'Manager' : 'Worker' }}</span><span v-if="selectedAgent.frontDoor" class="ad-tag ad-door">Front door</span><span v-if="!selectedAgent.enabled" class="ad-tag ad-dis">Disabled</span><span class="ad-tag ad-state"><i class="ad-dot" :class="{ 'ad-dot-off': !selectedAgent.enabled }" />{{ selectedAgent.enabled ? 'Enabled' : 'Disabled' }}</span></div><p>{{ selectedAgent.description }}</p></div><button class="btn pri" @click="editSelected">Edit</button></header>
      <div v-if="!hasRoutingCard(selectedAgent)" class="ad-warn ad-detail-warn"><UseCaseIcon name="warn" /><span>No routing card yet: managers only see the description. Fill in <b>When to call</b>, <b>When NOT to call</b>, <b>What to send</b> and <b>What it returns</b> so they route work here correctly.</span></div>
      <div class="ad-detail-grid">
        <section class="ad-main-sections"><div class="ad-sec"><h2>When to call</h2><p v-if="selectedAgent.whenToCall">{{ selectedAgent.whenToCall }}</p><p v-else class="ad-none">Not written yet.</p></div><div class="ad-sec"><h2>When NOT to call</h2><p v-if="selectedAgent.whenNotToCall">{{ selectedAgent.whenNotToCall }}</p><p v-else class="ad-none">Not written yet.</p></div><div class="ad-sec"><h2>What to send it</h2><p v-if="selectedAgent.send">{{ selectedAgent.send }}</p><p v-else class="ad-none">Not written yet.</p></div><div class="ad-sec"><h2>What it returns</h2><p v-if="selectedAgent.returns">{{ selectedAgent.returns }}</p><p v-else class="ad-none">Not written yet.</p></div></section>
        <aside class="ad-details-card"><h2>Details</h2><dl class="ad-kv"><dt>Cost tier</dt><dd class="ad-cost-row"><span class="ad-cost" :data-t="selectedAgent.costTier || ''"><i /><i /><i /></span>{{ costLabel(selectedAgent.costTier) }}</dd><dt>Model</dt><dd class="ad-mono">{{ modelLabel(selectedAgent) }}<span v-if="!selectedAgent.modelChoice || selectedAgent.modelChoice.mode === 'list'" class="ad-slotnote"> · set in Preferences</span></dd><dt>Status</dt><dd><i class="ad-dot" :class="{ 'ad-dot-off': !selectedAgent.enabled }" /> {{ selectedAgent.enabled ? 'Enabled' : 'Disabled — managers can’t launch it' }}</dd><dt>Source</dt><dd>{{ selectedAgent.isBuiltin ? 'Built-in · ships with Sulla' : 'Custom · made on this install' }}</dd><dt>Updated</dt><dd>{{ updatedLabel || 'Not available' }}</dd></dl><div class="ad-rel"><h3>Can call</h3><span v-if="selectedAgent.canCall.includes('*')">Everyone</span><span v-else-if="!selectedAgent.canCall.length" class="ad-dimtext">No one</span><span v-else class="ad-links"><button v-for="s in selectedAgent.canCall" :key="s" class="ad-link" :disabled="!agentBySlug.has(s)" @click="openDetail(s)">{{ s }}</button></span></div><div class="ad-rel"><h3>Called by</h3><span v-if="!calledBySelected.length" class="ad-dimtext">No one</span><span v-else class="ad-links"><button v-for="a in calledBySelected" :key="a.slug" class="ad-link" @click="openDetail(a.slug)">{{ a.slug }}</button></span></div><small class="ad-note">{{ selectedAgent.isBuiltin ? 'Your edits are kept when Sulla updates.' : '' }}</small></aside>
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import UseCaseIcon from '@pkg/components/routines/UseCaseIcon.vue';
import type { AgentDefinitionResponse } from '@pkg/main/agentsIpc';
import type { AgentModelChoice } from '@pkg/agent/languagemodels/modelRoutingTypes';

import {
  calledBy, costLabel, DIRECTORY_FILTERS, filterAgents, formatUpdated, groupAgents, hasRoutingCard, isManager, modelLabel, type DirectoryFilterKey,
} from './agentDirectory';

type DirectoryResponse = AgentDefinitionResponse & { modelChoice?: AgentModelChoice };
const props = defineProps<{ agents: DirectoryResponse[]; loading: boolean; search: string }>();
const emit = defineEmits<{ (e: 'edit', agent: DirectoryResponse): void; (e: 'detail-change', agent: AgentDefinitionResponse | null): void; (e: 'update:search', value: string): void }>();

const filter = ref<DirectoryFilterKey>('all');
const missingOnly = ref(false);
const selected = ref<string | null>(null);
let directoryScrollTop = 0;

const agentBySlug = computed(() => new Map(props.agents.map(a => [a.slug, a])));
const chips = computed(() => DIRECTORY_FILTERS.map(f => ({ key: f.key, label: f.label, count: props.agents.filter(f.test).length })));
const missingCount = computed(() => props.agents.filter(a => !hasRoutingCard(a)).length);
const frontDoorCount = computed(() => props.agents.filter(a => a.frontDoor).length);
const currentFilterLabel = computed(() => DIRECTORY_FILTERS.find(f => f.key === filter.value)?.label ?? 'All');
const filteredList = computed(() => filterAgents(props.agents, filter.value, props.search, missingOnly.value));
const groups = computed(() => groupAgents(filteredList.value, filter.value, props.search, missingOnly.value));
const selectedAgent = computed(() => (selected.value ? agentBySlug.value.get(selected.value) ?? null : null));
const calledBySelected = computed(() => (selectedAgent.value ? calledBy(props.agents, selectedAgent.value.slug) : []));
const updatedLabel = computed(() => formatUpdated(selectedAgent.value?.updatedAt));

function scrollHost() { return document.querySelector<HTMLElement>('.studio-content'); }
function openDetail(slug: string) {
  if (!selected.value) directoryScrollTop = scrollHost()?.scrollTop ?? 0;
  selected.value = slug;
  emit('detail-change', selectedAgent.value);
  scrollHost()?.scrollTo({ top: 0 });
}
function closeDetail() {
  selected.value = null;
  emit('detail-change', null);
  requestAnimationFrame(() => scrollHost()?.scrollTo({ top: directoryScrollTop }));
}
defineExpose({ closeDetail });
function clearAll() { filter.value = 'all'; missingOnly.value = false; emit('update:search', ''); }
function editSelected() { if (selectedAgent.value) emit('edit', selectedAgent.value); }

function onKeydown(e: KeyboardEvent) { if (e.key === 'Escape' && selected.value) closeDetail(); }
onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<style scoped lang="scss">
@import '@pkg/assets/styles/studio-ui.scss';

.ad-root { position: relative; }

.ad-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 16px; }
.ad-chip { display: inline-flex; flex: none; align-items: center; gap: 6px; padding: 5px 11px; border: 1px solid var(--uc-line); border-radius: 16px; background: var(--uc-card); color: var(--uc-muted); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
.ad-chip:hover { border-color: var(--uc-line-strong); color: var(--uc-text); }
.ad-chip em { font-style: normal; color: var(--uc-dim); font-variant-numeric: tabular-nums; }
.ad-chip.on { border-color: var(--uc-accent-line); background: var(--uc-accent-soft); color: var(--uc-accent); font-weight: 600; }
.ad-chip.on em { color: var(--uc-accent); }
.ad-sum { margin-left: auto; color: var(--uc-dim); font-size: 12px; }
.ad-missing { padding: 0; border: 0; background: none; color: var(--status-warning); cursor: pointer; text-decoration: underline; text-decoration-color: var(--status-warning-soft); text-underline-offset: 3px; font: inherit; }

.ad-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.ad-group { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; margin: 10px 0 0; color: var(--uc-dim); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.ad-group:first-child { margin-top: 0; }
.ad-group span { font-weight: 400; letter-spacing: 0; text-transform: none; font-size: 11px; }

.ad-card { position: relative; min-width: 0; display: flex; flex-direction: column; gap: 10px; padding: 16px; border: 1px solid var(--uc-line); border-radius: 12px; background: var(--uc-card); color: var(--uc-text); box-shadow: var(--uc-shadow); text-align: left; font: inherit; cursor: pointer; transition: box-shadow 240ms ease, border-color 240ms ease, transform 240ms ease; }
.ad-card:hover { border-color: var(--uc-line-strong); box-shadow: 0 6px 18px rgb(26 35 50 / 7%), 0 1px 3px rgb(26 35 50 / 4%); transform: translateY(-1px); }
.ad-card.ad-sel { border-color: var(--uc-accent-line); box-shadow: 0 0 0 3px color-mix(in srgb, var(--uc-accent) 12%, transparent), 0 6px 18px rgb(26 35 50 / 7%); }
.ad-card.ad-off { background: var(--uc-paper); }
.ad-card.ad-off .ad-name, .ad-card.ad-off .ad-desc { color: var(--uc-muted); }
.ad-ch { display: flex; align-items: flex-start; gap: 10px; }
.ad-ico { display: grid; place-items: center; flex: none; width: 30px; height: 30px; border-radius: 8px; background: var(--uc-paper); color: var(--uc-muted); box-shadow: inset 0 0 0 1px var(--uc-line); font-size: 16px; }
.ad-ico.ad-mgr { background: var(--uc-accent-soft); color: var(--uc-accent); box-shadow: inset 0 0 0 1px var(--uc-accent-line); }
.ad-ico.ad-lg { width: 44px; height: 44px; border-radius: 11px; }
.ad-tt { min-width: 0; flex: 1; }
.ad-name { display: block; font-size: 14px; font-weight: 600; letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ad-slug { display: block; margin-top: 1px; color: var(--uc-dim); font: 11px var(--font-mono); }
.ad-badges { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; max-width: 52%; }
.ad-tag { display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px; border: 1px solid var(--uc-line); border-radius: 9px; background: var(--uc-paper); color: var(--uc-muted); font-size: 10.5px; line-height: 16px; white-space: nowrap; }
.ad-tag.ad-door { border-color: var(--uc-accent-line); background: var(--uc-accent-soft); color: var(--uc-accent); }
.ad-tag.ad-dis { border-color: var(--uc-line-strong); background: var(--uc-card); color: var(--uc-dim); }
.ad-tag.ad-custom { border-color: #e3dcf3; background: #f6f3fc; color: #6a55b4; }
.ad-desc { margin: 0; color: var(--uc-muted); font-size: 12.5px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ad-when { padding: 9px 11px; border-radius: 9px; background: var(--uc-paper); font-size: 12px; color: var(--uc-text); }
.ad-when small { display: block; margin-bottom: 2px; color: var(--uc-dim); font-size: 10px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; }
.ad-when p { margin: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ad-warn { display: flex; gap: 8px; align-items: flex-start; padding: 9px 11px; border: 1px solid var(--status-warning); border-radius: 9px; background: var(--status-warning-soft); color: var(--status-warning); font-size: 12px; }
.ad-warn :deep(svg) { flex: none; margin-top: 1px; color: var(--status-warning); font-size: 14px; }
.ad-foot { display: flex; align-items: center; gap: 12px; margin-top: auto; padding-top: 2px; color: var(--uc-dim); font-size: 11.5px; min-width: 0; }
.ad-foot > span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.ad-foot .ad-model { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); font-size: 11px; }
.ad-foot .ad-calls { margin-left: auto; }
.ad-cost { display: inline-flex; gap: 2px; align-items: flex-end; }
.ad-cost i { display: block; width: 3px; border-radius: 1px; background: var(--uc-line-strong); }
.ad-cost i:nth-child(1) { height: 6px; }
.ad-cost i:nth-child(2) { height: 9px; }
.ad-cost i:nth-child(3) { height: 12px; }
.ad-cost[data-t="low"] i:nth-child(-n+1), .ad-cost[data-t="medium"] i:nth-child(-n+2), .ad-cost[data-t="high"] i:nth-child(-n+3) { background: var(--uc-muted); }
.ad-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--uc-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--uc-success) 12%, transparent); }
.ad-dot.ad-dot-off { background: var(--border-muted); box-shadow: none; }

.ad-skel { height: 178px; border: 1px solid var(--uc-line); border-radius: 12px; background: var(--uc-card); padding: 16px; }
.ad-skel i { display: block; height: 10px; margin-bottom: 10px; border-radius: 5px; background: linear-gradient(90deg, var(--uc-paper), color-mix(in srgb, var(--uc-paper) 60%, var(--uc-card)), var(--uc-paper)); background-size: 200% 100%; animation: adShim 1.2s ease infinite; }
.ad-skel i:nth-child(1) { width: 46%; height: 14px; }
.ad-skel i:nth-child(2) { width: 92%; }
.ad-skel i:nth-child(3) { width: 70%; }
.ad-skel i:nth-child(4) { width: 100%; height: 42px; border-radius: 9px; }
@keyframes adShim { to { background-position: -200% 0; } }

.ad-empty { grid-column: 1 / -1; padding: 60px 20px; color: var(--uc-muted); text-align: center; }
.ad-empty b { display: block; margin-bottom: 4px; color: var(--uc-text); font-size: 15px; font-weight: 600; }
.ad-empty .btn { margin-top: 12px; }

.ad-detail { max-width: 1180px; margin: 0 auto; }
.ad-back { display: inline-flex; align-items: center; gap: 6px; margin: 0 0 14px; padding: 0; border: 0; background: transparent; color: var(--uc-muted); font: inherit; font-size: 12px; cursor: pointer; }
.ad-back:hover { color: var(--uc-accent); }
.ad-dhead { display: flex; align-items: flex-start; gap: 16px; padding: 22px; border: 1px solid var(--uc-line); border-radius: 14px; background: var(--uc-card); box-shadow: var(--uc-shadow); }
.ad-dhead h1 { margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -.025em; }
.ad-dhead .ad-tt > p { max-width: 780px; margin: 12px 0 0; color: var(--uc-muted); font-size: 13.5px; line-height: 1.55; }
.ad-dhead > .btn { margin-left: auto; }
.ad-pbadges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
.ad-state { gap: 6px; }
.ad-state .ad-dot { width: 6px; height: 6px; }
.ad-detail-warn { margin-top: 14px; padding: 12px 14px; }
.ad-detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 360px); align-items: start; gap: 16px; margin-top: 16px; }
.ad-main-sections, .ad-details-card { border: 1px solid var(--uc-line); border-radius: 14px; background: var(--uc-card); box-shadow: var(--uc-shadow); }
.ad-main-sections { padding: 4px 22px; }
.ad-sec { padding: 18px 0; border-bottom: 1px solid var(--uc-line); }
.ad-sec:last-child { border-bottom: 0; }
.ad-sec h2, .ad-details-card > h2 { margin: 0 0 7px; color: var(--uc-dim); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.ad-sec p { margin: 0; color: var(--uc-text); font-size: 13.5px; line-height: 1.65; white-space: pre-wrap; }
.ad-sec p.ad-none { color: var(--uc-dim); font-style: italic; }
.ad-details-card { padding: 20px; }
.ad-kv { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 10px 12px; margin: 0; font-size: 12.5px; }
.ad-kv dt { color: var(--uc-dim); }
.ad-kv dd { min-width: 0; margin: 0; color: var(--uc-text); overflow-wrap: anywhere; }
.ad-kv .ad-mono { font: 11.5px var(--font-mono); }
.ad-cost-row { display: flex; align-items: center; gap: 6px; }
.ad-slotnote { font-family: var(--font-body); color: var(--uc-dim); }
.ad-dimtext { color: var(--uc-dim); }
.ad-rel { padding-top: 16px; margin-top: 16px; border-top: 1px solid var(--uc-line); font-size: 12.5px; }
.ad-rel h3 { margin: 0 0 8px; color: var(--uc-dim); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
.ad-links { display: flex; flex-wrap: wrap; gap: 5px; }
.ad-link { padding: 3px 8px; border: 1px solid var(--uc-line); border-radius: 9px; background: var(--uc-paper); color: var(--uc-text); font: 11px var(--font-mono); cursor: pointer; transition: border-color 160ms ease, background 160ms ease; }
.ad-link:hover { border-color: var(--uc-accent-line); background: var(--uc-accent-soft); color: var(--uc-accent); }
.ad-link[disabled] { cursor: default; color: var(--uc-dim); }
.ad-note { display: block; margin-top: 18px; color: var(--uc-dim); font-size: 11.5px; }


@media (max-width: 760px) {
  .ad-grid { grid-template-columns: minmax(0, 1fr); }
  .ad-bar { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; }
  .ad-bar .ad-sum { display: none; }
  .ad-detail-grid { grid-template-columns: 1fr; }
  .ad-dhead { padding: 18px; }
  .ad-dhead .ad-lg { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .ad-card, .ad-skel i { transition-duration: 1ms !important; animation-duration: 1ms !important; }
  .ad-card:hover { transform: none; }
}
</style>
