<template>
  <div
    class="td-dashboard"
    :class="{ dark: isDark }"
  >
    <div class="td-scroll">
      <!-- Auto-training toggle notice -->
      <div
        class="td-notice"
        :class="{ dark: isDark, enabled: autoTrainEnabled, disabled: !autoTrainEnabled }"
      >
        <div class="td-notice-content">
          <div class="td-notice-icon">
            <svg
              v-if="autoTrainEnabled"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <svg
              v-else
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle
                cx="12"
                cy="12"
                r="10"
              />
              <line
                x1="4.93"
                y1="4.93"
                x2="19.07"
                y2="19.07"
              />
            </svg>
          </div>
          <div class="td-notice-text">
            <div class="td-notice-title">
              {{ autoTrainEnabled ? 'Automatic Training Enabled' : 'Automatic Training Disabled' }}
            </div>
            <div class="td-notice-desc">
              <template v-if="autoTrainEnabled">
                Sulla is configured to automatically train on your conversations. This happens on a nightly schedule
                with no manual configuration required beyond installing the training system.
              </template>
              <template v-else>
                Any scheduled training will not run. All training must be done manually through the
                Create Training Data and Train Model wizards.
              </template>
            </div>
          </div>
        </div>
        <label
          class="td-toggle"
          :class="{ dark: isDark }"
        >
          <input
            type="checkbox"
            :checked="autoTrainEnabled"
            @change="toggleAutoTrain"
          >
          <span class="td-toggle-slider" />
        </label>
      </div>

      <!-- Schedule info -->
      <div class="td-info-cards">
        <div
          class="td-card"
          :class="{ dark: isDark }"
        >
          <div class="td-card-label">
            Scheduled For
          </div>
          <div class="td-card-value">
            <template v-if="autoTrainEnabled && scheduleHour != null">
              {{ formatTime(scheduleHour, scheduleMinute) }}
            </template>
            <template v-else>
              <span class="td-muted">Not scheduled</span>
            </template>
          </div>
        </div>
        <div
          class="td-card"
          :class="{ dark: isDark }"
        >
          <div class="td-card-label">
            Last Run
          </div>
          <div class="td-card-value">
            <template v-if="lastRun">
              {{ formatDate(lastRun.createdAt) }}
            </template>
            <template v-else>
              <span class="td-muted">Never</span>
            </template>
          </div>
        </div>
        <div
          class="td-card"
          :class="{ dark: isDark }"
        >
          <div class="td-card-label">
            Duration
          </div>
          <div class="td-card-value">
            <template v-if="lastRun?.durationMs">
              {{ formatDuration(lastRun.durationMs) }}
            </template>
            <template v-else>
              <span class="td-muted">--</span>
            </template>
          </div>
        </div>
      </div>

      <!-- Quick action -->
      <div
        class="td-action-bar"
        :class="{ dark: isDark }"
      >
        <div class="td-action-row">
          <button
            class="td-btn-primary"
            :disabled="trainingNow || !autoTrainEnabled"
            @click="trainConversationsNow"
          >
            <span
              v-if="trainingNow"
              class="td-btn-spinner"
            />
            <svg
              v-else
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            {{ trainingNow ? 'Training...' : 'Train on Conversations Now' }}
          </button>
          <p
            v-if="!autoTrainEnabled"
            class="td-action-hint"
          >
            Enable automatic training above to use this.
          </p>
        </div>
        <!-- Progress bar -->
        <div
          v-if="trainingNow || trainingProgress > 0"
          class="td-progress-wrap"
          :class="{ dark: isDark }"
        >
          <div class="td-progress-bar">
            <div
              class="td-progress-fill"
              :class="{ complete: trainingProgress >= 100 }"
              :style="{ width: trainingProgress + '%' }"
            />
          </div>
          <div class="td-progress-info">
            <span class="td-progress-phase">{{ trainingPhase }}</span>
            <span class="td-progress-pct">{{ Math.round(trainingProgress) }}%</span>
          </div>
        </div>
      </div>

      <!-- Scheduled training configs -->
      <div class="td-section">
        <h3
          class="td-section-title"
          :class="{ dark: isDark }"
        >
          Scheduled Training Configs
        </h3>
        <div
          v-if="scheduledConfigs.length === 0"
          class="td-empty"
          :class="{ dark: isDark }"
        >
          No scheduled configs yet. Use "Schedule Nightly Training" in the Create Training Data wizard to add one.
        </div>
        <div
          v-else
          class="td-configs-list"
        >
          <div
            v-for="cfg in scheduledConfigs"
            :key="cfg.id"
            class="td-config"
            :class="{ dark: isDark }"
          >
            <div class="td-config-details">
              <div class="td-config-name">
                {{ cfg.name }}
              </div>
              <div class="td-config-meta">
                <span class="td-config-source">{{ cfg.source }}</span>
                <span class="td-config-model">{{ cfg.modelKey }}</span>
                <span
                  v-if="cfg.outputFilename"
                  class="td-config-output"
                >{{ cfg.outputFilename }}.jsonl</span>
                <span
                  v-if="cfg.files?.length"
                  class="td-config-files"
                >{{ cfg.files.length }} file{{ cfg.files.length !== 1 ? 's' : '' }}</span>
              </div>
            </div>
            <button
              class="td-config-remove"
              :class="{ dark: isDark }"
              title="Remove"
              @click="removeConfig(cfg.id)"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <line
                  x1="18"
                  y1="6"
                  x2="6"
                  y2="18"
                />
                <line
                  x1="6"
                  y1="6"
                  x2="18"
                  y2="18"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Training runs history -->
      <div class="td-section">
        <h3
          class="td-section-title"
          :class="{ dark: isDark }"
        >
          Training Runs
        </h3>
        <div
          v-if="loading"
          class="td-loading"
        >
          Loading history...
        </div>
        <div
          v-else-if="runs.length === 0"
          class="td-empty"
          :class="{ dark: isDark }"
        >
          No training runs yet. Training will appear here once the system has processed conversations.
        </div>
        <div
          v-else
          class="td-runs-list"
        >
          <div
            v-for="run in runs"
            :key="run.filename"
            class="td-run clickable"
            :class="{ dark: isDark }"
            @click="openRunLog(run)"
          >
            <div class="td-run-status">
              <span
                class="td-status-dot"
                :class="run.status"
              />
            </div>
            <div class="td-run-details">
              <div class="td-run-date">
                {{ formatDate(run.createdAt) }}
              </div>
              <div class="td-run-meta">
                <span
                  v-if="run.model"
                  class="td-run-model"
                >{{ run.model }}</span>
                <span
                  v-if="run.durationMs"
                  class="td-run-duration"
                >{{ formatDuration(run.durationMs) }}</span>
                <span
                  v-if="run.conversationsProcessed"
                  class="td-run-convos"
                >
                  {{ run.conversationsProcessed }} conversation{{ run.conversationsProcessed !== 1 ? 's' : '' }}
                </span>
              </div>
            </div>
            <div
              class="td-run-status-label"
              :class="run.status"
            >
              {{ run.status === 'completed' ? 'Completed' : run.status === 'running' ? 'Running' : 'Failed' }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted, onBeforeUnmount } from 'vue';

