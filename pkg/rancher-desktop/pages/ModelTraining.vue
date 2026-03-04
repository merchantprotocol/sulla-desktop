<script lang="ts">
import { ipcRenderer } from 'electron';
import { defineComponent } from 'vue';

import './assets/AgentKnowledgeBase.css';
import PostHogTracker from '@pkg/components/PostHogTracker.vue';

const navItems = [
  { id: 'run', name: 'Run' },
  { id: 'docs', name: 'Document Processing' },
  { id: 'history', name: 'History' },
];

interface TrainingLogEntry {
  filename: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
}

export default defineComponent({
  name: 'model-training',

  components: { PostHogTracker },

  data() {
    return {
      navItems,
      currentNav:     'run' as string,

      // Install state
      installChecked:      false,
      envInstalled:        false,
      envInstalling:       false,
      installError:        '' as string,
      installPhase:        '' as string,
      installDescription:  '' as string,
      installCurrent:      0,
      installMax:          100,
      installFileName:     '' as string,
      installBytesReceived: 0,
      installBytesTotal:   0,
      installModelName:    '' as string,
      installModelRepo:    '' as string,
      installLogContent:   '' as string,
      installLogFile:      '' as string,
      installLogTimer:     null as ReturnType<typeof setInterval> | null,

      // Run page
      selectedModel:  '' as string,
      trainableModels: [] as Array<{ key: string; displayName: string; trainingRepo: string }>,
      isRunning:      false,
      runError:       '' as string,
      activeLogFile:  '' as string,
      activeLogContent: '' as string,
      logPollTimer:   null as ReturnType<typeof setInterval> | null,

      // Training sources
      sourceDocProcessing: false,
      sourceLoraTraining:  true,
      sourceSkills:        false,
      docsConfigExists:    false,

      // Schedule
      scheduleEnabled: false,
      scheduleHour:    2,
      scheduleMinute:  0,
      scheduleSaving:  false,

      // Document Processing — file tree
      treeRoot:          [] as Array<{ path: string; name: string; isDir: boolean; hasChildren: boolean; size: number; ext: string }>,
      treeChildren:      {} as Record<string, Array<{ path: string; name: string; isDir: boolean; hasChildren: boolean; size: number; ext: string }>>,
      expandedDirs:      new Set<string>() as Set<string>,
      selectedFolders:   [] as string[],
      selectedFiles:     [] as string[],
      docsFileTypes:     ['.txt', '.md', '.pdf', '.docx'] as string[],
      treeLoading:       '' as string,
      docsSaving:        false,
      docsSaved:         false,

      // History page
      historyLogs:     [] as TrainingLogEntry[],
      historyLoading:  false,
      selectedLogFile: '' as string,
      selectedLogContent: '' as string,
      logViewLoading:  false,
    };
  },

  computed: {
    scheduleTimeFormatted(): string {
      const h = String(this.scheduleHour).padStart(2, '0');
      const m = String(this.scheduleMinute).padStart(2, '0');
      return `${h}:${m}`;
    },
  },

  async mounted() {
    // Check install status first — if not installed, show install screen
    await this.checkInstallStatus();
    if (this.envInstalled) {
      await this.loadTrainableModels();
      await this.checkDocsConfigExists();
      await this.loadSchedule();
      await this.checkRunningStatus();
    }

    // Listen for install progress events from main process
    ipcRenderer.on('training-install-progress' as any, this.handleInstallProgress);
  },

  beforeUnmount() {
    this.stopLogPolling();
    this.stopInstallLogPolling();
    ipcRenderer.removeListener('training-install-progress' as any, this.handleInstallProgress);
  },

  methods: {
    // ── Install ──────────────────────────────────────────────────────

    async checkInstallStatus() {
      try {
        const status = await ipcRenderer.invoke('training-install-status');
        this.envInstalled = status.installed;
        this.envInstalling = status.installing;
        this.installError = status.error || '';
        this.installModelName = status.displayName || '';
        this.installModelRepo = status.trainingRepo || '';
      } catch (err) {
        console.error('Failed to check install status:', err);
      } finally {
        this.installChecked = true;
      }
    },

    handleInstallProgress(_event: any, data: any) {
      this.installPhase = data.phase || '';
      this.installDescription = data.description || '';
      this.installCurrent = data.current ?? 0;
      this.installMax = data.max ?? 100;
      this.installFileName = data.fileName || '';
      this.installBytesReceived = data.bytesReceived ?? 0;
      this.installBytesTotal = data.bytesTotal ?? 0;

      if (data.phase === 'done') {
        this.envInstalled = true;
        this.envInstalling = false;
        this.stopInstallLogPolling();
        // Load the main UI data now
        this.loadTrainableModels();
        this.checkDocsConfigExists();
        this.loadSchedule();
        this.checkRunningStatus();
      } else if (data.phase === 'error') {
        this.envInstalling = false;
        this.installError = data.description || 'Installation failed';
        this.stopInstallLogPolling();
      }
    },

    async startInstall() {
      this.envInstalling = true;
      this.installError = '';
      this.installPhase = 'deps';
      this.installDescription = 'Starting installation...';
      this.installCurrent = 0;
      this.installLogContent = '';

      try {
        const result = await ipcRenderer.invoke('training-install');
        this.installLogFile = result?.logFilename || '';
        // Start polling the install log for live output
        if (this.installLogFile) {
          this.startInstallLogPolling();
        }
      } catch (err: any) {
        // Error handling is done via the progress event (phase=error)
        // but also catch here for immediate invoke failures
        if (!this.installError) {
          this.installError = err?.message || 'Installation failed';
        }
        this.envInstalling = false;
      }
    },

    startInstallLogPolling() {
      this.stopInstallLogPolling();
      this.installLogTimer = setInterval(async() => {
        if (!this.installLogFile) return;
        try {
          this.installLogContent = await ipcRenderer.invoke('training-log-read', this.installLogFile);
        } catch {
          // File may not exist yet
        }
      }, 2000);
    },

    stopInstallLogPolling() {
      if (this.installLogTimer) {
        clearInterval(this.installLogTimer);
        this.installLogTimer = null;
      }
    },

    installProgressPct(): number {
      if (this.installMax <= 0) return 0;
      return Math.min(100, Math.round((this.installCurrent / this.installMax) * 100));
    },

    installDownloadPct(): string {
      if (this.installBytesTotal <= 0) return '';
      const pct = Math.round((this.installBytesReceived / this.installBytesTotal) * 100);
      const received = (this.installBytesReceived / (1024 * 1024)).toFixed(1);
      const total = (this.installBytesTotal / (1024 * 1024)).toFixed(1);
      return `${received} / ${total} MB (${pct}%)`;
    },

    // ── Navigation ───────────────────────────────────────────────────

    navClicked(navId: string) {
      this.currentNav = navId;
      if (navId === 'history') {
        this.loadHistory();
      } else if (navId === 'docs') {
        this.loadDocsConfig();
      }
    },

    async loadTrainableModels() {
      try {
        this.trainableModels = await ipcRenderer.invoke('training-models-downloaded');
        if (this.trainableModels.length > 0 && !this.selectedModel) {
          this.selectedModel = this.trainableModels[0].key;
        }
      } catch (err) {
        console.error('Failed to load trainable models:', err);
      }
    },

    async checkDocsConfigExists() {
      try {
        this.docsConfigExists = await ipcRenderer.invoke('training-docs-config-exists');
        if (!this.docsConfigExists) {
          this.sourceDocProcessing = false;
        }
      } catch {
        this.docsConfigExists = false;
        this.sourceDocProcessing = false;
      }
    },

    async checkRunningStatus() {
      try {
        const result = await ipcRenderer.invoke('training-status');
        this.isRunning = result.running;
        if (this.isRunning) {
          this.currentNav = 'active-run';
          this.startLogPolling();
        }
      } catch {
        // Ignore
      }
    },

    backToRun() {
      this.currentNav = 'run';
    },

    async startTraining() {
      if (!this.selectedModel) {
        this.runError = 'Please select a model first.';
        return;
      }
      this.runError = '';
      this.isRunning = true;
      this.activeLogContent = '';

      try {
        const sources = {
          documentProcessing: this.sourceDocProcessing,
          loraTraining:       this.sourceLoraTraining,
          skills:             this.sourceSkills,
        };
        const result = await ipcRenderer.invoke('training-run', this.selectedModel, sources);
        this.activeLogFile = result.logFilename;
        this.startLogPolling();
        this.currentNav = 'active-run';
      } catch (err: any) {
        this.runError = err?.message || 'Failed to start training';
        this.isRunning = false;
      }
    },

    startLogPolling() {
      this.stopLogPolling();
      this.logPollTimer = setInterval(async() => {
        if (!this.activeLogFile) {
          return;
        }
        try {
          this.activeLogContent = await ipcRenderer.invoke('training-log-read', this.activeLogFile);

          // Check if training is still running
          const status = await ipcRenderer.invoke('training-status');
          if (!status.running) {
            this.isRunning = false;
            this.stopLogPolling();
            // One final read
            this.activeLogContent = await ipcRenderer.invoke('training-log-read', this.activeLogFile);
          }
        } catch {
          // Log file may not exist yet
        }
      }, 2000);
    },

    stopLogPolling() {
      if (this.logPollTimer) {
        clearInterval(this.logPollTimer);
        this.logPollTimer = null;
      }
    },

    async loadSchedule() {
      try {
        const schedule = await ipcRenderer.invoke('training-schedule-get');
        this.scheduleEnabled = schedule.enabled;
        this.scheduleHour = schedule.hour;
        this.scheduleMinute = schedule.minute;
      } catch (err) {
        console.error('Failed to load schedule:', err);
      }
    },

    async saveSchedule() {
      this.scheduleSaving = true;
      try {
        await ipcRenderer.invoke('training-schedule-set', {
          enabled: this.scheduleEnabled,
          hour:    this.scheduleHour,
          minute:  this.scheduleMinute,
        });
      } catch (err) {
        console.error('Failed to save schedule:', err);
      } finally {
        this.scheduleSaving = false;
      }
    },

    async loadHistory() {
      this.historyLoading = true;
      try {
        this.historyLogs = await ipcRenderer.invoke('training-history');
      } catch (err) {
        console.error('Failed to load history:', err);
        this.historyLogs = [];
      } finally {
        this.historyLoading = false;
      }
    },

    async viewLog(filename: string) {
      this.selectedLogFile = filename;
      this.logViewLoading = true;
      this.selectedLogContent = '';
      try {
        this.selectedLogContent = await ipcRenderer.invoke('training-log-read', filename);
      } catch (err: any) {
        this.selectedLogContent = `Error loading log: ${err?.message || 'Unknown error'}`;
      } finally {
        this.logViewLoading = false;
      }
    },

    formatFileSize(bytes: number): string {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    },

    formatDate(isoString: string): string {
      try {
        return new Date(isoString).toLocaleString();
      } catch {
        return isoString;
      }
    },

    // ── Document Processing (file tree) ─────────────────────────────

    async loadDocsConfig() {
      this.docsSaved = false;
      try {
        const config = await ipcRenderer.invoke('training-docs-config-load');
        this.selectedFolders = config.folders;
        this.selectedFiles = config.files;
        this.docsFileTypes = config.fileTypes;
      } catch (err) {
        console.error('Failed to load docs config:', err);
      }
      // Load home directory as the tree root
      const os = require('os');
      await this.loadTreeDir(os.homedir(), true);
    },

    async loadTreeDir(dirPath: string, isRoot: boolean = false) {
      this.treeLoading = dirPath;
      try {
        const entries = await ipcRenderer.invoke('training-docs-list-dir', dirPath);
        if (isRoot) {
          this.treeRoot = entries;
        } else {
          this.treeChildren = { ...this.treeChildren, [dirPath]: entries };
        }
      } catch (err) {
        console.error('Failed to list directory:', dirPath, err);
      } finally {
        this.treeLoading = '';
      }
    },

    async toggleDir(dirPath: string) {
      if (this.expandedDirs.has(dirPath)) {
        this.expandedDirs.delete(dirPath);
        // Force reactivity
        this.expandedDirs = new Set(this.expandedDirs);
      } else {
        this.expandedDirs.add(dirPath);
        this.expandedDirs = new Set(this.expandedDirs);
        // Load children if not already loaded
        if (!this.treeChildren[dirPath]) {
          await this.loadTreeDir(dirPath);
        }
      }
    },

    toggleSelectFolder(folderPath: string) {
      const idx = this.selectedFolders.indexOf(folderPath);
      if (idx >= 0) {
        this.selectedFolders.splice(idx, 1);
      } else {
        this.selectedFolders.push(folderPath);
      }
      this.docsSaved = false;
    },

    toggleSelectFile(filePath: string) {
      const idx = this.selectedFiles.indexOf(filePath);
      if (idx >= 0) {
        this.selectedFiles.splice(idx, 1);
      } else {
        this.selectedFiles.push(filePath);
      }
      this.docsSaved = false;
    },

    isSelected(itemPath: string, isDir: boolean): boolean {
      if (isDir) {
        return this.selectedFolders.includes(itemPath);
      }
      return this.selectedFiles.includes(itemPath);
    },

    async saveDocsConfig() {
      this.docsSaving = true;
      try {
        await ipcRenderer.invoke(
          'training-docs-config-save',
          [...this.selectedFolders],
          [...this.selectedFiles],
          [...this.docsFileTypes],
        );
        this.docsSaved = true;
        this.docsConfigExists = true;
      } catch (err) {
        console.error('Failed to save docs config:', err);
      } finally {
        this.docsSaving = false;
      }
    },

    closeWindow() {
      window.close();
    },
  },
});
</script>

