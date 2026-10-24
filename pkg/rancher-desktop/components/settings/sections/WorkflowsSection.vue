<script setup lang="ts">
import { computed } from 'vue';

import PrefCard from '../PrefCard.vue';
import PrefRow from '../PrefRow.vue';
import PrefToggle from '../PrefToggle.vue';

import { useEngineSettings } from '@pkg/composables/preferences/useEngineSettings';
import { useSullaSetting } from '@pkg/composables/preferences/useSullaSetting';
import {
  DEFAULT_WORKER_CONCURRENCY, WORKER_CONCURRENCY_KEY, isValidWorkerConcurrency,
} from '@pkg/shared/workerConcurrency';

const workers = useSullaSetting<number>(WORKER_CONCURRENCY_KEY, DEFAULT_WORKER_CONCURRENCY, 'number');
const { get, set, isLocked } = useEngineSettings();
const watching = computed(() => !!get('experimental.externalWaitMonitorEnabled'));

function saveWorkers(event: Event) {
  const raw = (event.target as HTMLInputElement).value;

  if (isValidWorkerConcurrency(raw)) {
    void workers.save(Number(raw));
  } else {
    void workers.reload();
  }
}

function saveConcurrency(event: Event) {
  const n = Math.round(Number((event.target as HTMLInputElement).value));

  if (Number.isFinite(n) && n >= 1 && n <= 32) {
    void set('experimental.externalWaitMonitorConcurrency', n);
  }
}
</script>

<template>
  <div>
    <div class="ph">
      <div>
        <h1>Workflows</h1>
        <p>How much background work runs at once.</p>
      </div>
    </div>

    <PrefCard title="Workers">
      <PrefRow
        title="Workflows at once"
        subtitle="A shared ceiling for system runs such as dreaming."
      >
        <input
          class="inp sm"
          type="number"
          min="1"
          step="1"
          aria-label="Workflows at once"
          :value="workers.value.value"
          @change="saveWorkers"
        >
      </PrefRow>
      <p
        v-if="workers.error.value"
        class="note badc"
      >
        {{ workers.error.value }}
      </p>
    </PrefCard>

    <PrefCard
      title="Waiting on outside events"
      subtitle="Runs that pause for an email, a reply or a webhook."
    >
      <PrefRow title="Watch for outside events">
        <PrefToggle
          :model-value="get('experimental.externalWaitMonitorEnabled')"
          :disabled="isLocked('experimental.externalWaitMonitorEnabled')"
          label="Watch for outside events"
          @update:model-value="set('experimental.externalWaitMonitorEnabled', $event)"
        />
      </PrefRow>
      <PrefRow
        title="Events checked at once"
        subtitle="Between 1 and 32."
        :off="!get('experimental.externalWaitMonitorEnabled')"
      >
        <input
          class="inp sm"
          type="number"
          min="1"
          max="32"
          aria-label="Events checked at once"
          :value="get('experimental.externalWaitMonitorConcurrency')"
          :disabled="!watching || isLocked('experimental.externalWaitMonitorConcurrency')"
          @change="saveConcurrency"
        >
      </PrefRow>
      <PrefRow
        title="Hold back duplicate task comments"
        subtitle="Off while the watcher is being proven."
        :off="!get('experimental.externalWaitMonitorEnabled')"
      >
        <PrefToggle
          :model-value="get('experimental.externalWaitCommentSuppressionEnabled')"
          :disabled="!watching || isLocked('experimental.externalWaitCommentSuppressionEnabled')"
          label="Hold back duplicate task comments"
          @update:model-value="set('experimental.externalWaitCommentSuppressionEnabled', $event)"
        />
      </PrefRow>
    </PrefCard>
  </div>
</template>