const { ipcRenderer } = require('electron');

interface TrainingRun {
  filename:                string;
  size:                    number;
  createdAt:               string;
  modifiedAt:              string;
  model?:                  string;
  durationMs?:             number;
  conversationsProcessed?: number;
  status:                  'completed' | 'running' | 'failed';
}

export default defineComponent({
  name:  'TrainingDashboard',
  props: {
    isDark: { type: Boolean, default: false },
  },

  emits: ['open-training-log'],

  setup(_props, { emit }) {
    const autoTrainEnabled = ref(false);
    const scheduleHour = ref<number | null>(null);
    const scheduleMinute = ref<number | null>(null);
    const runs = ref<TrainingRun[]>([]);
    const loading = ref(true);
    const trainingNow = ref(false);
    const trainingPhase = ref('');
    const trainingProgress = ref(0);
    const activeLogFilename = ref('');
    const scheduledConfigs = ref<any[]>([]);

    const lastRun = computed(() => {
      return runs.value.find(r => r.status === 'completed') || runs.value[0] || null;
    });

    async function loadSchedule() {
      try {
        const schedule = await ipcRenderer.invoke('training-schedule-get');
        autoTrainEnabled.value = schedule.enabled;
        scheduleHour.value = schedule.hour;
        scheduleMinute.value = schedule.minute;
      } catch {
        // Not ready
      }
    }

    async function loadHistory() {
      loading.value = true;
      try {
        runs.value = await ipcRenderer.invoke('training-history');
      } catch {
        runs.value = [];
      } finally {
        loading.value = false;
      }
    }

    async function toggleAutoTrain() {
      const newEnabled = !autoTrainEnabled.value;
      autoTrainEnabled.value = newEnabled;
      try {
        await ipcRenderer.invoke('training-schedule-set', {
          enabled: newEnabled,
          hour:    scheduleHour.value ?? 2,
          minute:  scheduleMinute.value ?? 0,
        });
      } catch (err) {
        console.error('[TrainingDashboard] Failed to toggle schedule:', err);
        autoTrainEnabled.value = !newEnabled; // revert
      }
    }

    function formatTime(hour: number, minute: number): string {
      const h = hour % 12 || 12;
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const m = String(minute).padStart(2, '0');
      return `${ h }:${ m } ${ ampm }`;
    }

    function formatDate(iso: string): string {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, {
        month:  'short',
        day:    'numeric',
        year:   'numeric',
        hour:   'numeric',
        minute: '2-digit',
      });
    }

    function formatDuration(ms: number): string {
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return `${ sec }s`;
      const min = Math.floor(sec / 60);
      const remSec = sec % 60;
      if (min < 60) return `${ min }m ${ remSec }s`;
      const hr = Math.floor(min / 60);
      const remMin = min % 60;
      return `${ hr }h ${ remMin }m`;
    }

    function openRunLog(run: TrainingRun) {
      emit('open-training-log', run.filename);
    }

    async function loadConfigs() {
      try {
        scheduledConfigs.value = await ipcRenderer.invoke('training-scheduled-configs-list');
      } catch {
        scheduledConfigs.value = [];
      }
    }

    async function removeConfig(id: string) {
      try {
        await ipcRenderer.invoke('training-scheduled-configs-remove', id);
        scheduledConfigs.value = scheduledConfigs.value.filter(c => c.id !== id);
      } catch (err) {
        console.error('[TrainingDashboard] Failed to remove config:', err);
      }
    }

    function handleRunProgress(_event: any, data: { phase: string; progress: number; logFilename: string }) {
      trainingPhase.value = data.phase;
      trainingProgress.value = data.progress;
      if (data.progress >= 100) {
        setTimeout(async() => {
          trainingNow.value = false;
          await loadHistory();
          setTimeout(() => {
            trainingPhase.value = '';
            trainingProgress.value = 0;
          }, 3000);
        }, 500);
      }
    }

    async function trainConversationsNow() {
      trainingNow.value = true;
      trainingPhase.value = 'Starting...';
      trainingProgress.value = 0;
      try {
        const result = await ipcRenderer.invoke('training-train-conversations-now');
        if (result?.logFilename) {
          activeLogFilename.value = result.logFilename;
          emit('open-training-log', result.logFilename);
        }
      } catch (err) {
        console.error('[TrainingDashboard] Train conversations failed:', err);
        trainingNow.value = false;
        trainingPhase.value = '';
        trainingProgress.value = 0;
      }
    }

    onMounted(async() => {
      ipcRenderer.on('training-run-progress' as any, handleRunProgress);
      // Restore progress state if training is already running (e.g. after page navigation)
      try {
        const status = await ipcRenderer.invoke('training-status');
        if (status.running) {
          trainingNow.value = true;
          trainingPhase.value = status.phase || 'Training in progress...';
          trainingProgress.value = status.progress || 0;
          if (status.logFilename) activeLogFilename.value = status.logFilename;
        }
      } catch { /* ok */ }
      await Promise.all([loadSchedule(), loadHistory(), loadConfigs()]);
    });

    onBeforeUnmount(() => {
      ipcRenderer.removeListener('training-run-progress' as any, handleRunProgress);
    });

    return {
      autoTrainEnabled,
      scheduleHour,
      scheduleMinute,
      runs,
      loading,
      lastRun,
      trainingNow,
      trainingPhase,
      trainingProgress,
      activeLogFilename,
      scheduledConfigs,
      toggleAutoTrain,
      trainConversationsNow,
      openRunLog,
      loadConfigs,
      removeConfig,
      formatTime,
      formatDate,
      formatDuration,
    };
  },
});
</script>

