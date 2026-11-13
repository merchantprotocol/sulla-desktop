<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->

<script setup lang="ts">
import { computed } from 'vue';

import PrefCard from '../PrefCard.vue';
import PrefRow from '../PrefRow.vue';
import PrefToggle from '../PrefToggle.vue';
import PromptEditorCard from '../PromptEditorCard.vue';

import { usePromptSections } from '@pkg/composables/preferences/usePromptSections';
import { useSullaSetting } from '@pkg/composables/preferences/useSullaSetting';

const enabled = useSullaSetting('heartbeatEnabled', false, 'boolean', { refreshOnFocus: true });
const delay = useSullaSetting('heartbeatDelayMinutes', 15, 'number');
const prompts = usePromptSections();
// Who runs the heartbeat moved to AI models → Defaults (it replaced heartbeatProvider / heartbeatModelId).
const emit = defineEmits<{ (e: 'go', section: 'models'): void }>();

const heartbeat = computed(() => prompts.find('heartbeat'));
const goal = computed(() => prompts.find('heartbeat_goal'));

async function saveDelay(event: Event) {
  const input = event.target as HTMLInputElement;
  const minutes = Math.round(Number(input.value));

  if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440) {
    await delay.save(minutes);

    return;
  }
  await delay.reload();
  input.value = String(delay.value.value);
  delay.error.value = 'Enter a number of minutes between 1 and 1,440.';
}
</script>

<template>
  <div>
    <div class="ph">
      <div>
        <h1>Heartbeat</h1>
        <p>Sulla checks in on its own, works on open goals and tells you what moved.</p>
      </div>
    </div>

    <PrefCard title="Heartbeat">
      <PrefRow title="Run the heartbeat">
        <PrefToggle
          :model-value="enabled.value.value"
          label="Run the heartbeat"
          @update:model-value="enabled.save($event)"
        />
      </PrefRow>
      <PrefRow
        title="How often"
        subtitle="Between 1 and 1,440 minutes."
        :off="!enabled.value.value"
      >
        <input
          class="inp sm"
          type="number"
          min="1"
          max="1440"
          aria-label="Minutes between heartbeats"
          :value="delay.value.value"
          :disabled="!enabled.value.value"
          @change="saveDelay"
        > <span class="dimc">minutes</span>
      </PrefRow>
      <PrefRow
        title="Who runs it"
        subtitle="Pick the agent or model under AI models → Defaults."
        :off="!enabled.value.value"
      >
        <button
          type="button"
          class="link"
          @click="emit('go', 'models')"
        >
          Open Defaults
        </button>
      </PrefRow>
      <p
        v-if="enabled.error.value || delay.error.value || prompts.error.value"
        class="note badc"
      >
        {{ enabled.error.value || delay.error.value || prompts.error.value }}
      </p>
    </PrefCard>

    <PromptEditorCard
      title="Heartbeat instructions"
      :section="heartbeat"
      :rows="8"
      @save="prompts.save('heartbeat', $event)"
      @reset="prompts.reset('heartbeat')"
    >
      <template
        v-if="heartbeat"
        #actions
      >
        <PrefToggle
          :model-value="heartbeat.enabled"
          label="Include the heartbeat instructions"
          @update:model-value="prompts.setEnabled(heartbeat, $event)"
        />
      </template>
    </PromptEditorCard>

    <PromptEditorCard
      v-if="goal"
      title="Heartbeat goal"
      subtitle="The standing goal the heartbeat works toward. Only the heartbeat reads it."
      :section="goal"
      :rows="6"
      @save="prompts.save('heartbeat_goal', $event)"
      @reset="prompts.reset('heartbeat_goal')"
    >
      <template #actions>
        <PrefToggle
          :model-value="goal.enabled"
          label="Include the heartbeat goal"
          @update:model-value="prompts.setEnabled(goal, $event)"
        />
      </template>
    </PromptEditorCard>
  </div>
</template>
