<template>
  <div class="training-pane" :class="{ dark: isDark }">
    <!-- Loading -->
    <div v-if="!installChecked" class="tp-loading">
      <span class="tp-loading-text">Checking installation…</span>
    </div>

    <div v-else-if="!envInstalled" class="tp-install-screen">
      <!-- Before install starts: centered prompt -->
      <div v-if="!envInstalling && !installError" class="tp-install-prompt">
        <div class="tp-install-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </div>
        <h2 class="tp-install-title">Install Training Setup</h2>
        <p class="tp-install-desc">
          This will install the Python training dependencies and download the
          <strong>{{ installModelName }}</strong> model<span v-if="installModelRepo"> ({{ installModelRepo }})</span>.
          This may take several minutes depending on your connection speed.
        </p>

        <!-- Disk space info -->
        <div class="tp-disk-info" :class="{ insufficient: !hasEnoughSpace }">
          <div class="tp-disk-row">
            <span class="tp-disk-label">Required space:</span>
            <span class="tp-disk-value">{{ formatBytes(requiredBytes) }}</span>
          </div>
          <div class="tp-disk-row">
            <span class="tp-disk-label">Available space:</span>
            <span class="tp-disk-value">{{ formatBytes(availableBytes) }}</span>
          </div>
          <div v-if="!hasEnoughSpace" class="tp-disk-warning">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            Not enough disk space. Free up at least {{ formatBytes(requiredBytes - availableBytes) }} to continue.
          </div>
        </div>

        <button
          class="tp-btn-install"
          :class="{ disabled: !hasEnoughSpace }"
          :disabled="!hasEnoughSpace"
          @click="startInstall"
        >
          Install Training Setup
        </button>
      </div>

      <!-- During install: progress + logs -->
      <div v-if="envInstalling" class="tp-install-progress">
        <h2 class="tp-progress-title">Installing Training Environment</h2>
        <p class="tp-progress-desc">{{ installDescription || 'Starting...' }}</p>

        <!-- Progress bar -->
        <div class="tp-progress-track">
          <div class="tp-progress-fill" :style="{ width: progressPct + '%' }"/>
        </div>
        <div class="tp-progress-labels">
          <span>{{ installPhase === 'model' ? 'Downloading model' : 'Installing dependencies' }}</span>
          <span>{{ progressPct }}%</span>
        </div>

        <!-- File download detail -->
        <div v-if="installPhase === 'model' && installFileName" class="tp-file-detail">
          <span>{{ installFileName }}</span>
          <span v-if="downloadDetail" class="tp-file-size">{{ downloadDetail }}</span>
        </div>

        <!-- Live log output -->
        <div class="tp-log-box">
          <pre class="tp-log-output" ref="logOutputRef">{{ installLogContent || 'Waiting for output…' }}</pre>
        </div>
      </div>

      <!-- Error state -->
      <div v-if="!envInstalling && installError" class="tp-install-prompt">
        <div class="tp-error-box">
          <strong>Installation failed:</strong> {{ installError }}
        </div>
        <button class="tp-btn-install" @click="startInstall">
          Retry Installation
        </button>
        <div v-if="installLogContent" class="tp-log-box tp-log-error">
          <pre class="tp-log-output">{{ installLogContent }}</pre>
        </div>
      </div>
    </div>

    <!-- Post-install: dashboard + file table -->
    <div v-else class="tp-dashboard">
      <!-- Training data scale indicator -->
      <div class="tp-scale" :class="{ dark: isDark }">
        <div class="tp-scale-header">
          <span class="tp-scale-label">Training Data Scale</span>
          <span class="tp-scale-badge" :class="dataScale">{{ dataScaleLabel }}</span>
        </div>
        <div class="tp-scale-bar">
          <div class="tp-scale-fill" :class="dataScale" :style="{ width: dataScalePct + '%' }" />
          <div class="tp-scale-marks">
            <span class="tp-scale-mark" :style="{ left: '0%' }">0</span>
            <span class="tp-scale-mark" :style="{ left: '10%' }">100</span>
            <span class="tp-scale-mark" :style="{ left: '50%' }">500</span>
            <span class="tp-scale-mark" :style="{ left: '100%' }">1000+</span>
          </div>
        </div>
        <div class="tp-scale-detail">
          {{ totalExamples }} training examples across {{ dataFiles.length }} file{{ dataFiles.length !== 1 ? 's' : '' }}
          ({{ formatBytes(totalDataSize) }})
        </div>
      </div>

      <!-- Stats cards row -->
      <div class="tp-cards">
        <div class="tp-card" :class="{ dark: isDark }">
          <div class="tp-card-label">Total Examples</div>
          <div class="tp-card-value">{{ totalExamples }}</div>
          <div class="tp-card-sub">{{ dataScaleLabel }} for LoRA</div>
        </div>
        <div class="tp-card" :class="{ dark: isDark }">
          <div class="tp-card-label">Document Knowledge</div>
          <div class="tp-card-value">{{ docExamples }}</div>
          <div class="tp-card-sub">{{ docFiles.length }} file{{ docFiles.length !== 1 ? 's' : '' }}</div>
        </div>
        <div class="tp-card" :class="{ dark: isDark }">
          <div class="tp-card-label">Session Data</div>
          <div class="tp-card-value">{{ sessionExamples }}</div>
          <div class="tp-card-sub">{{ sessionFiles.length }} file{{ sessionFiles.length !== 1 ? 's' : '' }}</div>
        </div>
        <div class="tp-card" :class="{ dark: isDark }">
          <div class="tp-card-label">Available Disk</div>
          <div class="tp-card-value">{{ formatBytes(availableBytes) }}</div>
          <div class="tp-card-sub">{{ installModelName }}</div>
        </div>
      </div>

      <!-- Actions bar -->
      <div class="tp-actions-bar" :class="{ dark: isDark }">
        <div class="tp-installed-badge">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          Environment ready
        </div>
        <button class="tp-btn-refresh" :class="{ dark: isDark }" title="Refresh" @click="loadDataFiles">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </button>
      </div>

      <!-- JSONL file table -->
      <div class="tp-table-wrapper">
        <div v-if="dataFilesLoading" class="tp-table-status">Loading training data…</div>
        <div v-else-if="dataFiles.length === 0" class="tp-table-empty">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.3">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
          </svg>
          <p>No training data yet</p>
          <p class="tp-table-empty-hint">Select files in the sidebar and prepare them for training</p>
        </div>
        <table v-else class="tp-table" :class="{ dark: isDark }">
          <thead>
            <tr>
              <th @click="sortBy('filename')">File <span v-if="sortKey === 'filename'" class="tp-sort-arrow">{{ sortDir === 'asc' ? '\u25B2' : '\u25BC' }}</span></th>
              <th @click="sortBy('examples')">Examples <span v-if="sortKey === 'examples'" class="tp-sort-arrow">{{ sortDir === 'asc' ? '\u25B2' : '\u25BC' }}</span></th>
              <th @click="sortBy('source')">Source <span v-if="sortKey === 'source'" class="tp-sort-arrow">{{ sortDir === 'asc' ? '\u25B2' : '\u25BC' }}</span></th>
              <th @click="sortBy('size')">Size <span v-if="sortKey === 'size'" class="tp-sort-arrow">{{ sortDir === 'asc' ? '\u25B2' : '\u25BC' }}</span></th>
              <th @click="sortBy('modifiedAt')">Modified <span v-if="sortKey === 'modifiedAt'" class="tp-sort-arrow">{{ sortDir === 'asc' ? '\u25B2' : '\u25BC' }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in sortedDataFiles" :key="f.path">
              <td class="tp-cell-file" :title="f.path">{{ f.filename }}</td>
              <td class="tp-cell-examples">{{ f.examples }}</td>
              <td>
                <span class="tp-badge" :class="f.source">{{ sourceLabel(f.source) }}</span>
              </td>
              <td class="tp-cell-size">{{ formatBytes(f.size) }}</td>
              <td class="tp-cell-date">{{ formatDate(f.modifiedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { ipcRenderer } from 'electron';

export default defineComponent({
  name: 'TrainingPane',

  props: {
    isDark: { type: Boolean, default: false },
  },

  emits: ['close', 'env-ready'],

  setup(_props, { emit }) {
    const installChecked = ref(false);
    const envInstalled = ref(false);
    const envInstalling = ref(false);
    const installError = ref('');
    const installPhase = ref('');
    const installDescription = ref('');
    const installCurrent = ref(0);
    const installMax = ref(100);
    const installFileName = ref('');
    const installBytesReceived = ref(0);
    const installBytesTotal = ref(0);
    const installModelName = ref('');
    const installModelRepo = ref('');
    const installLogContent = ref('');
    const installLogFile = ref('');
    const logOutputRef = ref<HTMLElement | null>(null);

    // Disk space
    const requiredBytes = ref(0);
    const availableBytes = ref(0);

    // Training data files
    interface DataFile {
      filename: string;
      path: string;
      size: number;
      modifiedAt: string;
      examples: number;
      source: 'sessions' | 'documents' | 'processed';
    }
    const dataFiles = ref<DataFile[]>([]);
    const dataFilesLoading = ref(false);
    const sortKey = ref<'filename' | 'examples' | 'source' | 'size' | 'modifiedAt'>('modifiedAt');
    const sortDir = ref<'asc' | 'desc'>('desc');

    const docFiles = computed(() => dataFiles.value.filter(f => f.source === 'documents'));
    const sessionFiles = computed(() => dataFiles.value.filter(f => f.source === 'sessions' || f.source === 'processed'));
    const totalExamples = computed(() => dataFiles.value.reduce((s, f) => s + f.examples, 0));
    const docExamples = computed(() => docFiles.value.reduce((s, f) => s + f.examples, 0));
    const sessionExamples = computed(() => sessionFiles.value.reduce((s, f) => s + f.examples, 0));
    const totalDataSize = computed(() => dataFiles.value.reduce((s, f) => s + f.size, 0));

    // Training data quality scale: <50 poor, 50-200 fair, 200-500 good, 500+ great
    const dataScale = computed(() => {
      const n = totalExamples.value;
      if (n < 50) return 'poor';
      if (n < 200) return 'fair';
      if (n < 500) return 'good';
      return 'great';
    });
    const dataScaleLabel = computed(() => {
      const labels: Record<string, string> = { poor: 'Poor', fair: 'Fair', good: 'Good', great: 'Great' };
      return labels[dataScale.value];
    });
    const dataScalePct = computed(() => {
      const n = totalExamples.value;
      if (n >= 1000) return 100;
      // Non-linear scale: 0-100 maps to 0-10%, 100-500 maps to 10-50%, 500-1000 maps to 50-100%
      if (n <= 100) return (n / 100) * 10;
      if (n <= 500) return 10 + ((n - 100) / 400) * 40;
      return 50 + ((n - 500) / 500) * 50;
    });

    const sortedDataFiles = computed(() => {
      const key = sortKey.value;
      const dir = sortDir.value === 'asc' ? 1 : -1;
      return [...dataFiles.value].sort((a, b) => {
        const av = a[key], bv = b[key];
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
    });

    function sortBy(key: 'filename' | 'examples' | 'source' | 'size' | 'modifiedAt') {
      if (sortKey.value === key) {
        sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey.value = key;
        sortDir.value = key === 'modifiedAt' || key === 'size' || key === 'examples' ? 'desc' : 'asc';
      }
    }

    function sourceLabel(source: string): string {
      const labels: Record<string, string> = { documents: 'Documents', sessions: 'Sessions', processed: 'Processed' };
      return labels[source] || source;
    }

    function formatDate(iso: string): string {
      try { return new Date(iso).toLocaleString(); } catch { return iso; }
    }

    async function loadDataFiles() {
      dataFilesLoading.value = true;
      try {
        dataFiles.value = await ipcRenderer.invoke('training-data-files');
      } catch (err) {
        console.error('Failed to load training data files:', err);
      } finally {
        dataFilesLoading.value = false;
      }
    }

    // Document processing queue
    interface DocQueueItem {
      file: string;
      status: 'queued' | 'processing' | 'ready' | 'skipped';
      pairs: number;
    }
    const docQueue = ref<DocQueueItem[]>([]);
    const docProcessingActive = ref(false);

    function handleDocProgress(_event: any, data: any) {
      if (data.phase === 'saving') {
        docProcessingActive.value = true;
        docQueue.value = [];
      } else if (data.phase === 'processing') {
        // A file is being processed - add or update it
        const file = data.file || '';
        const existing = docQueue.value.find(i => i.file === file);
        if (existing) {
          existing.status = 'processing';
        } else {
          docQueue.value.push({ file, status: 'processing', pairs: 0 });
        }
      } else if (data.phase === 'file-ok') {
        const file = data.file || '';
        const existing = docQueue.value.find(i => i.file === file);
        if (existing) {
          existing.status = 'ready';
          existing.pairs = data.pairs || 0;
        } else {
          docQueue.value.push({ file, status: 'ready', pairs: data.pairs || 0 });
        }
        loadDataFiles();
      } else if (data.phase === 'file-skip') {
        const file = data.file || '';
        const existing = docQueue.value.find(i => i.file === file);
        if (existing) {
          existing.status = 'skipped';
        } else {
          docQueue.value.push({ file, status: 'skipped', pairs: 0 });
        }
      } else if (data.phase === 'done') {
        docProcessingActive.value = false;
        loadDataFiles();
      } else if (data.phase === 'error') {
        docProcessingActive.value = false;
        console.error('[TrainingPane] Document processing error:', data.message);
      }
    }

    let installLogTimer: ReturnType<typeof setInterval> | null = null;

    const hasEnoughSpace = computed(() => {
      if (requiredBytes.value === 0) return true; // unknown requirement, allow
      return availableBytes.value >= requiredBytes.value;
    });

    const progressPct = computed(() => {
      if (installMax.value <= 0) return 0;
      return Math.min(100, Math.round((installCurrent.value / installMax.value) * 100));
    });

    const downloadDetail = computed(() => {
      if (installBytesTotal.value <= 0) return '';
      const pct = Math.round((installBytesReceived.value / installBytesTotal.value) * 100);
      const received = (installBytesReceived.value / (1024 * 1024)).toFixed(1);
      const total = (installBytesTotal.value / (1024 * 1024)).toFixed(1);
      return `${received} / ${total} MB (${pct}%)`;
    });

    function formatBytes(bytes: number): string {
      if (bytes <= 0) return '—';
      if (bytes < 1_000_000_000) {
        return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
      }
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }

    async function checkInstallStatus() {
      try {
        const status = await ipcRenderer.invoke('training-install-status');
        envInstalled.value = status.installed;
        envInstalling.value = status.installing;
        installError.value = status.error || '';
        installModelName.value = status.displayName || '';
        installModelRepo.value = status.trainingRepo || '';
        requiredBytes.value = status.requiredBytes ?? 0;
        availableBytes.value = status.availableBytes ?? 0;
        if (status.installed) {
          emit('env-ready');
          loadDataFiles();
        }
      } catch (err) {
        console.error('Failed to check install status:', err);
      } finally {
        installChecked.value = true;
      }
    }

    function handleInstallProgress(_event: any, data: any) {
      installPhase.value = data.phase || '';
      installDescription.value = data.description || '';
      installCurrent.value = data.current ?? 0;
      installMax.value = data.max ?? 100;
      installFileName.value = data.fileName || '';
      installBytesReceived.value = data.bytesReceived ?? 0;
      installBytesTotal.value = data.bytesTotal ?? 0;

      if (data.phase === 'done') {
        envInstalled.value = true;
        envInstalling.value = false;
        stopInstallLogPolling();
        emit('env-ready');
        loadDataFiles();
      } else if (data.phase === 'error') {
        envInstalling.value = false;
        installError.value = data.description || 'Installation failed';
        stopInstallLogPolling();
      }
    }

    async function startInstall() {
      envInstalling.value = true;
      installError.value = '';
      installPhase.value = 'deps';
      installDescription.value = 'Starting installation...';
      installCurrent.value = 0;
      installLogContent.value = '';

      try {
        const result = await ipcRenderer.invoke('training-install');
        installLogFile.value = result?.logFilename || '';
        if (installLogFile.value) {
          startInstallLogPolling();
        }
      } catch (err: any) {
        if (!installError.value) {
          installError.value = err?.message || 'Installation failed';
        }
        envInstalling.value = false;
      }
    }

    function startInstallLogPolling() {
      stopInstallLogPolling();
      installLogTimer = setInterval(async () => {
        if (!installLogFile.value) return;
        try {
          installLogContent.value = await ipcRenderer.invoke('training-log-read', installLogFile.value);
          nextTick(() => {
            if (logOutputRef.value) {
              const container = logOutputRef.value.parentElement;
              if (container) {
                container.scrollTop = container.scrollHeight;
              }
            }
          });
        } catch {
          // File may not exist yet
        }
      }, 2000);
    }

    function stopInstallLogPolling() {
      if (installLogTimer) {
        clearInterval(installLogTimer);
        installLogTimer = null;
      }
    }

    onMounted(async () => {
      await checkInstallStatus();
      ipcRenderer.on('training-install-progress' as any, handleInstallProgress);
      ipcRenderer.on('training-prepare-progress' as any, handleDocProgress);
    });

    onBeforeUnmount(() => {
      stopInstallLogPolling();
      ipcRenderer.removeListener('training-install-progress' as any, handleInstallProgress);
      ipcRenderer.removeListener('training-prepare-progress' as any, handleDocProgress);
    });

    return {
      installChecked,
      envInstalled,
      envInstalling,
      installError,
      installPhase,
      installDescription,
      installFileName,
      installModelName,
      installModelRepo,
      installLogContent,
      progressPct,
      downloadDetail,
      startInstall,
      logOutputRef,
      requiredBytes,
      availableBytes,
      hasEnoughSpace,
      formatBytes,
      dataFiles,
      dataFilesLoading,
      docFiles,
      sessionFiles,
      totalExamples,
      docExamples,
      sessionExamples,
      totalDataSize,
      dataScale,
      dataScaleLabel,
      dataScalePct,
      sortedDataFiles,
      sortKey,
      sortDir,
      sortBy,
      sourceLabel,
      formatDate,
      loadDataFiles,
      docQueue,
      docProcessingActive,
    };
  },
});
</script>

<style scoped>
.training-pane {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #ffffff;
  overflow-y: auto;
  padding: 2rem;
}
.training-pane.dark {
  background: #0f172a;
  color: #e2e8f0;
}

/* Loading state */
.tp-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
}
.tp-loading-text {
  font-size: 0.875rem;
  color: #94a3b8;
}

/* Install screen */
.tp-install-screen {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
}

/* Install prompt (pre-install and error) */
.tp-install-prompt {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  max-width: 28rem;
  gap: 0.75rem;
}
.tp-install-icon {
  color: #0284c7;
  margin-bottom: 0.5rem;
}
.dark .tp-install-icon {
  color: #38bdf8;
}
.tp-install-title {
  font-size: 1.125rem;
  font-weight: 600;
  color: #0f172a;
  margin: 0;
}
.dark .tp-install-title {
  color: #f1f5f9;
}
.tp-install-desc {
  font-size: 0.875rem;
  line-height: 1.5;
  color: #64748b;
  margin: 0;
}
.dark .tp-install-desc {
  color: #94a3b8;
}

/* Disk space info */
.tp-disk-info {
  width: 100%;
  padding: 0.75rem 1rem;
  border-radius: 0.5rem;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  font-size: 0.8125rem;
  text-align: left;
}
.dark .tp-disk-info {
  background: #1e293b;
  border-color: #334155;
}
.tp-disk-info.insufficient {
  border-color: #fca5a5;
  background: #fef2f2;
}
.dark .tp-disk-info.insufficient {
  border-color: #7f1d1d;
  background: #450a0a;
}
.tp-disk-row {
  display: flex;
  justify-content: space-between;
  padding: 0.2rem 0;
}
.tp-disk-label {
  color: #64748b;
}
.dark .tp-disk-label {
  color: #94a3b8;
}
.tp-disk-value {
  font-weight: 600;
  color: #0f172a;
}
.dark .tp-disk-value {
  color: #f1f5f9;
}
.tp-disk-warning {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid #fca5a5;
  color: #dc2626;
  font-size: 0.75rem;
  font-weight: 500;
}
.dark .tp-disk-warning {
  border-top-color: #7f1d1d;
  color: #fca5a5;
}

/* Install button */
.tp-btn-install {
  margin-top: 0.5rem;
  padding: 0.75rem 2rem;
  font-size: 1rem;
  font-weight: 600;
  border: none;
  border-radius: 0.5rem;
  background: #0284c7;
  color: #ffffff;
  cursor: pointer;
  transition: background 0.15s, transform 0.1s;
}
.tp-btn-install:hover:not(.disabled) {
  background: #0369a1;
  transform: translateY(-1px);
}
.tp-btn-install:active:not(.disabled) {
  transform: translateY(0);
}
.tp-btn-install.disabled {
  background: #94a3b8;
  cursor: not-allowed;
  opacity: 0.6;
}

/* Progress section */
.tp-install-progress {
  width: 100%;
  max-width: 48rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.tp-progress-title {
  font-size: 1rem;
  font-weight: 600;
  color: #0f172a;
  margin: 0;
}
.dark .tp-progress-title {
  color: #f1f5f9;
}
.tp-progress-desc {
  font-size: 0.875rem;
  color: #64748b;
  margin: 0;
}
.dark .tp-progress-desc {
  color: #94a3b8;
}
.tp-progress-track {
  width: 100%;
  height: 0.5rem;
  background: #e2e8f0;
  border-radius: 9999px;
  overflow: hidden;
}
.dark .tp-progress-track {
  background: #334155;
}
.tp-progress-fill {
  height: 100%;
  background: #0284c7;
  border-radius: 9999px;
  transition: width 0.3s ease;
}
.tp-progress-labels {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: #94a3b8;
}
.tp-file-detail {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 0.5rem;
  font-size: 0.875rem;
  color: #475569;
}
.dark .tp-file-detail {
  background: #1e293b;
  border-color: #334155;
  color: #94a3b8;
}
.tp-file-size {
  font-size: 0.75rem;
  color: #94a3b8;
}

/* Log box */
.tp-log-box {
  min-height: 12rem;
  max-height: 20rem;
  overflow-y: auto;
  border: 1px solid #e2e8f0;
  border-radius: 0.5rem;
  background: #1e293b;
}
.dark .tp-log-box {
  border-color: #334155;
  background: #0f172a;
}
.tp-log-output {
  margin: 0;
  padding: 1rem;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.75rem;
  line-height: 1.6;
  white-space: pre-wrap;
  color: #cbd5e1;
}
.tp-log-error {
  margin-top: 1rem;
}

/* Error box */
.tp-error-box {
  width: 100%;
  padding: 0.75rem 1rem;
  border-radius: 0.5rem;
  border: 1px solid #fca5a5;
  background: #fef2f2;
  color: #991b1b;
  font-size: 0.875rem;
  text-align: left;
}
.dark .tp-error-box {
  background: #450a0a;
  border-color: #7f1d1d;
  color: #fca5a5;
}

/* Post-install dashboard */
.tp-dashboard {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 1.5rem;
  gap: 1rem;
  overflow-y: auto;
}

/* Stats cards */
.tp-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.75rem;
}
@media (max-width: 800px) {
  .tp-cards { grid-template-columns: repeat(2, 1fr); }
}
.tp-card {
  padding: 1rem;
  border-radius: 0.5rem;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
}
.tp-card.dark {
  background: #1e293b;
  border-color: #334155;
}
.tp-card-label {
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  margin-bottom: 0.25rem;
}
.dark .tp-card-label {
  color: #94a3b8;
}
.tp-card-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: #0f172a;
  line-height: 1.2;
}
.dark .tp-card-value {
  color: #f1f5f9;
}
.tp-card-sub {
  font-size: 0.75rem;
  color: #94a3b8;
  margin-top: 0.125rem;
}

/* Actions bar */
.tp-actions-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0;
  border-bottom: 1px solid #e2e8f0;
}
.tp-actions-bar.dark {
  border-bottom-color: #334155;
}
.tp-installed-badge {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: #16a34a;
}
.dark .tp-installed-badge {
  color: #4ade80;
}
.tp-btn-refresh {
  background: none;
  border: none;
  padding: 4px;
  border-radius: 4px;
  cursor: pointer;
  color: #64748b;
  display: flex;
  align-items: center;
}
.tp-btn-refresh:hover {
  background: #f1f5f9;
  color: #0f172a;
}
.tp-btn-refresh.dark:hover {
  background: #334155;
  color: #e2e8f0;
}

/* File table */
.tp-table-wrapper {
  flex: 1;
  overflow-y: auto;
}
.tp-table-status {
  padding: 2rem;
  text-align: center;
  font-size: 0.875rem;
  color: #94a3b8;
}
.tp-table-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem 1rem;
  gap: 0.5rem;
  color: #94a3b8;
  font-size: 0.875rem;
}
.tp-table-empty-hint {
  font-size: 0.75rem;
  color: #64748b;
}
.tp-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}
.tp-table thead th {
  text-align: left;
  padding: 0.5rem 0.75rem;
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  border-bottom: 1px solid #e2e8f0;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.tp-table.dark thead th {
  color: #94a3b8;
  border-bottom-color: #334155;
}
.tp-table thead th:hover {
  color: #0f172a;
}
.tp-table.dark thead th:hover {
  color: #e2e8f0;
}
.tp-sort-arrow {
  font-size: 0.625rem;
  margin-left: 2px;
}
.tp-table tbody tr {
  border-bottom: 1px solid #f1f5f9;
}
.tp-table.dark tbody tr {
  border-bottom-color: #1e293b;
}
.tp-table tbody tr:hover {
  background: #f8fafc;
}
.tp-table.dark tbody tr:hover {
  background: #1e293b;
}
.tp-table td {
  padding: 0.5rem 0.75rem;
  color: #334155;
}
.tp-table.dark td {
  color: #cbd5e1;
}
.tp-cell-file {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
}
.tp-cell-size {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.tp-cell-date {
  white-space: nowrap;
  font-size: 0.75rem;
  color: #94a3b8;
}

/* Source badge */
.tp-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 600;
}
.tp-badge.documents {
  background: #dbeafe;
  color: #1e40af;
}
.dark .tp-badge.documents {
  background: #1e3a5f;
  color: #60a5fa;
}
.tp-badge.sessions {
  background: #fef3c7;
  color: #92400e;
}
.dark .tp-badge.sessions {
  background: #78350f;
  color: #fcd34d;
}
.tp-badge.processed {
  background: #dcfce7;
  color: #166534;
}
.dark .tp-badge.processed {
  background: #14532d;
  color: #4ade80;
}

.tp-cell-examples {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

/* Training data scale indicator */
.tp-scale {
  padding: 1rem;
  border: 1px solid #e2e8f0;
  border-radius: 0.5rem;
  background: #f8fafc;
}
.tp-scale.dark {
  background: #1e293b;
  border-color: #334155;
}
.tp-scale-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}
.tp-scale-label {
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
}
.dark .tp-scale-label {
  color: #94a3b8;
}
.tp-scale-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 700;
}
.tp-scale-badge.poor {
  background: #fef2f2;
  color: #dc2626;
}
.dark .tp-scale-badge.poor {
  background: #450a0a;
  color: #fca5a5;
}
.tp-scale-badge.fair {
  background: #fef3c7;
  color: #d97706;
}
.dark .tp-scale-badge.fair {
  background: #78350f;
  color: #fcd34d;
}
.tp-scale-badge.good {
  background: #dbeafe;
  color: #2563eb;
}
.dark .tp-scale-badge.good {
  background: #1e3a5f;
  color: #60a5fa;
}
.tp-scale-badge.great {
  background: #dcfce7;
  color: #16a34a;
}
.dark .tp-scale-badge.great {
  background: #14532d;
  color: #4ade80;
}
.tp-scale-bar {
  position: relative;
  height: 8px;
  background: #e2e8f0;
  border-radius: 9999px;
  overflow: hidden;
  margin-bottom: 1.25rem;
}
.dark .tp-scale-bar {
  background: #334155;
}
.tp-scale-fill {
  height: 100%;
  border-radius: 9999px;
  transition: width 0.4s ease;
}
.tp-scale-fill.poor {
  background: #ef4444;
}
.tp-scale-fill.fair {
  background: #f59e0b;
}
.tp-scale-fill.good {
  background: #3b82f6;
}
.tp-scale-fill.great {
  background: #22c55e;
}
.tp-scale-marks {
  position: absolute;
  top: 12px;
  left: 0;
  right: 0;
}
.tp-scale-mark {
  position: absolute;
  font-size: 0.625rem;
  color: #94a3b8;
  transform: translateX(-50%);
}
.tp-scale-detail {
  font-size: 0.75rem;
  color: #64748b;
}
.dark .tp-scale-detail {
  color: #94a3b8;
}

