<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <!-- Loading overlay while system boots -->
  <div
    v-if="showOverlay || props.forceVisible"
    class="sulla-startup-overlay"
  >
    <div class="sulla-startup-column">
      <!-- Feature showcase: the main focus, fills everything above the progress card -->
      <StartupShowcase class="sulla-startup-showcase" />

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
              Getting everything ready for you
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
          :fallback-label="progressDescription || 'Preparing the secure environment for Sulla'"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';

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

// Clear the screen the moment the model reaches 100%, instead of waiting for the next readiness poll.
watch(() => snapshot.value?.ready, (ready) => {
  if (ready) showOverlay.value = false;
});

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
  overflow: hidden;
  background: rgba(13, 17, 23, 0.85);
  backdrop-filter: blur(12px);
}

.sulla-startup-column {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  height: 100%;
  min-height: 0;
}

/* Showcase owns the window; the progress card is a short strip at the bottom. */
.sulla-startup-showcase {
  flex: 1 1 auto;
  min-height: 0;
}

.sulla-startup-card {
  position: relative;
  box-sizing: border-box;
  flex: 0 0 auto;
  width: calc(100% - 32px);
  max-width: 44rem;
  margin: 0 auto 16px;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid rgba(26, 35, 50, 0.14);
  background: #ffffff;
  --text-primary: #1a2332;
  --text-secondary: #5b6778;
  --text-muted: #8a94a3;
  padding: 14px 20px 16px;
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
  margin-bottom: 8px;
}

.sulla-startup-icon {
  display: flex;
  height: 1.75rem;
  width: 1.75rem;
  align-items: center;
  justify-content: center;
  border-radius: 0.75rem;
  background: rgba(80, 150, 179, 0.1);
  color: var(--accent-primary, #5096b3);
}

.sulla-startup-title {
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary, #e6edf3);
  margin: 0;
}

.sulla-startup-subtitle {
  font-size: 0.8rem;
  color: var(--text-secondary, #b1bac4);
  margin: 0;
}

.sulla-startup-download {
  margin-top: 0.5rem;
  border-radius: 0.75rem;
  border: 1px solid rgba(80, 150, 179, 0.15);
  background: rgba(80, 150, 179, 0.08);
  padding: 0.6rem 0.8rem;
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
/* The card is white: give the progress panel dark ink and a light track. */
.sulla-startup-card :deep(.sulla-sp) {
  --sp-ink: #1a2332;
  --sp-read: #5b6778;
  --sp-hair: rgba(26, 35, 50, 0.14);
  --sp-track: #e3eaf1;
}
</style>

<style scoped>
.theme-noir .sulla-startup-overlay {
  background: radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--nx-accent) 833.3333%, transparent), transparent 32%), color-mix(in srgb, var(--nx-paper) 108.6957%, transparent);
  backdrop-filter: blur(22px);
}
.theme-noir .sulla-startup-card {
  padding: 14px 22px 16px;
  border: 0;
  border-radius: 16px;
  background: #ffffff;
  box-shadow: inset 0 0 0 1px rgba(26, 35, 50, 0.14), 0 20px 50px rgba(0, 0, 0, 0.35);
  animation: startup-noir-enter .5s cubic-bezier(.22, 1, .36, 1) both;
}
.theme-noir .sulla-startup-accent { display: none; }
.theme-noir .sulla-startup-header { gap: 12px; margin-bottom: 8px; }
.theme-noir .sulla-startup-icon {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  color: #a8c0dc;
  background: linear-gradient(145deg, color-mix(in srgb, var(--nx-accent-2) 454.5455%, transparent), color-mix(in srgb, var(--nx-accent) 1666.6667%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 294.1176%, transparent), 0 0 34px color-mix(in srgb, var(--nx-accent) 285.7143%, transparent);
}
.theme-noir .sulla-startup-icon svg { width: 18px; height: 18px; }
.theme-noir-light .sulla-startup-icon { color: var(--nx-accent-2); }
.theme-noir .sulla-startup-title { font-family: 'Playfair Display', Georgia, serif; font-size: 18px; color: #1a2332; }
.theme-noir .sulla-startup-subtitle,
.theme-noir .sulla-startup-download-status { color: #5b6778; font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace; }
.theme-noir .sulla-startup-download { border: 0; border-radius: 14px; background: rgba(80, 150, 179, 0.08); box-shadow: inset 0 0 0 1px rgba(26, 35, 50, 0.1); }
@keyframes startup-noir-enter { from { opacity: 0; transform: translateY(8px) scale(.98); filter: blur(8px); } to { opacity: 1; transform: none; filter: none; } }
@media (max-width: 520px) {
  .sulla-startup-card,
  .theme-noir .sulla-startup-card { padding: 12px 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .theme-noir .sulla-startup-card { animation: none; }
}
</style>
