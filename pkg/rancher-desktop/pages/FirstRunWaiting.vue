<template>
  <div class="frw-container max-w-lg mx-0 p-6">
    <h2 class="frw-title text-2xl font-bold mt-5 mb-4">
      You're all set. Finishing setup…
    </h2>
    <p class="frw-subtitle mb-3">
      Sulla is preparing its private workspace. The first time takes a few minutes, depending on your internet speed.
      Please leave this window open until it finishes.
    </p>
    <p class="frw-subtitle mb-6">
      When it's ready, Sulla opens automatically. If you picked a first automation, it's waiting in the chat box. Press Enter to start it.
    </p>

    <div class="frw-progress-box mt-6 p-4 rounded-lg">
      <h4 class="frw-title text-sm font-semibold mb-2">
        Startup Progress
      </h4>
      <div class="frw-progress-track w-full rounded-full h-2.5 mb-2">
        <div
          class="frw-progress-bar h-2.5 rounded-full"
          :style="{ width: `${progressPercent}%` }"
        />
      </div>
      <p class="frw-muted text-xs">
        {{ progressDescription || startupController.state.progressDescription }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { defineProps, onMounted, onUnmounted, ref } from 'vue';

import { StartupProgressController } from './agent/StartupProgressController';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{
  startupController: StartupProgressController;
}>();

const progressPercent = ref(0);
const progressDescription = ref('');

const updateProgress = (event: any, progress: { current: number; max: number; description?: string }) => {
  if (progress.max > 0) {
    const current = Number(progress.current);
    const max = Number(progress.max);
    progressPercent.value = (current / max) * 100;
    if (progress.description) {
      progressDescription.value = progress.description;
    }
  }
};

onMounted(() => {
  ipcRenderer.on('k8s-progress', updateProgress);
});

onUnmounted(() => {
  ipcRenderer.removeListener('k8s-progress', updateProgress);
});
</script>

<style lang="scss" scoped>
.frw-container {
  background: var(--bg-surface);
}

.frw-title {
  color: var(--text-primary);
}

.frw-subtitle {
  color: var(--text-secondary);
}

.frw-progress-box {
  background: var(--bg-surface-alt);
}

.frw-progress-track {
  background: var(--bg-surface-hover);
}

.frw-progress-bar {
  background: var(--accent-primary);
}

.frw-muted {
  color: var(--text-muted);
}
</style>
