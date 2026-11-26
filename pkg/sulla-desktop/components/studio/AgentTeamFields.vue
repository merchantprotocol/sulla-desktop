<!--
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import AgentModelControls from './AgentModelControls.vue';

import type { AgentModelTiers } from '@pkg/agent/languagemodels/agentModelTiers';
import type { AgentModelChoice, ModelRoutingState } from '@pkg/agent/languagemodels/modelRoutingTypes';
import { choiceLabel } from '@pkg/components/settings/sections/modelRouting/routingLogic';
import { PRODUCT_OWNER, WORKFLOW_STEPS, type ProductOwnerStep } from '@pkg/shared/productOwnerWorkflow';

export interface AgentTeamMember {
  id:           string;
  slug:         string;
  name:         string;
  description?: string;
  enabled:      boolean;
  status:       string;
  canCall:      string[];
  modelChoice?: AgentModelChoice;
  type?:        string | null;
}

export interface AgentTeamModelDraft {
  choice:     AgentModelChoice;
  savedTiers: AgentModelTiers | null;
  tiers:      AgentModelTiers | null;
}

const props = defineProps<{
  owner:   AgentTeamMember;
  agents:  AgentTeamMember[];
  routing: ModelRoutingState;
  drafts:  Record<string, AgentTeamModelDraft>;
}>();
const emit = defineEmits<{ 'update-tiers': [slug: string, tiers: AgentModelTiers | null] }>();

const selectedSlug = ref('');
const search = ref('');
const active = computed(() => props.agents.filter(agent => agent.enabled && agent.status !== 'archive' && agent.id !== props.owner.id));
const bySlug = computed(() => new Map(props.agents.map(agent => [agent.slug, agent])));

function roster(owner: AgentTeamMember | undefined): AgentTeamMember[] {
  if (!owner) return [];
  const choices = owner.canCall ?? [];
  if (!choices.length || choices.includes('*')) return active.value.filter(agent => agent.id !== owner.id);
  const allowed = new Set(choices);
  return active.value.filter(agent => allowed.has(agent.slug) && agent.id !== owner.id);
}

const ownerRoster = computed(() => roster(props.owner));
// The Product Owner's direct handoffs, named by the step each one leads.
const LEAD_CAPTIONS: Partial<Record<ProductOwnerStep, string>> = {
  mockup:     'Mockup, when UI design is needed',
  build:      'Build and review lead',
  acceptance: 'Acceptance and break-it checks',
};
const workflowLeads = computed(() => WORKFLOW_STEPS.flatMap((step) => {
  const caption = LEAD_CAPTIONS[step.id];
  // Only a coordinator the owner can hand off to. Its own team is unreachable otherwise.
  const agent = caption ? ownerRoster.value.find(item => item.slug === step.agent) : undefined;
  return agent && caption ? [{ agent, step: step.id, caption }] : [];
}));
const workflowDirect = computed(() => workflowLeads.value.map(lead => lead.agent));
const leadFor = (step: ProductOwnerStep) => workflowLeads.value.find(lead => lead.step === step)?.agent;
const codingRoster = computed(() => {
  const shown = new Set(workflowDirect.value.map(agent => agent.id));
  return roster(leadFor('build')).filter(agent => !shown.has(agent.id));
});
const testingRoster = computed(() => {
  const shown = new Set([...workflowDirect.value, ...codingRoster.value].map(agent => agent.id));
  return roster(leadFor('acceptance')).filter(agent => !shown.has(agent.id));
});
const workflowMembers = computed(() => new Set([
  ...workflowDirect.value.map(agent => agent.slug),
  ...codingRoster.value.map(agent => agent.slug),
  ...testingRoster.value.map(agent => agent.slug),
]));
const otherRoster = computed(() => ownerRoster.value.filter(agent => !workflowMembers.value.has(agent.slug)));
const unavailable = computed(() => {
  const choices = props.owner.canCall ?? [];
  if (!choices.length || choices.includes('*')) return props.agents.filter(agent => agent.id !== props.owner.id && (!agent.enabled || agent.status === 'archive'));
  const found = new Set(props.agents.map(agent => agent.slug));
  return choices.map(slug => bySlug.value.get(slug) ?? ({
    id: `missing:${ slug }`, slug, name: slug, enabled: false, status: found.has(slug) ? 'disabled' : 'missing', canCall: [],
  } as AgentTeamMember)).filter(agent => !agent.enabled || agent.status === 'archive' || agent.id.startsWith('missing:'));
});
const visibleOtherRoster = computed(() => {
  const query = search.value.trim().toLowerCase();
  return query ? otherRoster.value.filter(agent => `${ agent.name } ${ agent.slug }`.toLowerCase().includes(query)) : otherRoster.value;
});
const isProductOwner = computed(() => props.owner.slug === PRODUCT_OWNER);
const delegatedGroups = computed(() => {
  if (isProductOwner.value || !props.owner.canCall.length || props.owner.canCall.includes('*')) return [];
  const groups: { owner: AgentTeamMember; members: AgentTeamMember[] }[] = [];
  const queued = [...ownerRoster.value];
  const expanded = new Set([props.owner.id]);
  const listed = new Set(ownerRoster.value.map(agent => agent.id));
  while (queued.length) {
    const coordinator = queued.shift()!;
    if (expanded.has(coordinator.id)) continue;
    expanded.add(coordinator.id);
    if (!coordinator.canCall.length) continue;
    const reachable = roster(coordinator);
    for (const member of reachable) if (!expanded.has(member.id)) queued.push(member);
    const members = reachable.filter(member => !listed.has(member.id));
    for (const member of members) listed.add(member.id);
    if (!members.length) continue;
    groups.push({ owner: coordinator, members });
  }
  return groups;
});
const allVisible = computed(() => {
  const rows = isProductOwner.value
    ? [...workflowDirect.value, ...codingRoster.value, ...testingRoster.value, ...otherRoster.value]
    : [...ownerRoster.value, ...delegatedGroups.value.flatMap(group => group.members)];
  return [...new Map(rows.map(agent => [agent.id, agent])).values()];
});
const selected = computed(() => bySlug.value.get(selectedSlug.value));
const selectedDraft = computed(() => selected.value ? props.drafts[selected.value.slug] : undefined);

