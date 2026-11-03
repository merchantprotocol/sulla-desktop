<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="ad-root">
    <div class="ad-bar">
      <button v-for="f in chips" :key="f.key" class="ad-chip" :class="{ on: filter === f.key }" :aria-pressed="filter === f.key" @click="filter = f.key">{{ f.label }} <em>{{ f.count }}</em></button>
      <span class="ad-sum">
        {{ frontDoorCount }} front door ·
        <button v-if="missingCount" class="ad-missing" :aria-pressed="missingOnly" @click="missingOnly = !missingOnly">{{ missingOnly ? 'Showing' : '' }} {{ missingCount }} without a routing card</button>
        <template v-else>every agent has a routing card</template>
      </span>
    </div>

    <div class="ad-grid" aria-live="polite">
      <template v-if="loading">
        <div v-for="n in 6" :key="n" class="ad-skel"><i /><i /><i /><i /></div>
      </template>
      <div v-else-if="filteredList.length === 0" class="ad-empty">
        <b>No agents match “{{ search || currentFilterLabel }}”.</b>
        <span>Try a slug like <code>codex-luna-worker</code> or a job like “mockup”.</span>
        <button class="btn sm" @click="clearAll">Clear search and filters</button>
      </div>
      <template v-else>
        <template v-for="group in groups" :key="group.title ?? 'flat'">
          <div v-if="group.title" class="ad-group">{{ group.title }} <span>{{ group.agents.length }} · {{ group.hint }}</span></div>
          <button
            v-for="agent in group.agents"
            :key="agent.slug"
            class="ad-card"
            :class="{ 'ad-off': !agent.enabled, 'ad-sel': selected === agent.slug }"
            :aria-label="`Open ${ agent.name }`"
            @click="openPanel(agent.slug)"
          >
            <div class="ad-ch">
              <span class="ad-ico" :class="{ 'ad-mgr': isManager(agent) }"><UseCaseIcon :name="isManager(agent) ? 'manager' : 'agent'" /></span>
              <span class="ad-tt"><span class="ad-name">{{ agent.name }}</span><span class="ad-slug">{{ agent.slug }}</span></span>
              <span class="ad-badges">
                <span v-if="agent.frontDoor" class="ad-tag ad-door" title="Can be the first agent the human talks to">Front door</span>
                <span v-if="agent.isBuiltin" class="ad-tag">Built-in</span>
                <span v-else class="ad-tag ad-custom">Custom</span>
                <span v-if="!agent.enabled" class="ad-tag ad-dis">Disabled</span>
              </span>
            </div>
            <p class="ad-desc">{{ agent.description }}</p>
            <div v-if="hasRoutingCard(agent)" class="ad-when"><small>When to call</small><p>{{ agent.whenToCall }}</p></div>
            <div v-else class="ad-warn"><UseCaseIcon name="warn" /><span>No routing card yet: managers only see the description.</span></div>
            <div class="ad-foot">
              <span :title="`Cost tier: ${ costLabel(agent.costTier) }`"><span class="ad-cost" :data-t="agent.costTier || ''"><i /><i /><i /></span>{{ costLabel(agent.costTier) }}</span>
              <span class="ad-model" :title="modelLabel(agent)">{{ modelLabel(agent) }}</span>
              <span class="ad-calls"><i class="ad-dot" :class="{ 'ad-dot-off': !agent.enabled }" />{{ agent.enabled ? 'Enabled' : 'Disabled' }}</span>
            </div>
          </button>
        </template>
      </template>
    </div>

    <div class="ad-scrim" :class="{ 'ad-open': selectedAgent }" @click="closePanel" />
    <aside class="ad-panel" :class="{ 'ad-open': selectedAgent }" role="dialog" aria-modal="true" :aria-hidden="!selectedAgent" tabindex="-1">
      <template v-if="selectedAgent">
        <div class="ad-ph">
          <span class="ad-ico ad-lg" :class="{ 'ad-mgr': isManager(selectedAgent) }"><UseCaseIcon :name="isManager(selectedAgent) ? 'manager' : 'agent'" /></span>
          <div class="ad-tt">
            <h2>{{ selectedAgent.name }}</h2><span class="ad-slug">{{ selectedAgent.slug }}</span>
            <div class="ad-pbadges">
              <span v-if="selectedAgent.frontDoor" class="ad-tag ad-door">Front door</span>
              <span v-if="selectedAgent.isBuiltin" class="ad-tag">Built-in</span>
              <span v-else class="ad-tag ad-custom">Custom</span>
              <span v-if="!selectedAgent.enabled" class="ad-tag ad-dis">Disabled</span>
              <span class="ad-tag">{{ isManager(selectedAgent) ? 'Manager' : 'Worker' }}</span>
            </div>
            <p>{{ selectedAgent.description }}</p>
          </div>
          <button class="ad-x" aria-label="Close" @click="closePanel"><UseCaseIcon name="close" /></button>
        </div>
        <div class="ad-pb">
          <div v-if="!hasRoutingCard(selectedAgent)" class="ad-warn" style="margin-top: 14px">
            <UseCaseIcon name="warn" />
            <span>No routing card yet: managers only see the description. Fill in <b>When to call</b>, <b>When NOT to call</b>, <b>What to send</b> and <b>What it returns</b> so they route work here correctly.</span>
          </div>
          <div class="ad-sec"><h3>When to call</h3><p v-if="selectedAgent.whenToCall">{{ selectedAgent.whenToCall }}</p><p v-else class="ad-none">Not written yet.</p></div>
          <div class="ad-sec"><h3>When NOT to call</h3><p v-if="selectedAgent.whenNotToCall">{{ selectedAgent.whenNotToCall }}</p><p v-else class="ad-none">Not written yet.</p></div>
          <div class="ad-sec"><h3>What to send it</h3><p v-if="selectedAgent.send">{{ selectedAgent.send }}</p><p v-else class="ad-none">Not written yet.</p></div>
          <div class="ad-sec"><h3>What it returns</h3><p v-if="selectedAgent.returns">{{ selectedAgent.returns }}</p><p v-else class="ad-none">Not written yet.</p></div>
          <div class="ad-sec">
            <h3>Details</h3>
            <dl class="ad-kv">
              <dt>Cost tier</dt>
              <dd class="ad-cost-row"><span class="ad-cost" :data-t="selectedAgent.costTier || ''"><i /><i /><i /></span>{{ costLabel(selectedAgent.costTier) }}</dd>
              <dt>Model</dt>
              <dd class="ad-mono">{{ modelLabel(selectedAgent) }}<span v-if="!selectedAgent.model" class="ad-slotnote"> · set in Preferences</span></dd>
              <dt>Can call</dt>
              <dd>
                <span v-if="selectedAgent.canCall.includes('*')">Everyone</span>
                <span v-else-if="!selectedAgent.canCall.length" class="ad-dimtext">No one</span>
                <span v-else class="ad-links"><button v-for="s in selectedAgent.canCall" :key="s" class="ad-link" :disabled="!agentBySlug.has(s)" @click="openPanel(s)">{{ s }}</button></span>
              </dd>
              <dt>Called by</dt>
              <dd>
                <span v-if="!calledBySelected.length" class="ad-dimtext">No one</span>
                <span v-else class="ad-links"><button v-for="a in calledBySelected" :key="a.slug" class="ad-link" @click="openPanel(a.slug)">{{ a.slug }}</button></span>
              </dd>
              <dt>Status</dt>
              <dd><i class="ad-dot" :class="{ 'ad-dot-off': !selectedAgent.enabled }" style="margin-right: 6px" />{{ selectedAgent.enabled ? 'Enabled' : 'Disabled — managers can’t launch it' }}</dd>
              <dt>Source</dt>
              <dd>{{ selectedAgent.isBuiltin ? 'Built-in · ships with Sulla' : 'Custom · made on this install' }}</dd>
            </dl>
          </div>
        </div>
        <div class="ad-pf">
          <small>{{ selectedAgent.isBuiltin ? 'Your edits are kept when Sulla updates.' : (updatedLabel ? `Updated ${ updatedLabel }` : '') }}</small>
          <button class="btn" @click="closePanel">Close</button>
          <button class="btn pri" @click="editSelected">Edit</button>
        </div>
      </template>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import UseCaseIcon from '@pkg/components/routines/UseCaseIcon.vue';