<template>
  <div class="mt-root">
    <PostHogTracker page-name="ModelTraining" />

    <!-- Header -->
    <div class="mt-header">
      <h1 class="text-xl font-semibold tracking-tight text-slate-900">
        Model Training
      </h1>
    </div>

    <!-- Install Screen — shown when training environment is not yet set up -->
    <div
      v-if="installChecked && !envInstalled"
      class="mt-install-screen"
    >
      <!-- Before install starts: centered button -->
      <div
        v-if="!envInstalling && !installError"
        class="mt-install-prompt"
      >
        <div class="mt-install-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </div>
        <h2 class="text-lg font-semibold text-slate-900">
          Install Training Setup
        </h2>
        <p class="mt-install-desc">
          This will install the Python training dependencies and download the
          <strong>{{ installModelName }}</strong> model ({{ installModelRepo }}).
          This may take several minutes depending on your connection speed.
        </p>
        <button
          class="mt-btn-install"
          @click="startInstall"
        >
          Install Training Setup
        </button>
      </div>

      <!-- During install: progress + logs -->
      <div
        v-if="envInstalling"
        class="mt-install-progress-container"
      >
        <h2 class="text-base font-semibold text-slate-900">
          Installing Training Environment
        </h2>
        <p class="mt-1 text-sm text-slate-500">
          {{ installDescription || 'Starting...' }}
        </p>

        <!-- Progress bar -->
        <div class="mt-progress-bar-track">
          <div
            class="mt-progress-bar-fill"
            :style="{ width: installProgressPct() + '%' }"
          />
        </div>
        <div class="flex justify-between text-xs text-slate-400">
          <span>{{ installPhase === 'model' ? 'Downloading model' : 'Installing dependencies' }}</span>
          <span>{{ installProgressPct() }}%</span>
        </div>

        <!-- File download detail -->
        <div
          v-if="installPhase === 'model' && installFileName"
          class="mt-install-file-detail"
        >
          <span class="text-sm text-slate-600">{{ installFileName }}</span>
          <span
            v-if="installDownloadPct()"
            class="text-xs text-slate-400"
          >{{ installDownloadPct() }}</span>
        </div>

        <!-- Live log output -->
        <div class="mt-install-log">
          <pre class="mt-log-output">{{ installLogContent || 'Waiting for output\u2026' }}</pre>
        </div>
      </div>

      <!-- Error state -->
      <div
        v-if="!envInstalling && installError"
        class="mt-install-prompt"
      >
        <div class="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 mb-4">
          <strong>Installation failed:</strong> {{ installError }}
        </div>
        <button
          class="mt-btn-install"
          @click="startInstall"
        >
          Retry Installation
        </button>

        <!-- Show log from failed install -->
        <div
          v-if="installLogContent"
          class="mt-install-log mt-4"
        >
          <pre class="mt-log-output">{{ installLogContent }}</pre>
        </div>
      </div>
    </div>

    <!-- Main content with sidebar — only shown when environment is installed -->
    <div
      v-if="installChecked && envInstalled"
      class="mt-content"
    >
      <!-- Sidebar navigation -->
      <nav class="mt-sidebar">
        <div
          v-for="item in navItems"
          :key="item.id"
          class="mt-nav-item"
          :class="{ 'mt-nav-active': currentNav === item.id }"
          @click="navClicked(item.id)"
        >
          {{ item.name }}
        </div>
      </nav>

      <!-- Content area -->
      <div class="flex-auto p-6 overflow-y-auto">
        <!-- Run Tab -->
        <div
          v-if="currentNav === 'run'"
          class="space-y-6"
        >
          <div>
            <h2 class="text-base font-semibold text-slate-900">
              Run Training
            </h2>
            <p class="mt-1 text-sm text-slate-500">
              Manually invoke the training pipeline or schedule automatic nightly training runs.
            </p>
          </div>

          <!-- Model Selection -->
          <div class="space-y-2">
            <label class="block text-sm font-medium text-slate-700">Training Model</label>
            <select
              v-model="selectedModel"
              class="mt-select"
              :disabled="isRunning"
            >
              <option
                v-for="model in trainableModels"
                :key="model.key"
                :value="model.key"
              >
                {{ model.displayName }} ({{ model.trainingRepo }})
              </option>
            </select>
            <p class="text-xs text-slate-400">
              Select the base model to fine-tune. Only models with a training repo are shown.
            </p>
          </div>

          <!-- Training Sources -->
          <div class="space-y-2">
            <label class="block text-sm font-medium text-slate-700">Training Sources</label>
            <p class="text-xs text-slate-400">
              Select which training phases to run. At least one source must be enabled.
            </p>

            <div class="mt-source-list">
              <!-- Document Processing -->
              <label
                class="mt-source-item"
                :class="{ 'mt-source-disabled': !docsConfigExists }"
              >
                <input
                  v-model="sourceDocProcessing"
                  type="checkbox"
                  class="mt-source-checkbox"
                  :disabled="isRunning || !docsConfigExists"
                >
                <div>
                  <span class="mt-source-label">Document Processing</span>
                  <p
                    v-if="!docsConfigExists"
                    class="mt-source-note"
                  >
                    No document config found. Set up folders in the Document Processing tab first.
                  </p>
                  <p
                    v-else
                    class="mt-source-desc"
                  >
                    Scan configured folders and generate QA training pairs from your documents.
                  </p>
                </div>
              </label>

              <!-- LoRA Training -->
              <label class="mt-source-item">
                <input
                  v-model="sourceLoraTraining"
                  type="checkbox"
                  class="mt-source-checkbox"
                  :disabled="isRunning"
                >
                <div>
                  <span class="mt-source-label">LoRA Training</span>
                  <p class="mt-source-desc">
                    Fine-tune the model using feedback conversations, replay buffer, and document knowledge.
                  </p>
                </div>
              </label>

              <!-- Skills -->
              <label class="mt-source-item">
                <input
                  v-model="sourceSkills"
                  type="checkbox"
                  class="mt-source-checkbox"
                  :disabled="isRunning"
                >
                <div>
                  <span class="mt-source-label">Skills</span>
                  <p class="mt-source-desc">
                    Train on agent skill execution patterns and tool usage.
                  </p>
                </div>
              </label>
            </div>
          </div>

          <!-- Manual Run -->
          <div class="space-y-2">
            <label class="block text-sm font-medium text-slate-700">Manual Training Run</label>
            <div>
              <button
                class="mt-btn-primary"
                :disabled="isRunning || !selectedModel || (!sourceDocProcessing && !sourceLoraTraining && !sourceSkills)"
                @click="startTraining"
              >
                {{ isRunning ? 'Training in progress\u2026' : 'Start Training' }}
              </button>
            </div>
            <p class="text-xs text-slate-400">
              Runs the selected training phases in order. At least one source must be checked.
            </p>

            <!-- Error -->
            <div
              v-if="runError"
              class="rounded-lg border border-amber-400 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            >
              {{ runError }}
            </div>
          </div>

          <!-- Separator -->
          <hr class="border-slate-200" style="margin-top:20px;">

          <!-- Schedule -->
          <div class="space-y-2">
            <label class="block text-sm font-medium text-slate-700">Scheduled Training</label>
            <div class="flex items-center gap-3">
              <label class="mt-toggle">
                <input
                  v-model="scheduleEnabled"
                  type="checkbox"
                >
                <span class="mt-toggle-track" />
              </label>
              <span class="text-sm text-slate-600">{{ scheduleEnabled ? 'Enabled' : 'Disabled' }}</span>
            </div>
            <p class="text-xs text-slate-400">
              When enabled, training will automatically run once per day at the configured time.
            </p>
          </div>

          <div
            v-if="scheduleEnabled"
            class="space-y-2"
          >
            <label class="block text-sm font-medium text-slate-700">Schedule Time</label>
            <div class="flex items-center gap-4">
              <label class="flex items-center gap-2 text-sm text-slate-600">
                Hour (0-23):
                <input
                  v-model.number="scheduleHour"
                  type="number"
                  class="mt-input w-20"
                  min="0"
                  max="23"
                >
              </label>
              <label class="flex items-center gap-2 text-sm text-slate-600">
                Minute (0-59):
                <input
                  v-model.number="scheduleMinute"
                  type="number"
                  class="mt-input w-20"
                  min="0"
                  max="59"
                >
              </label>
            </div>
            <p class="text-xs text-slate-400">
              Training will run daily at {{ scheduleTimeFormatted }} local time.
            </p>
          </div>

          <div>
            <button
              class="mt-btn-primary"
              :disabled="scheduleSaving"
              @click="saveSchedule"
            >
              {{ scheduleSaving ? 'Saving\u2026' : 'Save Schedule' }}
            </button>
          </div>
        </div>

        <!-- Document Processing Tab -->
        <div
          v-if="currentNav === 'docs'"
          class="space-y-6"
        >
          <div>
            <h2 class="text-base font-semibold text-slate-900">
              Document Processing
            </h2>
            <p class="mt-1 text-sm text-slate-500">
              Browse your home directory and select folders or individual files for training.
              Compatible file types: .txt, .md, .pdf, .docx
            </p>
          </div>

          <!-- File Tree -->
          <div
            v-if="treeRoot.length === 0 && treeLoading"
            class="py-8 text-center text-sm text-slate-400"
          >
            Loading…
          </div>

          <div
            v-else
            class="mt-tree-container"
          >
            <template
              v-for="node in treeRoot"
              :key="node.path"
            >
              <!-- Directory node -->
              <div
                v-if="node.isDir"
                class="mt-tree-branch"
              >
                <div
                  class="mt-tree-row"
                  :class="{ 'mt-tree-row-selected': selectedFolders.includes(node.path) }"
                >
                  <span
                    class="mt-tree-arrow"
                    :class="{ 'mt-tree-arrow-open': expandedDirs.has(node.path), 'mt-tree-arrow-empty': !node.hasChildren }"
                    @click="toggleDir(node.path)"
                  />
                  <input
                    type="checkbox"
                    :checked="selectedFolders.includes(node.path)"
                    class="mt-tree-checkbox"
                    @change="toggleSelectFolder(node.path)"
                  >
                  <span
                    class="mt-tree-label mt-tree-dir-label"
                    @click="toggleDir(node.path)"
                  >
                    {{ node.name }}
                  </span>
                  <span
                    v-if="treeLoading === node.path"
                    class="mt-tree-spinner"
                  />
                </div>

                <!-- Children (lazy-loaded) -->
                <div
                  v-if="expandedDirs.has(node.path) && treeChildren[node.path]"
                  class="mt-tree-children"
                >
                  <template
                    v-for="child in treeChildren[node.path]"
                    :key="child.path"
                  >
                    <!-- Nested directory -->
                    <div
                      v-if="child.isDir"
                      class="mt-tree-branch"
                    >
                      <div
                        class="mt-tree-row"
                        :class="{ 'mt-tree-row-selected': selectedFolders.includes(child.path) }"
                      >
                        <span
                          class="mt-tree-arrow"
                          :class="{ 'mt-tree-arrow-open': expandedDirs.has(child.path), 'mt-tree-arrow-empty': !child.hasChildren }"
                          @click="toggleDir(child.path)"
                        />
                        <input
                          type="checkbox"
                          :checked="selectedFolders.includes(child.path)"
                          class="mt-tree-checkbox"
                          @change="toggleSelectFolder(child.path)"
                        >
                        <span
                          class="mt-tree-label mt-tree-dir-label"
                          @click="toggleDir(child.path)"
                        >
                          {{ child.name }}
                        </span>
                        <span
                          v-if="treeLoading === child.path"
                          class="mt-tree-spinner"
                        />
                      </div>

                      <!-- Grandchildren (one more level of nesting) -->
                      <div
                        v-if="expandedDirs.has(child.path) && treeChildren[child.path]"
                        class="mt-tree-children"
                      >
                        <template
                          v-for="gc in treeChildren[child.path]"
                          :key="gc.path"
                        >
                          <div
                            v-if="gc.isDir"
                            class="mt-tree-branch"
                          >
                            <div
                              class="mt-tree-row"
                              :class="{ 'mt-tree-row-selected': selectedFolders.includes(gc.path) }"
                            >
                              <span
                                class="mt-tree-arrow"
                                :class="{ 'mt-tree-arrow-open': expandedDirs.has(gc.path), 'mt-tree-arrow-empty': !gc.hasChildren }"
                                @click="toggleDir(gc.path)"
                              />
                              <input
                                type="checkbox"
                                :checked="selectedFolders.includes(gc.path)"
                                class="mt-tree-checkbox"
                                @change="toggleSelectFolder(gc.path)"
                              >
                              <span
                                class="mt-tree-label mt-tree-dir-label"
                                @click="toggleDir(gc.path)"
                              >
                                {{ gc.name }}
                              </span>
                              <span
                                v-if="treeLoading === gc.path"
                                class="mt-tree-spinner"
                              />
                            </div>

                            <!-- Depth 3+ children -->
                            <div
                              v-if="expandedDirs.has(gc.path) && treeChildren[gc.path]"
                              class="mt-tree-children"
                            >
                              <div
                                v-for="d3 in treeChildren[gc.path]"
                                :key="d3.path"
                                class="mt-tree-row"
                                :class="{ 'mt-tree-row-selected': isSelected(d3.path, d3.isDir) }"
                              >
                                <span
                                  v-if="d3.isDir"
                                  class="mt-tree-arrow"
                                  :class="{ 'mt-tree-arrow-open': expandedDirs.has(d3.path), 'mt-tree-arrow-empty': !d3.hasChildren }"
                                  @click="toggleDir(d3.path)"
                                />
                                <span
                                  v-else
                                  class="mt-tree-arrow mt-tree-arrow-empty"
                                />
                                <input
                                  type="checkbox"
                                  :checked="isSelected(d3.path, d3.isDir)"
                                  class="mt-tree-checkbox"
                                  @change="d3.isDir ? toggleSelectFolder(d3.path) : toggleSelectFile(d3.path)"
                                >
                                <span
                                  v-if="!d3.isDir"
                                  class="mt-tree-ext"
                                >{{ d3.ext }}</span>
                                <span
                                  class="mt-tree-label"
                                  :class="{ 'mt-tree-dir-label': d3.isDir }"
                                  @click="d3.isDir ? toggleDir(d3.path) : toggleSelectFile(d3.path)"
                                >
                                  {{ d3.name }}
                                </span>
                                <span
                                  v-if="!d3.isDir"
                                  class="mt-tree-size"
                                >{{ formatFileSize(d3.size) }}</span>
                              </div>
                            </div>
                          </div>

                          <!-- File at grandchild level -->
                          <div
                            v-else
                            class="mt-tree-row"
                            :class="{ 'mt-tree-row-selected': selectedFiles.includes(gc.path) }"
                          >
                            <span class="mt-tree-arrow mt-tree-arrow-empty" />
                            <input
                              type="checkbox"
                              :checked="selectedFiles.includes(gc.path)"
                              class="mt-tree-checkbox"
                              @change="toggleSelectFile(gc.path)"
                            >
                            <span class="mt-tree-ext">{{ gc.ext }}</span>
                            <span
                              class="mt-tree-label"
                              @click="toggleSelectFile(gc.path)"
                            >
                              {{ gc.name }}
                            </span>
                            <span class="mt-tree-size">{{ formatFileSize(gc.size) }}</span>
                          </div>
                        </template>
                      </div>
                    </div>

                    <!-- File at child level -->
                    <div
                      v-else
                      class="mt-tree-row"
                      :class="{ 'mt-tree-row-selected': selectedFiles.includes(child.path) }"
                    >
                      <span class="mt-tree-arrow mt-tree-arrow-empty" />
                      <input
                        type="checkbox"
                        :checked="selectedFiles.includes(child.path)"
                        class="mt-tree-checkbox"
                        @change="toggleSelectFile(child.path)"
                      >
                      <span class="mt-tree-ext">{{ child.ext }}</span>
                      <span
                        class="mt-tree-label"
                        @click="toggleSelectFile(child.path)"
                      >
                        {{ child.name }}
                      </span>
                      <span class="mt-tree-size">{{ formatFileSize(child.size) }}</span>
                    </div>
                  </template>
                </div>
              </div>

              <!-- File at root level -->
              <div
                v-else
                class="mt-tree-row"
                :class="{ 'mt-tree-row-selected': selectedFiles.includes(node.path) }"
              >
                <span class="mt-tree-arrow mt-tree-arrow-empty" />
                <input
                  type="checkbox"
                  :checked="selectedFiles.includes(node.path)"
                  class="mt-tree-checkbox"
                  @change="toggleSelectFile(node.path)"
                >
                <span class="mt-tree-ext">{{ node.ext }}</span>
                <span
                  class="mt-tree-label"
                  @click="toggleSelectFile(node.path)"
                >
                  {{ node.name }}
                </span>
                <span class="mt-tree-size">{{ formatFileSize(node.size) }}</span>
              </div>
            </template>
          </div>

          <!-- Selection summary + Save -->
          <div class="flex items-center gap-3 flex-wrap">
            <button
              class="mt-btn-primary"
              :disabled="docsSaving || (selectedFolders.length === 0 && selectedFiles.length === 0)"
              @click="saveDocsConfig"
            >
              {{ docsSaving ? 'Saving…' : 'Save Configuration' }}
            </button>
            <span
              v-if="docsSaved"
              class="text-sm font-medium text-emerald-600"
            >
              ✓ Saved
            </span>
            <span
              v-if="selectedFolders.length > 0 || selectedFiles.length > 0"
              class="text-sm text-slate-500"
            >
              {{ selectedFolders.length }} folder{{ selectedFolders.length === 1 ? '' : 's' }},
              {{ selectedFiles.length }} file{{ selectedFiles.length === 1 ? '' : 's' }} selected
            </span>
          </div>
        </div>

        <!-- Active Run Tab (not in sidebar nav) -->
        <div
          v-if="currentNav === 'active-run'"
          class="flex flex-col h-full"
        >
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-base font-semibold text-slate-900">
                Training in Progress
              </h2>
              <p class="mt-1 text-sm text-slate-500">
                Live output from the training pipeline.
              </p>
            </div>
            <div class="flex items-center gap-3">
              <span
                v-if="isRunning"
                class="flex items-center gap-2 text-sm text-sky-600"
              >
                <span class="mt-pulse" />
                Running
              </span>
              <span
                v-else
                class="text-sm font-medium text-slate-500"
              >
                Completed
              </span>
              <button
                class="mt-btn-secondary"
                @click="backToRun"
              >
                ← Back
              </button>
            </div>
          </div>

          <div class="mt-active-log">
            <pre class="mt-log-output">{{ activeLogContent || 'Waiting for output\u2026' }}</pre>
          </div>
        </div>

        <!-- History Tab -->
        <div
          v-if="currentNav === 'history'"
          class="space-y-6"
        >
          <div>
            <h2 class="text-base font-semibold text-slate-900">
              Training History
            </h2>
            <p class="mt-1 text-sm text-slate-500">
              View logs from previous training runs. Click a log entry to view its output.
            </p>
          </div>

          <div
            v-if="historyLoading"
            class="py-8 text-center text-sm text-slate-400"
          >
            Loading history…
          </div>

          <div
            v-else-if="historyLogs.length === 0"
            class="py-8 text-center text-sm text-slate-400"
          >
            No training runs found. Run a training job from the "Run" page to see history here.
          </div>

          <div
            v-else
            class="mt-history-layout"
          >
            <!-- Log list -->
            <div class="mt-history-list">
              <div
                v-for="log in historyLogs"
                :key="log.filename"
                class="mt-history-item"
                :class="{ 'mt-history-item-selected': selectedLogFile === log.filename }"
                @click="viewLog(log.filename)"
              >
                <span class="text-sm font-medium">{{ formatDate(log.createdAt) }}</span>
                <span class="text-xs text-slate-400">{{ formatFileSize(log.size) }}</span>
              </div>
            </div>

            <!-- Log viewer -->
            <div class="flex-auto flex flex-col border border-slate-200 rounded-lg overflow-hidden">
              <div
                v-if="!selectedLogFile"
                class="py-8 text-center text-sm text-slate-400"
              >
                Select a log entry to view its output.
              </div>
              <div
                v-else-if="logViewLoading"
                class="py-8 text-center text-sm text-slate-400"
              >
                Loading log…
              </div>
              <div
                v-else
                class="mt-log-container"
              >
                <pre class="mt-log-output">{{ selectedLogContent }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="mt-footer">
      <button
        class="mt-btn-secondary"
        @click="closeWindow"
      >
        Close
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Install screen */
.mt-install-screen {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow-y: auto;
  padding: 2rem;
}
.mt-install-prompt {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  max-width: 28rem;
  gap: 0.75rem;
}
.mt-install-icon {
  color: var(--color-sky-500);
  margin-bottom: 0.5rem;
}
.mt-install-desc {
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--color-slate-500);
}
.mt-btn-install {
  margin-top: 0.5rem;
  padding: 0.75rem 2rem;
  font-size: var(--text-base);
  font-weight: var(--font-weight-semibold);
  border: none;
  border-radius: var(--radius-lg);
  background: var(--color-sky-600);
  color: var(--color-white);
  cursor: pointer;
  transition: background 0.15s, transform 0.1s;
}
.mt-btn-install:hover {
  background: var(--color-sky-700);
  transform: translateY(-1px);
}
.mt-btn-install:active {
  transform: translateY(0);
}
.mt-install-progress-container {
  width: 100%;
  max-width: 48rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.mt-progress-bar-track {
  width: 100%;
  height: 0.5rem;
  background: var(--color-slate-200);
  border-radius: 9999px;
  overflow: hidden;
}
.mt-progress-bar-fill {
  height: 100%;
  background: var(--color-sky-500);
  border-radius: 9999px;
  transition: width 0.3s ease;
}
.mt-install-file-detail {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: var(--color-slate-50);
  border: 1px solid var(--color-slate-200);
  border-radius: var(--radius-md);
}
.mt-install-log {
  flex: 1;
  min-height: 12rem;
  max-height: 20rem;
  overflow-y: auto;
  border: 1px solid var(--color-slate-200);
  border-radius: var(--radius-lg);
  background: var(--color-slate-900);
}
.mt-install-log .mt-log-output {
  color: var(--color-slate-300);
}

/* Root layout — matches LanguageModelSettings .lm-settings */
.mt-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: white;
  color: var(--color-slate-900);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}