watch([() => props.owner.id, allVisible], () => {
  if (!allVisible.value.some(agent => agent.slug === selectedSlug.value)) selectedSlug.value = allVisible.value[0]?.slug ?? '';
}, { immediate: true });

const same = (left: AgentModelTiers | null, right: AgentModelTiers | null) => JSON.stringify(left) === JSON.stringify(right);
function routeSummary(agent: AgentTeamMember): string {
  const draft = props.drafts[agent.slug];
  const first = draft?.tiers?.tiers[0]?.candidates[0];
  if (!first) return choiceLabel(draft?.choice ?? agent.modelChoice ?? { mode: 'list' }, props.routing);
  if (!first.model) return 'Choose a model';
  const fallbacks = draft.tiers!.tiers.reduce((count, tier) => count + tier.candidates.length, 0) - 1;
  return `${ first.model }${ first.effort ? ` · ${ first.effort }` : '' }${ fallbacks ? ` · ${ fallbacks } fallback${ fallbacks === 1 ? '' : 's' }` : '' }`;
}
function source(agent: AgentTeamMember): string {
  const draft = props.drafts[agent.slug];
  if (!draft?.tiers) return 'Uses this agent’s inherited AI Models route';
  return same(draft.tiers, draft.savedTiers) ? 'Saved model tiers' : 'Unsaved model tiers';
}
function select(agent: AgentTeamMember) { selectedSlug.value = agent.slug }
</script>