/* Document processing queue */
.tp-doc-queue {
  border: 1px solid #e2e8f0;
  border-radius: 0.5rem;
  background: #f8fafc;
  overflow: hidden;
}
.tp-doc-queue.dark {
  background: #1e293b;
  border-color: #334155;
}
.tp-doc-queue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #e2e8f0;
}
.tp-doc-queue.dark .tp-doc-queue-header {
  border-bottom-color: #334155;
}
.tp-doc-queue-title {
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
}
.dark .tp-doc-queue-title {
  color: #94a3b8;
}
.tp-doc-queue-status {
  font-size: 0.75rem;
  font-weight: 500;
  color: #0284c7;
}
.tp-doc-queue-status.done {
  color: #16a34a;
}
.tp-doc-queue-list {
  max-height: 16rem;
  overflow-y: auto;
}
.tp-doc-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  border-bottom: 1px solid #f1f5f9;
}
.tp-doc-item.dark {
  border-bottom-color: #1e293b;
}
.tp-doc-item:last-child {
  border-bottom: none;
}
.tp-doc-status-icon {
  display: flex;
  align-items: center;
  width: 14px;
  flex-shrink: 0;
}
.tp-doc-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #94a3b8;
}
.tp-doc-dot.queued {
  background: #fbbf24;
}
.tp-doc-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid #0284c7;
  border-top-color: transparent;
  border-radius: 50%;
  animation: tp-doc-spin 0.6s linear infinite;
}
@keyframes tp-doc-spin {
  to { transform: rotate(360deg); }
}
.tp-doc-filename {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  color: #334155;
}
.dark .tp-doc-filename {
  color: #cbd5e1;
}
.tp-doc-pairs {
  font-size: 0.6875rem;
  color: #64748b;
  flex-shrink: 0;
}
.tp-doc-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 9999px;
  font-size: 0.625rem;
  font-weight: 600;
  flex-shrink: 0;
}
.tp-doc-badge.queued {
  background: #fef3c7;
  color: #92400e;
}
.dark .tp-doc-badge.queued {
  background: #78350f;
  color: #fcd34d;
}
.tp-doc-badge.processing {
  background: #dbeafe;
  color: #1e40af;
}
.dark .tp-doc-badge.processing {
  background: #1e3a5f;
  color: #60a5fa;
}
.tp-doc-badge.ready {
  background: #dcfce7;
  color: #166534;
}
.dark .tp-doc-badge.ready {
  background: #14532d;
  color: #4ade80;
}
.tp-doc-badge.skipped {
  background: #f1f5f9;
  color: #64748b;
}
.dark .tp-doc-badge.skipped {
  background: #334155;
  color: #94a3b8;
}
</style>