/* Content area — matches LanguageModelSettings .lm-content */
.mt-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* Header — matches LanguageModelSettings */
.mt-header {
  height: 3rem;
  display: flex;
  align-items: center;
  padding: 0 0.75rem;
  width: 100%;
  border-bottom: 1px solid var(--color-slate-200);
  flex-shrink: 0;
}

/* Sidebar — matches LanguageModelSettings 200px width */
.mt-sidebar {
  width: 200px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-slate-200);
  padding-top: 0.75rem;
}

/* Footer — matches LanguageModelSettings */
.mt-footer {
  padding: 1rem 1.5rem;
  border-top: 1px solid var(--color-slate-200);
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  flex-shrink: 0;
}

/* Layout helpers that need scoped specificity */
.mt-nav-item {
  padding: 0.5rem 1rem;
  font-size: var(--text-sm);
  line-height: var(--text-sm--line-height);
  cursor: pointer;
  user-select: none;
  color: var(--color-slate-600);
  transition: background 0.15s, color 0.15s;
}
.mt-nav-item:hover {
  background: var(--color-slate-50);
  color: var(--color-slate-900);
}
.mt-nav-active {
  background: var(--color-sky-50);
  color: var(--color-sky-700);
  border-left: 2px solid var(--color-sky-500);
  font-weight: var(--font-weight-medium);
}

