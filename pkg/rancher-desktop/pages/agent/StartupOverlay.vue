<template>
  <!-- Loading overlay while system boots -->
  <div
    v-if="showOverlay"
    class="sulla-startup-overlay"
  >
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
            {{ progressDescription || 'Initializing system...' }}
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

      <!-- K8s progress bar -->
      <div
        v-if="progressMax > 0"
        class="sulla-startup-track"
      >
        <div
          class="sulla-startup-fill"
          :style="{ width: (progressCurrent / progressMax * 100) + '%' }"
        />
      </div>
      <div
        v-else
        class="sulla-startup-track"
      >
        <div class="sulla-startup-fill sulla-progress-indeterminate" />
      </div>

      <!-- Percentage label -->
      <div
        v-if="progressMax > 0"
        class="sulla-startup-percent"
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
.sulla-startup-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(13, 17, 23, 0.85);
  backdrop-filter: blur(12px);
}

.sulla-startup-card {
  position: relative;
  width: 100%;
  max-width: 28rem;
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
  color: var(--text-muted, #8b949e);
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

.sulla-startup-track {
  margin-top: 1.25rem;
  height: 4px;
  width: 100%;
  overflow: hidden;
  border-radius: 2px;
  background: var(--bg-surface-hover, #21262d);
}

.sulla-startup-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent-primary, #5096b3);
  transition: width 500ms ease-out;
  width: 40%;
}

.sulla-startup-percent {
  margin-top: 0.5rem;
  text-align: right;
  font-size: 0.75rem;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim, #6e7681);
}

@keyframes sulla-indeterminate {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}

.sulla-progress-indeterminate {
  animation: sulla-indeterminate 1.5s ease-in-out infinite;
}
</style>

<style scoped>
:global(.theme-noir) .sulla-startup-overlay {
  background: radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--nx-accent) 833.3333%, transparent), transparent 32%), color-mix(in srgb, var(--nx-paper) 108.6957%, transparent);
  backdrop-filter: blur(22px);
}
:global(.theme-noir) .sulla-startup-card {
  max-width: 30rem;
  padding: 34px;
  border: 0;
  border-radius: 22px;
  background: color-mix(in srgb, var(--nx-surface) 131.5789%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-hair-strong) 160%, transparent), 0 0 70px color-mix(in srgb, var(--nx-accent) 833.3333%, transparent), 0 30px 80px color-mix(in srgb, var(--shadow) 163.6364%, transparent);
  animation: startup-noir-enter .5s cubic-bezier(.22, 1, .36, 1) both;
}
:global(.theme-noir) .sulla-startup-accent { display: none; }
:global(.theme-noir) .sulla-startup-header { flex-direction: column; text-align: center; gap: 14px; margin-bottom: 22px; }
:global(.theme-noir) .sulla-startup-icon {
  width: 58px;
  height: 58px;
  border-radius: 18px;
  color: #a8c0dc;
  background: linear-gradient(145deg, color-mix(in srgb, var(--nx-accent-2) 454.5455%, transparent), color-mix(in srgb, var(--nx-accent) 1666.6667%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 294.1176%, transparent), 0 0 34px color-mix(in srgb, var(--nx-accent) 285.7143%, transparent);
}
:global(.theme-noir) .sulla-startup-icon svg { width: 26px; height: 26px; }
:global(.theme-noir-light) .sulla-startup-icon { color: var(--nx-accent-2); }
:global(.theme-noir) .sulla-startup-title { font-family: 'Playfair Display', Georgia, serif; font-size: 27px; color: var(--nx-read-1); }
:global(.theme-noir) .sulla-startup-subtitle,
:global(.theme-noir) .sulla-startup-download-status,
:global(.theme-noir) .sulla-startup-percent { color: var(--nx-read-4); font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace; }
:global(.theme-noir) .sulla-startup-download { border: 0; border-radius: 14px; background: color-mix(in srgb, var(--nx-hair-strong) 457.1429%, transparent); box-shadow: inset 0 0 0 1px var(--nx-hair); }
:global(.theme-noir) .sulla-startup-track {
  position: relative;
  height: 8px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-surface-alt) 128.2051%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-hair-strong) 160%, transparent), 0 0 22px color-mix(in srgb, var(--nx-accent) 1250%, transparent);
}
:global(.theme-noir) .sulla-startup-fill {
  position: relative;
  overflow: hidden;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--nx-accent), var(--nx-accent-2));
  box-shadow: 0 0 14px color-mix(in srgb, var(--nx-accent-2) 200%, transparent);
}
:global(.theme-noir) .sulla-startup-fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, transparent 25%, color-mix(in srgb, var(--nx-read-1) 166.6667%, transparent) 50%, transparent 75%);
  transform: translateX(-100%);
  animation: startup-noir-shimmer 1.7s ease-in-out infinite;
}
@keyframes startup-noir-enter { from { opacity: 0; transform: translateY(8px) scale(.98); filter: blur(8px); } to { opacity: 1; transform: none; filter: none; } }
@keyframes startup-noir-shimmer { to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) {
  :global(.theme-noir) .sulla-startup-card,
  :global(.theme-noir) .sulla-startup-fill::after,
  :global(.theme-noir) .sulla-progress-indeterminate { animation: none; }
}
</style>