<style>
.td-dashboard {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.td-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

/* Notice banner */
.td-notice {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px;
  border-radius: 8px;
  margin-bottom: 24px;
  transition: background 0.2s, border-color 0.2s;
}
.td-notice.enabled {
  background: var(--bg-success);
  border: 1px solid var(--border-success);
}
.td-notice.disabled {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
}
.td-notice-content {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  flex: 1;
}
.td-notice-icon {
  flex-shrink: 0;
  margin-top: 2px;
}
.td-notice.enabled .td-notice-icon {
  color: var(--text-success);
}
.td-notice.disabled .td-notice-icon {
  color: var(--text-muted);
}
.td-notice-title {
  font-size: var(--fs-body);
  font-weight: var(--weight-bold);
  margin-bottom: 4px;
}
.td-notice.enabled .td-notice-title {
  color: var(--text-success);
}
.td-notice.disabled .td-notice-title {
  color: var(--text-secondary);
}
.td-notice-desc {
  font-size: var(--fs-code);
  line-height: 1.6;
}
.td-notice.enabled .td-notice-desc {
  color: var(--text-success);
}
.td-notice.disabled .td-notice-desc {
  color: var(--text-muted);
}

/* Toggle switch */
.td-toggle {
  position: relative;
  flex-shrink: 0;
  width: 44px;
  height: 24px;
  cursor: pointer;
  margin-top: 2px;
}
.td-toggle input {
  opacity: 0;
  width: 0;
  height: 0;
  position: absolute;
}
.td-toggle-slider {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  border-radius: 12px;
  background: var(--bg-surface-hover);
  transition: background 0.2s;
}
.td-toggle input:checked + .td-toggle-slider {
  background: var(--status-success);
}
.td-toggle-slider::before {
  content: '';
  position: absolute;
  width: 18px;
  height: 18px;
  left: 3px;
  top: 3px;
  border-radius: 50%;
  background: var(--bg-surface);
  transition: transform 0.2s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}
.td-toggle input:checked + .td-toggle-slider::before {
  transform: translateX(20px);
}

/* Info cards */
.td-info-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 24px;
}
.td-card {
  padding: 14px 16px;
  border-radius: 8px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
}
.td-card-label {
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
  color: var(--text-muted);
  margin-bottom: 6px;
}
.td-card-value {
  font-size: var(--fs-body);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}