/* Select */
.mt-select {
  display: block;
  width: 100%;
  max-width: 25rem;
  padding: 0.5rem 0.75rem;
  font-size: var(--text-sm);
  line-height: var(--text-sm--line-height);
  border: 1px solid var(--color-slate-300);
  border-radius: var(--radius-md);
  background: var(--color-white);
  color: var(--color-slate-900);
}
.mt-select:focus {
  outline: none;
  border-color: var(--color-sky-500);
  box-shadow: 0 0 0 1px var(--color-sky-500);
}
.mt-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Text input */
.mt-input {
  padding: 0.375rem 0.625rem;
  font-size: var(--text-sm);
  border: 1px solid var(--color-slate-300);
  border-radius: var(--radius-md);
  background: var(--color-white);
  color: var(--color-slate-900);
}
.mt-input:focus {
  outline: none;
  border-color: var(--color-sky-500);
  box-shadow: 0 0 0 1px var(--color-sky-500);
}

/* Buttons */
.mt-btn-primary {
  padding: 0.5rem 1rem;
  font-size: var(--text-sm);
  font-weight: var(--font-weight-medium);
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-sky-600);
  color: var(--color-white);
  cursor: pointer;
  transition: background 0.15s;
}
.mt-btn-primary:hover {
  background: var(--color-sky-700);
}
.mt-btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mt-btn-secondary {
  padding: 0.5rem 1rem;
  font-size: var(--text-sm);
  font-weight: var(--font-weight-medium);
  border: 1px solid var(--color-slate-300);
  border-radius: var(--radius-md);
  background: var(--color-white);
  color: var(--color-slate-700);
  cursor: pointer;
  transition: background 0.15s;
}
.mt-btn-secondary:hover {
  background: var(--color-slate-50);
}

