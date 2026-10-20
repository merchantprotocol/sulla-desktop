<template>
  <!-- Loading overlay while system boots -->
  <div
    v-if="showOverlay || props.forceVisible"
    class="sulla-startup-overlay"
  >
    <div class="sulla-startup-column">
      <div class="sulla-startup-card">
        <!-- Decorative top accent bar -->
        <div class="sulla-startup-accent" />

        <!-- Icon + Title -->
        <div class="sulla-startup-header">
          <div class="sulla-startup-icon">
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
            <h2 class="sulla-startup-title">
              Starting Sulla
            </h2>
            <p class="sulla-startup-subtitle">
              {{ snapshot?.ready ? 'Ready' : 'Getting everything ready' }}
            </p>
          </div>
        </div>

        <!-- Model download progress -->
        <div
          v-if="modelDownloading"
          class="sulla-startup-download"
        >
          <p class="sulla-startup-download-label">
            Downloading: <strong class="sulla-startup-download-name">{{ modelName }}</strong>
          </p>
          <p class="sulla-startup-download-status">
            {{ modelDownloadStatus }}
          </p>
        </div>

        <!-- Unified startup progress (backend + service lifecycle) -->
        <StartupProgressPanel
          :snapshot="snapshot"
          :fallback-percent="progressMax > 0 ? progressCurrent / progressMax * 100 : 0"
          :fallback-label="progressDescription || 'Initializing system...'"
        />
      </div>

      <!-- Feature showcase: below the progress, never over it -->
      <StartupShowcase class="sulla-startup-showcase" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

import StartupProgressPanel from './StartupProgressPanel.vue';
import StartupShowcase from './StartupShowcase.vue';
import { useStartupProgress } from './useStartupProgress';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { StartupProgressSnapshot } from '@pkg/utils/startupProgress';

const props = withDefaults(defineProps<{ forceVisible?: boolean }>(), { forceVisible: false });

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

const snapshot = ref<StartupProgressSnapshot | null>(null);

function onStartupProgress(_event: unknown, next: StartupProgressSnapshot) {
  snapshot.value = next;
}

onMounted(() => {
  start();
  ipcRenderer.on('startup-progress', onStartupProgress);
  ipcRenderer.invoke('startup-progress').then((initial) => {
    // A broadcast may have landed first; keep whichever is further along.
    if (initial && (!snapshot.value || initial.percent >= snapshot.value.percent)) snapshot.value = initial;
  }).catch(() => undefined);
});

onUnmounted(() => {
  ipcRenderer.removeListener('startup-progress', onStartupProgress);
  dispose();
});
</script>

<style scoped>
.sulla-startup-overlay {
  box-sizing: border-box;
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: safe center;
  justify-content: center;
  overflow-y: auto;
  padding: 24px 16px;
  background: rgba(13, 17, 23, 0.85);
  backdrop-filter: blur(12px);
}

.sulla-startup-column {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 16px;
  width: 100%;
  max-width: 34rem;
  margin: auto 0;
}

.sulla-startup-card {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid var(--border-default, #30363d);
  background: var(--bg-surface, #161b22);
  padding: 2rem;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 30px rgba(80, 150, 179, 0.05);
}

.sulla-startup-accent {
  position: absolute;
  inset: 0 0 auto 0;
  height: 3px;
  background: linear-gradient(90deg, var(--accent-primary, #5096b3), rgba(80, 150, 179, 0.3));
}

.sulla-startup-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.sulla-startup-icon {
  display: flex;
  height: 2.5rem;
  width: 2.5rem;
  align-items: center;
  justify-content: center;
  border-radius: 0.75rem;
  background: rgba(80, 150, 179, 0.1);
  color: var(--accent-primary, #5096b3);
}

.sulla-startup-title {
  font-size: 1.125rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary, #e6edf3);
  margin: 0;
}

.sulla-startup-subtitle {
  font-size: 0.875rem;
  color: var(--text-secondary, #b1bac4);
  margin: 0;
}

.sulla-startup-download {
  margin-top: 1rem;
  border-radius: 0.75rem;
  border: 1px solid rgba(80, 150, 179, 0.15);
  background: rgba(80, 150, 179, 0.05);
  padding: 1rem;
}

.sulla-startup-download-label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-secondary, #b1bac4);
  margin: 0;
}

.sulla-startup-download-name {
  color: var(--accent-primary, #5096b3);
}

.sulla-startup-download-status {
  font-size: 0.75rem;
  color: var(--text-muted, #8b949e);
  margin: 0.375rem 0 0;
}
</style>

<style scoped>
.theme-noir .sulla-startup-overlay {
  background: radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--nx-accent) 833.3333%, transparent), transparent 32%), color-mix(in srgb, var(--nx-paper) 108.6957%, transparent);
  backdrop-filter: blur(22px);
}
.theme-noir .sulla-startup-card {
  padding: 30px 32px;
  border: 0;
  border-radius: 22px;
  background: color-mix(in srgb, var(--nx-surface) 131.5789%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-hair-strong) 160%, transparent), 0 0 70px color-mix(in srgb, var(--nx-accent) 833.3333%, transparent), 0 30px 80px color-mix(in srgb, var(--shadow) 163.6364%, transparent);
  animation: startup-noir-enter .5s cubic-bezier(.22, 1, .36, 1) both;
}
.theme-noir .sulla-startup-accent { display: none; }
.theme-noir .sulla-startup-header { flex-direction: column; text-align: center; gap: 14px; margin-bottom: 22px; }
.theme-noir .sulla-startup-icon {
  width: 58px;
  height: 58px;
  border-radius: 18px;
  color: #a8c0dc;
  background: linear-gradient(145deg, color-mix(in srgb, var(--nx-accent-2) 454.5455%, transparent), color-mix(in srgb, var(--nx-accent) 1666.6667%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 294.1176%, transparent), 0 0 34px color-mix(in srgb, var(--nx-accent) 285.7143%, transparent);
}
.theme-noir .sulla-startup-icon svg { width: 26px; height: 26px; }
.theme-noir-light .sulla-startup-icon { color: var(--nx-accent-2); }
.theme-noir .sulla-startup-title { font-family: 'Playfair Display', Georgia, serif; font-size: 27px; color: var(--nx-read-1); }
.theme-noir .sulla-startup-subtitle,
.theme-noir .sulla-startup-download-status { color: var(--nx-read-2); font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace; }
.theme-noir .sulla-startup-download { border: 0; border-radius: 14px; background: color-mix(in srgb, var(--nx-hair-strong) 457.1429%, transparent); box-shadow: inset 0 0 0 1px var(--nx-hair); }
@keyframes startup-noir-enter { from { opacity: 0; transform: translateY(8px) scale(.98); filter: blur(8px); } to { opacity: 1; transform: none; filter: none; } }
@media (max-width: 520px) {
  .sulla-startup-card,
  .theme-noir .sulla-startup-card { padding: 22px 18px; }
}
@media (prefers-reduced-motion: reduce) {
  .theme-noir .sulla-startup-card { animation: none; }
}
</style>
