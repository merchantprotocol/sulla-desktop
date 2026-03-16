<template>
  <!-- Loading overlay while system boots -->
  <div
    v-if="showOverlay"
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-100/80 backdrop-blur-md dark:bg-slate-950/80"
  >
    <div class="sulla-startup-card w-full max-w-md overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-8 shadow-2xl shadow-sky-500/5 dark:border-slate-700/60 dark:bg-slate-800 dark:shadow-sky-400/5">
      <!-- Decorative top accent bar -->
      <div class="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-sky-400 via-blue-500 to-indigo-500" />

      <!-- Icon + Title -->
      <div class="flex items-center gap-3 mb-4">
        <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 dark:bg-sky-500/10">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="text-sky-500 dark:text-sky-400"
          >
            <path d="M12 8V4" /><path d="M8 4h8" /><rect
              x="6"
              y="8"
              width="12"
              height="10"
              rx="2"
            /><path d="M9 18v2" /><path d="M15 18v2" /><path d="M9.5 12h.01" /><path d="M14.5 12h.01" /><path d="M10 15h4" />
          </svg>
        </div>
        <div>
          <h2 class="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Starting Sulla
          </h2>
          <p class="text-sm text-slate-500 dark:text-slate-400">
            {{ progressDescription || 'Initializing system...' }}
          </p>
        </div>
      </div>

      <!-- Model download progress -->
      <div
        v-if="modelDownloading"
        class="mt-4 rounded-xl border border-sky-200/60 bg-sky-50/80 p-4 dark:border-sky-500/20 dark:bg-sky-500/5"
      >
        <p class="text-sm font-medium text-slate-700 dark:text-slate-200">
          Downloading: <strong class="text-sky-600 dark:text-sky-400">{{ modelName }}</strong>
        </p>
        <p class="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
          {{ modelDownloadStatus }}
        </p>
      </div>

      <!-- K8s progress bar -->
      <div
        v-if="progressMax > 0"
        class="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700"
      >
        <div
          class="h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-500 transition-all duration-500 ease-out"
          :style="{ width: (progressCurrent / progressMax * 100) + '%' }"
        />
      </div>
      <div
        v-else
        class="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700"
      >
        <div class="sulla-progress-indeterminate h-full w-2/5 rounded-full bg-gradient-to-r from-sky-400 to-blue-500" />
      </div>

      <!-- Percentage label -->
      <div
        v-if="progressMax > 0"
        class="mt-2 text-right text-xs font-medium tabular-nums text-slate-400 dark:text-slate-500"
      >
        {{ Math.round(progressCurrent / progressMax * 100) }}%
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useStartupProgress } from './useStartupProgress';

const {
  systemReady,
  progressCurrent,
  progressMax,
  progressDescription,
  startupPhase,
  showOverlay,
  modelDownloading,
  modelName,
  modelDownloadStatus,
  modelMode,
  start,
  dispose,
} = useStartupProgress();

onMounted(() => {
  start();
});

onUnmounted(() => {
  dispose();
});
</script>

<style scoped>
.sulla-startup-card {
  position: relative;
}

@keyframes sulla-indeterminate {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(250%);
  }
}

.sulla-progress-indeterminate {
  animation: sulla-indeterminate 1.5s ease-in-out infinite;
}
</style>