/* Toggle switch */
.mt-toggle {
  position: relative;
  display: inline-block;
  width: 2.75rem;
  height: 1.5rem;
}
.mt-toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}
.mt-toggle-track {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: var(--color-slate-300);
  border-radius: 9999px;
  transition: background 0.2s;
}
.mt-toggle-track::before {
  content: "";
  position: absolute;
  height: 1.125rem;
  width: 1.125rem;
  left: 0.1875rem;
  bottom: 0.1875rem;
  background: var(--color-white);
  border-radius: 9999px;
  transition: transform 0.2s;
}
.mt-toggle input:checked + .mt-toggle-track {
  background: var(--color-sky-500);
}
.mt-toggle input:checked + .mt-toggle-track::before {
  transform: translateX(1.25rem);
}

/* Log output */
.mt-log-container {
  max-height: 24rem;
  overflow: auto;
  border: 1px solid var(--color-slate-200);
  border-radius: var(--radius-lg);
  background: var(--color-slate-50);
}
.mt-log-output {
  margin: 0;
  padding: 1rem;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--color-slate-700);
}

/* History layout */
.mt-history-layout {
  display: flex;
  gap: 1rem;
  height: calc(100vh - 18rem);
}
.mt-history-list {
  width: 16rem;
  flex-shrink: 0;
  border: 1px solid var(--color-slate-200);
  border-radius: var(--radius-lg);
  overflow-y: auto;
}
.mt-history-item {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: 0.75rem;
  border-bottom: 1px solid var(--color-slate-100);
  cursor: pointer;
  transition: background 0.1s;
}
.mt-history-item:hover {
  background: var(--color-slate-50);
}
.mt-history-item-selected {
  background: var(--color-sky-600) !important;
  color: var(--color-white);
}
.mt-history-item-selected .text-slate-400 {
  color: var(--color-sky-200);
}

