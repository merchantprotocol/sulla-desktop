<!--
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<template>
  <section
    class="space-y-4"
    aria-labelledby="agent-routing-heading"
  >
    <div>
      <h3
        id="agent-routing-heading"
        class="text-sm font-semibold text-content"
      >
        Routing card
      </h3>
      <p class="mt-1 text-xs text-content-muted">
        These fields describe when this agent is the right handoff and what a
        caller should expect.
      </p>
    </div>

    <div class="grid gap-4 md:grid-cols-2">
      <label class="space-y-1 text-sm">
        <span class="font-medium text-content">When to call</span>
        <textarea
          :value="modelValue.whenToCall"
          class="min-h-24 w-full rounded border border-edge bg-surface px-3 py-2 text-sm"
          rows="3"
          placeholder="Situations this agent handles well"
          @input="
            setField('whenToCall', ($event.target as HTMLTextAreaElement).value)
          "
        />
      </label>
      <label class="space-y-1 text-sm">
        <span class="font-medium text-content">When not to call</span>
        <textarea
          :value="modelValue.whenNotToCall"
          class="min-h-24 w-full rounded border border-edge bg-surface px-3 py-2 text-sm"
          rows="3"
          placeholder="Situations better handled elsewhere"
          @input="
            setField(
              'whenNotToCall',
              ($event.target as HTMLTextAreaElement).value,
            )
          "
        />
      </label>
      <label class="space-y-1 text-sm">
        <span class="font-medium text-content">Send</span>
        <textarea
          :value="modelValue.send"
          class="min-h-24 w-full rounded border border-edge bg-surface px-3 py-2 text-sm"
          rows="3"
          placeholder="Context a caller should include"
          @input="
            setField('send', ($event.target as HTMLTextAreaElement).value)
          "
        />
      </label>
      <label class="space-y-1 text-sm">
        <span class="font-medium text-content">Returns</span>
        <textarea
          :value="modelValue.returns"
          class="min-h-24 w-full rounded border border-edge bg-surface px-3 py-2 text-sm"
          rows="3"
          placeholder="What this agent returns to its caller"
          @input="
            setField('returns', ($event.target as HTMLTextAreaElement).value)
          "
        />
      </label>
    </div>

    <div class="grid gap-4 md:grid-cols-2">
      <label class="space-y-1 text-sm">
        <span class="font-medium text-content">Cost tier</span>
        <select
          :value="modelValue.costTier ?? ''"
          class="w-full rounded border border-edge bg-surface px-3 py-2 text-sm"
          @change="
            setField(
              'costTier',
              (($event.target as HTMLSelectElement).value ||
                null) as AgentEditorRoutingFields['costTier'],
            )
          "
        >
          <option value="">Not set</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>
      <label class="space-y-1 text-sm">
        <span class="font-medium text-content">First agent selection</span>
        <select
          :value="frontDoorValue"
          class="w-full rounded border border-edge bg-surface px-3 py-2 text-sm"
          @change="setFrontDoor(($event.target as HTMLSelectElement).value)"
        >
          <option value="unset">Not set</option>
          <option value="true">May be selected as first agent</option>
          <option value="false">May not be selected as first agent</option>
        </select>
        <span class="text-xs text-content-muted">
          Controls whether Reflex may choose this agent as the first persona
          for a brand-new chat. It does not change permissions or running jobs.
        </span>
      </label>
    </div>

    <label class="block space-y-1 text-sm">
      <span class="font-medium text-content">Team this agent may call</span>
      <select
        v-model="teamSelection"
        multiple
        class="min-h-28 w-full rounded border border-edge bg-surface px-3 py-2 text-sm"
        aria-label="Team this agent may call"
        aria-describedby="agent-team-help"
      >
        <option value="__default__">Default team · unrestricted</option>
        <option value="*">Everyone (wildcard)</option>
        <option
          v-for="agent in agents"
          :key="agent.slug"
          :value="agent.slug"
        >
          {{ agent.name }} · {{ agent.slug }}
        </option>
        <option
          v-for="slug in missingTeamRefs"
          :key="`missing-${slug}`"
          :value="slug"
        >
          {{ slug }} · not listed (preserved)
        </option>
      </select>
      <span
        id="agent-team-help"
        class="text-xs text-content-muted"
      >
        An empty selection keeps the existing default-team/unrestricted
        behavior. It does not mean “no one.”
      </span>
    </label>

    <details
      class="rounded border border-edge bg-surface/50 px-3 py-2"
    >
      <summary class="cursor-pointer text-sm font-medium text-content">
        Preview directory card
      </summary>
      <div class="mt-3 space-y-3 text-sm">
        <div class="grid gap-3 md:grid-cols-2">
          <div>
            <div class="text-xs uppercase tracking-wide text-content-muted">
              When to call
            </div>
            <p class="whitespace-pre-wrap">
              {{ modelValue.whenToCall || 'Not supplied' }}
            </p>
          </div>
          <div>
            <div class="text-xs uppercase tracking-wide text-content-muted">
              When not to call
            </div>
            <p class="whitespace-pre-wrap">
              {{ modelValue.whenNotToCall || 'Not supplied' }}
            </p>
          </div>
          <div>
            <div class="text-xs uppercase tracking-wide text-content-muted">
              Send
            </div>
            <p class="whitespace-pre-wrap">
              {{ modelValue.send || 'Not supplied' }}
            </p>
          </div>
          <div>
            <div class="text-xs uppercase tracking-wide text-content-muted">
              Returns
            </div>
            <p class="whitespace-pre-wrap">
              {{ modelValue.returns || 'Not supplied' }}
            </p>
          </div>
        </div>
        <div class="flex flex-wrap gap-2 text-xs text-content-muted">
          <span class="rounded bg-surface px-2 py-1">Cost: {{ modelValue.costTier || 'Not set' }}</span>
          <span class="rounded bg-surface px-2 py-1">Team: {{ teamLabel }}</span>
          <span class="rounded bg-surface px-2 py-1">First agent: {{ frontDoorLabel }}</span>
        </div>
      </div>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import {
  AGENT_EDITOR_DEFAULT_TEAM,
  agentEditorTeamLabel,
  nextAgentEditorTeam,
  type AgentEditorRoutingFields,
} from '@pkg/shared/agentEditor';

