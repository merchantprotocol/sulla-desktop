<!--
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<template>
  <aside
    class="space-y-3 rounded border border-edge bg-surface/50 p-4"
    aria-labelledby="agent-setup-heading"
  >
    <div class="flex items-start justify-between gap-3">
      <div>
        <h3
          id="agent-setup-heading"
          class="text-sm font-semibold text-content"
        >
          Local setup
        </h3>
        <p class="mt-1 text-xs text-content-muted">
          Advisory checks for this definition.
        </p>
      </div>
      <span
        class="rounded px-2 py-1 text-xs"
        :class="
          form.enabled
            ? 'bg-emerald-500/15 text-emerald-200'
            : 'bg-surface text-content-muted'
        "
      >
        {{ form.enabled ? 'Enabled' : 'Disabled for new work' }}
      </span>
    </div>

    <div class="space-y-2 text-sm">
      <div class="flex items-start justify-between gap-3">
        <span class="text-content-muted">Model route</span><span class="text-right">{{ modelStatus }}</span>
      </div>
      <div class="flex items-start justify-between gap-3">
        <span class="text-content-muted">Team</span><span class="text-right">{{ teamLabel }}</span>
      </div>
      <div class="flex items-start justify-between gap-3">
        <span class="text-content-muted">Tools</span><span class="text-right">{{
          form.allowedTools.length
            ? `${form.allowedTools.length} selected`
            : 'Default tools'
        }}</span>
      </div>
      <div class="flex items-start justify-between gap-3">
        <span class="text-content-muted">Skills</span><span class="text-right">{{
          form.skillRefs.length
            ? `${form.skillRefs.length} selected`
            : 'No explicit skills'
        }}</span>
      </div>
    </div>

    <div
      v-if="advisories.length"
      class="space-y-1 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
    >
      <div
        v-for="advisory in advisories"
        :key="advisory"
      >
        {{ advisory }}
      </div>
    </div>
    <p
      v-else
      class="text-xs text-emerald-200"
    >
      Reference availability is shown in Capabilities. Catalog read failures and
      unlisted saved references do not clear assignments.
    </p>

    <p class="text-xs text-content-muted">
      {{ tryHint }}
    </p>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { agentEditorTeamLabel } from '@pkg/shared/agentEditor';

import type { AgentEditorFormState } from './AgentEditorForm';

const props = defineProps<{
  form:            AgentEditorFormState;
  saved:           boolean;
  hasUnsavedEdits: boolean;
  modelStatus:     string;
}>();

const teamLabel = computed(() => agentEditorTeamLabel(props.form.canCall));
const advisories = computed(() => [
  ...(!props.form.whenToCall.trim() ? ['When to call is empty.'] : []),
  ...(!props.form.whenNotToCall.trim() ? ['When not to call is empty.'] : []),
  ...(!props.form.send.trim() ? ['Send guidance is empty.'] : []),
  ...(!props.form.returns.trim() ? ['Returns is empty.'] : []),
]);
const tryHint = computed(() => {
  if (!props.saved) return 'Save this definition before trying it.';
  if (!props.form.enabled) { return 'Enable and save this definition before trying it.' }
  if (props.hasUnsavedEdits) return 'Save or discard edits before trying it.';
  return 'Use Try in the header to open a separate empty normal chat with this agent selected.';
});
</script>