.td-muted {
  color: var(--text-muted);
  font-weight: var(--weight-normal);
}

/* Section */
.td-section {
  margin-bottom: 24px;
}
.td-section-title {
  font-size: var(--fs-code);
  font-weight: var(--weight-bold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
  color: var(--text-secondary);
  margin: 0 0 12px 0;
}
.td-section-title.dark {
  color: var(--text-muted);
}

.td-loading {
  font-size: var(--fs-code);
  color: var(--text-muted);
  padding: 16px 0;
}

.td-empty {
  font-size: var(--fs-code);
  color: var(--text-muted);
  padding: 24px 16px;
  text-align: center;
  border-radius: 8px;
  background: var(--bg-surface);
  border: 1px dashed var(--border-default);
}

/* Runs list */
.td-runs-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border-default);
}
.td-run {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--bg-page);
  transition: background 0.1s;
}
.td-run:hover {
  background: var(--bg-surface);
}
.td-run + .td-run {
  border-top: 1px solid var(--border-subtle);
}

.td-run-status {
  flex-shrink: 0;
}
.td-status-dot {
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.td-status-dot.completed {
  background: var(--status-success);
}
.td-status-dot.running {
  background: var(--accent-primary);
  animation: td-pulse 1.5s ease-in-out infinite;
}
.td-status-dot.failed {
  background: var(--status-error);
}
@keyframes td-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.td-run-details {
  flex: 1;
  min-width: 0;
}
.td-run-date {
  font-size: var(--fs-code);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
}
.td-run-meta {
  display: flex;
  gap: 12px;
  margin-top: 2px;
  font-size: var(--fs-code);
  color: var(--text-muted);
}
.td-run-model {
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
}

.td-run-status-label {
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-bold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
  padding: 2px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}
.td-run-status-label.completed {
  background: var(--bg-success);
  color: var(--text-success);
}
.td-run-status-label.running {
  background: var(--bg-info);
  color: var(--text-info);
}
.td-run-status-label.failed {
  background: var(--bg-error);
  color: var(--text-error);
}

/* Action bar */
.td-action-bar {
  margin-bottom: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.td-action-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

/* Progress bar */
.td-progress-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.td-progress-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-surface-hover);
  overflow: hidden;
}
.td-progress-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--accent-primary);
  transition: width 0.4s ease;
}
.td-progress-fill.complete {
  background: var(--status-success);
}
.td-progress-info {
  display: flex;
  justify-content: space-between;
  font-size: var(--fs-body-sm);
  color: var(--text-secondary);
}
.td-progress-phase {
  font-weight: var(--weight-semibold);
}
.td-progress-pct {
  font-variant-numeric: tabular-nums;
}