<template>
  <section class="team-shell">
    <header class="team-head">
      <div><h2>Team</h2><p>{{ owner.name }} can reach {{ allVisible.length }} enabled agent{{ allVisible.length === 1 ? '' : 's' }} through its delegation routes.</p></div>
      <span>{{ allVisible.length }} reachable<span v-if="unavailable.length"> · {{ unavailable.length }} unavailable</span></span>
    </header>
    <div
      class="precedence"
      role="note"
    >
      <strong>Chat choices come first.</strong> AI Team settings saved inside a chat override these defaults. Changes here apply only to future handoffs.
    </div>
    <div class="team-grid">
      <div class="team-list">
        <template v-if="isProductOwner">
          <h3>Product Owner workflow</h3>
          <template
            v-for="lead in workflowLeads"
            :key="lead.agent.id"
          >
            <button
              type="button"
              class="team-row"
              :class="{ selected: selectedSlug === lead.agent.slug }"
              @click="select(lead.agent)"
            >
              <span><strong>{{ lead.agent.name }}</strong><small>{{ lead.caption }}</small></span><span class="route">{{ routeSummary(lead.agent) }}</span><b>›</b>
            </button>
            <details
              v-if="lead.step === 'build' && codingRoster.length"
              open
              class="branch"
            >
              <summary><span><strong>Implementation and independent review</strong><small>{{ lead.agent.name }} chooses an eligible specialist at handoff</small></span><em>{{ codingRoster.length }}</em></summary>
              <button
                v-for="agent in codingRoster"
                :key="`coding:${agent.id}`"
                type="button"
                class="team-row child"
                :class="{ selected: selectedSlug === agent.slug }"
                @click="select(agent)"
              >
                <span><strong>{{ agent.name }}</strong><small>{{ agent.slug }}</small></span><span class="route">{{ routeSummary(agent) }}</span><b>›</b>
              </button>
            </details>
            <details
              v-if="lead.step === 'acceptance' && testingRoster.length"
              class="branch"
            >
              <summary><span><strong>Acceptance support</strong><small>{{ lead.agent.name }} can delegate supporting checks</small></span><em>{{ testingRoster.length }}</em></summary>
              <button
                v-for="agent in testingRoster"
                :key="`testing:${agent.id}`"
                type="button"
                class="team-row child"
                :class="{ selected: selectedSlug === agent.slug }"
                @click="select(agent)"
              >
                <span><strong>{{ agent.name }}</strong><small>{{ agent.slug }}</small></span><span class="route">{{ routeSummary(agent) }}</span><b>›</b>
              </button>
            </details>
          </template>
          <details
            v-if="otherRoster.length"
            class="branch"
          >
            <summary><span><strong>Other eligible specialists</strong><small>Available for direct Product Owner handoffs</small></span><em>{{ otherRoster.length }}</em></summary>
            <input
              v-model="search"
              type="search"
              placeholder="Find an agent"
              aria-label="Find an eligible specialist"
            >
            <button
              v-for="agent in visibleOtherRoster"
              :key="`other:${agent.id}`"
              type="button"
              class="team-row child"
              :class="{ selected: selectedSlug === agent.slug }"
              @click="select(agent)"
            >
              <span><strong>{{ agent.name }}</strong><small>{{ agent.slug }}</small></span><span class="route">{{ routeSummary(agent) }}</span><b>›</b>
            </button>
          </details>
        </template>
        <template v-else>
          <h3>Eligible agents</h3>
          <button
            v-for="agent in ownerRoster"
            :key="agent.id"
            type="button"
            class="team-row"
            :class="{ selected: selectedSlug === agent.slug }"
            @click="select(agent)"
          >
            <span><strong>{{ agent.name }}</strong><small>{{ agent.slug }}</small></span><span class="route">{{ routeSummary(agent) }}</span><b>›</b>
          </button>
          <details
            v-for="group in delegatedGroups"
            :key="group.owner.id"
            class="branch"
          >
            <summary><span><strong>Delegated by {{ group.owner.name }}</strong><small>Agents this coordinator can trigger</small></span><em>{{ group.members.length }}</em></summary>
            <button
              v-for="agent in group.members"
              :key="`${group.owner.id}:${agent.id}`"
              type="button"
              class="team-row child"
              :class="{ selected: selectedSlug === agent.slug }"
              @click="select(agent)"
            >
              <span><strong>{{ agent.name }}</strong><small>{{ agent.slug }}</small></span><span class="route">{{ routeSummary(agent) }}</span><b>›</b>
            </button>
          </details>
        </template>
        <details
          v-if="unavailable.length"
          class="unavailable"
        >
          <summary>Unavailable agents · {{ unavailable.length }}</summary>
          <p
            v-for="agent in unavailable"
            :key="agent.id"
          >
            <strong>{{ agent.name }}</strong> · {{ agent.status === 'archive' ? 'Archived' : agent.status === 'missing' ? 'Missing' : 'Disabled' }}
          </p>
        </details>
      </div>
      <aside
        v-if="selected && selectedDraft"
        class="team-inspector"
      >
        <header><small>{{ isProductOwner ? 'Product Owner team member' : `Called by ${owner.name}` }}</small><h3>{{ selected.name }}</h3><p>{{ selected.description || selected.slug }}</p></header>
        <div class="team-controls">
          <AgentModelControls
            :model-value="selectedDraft.choice"
            :tiers="selectedDraft.tiers"
            :state="routing"
            :source="source(selected)"
            shared-choice-readonly
            @update:model-value="() => {}"
            @update:tiers="emit('update-tiers', selected.slug, $event)"
          />
          <p class="future-note">
            A running or parked job keeps the route captured when it launched. This setting is read for the next handoff.
          </p>
        </div>
      </aside>
      <p
        v-else
        class="team-empty"
      >
        No enabled team member is available.
      </p>
    </div>
  </section>