interface RoutingAgentOption {
  slug: string;
  name: string;
}

const props = defineProps<{
  modelValue: AgentEditorRoutingFields;
  agents:     RoutingAgentOption[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: AgentEditorRoutingFields];
}>();

// v-model keeps every saved member selected; a plain :value on <select multiple> cannot.
const teamSelection = computed<string[]>({
  get: () => props.modelValue.canCall.length ? [...props.modelValue.canCall] : [AGENT_EDITOR_DEFAULT_TEAM],
  set: selected => setField('canCall', nextAgentEditorTeam(props.modelValue.canCall, selected)),
});
const knownSlugs = computed(
  () => new Set(props.agents.map((agent) => agent.slug)),
);
const missingTeamRefs = computed(() =>
  props.modelValue.canCall.filter(
    (slug) => slug !== '*' && !knownSlugs.value.has(slug),
  ),
);
const teamLabel = computed(() =>
  agentEditorTeamLabel(props.modelValue.canCall),
);
const frontDoorValue = computed(() =>
  props.modelValue.frontDoor === null
    ? 'unset'
    : String(props.modelValue.frontDoor),
);
const frontDoorLabel = computed(() =>
  props.modelValue.frontDoor === null
    ? 'Not set'
    : props.modelValue.frontDoor
      ? 'May be selected'
      : 'May not be selected',
);

function setField<K extends keyof AgentEditorRoutingFields>(
  key: K,
  value: AgentEditorRoutingFields[K],
): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

function setFrontDoor(value: string): void {
  setField('frontDoor', value === 'unset' ? null : value === 'true');
}
</script>