/* Active run log fills available space */
.mt-active-log {
  flex: 1;
  margin-top: 1rem;
  overflow: auto;
  border: 1px solid var(--color-slate-200);
  border-radius: var(--radius-lg);
  background: var(--color-slate-900);
}
.mt-active-log .mt-log-output {
  color: var(--color-slate-300);
}

/* Pulse indicator */
.mt-pulse {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 9999px;
  background: var(--color-sky-500);
  animation: mt-pulse-anim 1.5s ease-in-out infinite;
}
@keyframes mt-pulse-anim {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* Training source checkboxes */
.mt-source-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.mt-source-item {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--color-slate-200);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
}
.mt-source-item:hover {
  background: var(--color-slate-50);
}
.mt-source-disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.mt-source-disabled:hover {
  background: transparent;
}
.mt-source-checkbox {
  flex-shrink: 0;
  width: 1rem;
  height: 1rem;
  margin-top: 0.125rem;
  accent-color: var(--color-sky-600);
}
.mt-source-label {
  display: block;
  font-size: var(--text-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-slate-800);
}
.mt-source-desc {
  margin-top: 0.125rem;
  font-size: var(--text-xs);
  color: var(--color-slate-400);
}
.mt-source-note {
  margin-top: 0.125rem;
  font-size: var(--text-xs);
  color: var(--color-amber-600);
  font-style: italic;
}

