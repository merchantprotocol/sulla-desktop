<template>
  <div class="max-w-lg mx-0 p-6 bg-white dark:bg-gray-800/30">
    <h2 class="text-2xl font-bold mt-5 mb-4 text-gray-900 dark:text-gray-100">Congratulations!</h2>
    <p class="mb-6 text-gray-600 dark:text-gray-400">
      Now the hard part is just waiting. This process may take a while depending on your Internet connection speed. If this process is interrupted it may make using the software very difficult. lol.
    </p>

    <div class="mt-6 p-4 bg-gray-100 dark:bg-gray-800 rounded-lg">
      <h4 class="text-sm font-semibold mb-2 text-gray-900 dark:text-gray-100">Startup Progress</h4>
      <div class="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 mb-2">
        <div class="h-2.5 rounded-full" :style="{ width: `${progressPercent}%`, backgroundColor: '#30a5e9' }"></div>
      </div>
      <p class="text-xs text-gray-600 dark:text-gray-400">{{ progressDescription || startupController.state.progressDescription }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { defineProps, onMounted, onUnmounted, ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { StartupProgressController } from './agent/StartupProgressController';

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
</style>