</template>

<style scoped>
.team-shell { min-width: 0; }
.team-head { display: flex; justify-content: space-between; gap: 1rem; align-items: start; padding-bottom: .85rem; border-bottom: 1px solid var(--uc-line); }
.team-head h2, .team-head p, .team-list h3, .team-inspector h3, .team-inspector p { margin: 0; }
.team-head p, .team-head > span, .team-inspector p, .future-note { color: var(--uc-muted); }
.team-head > span { white-space: nowrap; font-size: .8rem; }
.precedence { margin: .85rem 0; padding: .65rem .75rem; border: 1px solid color-mix(in srgb, var(--uc-accent) 42%, var(--uc-line)); border-radius: .55rem; background: color-mix(in srgb, var(--uc-accent) 8%, var(--uc-paper)); color: var(--uc-muted); }
.precedence strong { color: var(--uc-text); }
.team-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(18rem, .72fr); gap: .85rem; align-items: start; }
.team-list { display: grid; gap: .4rem; min-width: 0; }
.team-list h3 { margin: .2rem 0; font-size: .86rem; color: var(--uc-muted); }
.team-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(7rem, auto) auto; align-items: center; gap: .65rem; width: 100%; min-width: 0; padding: .62rem .7rem; border: 1px solid var(--uc-line); border-radius: .5rem; background: var(--uc-paper); color: var(--uc-text); text-align: left; cursor: pointer; }
.team-row:hover, .team-row.selected { border-color: var(--uc-accent); }
.team-row.selected { background: color-mix(in srgb, var(--uc-accent) 11%, var(--uc-paper)); box-shadow: inset 2px 0 var(--uc-accent); }
.team-row span { min-width: 0; }
.team-row strong, .team-row small { display: block; overflow-wrap: anywhere; }
.team-row small { margin-top: .12rem; color: var(--uc-muted); font-weight: 400; }
.team-row .route { color: var(--uc-muted); font-size: .78rem; text-align: right; }
.team-row b { color: var(--uc-accent); }
details { min-width: 0; border-left: 1px solid var(--uc-line-strong); margin-left: .7rem; padding-left: .6rem; }
summary { display: flex; justify-content: space-between; gap: .5rem; align-items: center; padding: .45rem .2rem; color: var(--uc-text); cursor: pointer; }
summary span { min-width: 0; }
summary strong, summary small { display: block; }
summary small, summary em { color: var(--uc-muted); font-size: .76rem; font-style: normal; font-weight: 400; }
.branch .team-row { margin-top: .35rem; }
.branch input { width: 100%; margin: .3rem 0 0; padding: .45rem; color: var(--uc-text); background: var(--uc-paper); border: 1px solid var(--uc-line); border-radius: .4rem; }
.unavailable { margin-top: .3rem; color: var(--uc-muted); }
.unavailable p { margin: .35rem 0; font-size: .78rem; }
.team-inspector { position: sticky; top: 1rem; min-width: 0; border: 1px solid var(--uc-line-strong); border-radius: .6rem; background: var(--uc-paper); }
.team-inspector > header { padding: .8rem; border-bottom: 1px solid var(--uc-line); }
.team-inspector > header small { color: var(--uc-accent); }
.team-inspector > header h3 { margin-top: .15rem; }
.team-inspector > header p { margin-top: .2rem; font-size: .8rem; }
.team-controls { padding: .8rem; }
.future-note { margin: .75rem 0 0; padding-top: .65rem; border-top: 1px solid var(--uc-line); font-size: .78rem; }
.team-empty { color: var(--uc-muted); }
@media (max-width: 850px) { .team-grid { grid-template-columns: 1fr; } .team-inspector { position: static; } }
@media (max-width: 560px) { .team-head { display: block; } .team-head > span { display: block; margin-top: .35rem; } .team-row { grid-template-columns: minmax(0, 1fr) auto; } .team-row .route { grid-column: 1 / -1; text-align: left; } }
</style>
