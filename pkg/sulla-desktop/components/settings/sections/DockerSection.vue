<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->

<script setup lang="ts">
import os from 'os';

import { computed } from 'vue';

import PrefCard from '../PrefCard.vue';
import PrefIcon from '../PrefIcon.vue';
import PrefRange from '../PrefRange.vue';
import PrefRow from '../PrefRow.vue';
import PrefToggle from '../PrefToggle.vue';

import { openDockerTab } from '@pkg/composables/preferences/openInMain';
import { useEngineSettings } from '@pkg/composables/preferences/useEngineSettings';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

// In the Docker tab this page is "Docker options"; in Preferences it's "Docker".
const props = defineProps<{ inDocker?: boolean }>();

const { get, set, isLocked } = useEngineSettings();

// VM sizing and PATH setup are macOS-only (the Sulla VM); the validator rejects them elsewhere.
const isMac = os.platform() === 'darwin';
const maxMemory = Math.max(2, Math.ceil(os.totalmem() / 2 ** 30));
const maxCpus = Math.max(1, os.cpus().length);
// Docker below 2 GB isn't useful, but an existing smaller value still shows.
const minMemory = computed(() => Math.min(2, get<number>('virtualMachine.memoryInGB') || 2));
const memoryTicks = computed(() => {
  const steps = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(minMemory.value + (maxMemory - minMemory.value) * f));

  return steps.map((gb, i) => (i === 0 || i === steps.length - 1 ? `${ gb } GB` : String(gb)));
});
const cpuTicks = computed(() => ['1', '', '', '', String(maxCpus)]);

// Removed controls that the Sulla runtime never reads: virtual machine type,
// file sharing (9P/SSHFS), Rosetta, disk size, container engine, storage
// driver, WebAssembly, port forwarding and allowed images. The runtime always
// uses Apple Virtualization with VirtioFS, turns Rosetta on when installed,
// runs dockerd, and grows its sparse disk on demand, so those settings
// saved values that changed nothing.

function selectValue(event: Event) {
  return (event.target as HTMLSelectElement).value;
}

async function restartDocker() {
  const result = await ipcRenderer.invoke('show-message-box', {
    type:     'question',
    title:    'Restart Docker?',
    message:  'Restart Docker now?',
    detail:   'Containers with a restart policy come back on their own.',
    buttons:  ['Restart', 'Cancel'],
    cancelId: 1,
  });

  if (result.response === 0) {
    ipcRenderer.send('k8s-restart');
  }
}
</script>

<template>
  <div>
    <div class="ph">
      <div v-if="props.inDocker">
        <h1>Docker options</h1>
        <p>Memory, CPU and command-line tools. Also in Preferences › Docker.</p>
      </div>
      <div v-else>
        <h1>Docker</h1>
        <p>Memory, CPU and command-line tools for your containers.</p>
      </div>
      <div
        v-if="!props.inDocker"
        class="r"
      >
        <button
          type="button"
          class="btn"
          @click="openDockerTab()"
        >
          <PrefIcon name="box" />Open Docker
        </button>
      </div>
    </div>

    <PrefCard
      v-if="isMac"
      title="Performance"
      subtitle="Changes here restart Docker."
    >
      <PrefRow title="Memory">
        <template #subtitle>
          The most memory Docker can use. <span class="soon">Giving it back when idle: coming soon</span>
        </template>
        <PrefRange
          :model-value="get('virtualMachine.memoryInGB')"
          :min="minMemory"
          :max="maxMemory"
          :ticks="memoryTicks"
          :format="v => `${v} GB`"
          :disabled="isLocked('virtualMachine.memoryInGB')"
          label="Memory"
          @change="set('virtualMachine.memoryInGB', $event)"
        />
      </PrefRow>
      <PrefRow title="CPU cores">
        <PrefRange
          :model-value="get('virtualMachine.numberCPUs')"
          :min="1"
          :max="maxCpus"
          :ticks="cpuTicks"
          :format="v => `${v} core${v === 1 ? '' : 's'}`"
          :disabled="isLocked('virtualMachine.numberCPUs')"
          label="CPU cores"
          @change="set('virtualMachine.numberCPUs', $event)"
        />
      </PrefRow>
    </PrefCard>

    <PrefCard title="Engine">
      <PrefRow
        v-if="isMac"
        title="Command-line tools"
        subtitle="docker and its plugins in Terminal."
      >
        <select
          class="sel"
          aria-label="Command-line tools"
          :value="get('application.pathManagementStrategy')"
          :disabled="isLocked('application.pathManagementStrategy')"
          @change="set('application.pathManagementStrategy', selectValue($event))"
        >
          <option value="rcfiles">
            Add to my shell profile
          </option>
          <option value="manual">
            I’ll set PATH myself
          </option>
        </select>
      </PrefRow>
    </PrefCard>

    <PrefCard title="Network">
      <PrefRow
        title="Reach containers by name"
        off
      >
        <template #subtitle>
          Open sulla-vault.sulla.local instead of the local vault address. <span class="soon">Coming soon</span>
        </template>
        <PrefToggle
          :model-value="false"
          disabled
          label="Reach containers by name"
        />
      </PrefRow>
    </PrefCard>


    <PrefCard title="Maintenance">
      <PrefRow
        title="Restart Docker"
        subtitle="Containers with a restart policy come back on their own."
      >
        <button
          type="button"
          class="btn sm"
          @click="restartDocker"
        >
          <PrefIcon name="restart" />Restart
        </button>
      </PrefRow>
      <PrefRow
        title="Clean up"
        off
      >
        <template #subtitle>
          Removes stopped containers, unused images and build cache. <span class="soon">Coming soon</span>
        </template>
        <button
          type="button"
          class="btn sm"
          disabled
        >
          Clean up…
        </button>
      </PrefRow>
      <PrefRow title="Snapshots">
        <button
          type="button"
          class="link"
          @click="openDockerTab('snapshots')"
        >
          Open
        </button>
      </PrefRow>
    </PrefCard>
  </div>
</template>