/* Clickable runs */
.td-run.clickable {
  cursor: pointer;
}
.td-btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border: none;
  border-radius: 8px;
  font-size: var(--fs-code);
  font-weight: var(--weight-bold);
  cursor: pointer;
  background: var(--accent-primary);
  color: var(--text-on-accent);
  transition: background 0.15s, opacity 0.15s;
}
.td-btn-primary:hover:not(:disabled) {
  background: var(--accent-primary-hover);
}
.td-btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.td-btn-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-default);
  border-top-color: var(--text-on-accent);
  border-radius: 50%;
  animation: td-spin 0.6s linear infinite;
}
@keyframes td-spin {
  to { transform: rotate(360deg); }
}
.td-action-hint {
  font-size: var(--fs-code);
  color: var(--text-muted);
  margin: 0;
}

/* Configs list */
.td-configs-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border-default);
}
.td-config {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  background: var(--bg-page);
}
.td-config + .td-config {
  border-top: 1px solid var(--border-subtle);
}
.td-config-details {
  flex: 1;
  min-width: 0;
}
.td-config-name {
  font-size: var(--fs-code);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
}
.td-config-meta {
  display: flex;
  gap: 12px;
  margin-top: 2px;
  font-size: var(--fs-code);
  color: var(--text-muted);
}
.td-config-source {
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
}
.td-config-model {
  font-weight: var(--weight-medium);
}
.td-config-output {
  font-style: italic;
}
.td-config-files {
  font-weight: var(--weight-medium);
}
.td-config-remove {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.td-config-remove:hover {
  background: var(--bg-error);
  color: var(--text-error);
}
</style>