import type { AgentDefinitionResponse } from '@pkg/main/agentsIpc';

import {
  calledBy, costLabel, DIRECTORY_FILTERS, filterAgents, formatUpdated, groupAgents, hasRoutingCard, isManager, modelLabel, type DirectoryFilterKey,
} from './agentDirectory';

const props = defineProps<{ agents: AgentDefinitionResponse[]; loading: boolean; search: string }>();
const emit = defineEmits<{ (e: 'edit', agent: AgentDefinitionResponse): void; (e: 'update:search', value: string): void }>();

const filter = ref<DirectoryFilterKey>('all');
const missingOnly = ref(false);
const selected = ref<string | null>(null);

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

function openPanel(slug: string) { selected.value = slug; }
function closePanel() { selected.value = null; }
function clearAll() { filter.value = 'all'; missingOnly.value = false; emit('update:search', ''); }
function editSelected() { if (selectedAgent.value) emit('edit', selectedAgent.value); }

function onKeydown(e: KeyboardEvent) { if (e.key === 'Escape' && selected.value) closePanel(); }
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
.ad-missing { padding: 0; border: 0; background: none; color: #c47a00; cursor: pointer; text-decoration: underline; text-decoration-color: #f1d9a6; text-underline-offset: 3px; font: inherit; }

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
.ad-slug { display: block; margin-top: 1px; color: var(--uc-dim); font: 11px var(--font-mono, ui-monospace, Menlo, monospace); }
.ad-badges { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; max-width: 52%; }
.ad-tag { display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px; border: 1px solid var(--uc-line); border-radius: 9px; background: var(--uc-paper); color: var(--uc-muted); font-size: 10.5px; line-height: 16px; white-space: nowrap; }
.ad-tag.ad-door { border-color: var(--uc-accent-line); background: var(--uc-accent-soft); color: var(--uc-accent); }
.ad-tag.ad-dis { border-color: var(--uc-line-strong); background: var(--uc-card); color: var(--uc-dim); }
.ad-tag.ad-custom { border-color: #e3dcf3; background: #f6f3fc; color: #6a55b4; }
.ad-desc { margin: 0; color: var(--uc-muted); font-size: 12.5px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ad-when { padding: 9px 11px; border-radius: 9px; background: var(--uc-paper); font-size: 12px; color: var(--uc-text); }
.ad-when small { display: block; margin-bottom: 2px; color: var(--uc-dim); font-size: 10px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; }
.ad-when p { margin: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ad-warn { display: flex; gap: 8px; align-items: flex-start; padding: 9px 11px; border: 1px solid #f1d9a6; border-radius: 9px; background: #fff8e8; color: #8a5a00; font-size: 12px; }
.ad-warn :deep(svg) { flex: none; margin-top: 1px; color: #c47a00; font-size: 14px; }
.ad-foot { display: flex; align-items: center; gap: 12px; margin-top: auto; padding-top: 2px; color: var(--uc-dim); font-size: 11.5px; min-width: 0; }
.ad-foot > span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.ad-foot .ad-model { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 11px; }
.ad-foot .ad-calls { margin-left: auto; }
.ad-cost { display: inline-flex; gap: 2px; align-items: flex-end; }
.ad-cost i { display: block; width: 3px; border-radius: 1px; background: var(--uc-line-strong); }
.ad-cost i:nth-child(1) { height: 6px; }
.ad-cost i:nth-child(2) { height: 9px; }
.ad-cost i:nth-child(3) { height: 12px; }
.ad-cost[data-t="low"] i:nth-child(-n+1), .ad-cost[data-t="medium"] i:nth-child(-n+2), .ad-cost[data-t="high"] i:nth-child(-n+3) { background: var(--uc-muted); }
.ad-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--uc-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--uc-success) 12%, transparent); }
.ad-dot.ad-dot-off { background: #b3bdca; box-shadow: none; }

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

.ad-scrim { position: fixed; inset: 0; z-index: 40; background: rgb(26 35 50 / 18%); opacity: 0; pointer-events: none; transition: opacity 240ms ease; }
.ad-scrim.ad-open { opacity: 1; pointer-events: auto; }
.ad-panel { position: fixed; z-index: 50; top: 10px; right: 10px; bottom: 10px; display: flex; flex-direction: column; width: min(520px, calc(100vw - 20px)); border: 1px solid var(--uc-line); border-radius: 16px; background: var(--uc-card); box-shadow: 0 20px 48px rgb(26 35 50 / 12%), 0 3px 10px rgb(26 35 50 / 5%); transform: translateX(calc(100% + 24px)); transition: transform 360ms cubic-bezier(.7, 0, .84, 0); }
.ad-panel.ad-open { transform: none; transition: transform 480ms cubic-bezier(.16, 1, .3, 1); }
.ad-ph { display: flex; align-items: flex-start; gap: 12px; padding: 18px 18px 14px; border-bottom: 1px solid var(--uc-line); }
.ad-ph h2 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -.02em; }
.ad-ph .ad-tt p { margin: 6px 0 0; color: var(--uc-muted); font-size: 12.5px; }
.ad-x { display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 8px; background: transparent; color: var(--uc-dim); font-size: 16px; cursor: pointer; }
.ad-x:hover { background: var(--uc-paper); color: var(--uc-text); }
.ad-pb { flex: 1; overflow: auto; padding: 4px 18px 18px; }
.ad-pbadges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
.ad-sec { padding: 14px 0; border-bottom: 1px solid var(--uc-line); }
.ad-sec:last-child { border-bottom: 0; }
.ad-sec h3 { margin: 0 0 5px; color: var(--uc-dim); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.ad-sec p { margin: 0; color: var(--uc-text); font-size: 13px; line-height: 1.55; }
.ad-sec p.ad-none { color: var(--uc-dim); font-style: italic; }
.ad-kv { display: grid; grid-template-columns: 110px 1fr; gap: 8px 12px; margin: 0; font-size: 12.5px; }
.ad-kv dt { color: var(--uc-dim); }
.ad-kv dd { margin: 0; color: var(--uc-text); min-width: 0; overflow-wrap: anywhere; }
.ad-kv .ad-mono { font: 11.5px var(--font-mono, ui-monospace, Menlo, monospace); }
.ad-cost-row { display: flex; align-items: center; gap: 6px; }
.ad-slotnote { font-family: var(--font-body, system-ui, sans-serif); color: var(--uc-dim); }
.ad-dimtext { color: var(--uc-dim); }
.ad-links { display: flex; flex-wrap: wrap; gap: 5px; }
.ad-link { padding: 2px 8px; border: 1px solid var(--uc-line); border-radius: 9px; background: var(--uc-paper); color: var(--uc-text); font: 11px var(--font-mono, ui-monospace, Menlo, monospace); cursor: pointer; transition: border-color 160ms ease, background 160ms ease; }
.ad-link:hover { border-color: var(--uc-accent-line); background: var(--uc-accent-soft); color: var(--uc-accent); }
.ad-link[disabled] { cursor: default; color: var(--uc-dim); }
.ad-link[disabled]:hover { border-color: var(--uc-line); background: var(--uc-paper); color: var(--uc-dim); }
.ad-pf { display: flex; align-items: center; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--uc-line); }
.ad-pf small { color: var(--uc-dim); font-size: 11.5px; margin-right: auto; }

@media (max-width: 760px) {
  .ad-grid { grid-template-columns: minmax(0, 1fr); }
  .ad-bar { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; }
  .ad-bar .ad-sum { display: none; }
  .ad-panel { top: auto; left: 0; right: 0; bottom: 0; width: 100%; max-height: 88vh; border-radius: 16px 16px 0 0; transform: translateY(100%); }
  .ad-panel.ad-open { transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .ad-card, .ad-panel, .ad-scrim, .ad-skel i { transition-duration: 1ms !important; animation-duration: 1ms !important; }
  .ad-card:hover { transform: none; }
}
</style>
