<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->

<script setup lang="ts">
import PrefCard from '../PrefCard.vue';
import PrefRow from '../PrefRow.vue';

import { useSullaSetting } from '@pkg/composables/preferences/useSullaSetting';
import {
  DEFAULT_WORKER_CONCURRENCY, WORKER_CONCURRENCY_KEY, isValidWorkerConcurrency,
} from '@pkg/shared/workerConcurrency';

const workers = useSullaSetting<number>(WORKER_CONCURRENCY_KEY, DEFAULT_WORKER_CONCURRENCY, 'number');

// The "Waiting on outside events" card was removed: nothing in Sulla reads
// experimental.externalWaitMonitor* any more, so its switches did nothing.

async function saveWorkers(event: Event) {
  const input = event.target as HTMLInputElement;
  const raw = input.value;

  if (isValidWorkerConcurrency(raw)) {
    await workers.save(Number(raw));

    return;
  }
  await workers.reload();
  input.value = String(workers.value.value);
  workers.error.value = 'Enter a whole number of 1 or more.';
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
  </div>
</template>