/* Document Processing — File tree */
.mt-tree-container {
  max-height: calc(100vh - 18rem);
  overflow-y: auto;
  border: 1px solid var(--color-slate-200);
  border-radius: var(--radius-lg);
  padding: 0.25rem 0;
}
.mt-tree-branch {
  /* wrapper for a dir + its children */
}
.mt-tree-children {
  padding-left: 1.25rem;
}
.mt-tree-row {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.75rem;
  font-size: var(--text-sm);
  cursor: default;
  user-select: none;
  transition: background 0.1s;
}
.mt-tree-row:hover {
  background: var(--color-slate-50);
}
.mt-tree-row-selected {
  background: var(--color-sky-50);
}
.mt-tree-row-selected:hover {
  background: var(--color-sky-100);
}

/* Expand / collapse arrow */
.mt-tree-arrow {
  flex-shrink: 0;
  display: inline-block;
  width: 1rem;
  height: 1rem;
  text-align: center;
  line-height: 1rem;
  font-size: 0.625rem;
  color: var(--color-slate-400);
  cursor: pointer;
  transition: transform 0.15s;
}
.mt-tree-arrow::before {
  content: "▶";
}
.mt-tree-arrow-open {
  transform: rotate(90deg);
}
.mt-tree-arrow-empty {
  visibility: hidden;
}
.mt-tree-arrow-empty::before {
  content: "";
}

.mt-tree-checkbox {
  flex-shrink: 0;
  width: 0.875rem;
  height: 0.875rem;
  accent-color: var(--color-sky-600);
  cursor: pointer;
}
.mt-tree-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-slate-700);
  cursor: pointer;
}
.mt-tree-dir-label {
  font-weight: var(--font-weight-medium);
  color: var(--color-slate-800);
}
.mt-tree-ext {
  flex-shrink: 0;
  padding: 0 0.25rem;
  font-size: var(--text-xs);
  font-weight: var(--font-weight-medium);
  color: var(--color-sky-700);
  background: var(--color-sky-50);
  border-radius: var(--radius-sm);
}
.mt-tree-size {
  flex-shrink: 0;
  font-size: var(--text-xs);
  color: var(--color-slate-400);
}
.mt-tree-spinner {
  flex-shrink: 0;
  display: inline-block;
  width: 0.75rem;
  height: 0.75rem;
  border: 2px solid var(--color-slate-200);
  border-top-color: var(--color-sky-500);
  border-radius: 9999px;
  animation: mt-spin 0.6s linear infinite;
}
@keyframes mt-spin {
  to { transform: rotate(360deg); }
}
</style>

