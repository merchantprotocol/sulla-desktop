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

    <!-- ==================== WIZARD STEPS ==================== -->
    <div v-else class="tp-wizard">

      <!-- ─── DASHBOARD ─── -->
      <TrainingDashboard v-if="currentStep === -1" :is-dark="isDark" @open-training-log="$emit('open-training-log', $event)" />

      <!-- ─── STEP 1: Document Selection ─── -->
      <div v-if="currentStep === 0" class="tp-step tp-step-select">
        <!-- Left: File tree + continue button -->
        <div class="tp-select-tree" :class="{ dark: isDark }">
          <div class="tp-select-tree-header">
            <span class="tp-select-tree-title">Your Files</span>
            <span class="tp-select-tree-count">
              {{ selectedFolders.length }} folder{{ selectedFolders.length !== 1 ? 's' : '' }},
              {{ selectedFiles.length }} file{{ selectedFiles.length !== 1 ? 's' : '' }}
            </span>
          </div>
          <div class="tp-select-tree-content">
            <div v-if="treeLoading === '__root__'" class="tp-tree-status">Loading…</div>
            <div v-else-if="loadError" class="tp-tree-status tp-tree-error">{{ loadError }}</div>
            <div v-else-if="treeRoot.length === 0" class="tp-tree-status">No files found.</div>
            <div v-else class="tp-tree-list">
              <template v-for="node in treeRoot" :key="node.path">
                <TreeNode
                  :node="node"
                  :depth="0"
                  :is-dark="isDark"
                  :expanded-dirs="expandedDirs"
                  :tree-children="treeChildren"
                  :tree-loading="treeLoading"
                  :selected-folders="selectedFolders"
                  :selected-files="selectedFiles"
                  @toggle-dir="toggleDir"
                  @toggle-folder="toggleSelectFolder"
                  @toggle-file="toggleSelectFile"
                />
              </template>
            </div>
          </div>
          <!-- Pinned action bar below tree -->
          <div class="tp-select-tree-actions" :class="{ dark: isDark }">
            <span class="tp-selection-summary" v-if="selectedFolders.length > 0 || selectedFiles.length > 0">
              {{ selectedFolders.length + selectedFiles.length }} item{{ (selectedFolders.length + selectedFiles.length) !== 1 ? 's' : '' }} selected
            </span>
            <button
              class="tp-btn-primary tp-btn-continue-sm"
              :disabled="selectedFolders.length === 0 && selectedFiles.length === 0"
              @click="$emit('step-change', 1)"
            >
              Continue
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          </div>
        </div>

      </div>

      <!-- ─── STEP 2: Craft Prompt ─── -->
      <div v-if="currentStep === 1" class="tp-step tp-step-prompt">
        <div class="tp-fullpage-content">
          <h2 class="tp-page-title">Craft Your Prompt</h2>
          <p class="tp-page-desc">
            Write or select a prompt template that guides how your documents are turned into training data.
            This prompt is sent to an LLM to generate high-quality examples from each document.
          </p>

          <!-- Prompt template selector -->
          <div class="tp-prompt-templates" :class="{ dark: isDark }">
            <h3 class="tp-section-title">Template</h3>
            <div class="tp-template-grid">
              <button
                v-for="tmpl in promptTemplates"
                :key="tmpl.id"
                class="tp-template-card"
                :class="{ dark: isDark, selected: selectedTemplate === tmpl.id }"
                @click="selectTemplate(tmpl.id)"
              >
                <div class="tp-template-name">{{ tmpl.name }}</div>
                <div class="tp-template-desc">{{ tmpl.description }}</div>
              </button>
            </div>
          </div>

          <!-- Custom prompt textarea -->
          <div class="tp-prompt-editor" :class="{ dark: isDark }">
            <h3 class="tp-section-title">Prompt</h3>
            <textarea
              class="tp-prompt-textarea"
              :class="{ dark: isDark }"
              v-model="customPrompt"
              rows="8"
              placeholder="Enter your custom prompt here. Use {document} as a placeholder for the document text and {filename} for the file name."
            />
            <div class="tp-prompt-hint">
              Variables: <code>{document}</code> = document text, <code>{filename}</code> = file name
            </div>
          </div>
        </div>

        <div class="tp-step-actions">
          <button class="tp-btn-back" :class="{ dark: isDark }" @click="$emit('step-change', 0)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Back
          </button>
          <button class="tp-btn-primary" @click="$emit('step-change', 2)">
            Continue
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- ─── STEP 3: Pre-Process (choose LLM + generate training data) ─── -->
      <div v-if="currentStep === 2" class="tp-step tp-step-generate">
        <!-- Left: main controls -->
        <div class="tp-generate-main" :class="{ dark: isDark }">
          <div class="tp-generate-main-scroll">
          <h2 class="tp-page-title">Generate Training Data</h2>
          <p class="tp-page-desc" style="margin-bottom: 16px;">
            Select a model to read your documents and generate training examples from your prompt template.
          </p>

          <!-- LLM Model selection for processing -->
          <div class="tp-llm-section" :class="{ dark: isDark }">
            <h3 class="tp-section-title">Choose a Model for Processing</h3>
            <p class="tp-model-section-desc" :class="{ dark: isDark }">
              Select which LLM will read your documents and generate the training prompts. More capable models
              produce higher-quality questions but cost more and take longer. You can use any model from your
              locally installed models or your connected integrations (OpenAI, Anthropic, etc.).
            </p>

            <!-- Local models -->
            <div v-if="localLlmModels.length > 0" class="tp-llm-group">
              <div class="tp-llm-group-label" :class="{ dark: isDark }">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
                  <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
                  <line x1="6" y1="6" x2="6.01" y2="6"/>
                  <line x1="6" y1="18" x2="6.01" y2="18"/>
                </svg>
                Local Models
                <span class="tp-llm-group-badge">Free</span>
              </div>
              <div class="tp-llm-list">
                <button
                  v-for="model in localLlmModels"
                  :key="'local-' + model.id"
                  class="tp-llm-card"
                  :class="{ dark: isDark, selected: processLlm === model.id && processLlmProvider === 'local' }"
                  @click="selectProcessLlm(model.id, 'local')"
                >
                  <div class="tp-model-radio" :class="{ selected: processLlm === model.id && processLlmProvider === 'local' }" />
                  <div class="tp-llm-card-info">
                    <div class="tp-model-name">{{ model.name }}</div>
                    <div class="tp-llm-card-meta">Local · No cost · Slower</div>
                  </div>
                </button>
              </div>
            </div>

            <!-- Remote / integration models -->
            <div v-if="remoteLlmModels.length > 0" class="tp-llm-group">
              <div class="tp-llm-group-label" :class="{ dark: isDark }">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                </svg>
                Cloud Models (via Integrations)
              </div>
              <div class="tp-llm-list">
                <button
                  v-for="model in remoteLlmModels"
                  :key="'remote-' + model.id"
                  class="tp-llm-card"
                  :class="{ dark: isDark, selected: processLlm === model.id && processLlmProvider === model.provider }"
                  @click="selectProcessLlm(model.id, model.provider)"
                >
                  <div class="tp-model-radio" :class="{ selected: processLlm === model.id && processLlmProvider === model.provider }" />
                  <div class="tp-llm-card-info">
                    <div class="tp-model-name">{{ model.name }}</div>
                    <div class="tp-llm-card-meta">{{ model.provider }} · API cost applies · Fast</div>
                  </div>
                </button>
              </div>
            </div>

            <div v-if="localLlmModels.length === 0 && remoteLlmModels.length === 0" class="tp-model-empty" :class="{ dark: isDark }">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
              </svg>
              <p>No models available. Install a local model or connect an integration (OpenAI, Anthropic, etc.) in Settings.</p>
            </div>
          </div>

          <!-- Estimates panel -->
          <div v-if="processLlm" class="tp-estimates" :class="{ dark: isDark }">
            <h3 class="tp-section-title">Estimated Cost & Time</h3>
            <div class="tp-estimates-grid">
              <div class="tp-estimate-card" :class="{ dark: isDark }">
                <div class="tp-estimate-label">Documents</div>
                <div class="tp-estimate-value">{{ selectedFolders.length + selectedFiles.length }} items</div>
              </div>
              <div class="tp-estimate-card" :class="{ dark: isDark }">
                <div class="tp-estimate-label">Est. Chunks</div>
                <div class="tp-estimate-value">{{ estChunks }}</div>
              </div>
              <div class="tp-estimate-card" :class="{ dark: isDark }">
                <div class="tp-estimate-label">Est. Tokens</div>
                <div class="tp-estimate-value">{{ estTokensFormatted }}</div>
              </div>
              <div class="tp-estimate-card" :class="{ dark: isDark }">
                <div class="tp-estimate-label">Est. Cost</div>
                <div class="tp-estimate-value" :class="{ 'tp-estimate-free': processLlmProvider === 'local' }">
                  {{ processLlmProvider === 'local' ? 'Free' : estCostFormatted }}
                </div>
              </div>
              <div class="tp-estimate-card" :class="{ dark: isDark }">
                <div class="tp-estimate-label">Est. Time</div>
                <div class="tp-estimate-value">{{ estTimeFormatted }}</div>
              </div>
              <div class="tp-estimate-card" :class="{ dark: isDark }">
                <div class="tp-estimate-label">Model</div>
                <div class="tp-estimate-value tp-estimate-model">{{ processLlm }}</div>
              </div>
            </div>
            <div class="tp-estimate-disclaimer" :class="{ dark: isDark }">
              These are rough estimates based on average document sizes. Actual costs and time may vary
              depending on document complexity and model response lengths.
            </div>
          </div>

          <!-- Output filename -->
          <div class="tp-output-filename" :class="{ dark: isDark }">
            <label class="tp-config-label">Output File Name</label>
            <div class="tp-output-filename-row">
              <input
                type="text"
                class="tp-config-input"
                :class="{ dark: isDark }"
                v-model="outputFilename"
                placeholder="training-data"
              />
              <span class="tp-output-ext">.jsonl</span>
            </div>
            <div class="tp-config-doc" :class="{ dark: isDark }">
              Name your output training file. The processed data will be saved as
              <strong>{{ outputFilenameClean }}.jsonl</strong> in your training data directory.
            </div>
          </div>

          <!-- Processing summary -->
          <div class="tp-process-summary" :class="{ dark: isDark }">
            <div class="tp-process-row">
              <span class="tp-process-label">Selected items</span>
              <span class="tp-process-value">{{ selectedFolders.length + selectedFiles.length }}</span>
            </div>
            <div class="tp-process-row">
              <span class="tp-process-label">Prompt template</span>
              <span class="tp-process-value">{{ selectedTemplateName }}</span>
            </div>
            <div class="tp-process-row">
              <span class="tp-process-label">Processing model</span>
              <span class="tp-process-value">{{ processLlm || '—' }}</span>
            </div>
            <div class="tp-process-row">
              <span class="tp-process-label">Output file</span>
              <span class="tp-process-value"><code>{{ outputFilenameClean }}.jsonl</code></span>
            </div>
          </div>

          <!-- Processing state -->
          <div v-if="!preprocessing && !preprocessDone" class="tp-process-ready" :class="{ dark: isDark }">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
              <polyline points="16 16 12 12 8 16"/>
              <line x1="12" y1="12" x2="12" y2="21"/>
              <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
            </svg>
            <p>Ready to process. Select a model above and click the button below to start generating training data.</p>
          </div>

          <div v-if="preprocessing" class="tp-process-active" :class="{ dark: isDark }">
            <div class="tp-process-spinner-row">
              <span class="tp-btn-spinner tp-spinner-lg" />
              <span>Processing documents…</span>
            </div>
          </div>

          <!-- Results after processing -->
          <div v-if="preprocessDone" class="tp-process-done" :class="{ dark: isDark }">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
            <div>
              <strong>Processing complete</strong>
              <p>{{ totalExamples }} training examples generated across {{ dataFiles.length }} file{{ dataFiles.length !== 1 ? 's' : '' }}</p>
            </div>
          </div>

          </div><!-- /tp-generate-main-scroll -->

          <!-- Pinned action bar -->
          <div class="tp-step-actions" :class="{ dark: isDark }">
            <button class="tp-btn-back" :class="{ dark: isDark }" @click="$emit('step-change', 1)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
              Back
            </button>
            <template v-if="!preprocessDone && !scheduledForNightly">
              <button
                class="tp-btn-secondary"
                :disabled="preprocessing || !processLlm || (selectedFolders.length === 0 && selectedFiles.length === 0)"
                @click="enqueueAndSchedule"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <polyline points="12 6 12 12 16 14"/>
                </svg>
                Schedule Nightly Training
              </button>
              <button
                class="tp-btn-primary"
                :disabled="preprocessing || !processLlm || (selectedFolders.length === 0 && selectedFiles.length === 0)"
                @click="enqueueAndProcess"
              >
                <span v-if="preprocessing" class="tp-btn-spinner" />
                {{ preprocessing ? 'Processing…' : 'Manually Process Now' }}
              </button>
            </template>
            <div v-else-if="scheduledForNightly && !preprocessDone" class="tp-scheduled-badge" :class="{ dark: isDark }">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
              Queued for nightly training
            </div>
            <button
              v-if="preprocessDone"
              class="tp-btn-primary"
              :disabled="totalExamples === 0"
              @click="$emit('step-change', 3)"
            >
              Continue
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          </div>
        </div><!-- /tp-generate-main -->

      </div>

      <!-- ─── STEP 4 (Train Wizard Step 1): Select Data Files ─── -->
      <div v-if="currentStep === 3" class="tp-step tp-step-datafiles">
        <div class="tp-fullpage-content">
          <h2 class="tp-page-title">Select Training Data</h2>
          <p class="tp-page-desc">
            Choose which training data files to use for fine-tuning. These are the JSONL files
            generated from your documents or collected from chat sessions.
          </p>

          <!-- Refresh -->
          <div style="margin-bottom: 16px;">
            <button class="tp-btn-secondary tp-btn-sm" :class="{ dark: isDark }" @click="loadDataFiles">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="23 4 23 10 17 10"/>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
              Refresh
            </button>
          </div>

          <!-- Loading -->
          <div v-if="dataFilesLoading" class="tp-process-active" :class="{ dark: isDark }">
            <div class="tp-process-spinner-row">
              <span class="tp-btn-spinner tp-spinner-lg" />
              <span>Loading data files…</span>
            </div>
          </div>

          <!-- Empty state -->
          <div v-else-if="dataFiles.length === 0" class="tp-process-ready" :class="{ dark: isDark }">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <p>No training data files found. Go back to the Create Training Data wizard to generate some.</p>
          </div>

          <!-- File list with checkboxes -->
          <div v-else class="tp-datafiles-list">
            <div class="tp-datafiles-header" :class="{ dark: isDark }">
              <label class="tp-datafiles-check-all">
                <input
                  type="checkbox"
                  :checked="selectedDataFiles.length === dataFiles.length"
                  :indeterminate="selectedDataFiles.length > 0 && selectedDataFiles.length < dataFiles.length"
                  @change="toggleAllDataFiles"
                />
                Select All
              </label>
              <span class="tp-datafiles-count">
                {{ selectedDataFiles.length }} of {{ dataFiles.length }} selected
                ({{ selectedDataExamples }} examples)
              </span>
            </div>
            <div
              v-for="file in sortedDataFiles"
              :key="file.path"
              class="tp-datafile-row"
              :class="{ dark: isDark, selected: selectedDataFiles.includes(file.path) }"
              @click="toggleDataFile(file.path)"
            >
              <input
                type="checkbox"
                class="tft-checkbox"
                :checked="selectedDataFiles.includes(file.path)"
                @click.stop
                @change="toggleDataFile(file.path)"
              />
              <div class="tp-datafile-info">
                <div class="tp-datafile-name">{{ file.filename }}</div>
                <div class="tp-datafile-meta" :class="{ dark: isDark }">
                  {{ file.examples }} examples · {{ formatBytes(file.size) }} · {{ sourceLabel(file.source) }} · {{ formatDate(file.modifiedAt) }}
                </div>
              </div>
            </div>
          </div>

          <!-- Scale based on selected files -->
          <div v-if="selectedDataFiles.length > 0" class="tp-scale" :class="{ dark: isDark }" style="margin-top: 20px;">
            <div class="tp-scale-header">
              <span class="tp-scale-label">{{ selectedDataExamples }} training examples</span>
              <span class="tp-scale-badge" :class="selectedDataScale">{{ selectedDataScaleLabel }}</span>
            </div>
            <div class="tp-scale-bar">
              <div class="tp-scale-fill" :class="selectedDataScale" :style="{ width: selectedDataScalePct + '%' }" />
              <div class="tp-scale-marks">
                <span class="tp-scale-mark" :style="{ left: '0%' }">0</span>
                <span class="tp-scale-mark" :style="{ left: '10%' }">100</span>
                <span class="tp-scale-mark" :style="{ left: '50%' }">500</span>
                <span class="tp-scale-mark" :style="{ left: '100%' }">1000+</span>
              </div>
            </div>
          </div>
        </div>

        <div class="tp-step-actions">
          <button class="tp-btn-back" :class="{ dark: isDark }" @click="$emit('step-change', 2)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Back
          </button>
          <button
            class="tp-btn-primary"
            :disabled="selectedDataFiles.length === 0"
            @click="$emit('step-change', 4)"
          >
            Continue
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- ─── STEP 5 (Train Wizard Step 2): Model & Training Settings ─── -->
      <div v-if="currentStep === 4" class="tp-step tp-step-model">
        <div class="tp-fullpage-content">
          <h2 class="tp-page-title">Model & Training Settings</h2>
          <p class="tp-page-desc">
            Choose the base model you want to fine-tune and configure your training parameters.
            LoRA (Low-Rank Adaptation) lets you customize a model quickly without retraining
            every parameter — typically 10-60 minutes on a modern GPU.
          </p>

          <!-- Downloaded models -->
          <div class="tp-model-section" :class="{ dark: isDark }">
            <h3 class="tp-section-title">Your Downloaded Models</h3>
            <p class="tp-model-section-desc" :class="{ dark: isDark }">
              These are models already downloaded to your machine that support fine-tuning.
              Select one to use as your base model.
            </p>

            <div v-if="downloadedModelsLoading" class="tp-model-loading">
              <span class="tp-btn-spinner tp-spinner-lg" />
              <span>Loading models…</span>
            </div>

            <div v-else-if="downloadedModels.length === 0" class="tp-model-empty" :class="{ dark: isDark }">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                <line x1="12" y1="22.08" x2="12" y2="12"/>
              </svg>
              <p>No trainable models found. Download a model from the Models page first, or paste a HuggingFace repo below.</p>
            </div>

            <div v-else class="tp-model-list">
              <button
                v-for="model in downloadedModels"
                :key="model.key"
                class="tp-model-card"
                :class="{ dark: isDark, selected: selectedModel === model.key }"
                @click="selectedModel = model.key"
              >
                <div class="tp-model-card-left">
                  <div class="tp-model-radio" :class="{ selected: selectedModel === model.key }" />
                  <div>
                    <div class="tp-model-name">{{ model.displayName }}</div>
                    <div class="tp-model-repo">{{ model.trainingRepo }}</div>
                  </div>
                </div>
              </button>
            </div>
          </div>

          <!-- HuggingFace URL input (accordion) -->
          <div class="tp-hf-section" :class="{ dark: isDark }">
            <button class="tp-hf-toggle" :class="{ dark: isDark }" @click="hfExpanded = !hfExpanded">
              <svg
                class="tp-hf-toggle-icon"
                :class="{ open: hfExpanded }"
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Add a Model from HuggingFace
            </button>
            <div v-if="hfExpanded" class="tp-hf-body">
              <p class="tp-model-section-desc" :class="{ dark: isDark }">
                Want to train a model that isn't listed above? Paste a HuggingFace model URL or repo ID below.
                The model weights will be downloaded before training begins.
              </p>
              <div class="tp-hf-input-row">
                <input
                  type="text"
                  class="tp-hf-input"
                  :class="{ dark: isDark, error: !!hfError }"
                  v-model="hfInput"
                  @input="onHfInputChange"
                  placeholder="e.g. unsloth/Qwen3.5-9B or https://huggingface.co/unsloth/Qwen3.5-9B"
                />
              </div>
              <div v-if="hfError" class="tp-hf-error">{{ hfError }}</div>
              <div v-else-if="hfParsedRepo" class="tp-hf-parsed" :class="{ dark: isDark }">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                Resolved: <strong>{{ hfParsedRepo }}</strong>
              </div>
              <div class="tp-hf-examples" :class="{ dark: isDark }">
                <span class="tp-hf-examples-label">Accepted formats:</span>
                <code>unsloth/Qwen3.5-9B</code>
                <code>https://huggingface.co/unsloth/Qwen3.5-9B</code>
                <code>hf.co/mistralai/Mistral-7B-v0.3</code>
              </div>
            </div>
          </div>

          <!-- Training parameters — single column with thorough docs -->
          <div class="tp-train-config" :class="{ dark: isDark }">
            <h3 class="tp-section-title">Training Parameters</h3>

            <div class="tp-config-stack">
              <div class="tp-config-field">
                <label class="tp-config-label">Learning Rate</label>
                <input type="text" class="tp-config-input" :class="{ dark: isDark }" v-model="trainLearningRate" />
                <div class="tp-config-doc" :class="{ dark: isDark }">
                  Controls how much the model's weights change with each training step. A higher learning rate
                  means faster learning but risks overshooting and producing unstable results. A lower rate is
                  more stable but takes longer and may under-learn your data. For LoRA fine-tuning, values between
                  <strong>1e-5</strong> (very conservative) and <strong>5e-4</strong> (aggressive) work best.
                  Start with <strong>2e-4</strong> if you're unsure.
                </div>
              </div>

              <div class="tp-config-field">
                <label class="tp-config-label">Epochs</label>
                <input type="number" class="tp-config-input" :class="{ dark: isDark }" v-model.number="trainEpochs" min="1" max="20" />
                <div class="tp-config-doc" :class="{ dark: isDark }">
                  An epoch is one complete pass through your entire training dataset. More epochs mean the model
                  sees your data more times. With small datasets (&lt;100 examples), 2-5 epochs helps the model
                  learn thoroughly. With larger datasets (500+), 1-2 epochs is usually sufficient. Too many epochs
                  can cause <em>overfitting</em> — the model memorizes your training data instead of learning
                  general patterns. Start with <strong>3</strong>.
                </div>
              </div>

              <div class="tp-config-field">
                <label class="tp-config-label">LoRA Rank</label>
                <input type="number" class="tp-config-input" :class="{ dark: isDark }" v-model.number="trainLoraRank" min="4" max="128" />
                <div class="tp-config-doc" :class="{ dark: isDark }">
                  LoRA works by adding small trainable matrices to the model's layers instead of modifying
                  every weight. The <em>rank</em> controls the size of these matrices — think of it as the
                  model's capacity to learn new things. A rank of <strong>8</strong> is minimal and fast but
                  may not capture complex patterns. A rank of <strong>32-64</strong> gives more learning capacity
                  but uses more memory and takes longer. For personal voice/style training, <strong>16</strong>
                  is a good default. Go higher (32-64) if your training data is diverse and complex.
                </div>
              </div>

              <div class="tp-config-field">
                <label class="tp-config-label">Eval Split (%)</label>
                <input type="number" class="tp-config-input" :class="{ dark: isDark }" v-model.number="trainEvalSplit" min="0" max="50" />
                <div class="tp-config-doc" :class="{ dark: isDark }">
                  The percentage of your training data held out for evaluation. This data is never used for
                  training — instead, the model is tested against it after each epoch to measure how well
                  it's actually learning (vs. just memorizing). A <strong>20%</strong> split is standard. Set
                  to <strong>0</strong> to use all data for training (not recommended — you lose the ability
                  to detect overfitting). With very small datasets (&lt;50 examples), you may want to lower
                  this to <strong>10%</strong> so more data is available for training.
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="tp-step-actions">
          <button class="tp-btn-back" :class="{ dark: isDark }" @click="$emit('step-change', 3)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Back
          </button>
          <button
            class="tp-btn-primary"
            :disabled="!selectedModel && !hfParsedRepo"
            @click="$emit('step-change', 5)"
          >
            Continue
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- ─── STEP 5: Train & Deploy ─── -->
      <div v-if="currentStep === 5" class="tp-step tp-step-train">
        <div class="tp-fullpage-content">
          <h2 class="tp-page-title">Train & Deploy</h2>
          <p class="tp-page-desc">
            Run LoRA fine-tuning on your processed training data. The output model will be saved
            and ready for use.
          </p>

          <!-- Summary card -->
          <div class="tp-train-summary" :class="{ dark: isDark }">
            <div class="tp-train-summary-row">
              <span class="tp-train-summary-label">Training Examples</span>
              <span class="tp-train-summary-value">{{ totalExamples }}</span>
            </div>
            <div class="tp-train-summary-row">
              <span class="tp-train-summary-label">Data Quality</span>
              <span class="tp-scale-badge" :class="dataScale">{{ dataScaleLabel }}</span>
            </div>
            <div class="tp-train-summary-row">
              <span class="tp-train-summary-label">Base Model</span>
              <span class="tp-train-summary-value">{{ selectedModelName }}</span>
            </div>
            <div class="tp-train-summary-row">
              <span class="tp-train-summary-label">LoRA Rank</span>
              <span class="tp-train-summary-value">{{ trainLoraRank }}</span>
            </div>
            <div class="tp-train-summary-row">
              <span class="tp-train-summary-label">Epochs</span>
              <span class="tp-train-summary-value">{{ trainEpochs }}</span>
            </div>
            <div class="tp-train-summary-row">
              <span class="tp-train-summary-label">Eval Split</span>
              <span class="tp-train-summary-value">{{ trainEvalSplit }}%</span>
            </div>
          </div>

          <!-- Data quality warning -->
          <div v-if="dataScale === 'poor'" class="tp-train-warning" :class="{ dark: isDark }">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <div>
              <strong>Low training data</strong>
              <p>You have fewer than 50 examples. Consider going back and adding more documents for better results.</p>
            </div>
          </div>
        </div>

        <div class="tp-step-actions">
          <button class="tp-btn-back" :class="{ dark: isDark }" @click="$emit('step-change', 4)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Back
          </button>
          <button class="tp-btn-primary tp-btn-train" :disabled="totalExamples === 0 || trainingLoading" @click="startTraining">
            <svg v-if="!trainingLoading" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            {{ trainingLoading ? 'Starting Training...' : 'Start Training' }}
          </button>
        </div>
      </div>

    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { ipcRenderer } from 'electron';
import TreeNode from './TreeNode.vue';
import TrainingDashboard from './TrainingDashboard.vue';

interface TreeEntry {
  path: string;
  name: string;
  isDir: boolean;
  hasChildren: boolean;
  size: number;
  ext: string;
  category?: string;
}

export default defineComponent({
  name: 'TrainingPane',
  components: { TreeNode, TrainingDashboard },

  props: {
    isDark:      { type: Boolean, default: false },
    currentStep: { type: Number, default: 0 },
  },

  emits: ['close', 'env-ready', 'step-change', 'content-scale', 'open-training-log'],

  setup(props, { emit }) {
    // ─── Install state ───
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

    // ─── File tree state (Step 1) ───
    const treeRoot = ref<TreeEntry[]>([]);
    const treeChildren = ref<Record<string, TreeEntry[]>>({});
    const expandedDirs = ref<Set<string>>(new Set());
    const treeLoading = ref('');
    const loadError = ref('');
    const selectedFolders = ref<string[]>([]);
    const selectedFiles = ref<string[]>([]);
    const preprocessing = ref(false);
    const scheduledForNightly = ref(false);
    const trainingLoading = ref(false);

    // ─── Training data state (Step 2) ───
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
      if (n <= 100) return (n / 100) * 10;
      if (n <= 500) return 10 + ((n - 100) / 400) * 40;
      return 50 + ((n - 500) / 500) * 50;
    });

    // ─── Selected content size analysis (Step 1) ───
    function findEntryByPath(path: string): TreeEntry | undefined {
      for (const entry of treeRoot.value) {
        if (entry.path === path) return entry;
      }
      for (const children of Object.values(treeChildren.value)) {
        for (const entry of children) {
          if (entry.path === path) return entry;
        }
      }
      return undefined;
    }

    const selectedContentSize = computed(() => {
      let total = 0;
      for (const p of selectedFiles.value) {
        const entry = findEntryByPath(p);
        if (entry) total += entry.size;
      }
      for (const p of selectedFolders.value) {
        const entry = findEntryByPath(p);
        if (entry && entry.size > 0) {
          total += entry.size;
        } else {
          // Estimate from loaded children
          const children = treeChildren.value[p];
          if (children) {
            for (const child of children) {
              total += child.size;
            }
          }
        }
      }
      return total;
    });

    // Scale based on raw content size:
    // < 50 KB = Poor (not enough material)
    // 50-500 KB = Fair (basic personalization)
    // 500 KB - 5 MB = Good (strong results)
    // > 5 MB = Great (production quality)
    const contentScale = computed(() => {
      const kb = selectedContentSize.value / 1024;
      if (kb < 50) return 'poor';
      if (kb < 500) return 'fair';
      if (kb < 5120) return 'good';
      return 'great';
    });
    const contentScaleLabel = computed(() => {
      const labels: Record<string, string> = {
        poor:  'Not enough',
        fair:  'Basic',
        good:  'Strong',
        great: 'Excellent',
      };
      return labels[contentScale.value];
    });
    const contentScalePct = computed(() => {
      const kb = selectedContentSize.value / 1024;
      if (kb >= 5120) return 100;
      if (kb <= 50) return Math.max(1, (kb / 50) * 10);
      if (kb <= 500) return 10 + ((kb - 50) / 450) * 40;
      return 50 + ((kb - 500) / 4620) * 50;
    });

    // Emit content scale to parent so the help pane can show the meter
    watch([selectedContentSize, contentScale, contentScaleLabel, contentScalePct], () => {
      emit('content-scale', {
        size:  selectedContentSize.value,
        scale: contentScale.value,
        label: contentScaleLabel.value,
        pct:   contentScalePct.value,
      });
    }, { immediate: true });

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

    // ─── Step 2: Prompt crafting ───
    interface PromptTemplate {
      id: string;
      name: string;
      description: string;
      prompt: string;
    }
    const promptTemplates: PromptTemplate[] = [
      {
        id: 'qa',
        name: 'Q&A',
        description: 'Generate question-answer pairs for factual recall',
        prompt: 'Generate diverse Q&A pairs from the following document. Each question should test knowledge of the content.\n\nDocument ({filename}):\n{document}',
      },
      {
        id: 'conversational',
        name: 'Conversational',
        description: 'Simulate chat — user asks, respond as me',
        prompt: 'Simulate a conversation where the user asks about topics from this document. Respond in the author\'s voice and style.\n\nDocument ({filename}):\n{document}',
      },
      {
        id: 'style',
        name: 'Style Transfer',
        description: 'Rewrite content in my personal voice',
        prompt: 'Analyze the writing style of this document and generate examples that capture the author\'s tone, vocabulary, and approach.\n\nDocument ({filename}):\n{document}',
      },
    ];
    const selectedTemplate = ref('qa');
    const customPrompt = ref(promptTemplates[0].prompt);

    function selectTemplate(id: string) {
      selectedTemplate.value = id;
      const tmpl = promptTemplates.find(t => t.id === id);
      if (tmpl) {
        customPrompt.value = tmpl.prompt;
      }
    }

    const selectedTemplateName = computed(() => {
      const tmpl = promptTemplates.find(t => t.id === selectedTemplate.value);
      return tmpl?.name || 'Custom';
    });

    // ─── Step 3: Model & Settings ───
    interface DownloadedModel {
      key: string;
      displayName: string;
      trainingRepo: string;
    }
    const downloadedModels = ref<DownloadedModel[]>([]);
    const downloadedModelsLoading = ref(false);
    const selectedModel = ref('');
    const selectedModelName = computed(() => {
      const m = downloadedModels.value.find(m => m.key === selectedModel.value);
      return m?.displayName || selectedModel.value;
    });

    async function loadDownloadedModels() {
      downloadedModelsLoading.value = true;
      try {
        downloadedModels.value = await ipcRenderer.invoke('training-models-downloaded');
        // Auto-select first model if nothing selected yet
        if (!selectedModel.value && downloadedModels.value.length > 0) {
          selectedModel.value = downloadedModels.value[0].key;
        }
      } catch (err) {
        console.error('[TrainingPane] Failed to load downloaded models:', err);
      } finally {
        downloadedModelsLoading.value = false;
      }
    }

    // ─── HuggingFace URL / repo input ───
    const hfExpanded = ref(false);
    const hfInput = ref('');
    const hfError = ref('');
    const hfParsedRepo = ref('');

    /**
     * Parse a HuggingFace model reference from various user inputs:
     *  - "unsloth/Qwen3.5-9B"                    → "unsloth/Qwen3.5-9B"
     *  - "https://huggingface.co/unsloth/Qwen3.5-9B"  → "unsloth/Qwen3.5-9B"
     *  - "https://huggingface.co/unsloth/Qwen3.5-9B/tree/main" → "unsloth/Qwen3.5-9B"
     *  - "huggingface.co/unsloth/Qwen3.5-9B"     → "unsloth/Qwen3.5-9B"
     *  - "hf.co/unsloth/Qwen3.5-9B"              → "unsloth/Qwen3.5-9B"
     * Returns null if input is not a valid HuggingFace repo reference.
     */
    function parseHuggingFaceRepo(input: string): string | null {
      const trimmed = input.trim();
      if (!trimmed) return null;

      // Try to extract from URL-like patterns
      // Match: (https?://)?(www\.)?(huggingface\.co|hf\.co)/org/model(/anything)?
      const urlPattern = /^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/;
      const urlMatch = trimmed.match(urlPattern);
      if (urlMatch) {
        return urlMatch[1];
      }

      // Try bare org/model format (e.g. "unsloth/Qwen3.5-9B")
      const repoPattern = /^([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)$/;
      const repoMatch = trimmed.match(repoPattern);
      if (repoMatch) {
        return repoMatch[1];
      }

      return null;
    }

    function onHfInputChange() {
      hfError.value = '';
      hfParsedRepo.value = '';

      if (!hfInput.value.trim()) return;

      const repo = parseHuggingFaceRepo(hfInput.value);
      if (repo) {
        hfParsedRepo.value = repo;
      } else {
        hfError.value = 'Could not parse a HuggingFace model from this input. Enter a repo like "unsloth/Qwen3.5-9B" or paste a HuggingFace URL.';
      }
    }

    const trainEpochs = ref(3);
    const trainLearningRate = ref('2e-4');
    const trainLoraRank = ref(16);
    const trainEvalSplit = ref(20);

    // ─── Step 3: Pre-process — LLM model selection for prompt generation ───
    interface LlmModelOption {
      id: string;
      name: string;
      provider: string;
    }
    const localLlmModels = ref<LlmModelOption[]>([]);
    const remoteLlmModels = ref<LlmModelOption[]>([]);
    const processLlm = ref('');
    const processLlmProvider = ref('');

    function selectProcessLlm(modelId: string, provider: string) {
      processLlm.value = modelId;
      processLlmProvider.value = provider;
    }

    async function loadLlmModels() {
      try {
        // Load local GGUF models that are downloaded
        const localStatus: Record<string, boolean> = await ipcRenderer.invoke('local-models-status');
        const localList: LlmModelOption[] = [];
        for (const [key, downloaded] of Object.entries(localStatus)) {
          if (downloaded) {
            localList.push({ id: key, name: key, provider: 'local' });
          }
        }
        localLlmModels.value = localList;

        // Load remote integration models
        // For now, populate with common models from connected providers
        // This will be wired to ModelDiscoveryService later
        const remoteList: LlmModelOption[] = [];
        // Placeholder models — these represent what would come from connected integrations
        const knownRemote = [
          { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI' },
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'OpenAI' },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'Anthropic' },
          { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'Anthropic' },
          { id: 'grok-4-1-fast-reasoning', name: 'Grok 4.1 Fast', provider: 'Grok' },
        ];
        // TODO: Wire to ModelDiscoveryService.fetchAllAvailableModels()
        // For now show these as available options
        remoteLlmModels.value = knownRemote;
      } catch (err) {
        console.error('[TrainingPane] Failed to load LLM models:', err);
      }
    }

    // ─── Estimates (based on selected content size) ───
    // ~4 chars per token, ~1500 tokens per chunk → ~6000 chars per chunk
    const CHARS_PER_CHUNK = 6000;
    const estChunks = computed(() => {
      const bytes = selectedContentSize.value;
      if (bytes === 0) return 0;
      // Approximate: 1 byte ≈ 1 char for text files
      return Math.max(1, Math.ceil(bytes / CHARS_PER_CHUNK));
    });

    const estTokens = computed(() => {
      // Each chunk ~1500 tokens input + ~500 tokens output
      return estChunks.value * 2000;
    });

    const estTokensFormatted = computed(() => {
      const t = estTokens.value;
      if (t < 1000) return `~${t}`;
      if (t < 1_000_000) return `~${(t / 1000).toFixed(0)}K`;
      return `~${(t / 1_000_000).toFixed(1)}M`;
    });

    const estCostFormatted = computed(() => {
      if (processLlmProvider.value === 'local') return 'Free';
      // Rough pricing: ~$3 per 1M input tokens, ~$15 per 1M output tokens (GPT-4o level)
      const inputTokens = estChunks.value * 1500;
      const outputTokens = estChunks.value * 500;
      const cost = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
      if (cost < 0.01) return '< $0.01';
      return `~$${cost.toFixed(2)}`;
    });

    const estTimeFormatted = computed(() => {
      if (processLlmProvider.value === 'local') {
        // Local models: ~2-5 seconds per chunk
        const secs = estChunks.value * 3;
        if (secs < 60) return `~${secs}s`;
        if (secs < 3600) return `~${Math.round(secs / 60)} min`;
        return `~${(secs / 3600).toFixed(1)} hrs`;
      }
      // API models: ~0.5-1 second per chunk
      const secs = estChunks.value * 0.8;
      if (secs < 60) return `~${Math.round(secs)}s`;
      if (secs < 3600) return `~${Math.round(secs / 60)} min`;
      return `~${(secs / 3600).toFixed(1)} hrs`;
    });

    // ─── Step 4: Pre-process state ───
    const preprocessDone = ref(false);
    const outputFilename = ref('training-data');

    const outputFilenameClean = computed(() => {
      // Sanitise: lowercase, replace spaces and special chars with hyphens, strip extension
      let name = outputFilename.value.trim().replace(/\.jsonl$/i, '');
      name = name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      return name || 'training-data';
    });

    // ─── Step 3 (Train Wizard): Select data files for training ───
    const selectedDataFiles = ref<string[]>([]);

    function toggleDataFile(filePath: string) {
      const idx = selectedDataFiles.value.indexOf(filePath);
      if (idx >= 0) {
        selectedDataFiles.value.splice(idx, 1);
      } else {
        selectedDataFiles.value.push(filePath);
      }
    }

    function toggleAllDataFiles() {
      if (selectedDataFiles.value.length === dataFiles.value.length) {
        selectedDataFiles.value = [];
      } else {
        selectedDataFiles.value = dataFiles.value.map(f => f.path);
      }
    }

    const selectedDataExamples = computed(() => {
      return dataFiles.value
        .filter(f => selectedDataFiles.value.includes(f.path))
        .reduce((s, f) => s + f.examples, 0);
    });

    const selectedDataScale = computed(() => {
      const n = selectedDataExamples.value;
      if (n < 50) return 'poor';
      if (n < 200) return 'fair';
      if (n < 500) return 'good';
      return 'great';
    });

    const selectedDataScaleLabel = computed(() => {
      const labels: Record<string, string> = { poor: 'Not enough', fair: 'Fair', good: 'Good', great: 'Excellent' };
      return labels[selectedDataScale.value];
    });

    const selectedDataScalePct = computed(() => {
      const n = selectedDataExamples.value;
      if (n >= 1000) return 100;
      if (n <= 100) return (n / 100) * 10;
      if (n <= 500) return 10 + ((n - 100) / 400) * 40;
      return 50 + ((n - 500) / 500) * 50;
    });

    // ─── File tree methods ───
    async function loadTreeDir(dirPath?: string) {
      const key = dirPath || '__root__';
      treeLoading.value = key;
      loadError.value = '';
      try {
        const entries: TreeEntry[] = dirPath
          ? await ipcRenderer.invoke('training-content-tree', dirPath)
          : await ipcRenderer.invoke('training-content-tree');
        if (!dirPath) {
          treeRoot.value = entries;
        } else {
          treeChildren.value = { ...treeChildren.value, [dirPath]: entries };
        }
      } catch (err: any) {
        if (!dirPath) {
          loadError.value = err?.message || 'Failed to load file tree.';
        }
      } finally {
        treeLoading.value = '';
      }
    }

    async function toggleDir(dirPath: string) {
      if (expandedDirs.value.has(dirPath)) {
        expandedDirs.value.delete(dirPath);
        expandedDirs.value = new Set(expandedDirs.value);
      } else {
        expandedDirs.value.add(dirPath);
        expandedDirs.value = new Set(expandedDirs.value);
        if (!treeChildren.value[dirPath]) {
          await loadTreeDir(dirPath);
        }
      }
    }

    function toggleSelectFolder(folderPath: string) {
      const idx = selectedFolders.value.indexOf(folderPath);
      if (idx >= 0) {
        selectedFolders.value.splice(idx, 1);
      } else {
        selectedFolders.value.push(folderPath);
      }
    }

    function toggleSelectFile(filePath: string) {
      const idx = selectedFiles.value.indexOf(filePath);
      if (idx >= 0) {
        selectedFiles.value.splice(idx, 1);
      } else {
        selectedFiles.value.push(filePath);
      }
    }

    async function prepareForTraining() {
      preprocessing.value = true;
      preprocessDone.value = false;
      try {
        await ipcRenderer.invoke(
          'training-prepare-docs',
          [...selectedFolders.value],
          [...selectedFiles.value],
          {
            prompt:         customPrompt.value,
            modelId:        processLlm.value,
            modelProvider:  processLlmProvider.value,
            outputFilename: outputFilenameClean.value,
          },
        );
        await loadDataFiles();
        preprocessDone.value = true;
      } catch (err) {
        console.error('[TrainingPane] Document preparation failed:', err);
      } finally {
        preprocessing.value = false;
      }
    }

    // ─── Data loading ───
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

    // ─── IPC event handlers ───
    function handleDocProgress(_event: any, data: any) {
      if (data.phase === 'file-ok' || data.phase === 'queue-file-ok') {
        loadDataFiles();
      } else if (data.phase === 'done' || data.phase === 'queue-done') {
        preprocessing.value = false;
        preprocessDone.value = true;
        loadDataFiles();
      } else if (data.phase === 'error' || data.phase === 'queue-file-error') {
        preprocessing.value = false;
      }
    }

    let installLogTimer: ReturnType<typeof setInterval> | null = null;

    const hasEnoughSpace = computed(() => {
      if (requiredBytes.value === 0) return true;
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
      if (bytes <= 0) return '\u2014';
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
          loadTreeDir();
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
        loadTreeDir();
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
      installLogTimer = setInterval(async() => {
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

    // ─── Settings persistence ───
    async function saveCreateWizardSettings() {
      try {
        await ipcRenderer.invoke('training-wizard-settings-save', 'create', {
          selectedFolders:    selectedFolders.value,
          selectedFiles:      selectedFiles.value,
          selectedTemplate:   selectedTemplate.value,
          customPrompt:       customPrompt.value,
          processLlm:         processLlm.value,
          processLlmProvider: processLlmProvider.value,
          outputFilename:     outputFilename.value,
        });
      } catch {
        // Settings DB may not be ready
      }
    }

    async function saveTrainWizardSettings() {
      try {
        await ipcRenderer.invoke('training-wizard-settings-save', 'train', {
          selectedDataFiles: selectedDataFiles.value,
          selectedModel:     selectedModel.value,
          trainEpochs:       trainEpochs.value,
          trainLearningRate: trainLearningRate.value,
          trainLoraRank:     trainLoraRank.value,
          trainEvalSplit:    trainEvalSplit.value,
        });
      } catch {
        // Settings DB may not be ready
      }
    }

    async function restoreSettings() {
      try {
        const create = await ipcRenderer.invoke('training-wizard-settings-load', 'create') as Record<string, any>;
        if (create.selectedFolders?.length)    selectedFolders.value = create.selectedFolders;
        if (create.selectedFiles?.length)      selectedFiles.value = create.selectedFiles;
        if (create.selectedTemplate)           selectedTemplate.value = create.selectedTemplate;
        if (create.customPrompt)               customPrompt.value = create.customPrompt;
        if (create.processLlm)                 processLlm.value = create.processLlm;
        if (create.processLlmProvider)         processLlmProvider.value = create.processLlmProvider;
        if (create.outputFilename)             outputFilename.value = create.outputFilename;

        const train = await ipcRenderer.invoke('training-wizard-settings-load', 'train') as Record<string, any>;
        if (train.selectedDataFiles?.length)   selectedDataFiles.value = train.selectedDataFiles;
        if (train.selectedModel)               selectedModel.value = train.selectedModel;
        if (train.trainEpochs != null)         trainEpochs.value = train.trainEpochs;
        if (train.trainLearningRate)           trainLearningRate.value = train.trainLearningRate;
        if (train.trainLoraRank != null)       trainLoraRank.value = train.trainLoraRank;
        if (train.trainEvalSplit != null)      trainEvalSplit.value = train.trainEvalSplit;
      } catch {
        // Settings not available yet — use defaults
      }
    }

    // Auto-save Create wizard settings when key values change
    watch([selectedFolders, selectedFiles, selectedTemplate, customPrompt, processLlm, processLlmProvider, outputFilename], saveCreateWizardSettings, { deep: true });
    // Auto-save Train wizard settings when key values change
    watch([selectedDataFiles, selectedModel, trainEpochs, trainLearningRate, trainLoraRank, trainEvalSplit], saveTrainWizardSettings, { deep: true });

    // ─── Queue operations ───
    async function enqueueAndProcess() {
      const filePaths = [...selectedFolders.value, ...selectedFiles.value];
      if (filePaths.length === 0) return;

      const entries = filePaths.map(fp => ({
        filePath:       fp,
        prompt:         customPrompt.value,
        modelId:        processLlm.value,
        modelProvider:  processLlmProvider.value,
        outputFilename: outputFilenameClean.value,
      }));

      preprocessing.value = true;
      preprocessDone.value = false;
      try {
        await ipcRenderer.invoke('training-queue-add', entries);
        await ipcRenderer.invoke('training-queue-process-now');
      } catch (err) {
        console.error('[TrainingPane] Queue processing failed:', err);
        preprocessing.value = false;
      }
    }

    async function enqueueAndSchedule() {
      const filePaths = [...selectedFolders.value, ...selectedFiles.value];
      if (filePaths.length === 0) return;

      const entries = filePaths.map(fp => ({
        filePath:       fp,
        prompt:         customPrompt.value,
        modelId:        processLlm.value,
        modelProvider:  processLlmProvider.value,
        outputFilename: outputFilenameClean.value,
      }));

      try {
        await ipcRenderer.invoke('training-queue-add', entries);
        // Ensure nightly schedule is enabled
        const schedule = await ipcRenderer.invoke('training-schedule-get');
        if (!schedule.enabled) {
          await ipcRenderer.invoke('training-schedule-set', { enabled: true, hour: schedule.hour, minute: schedule.minute });
        }
        // Save as a scheduled config visible on the dashboard
        await ipcRenderer.invoke('training-scheduled-configs-add', {
          name:           outputFilenameClean.value || 'Training Config',
          source:         'documents',
          modelKey:       processLlm.value,
          prompt:         customPrompt.value,
          outputFilename: outputFilenameClean.value,
          files:          filePaths,
        });
        scheduledForNightly.value = true;
      } catch (err) {
        console.error('[TrainingPane] Schedule failed:', err);
      }
    }

    async function startTraining() {
      trainingLoading.value = true;
      try {
        const result = await ipcRenderer.invoke('training-train-conversations-now');
        // Training started successfully - result contains log info
        console.log('[TrainingPane] Training started:', result);
        // Navigate to Training Dashboard by triggering click event
        const dashboardLink = document.querySelector('.tw-dashboard-link') as HTMLElement;
        if (dashboardLink) {
          const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
          dashboardLink.dispatchEvent(clickEvent);
        }
      } catch (err) {
        console.error('[TrainingPane] Failed to start training:', err);
        // Could emit an error event or show a toast here
      } finally {
        trainingLoading.value = false;
      }
    };

    onMounted(async () => {
      await checkInstallStatus();
      loadDownloadedModels();
      loadLlmModels();
      await restoreSettings();
      ipcRenderer.on('training-install-progress' as any, handleInstallProgress);
      ipcRenderer.on('training-prepare-progress' as any, handleDocProgress);
    });

    onBeforeUnmount(() => {
      stopInstallLogPolling();
      ipcRenderer.removeListener('training-install-progress' as any, handleInstallProgress);
      ipcRenderer.removeListener('training-prepare-progress' as any, handleDocProgress);
    });

    return {
      // Install
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
      // File tree (Step 1)
      treeRoot,
      treeChildren,
      expandedDirs,
      treeLoading,
      loadError,
      selectedFolders,
      selectedFiles,
      preprocessing,
      toggleDir,
      toggleSelectFolder,
      toggleSelectFile,
      prepareForTraining,
      enqueueAndProcess,
      enqueueAndSchedule,
      scheduledForNightly,
      // Data review (Step 2)
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
      selectedContentSize,
      contentScale,
      contentScaleLabel,
      contentScalePct,
      sortedDataFiles,
      sortKey,
      sortDir,
      sortBy,
      sourceLabel,
      formatDate,
      loadDataFiles,
      // Step 2: Prompt crafting
      promptTemplates,
      selectedTemplate,
      customPrompt,
      selectTemplate,
      selectedTemplateName,
      // Step 3: Model & Settings
      downloadedModels,
      downloadedModelsLoading,
      selectedModel,
      selectedModelName,
      loadDownloadedModels,
      hfExpanded,
      hfInput,
      hfError,
      hfParsedRepo,
      onHfInputChange,
      trainEpochs,
      trainLearningRate,
      trainLoraRank,
      trainEvalSplit,
      // Step 3: Pre-process (LLM selection + generation)
      localLlmModels,
      remoteLlmModels,
      processLlm,
      processLlmProvider,
      selectProcessLlm,
      estChunks,
      estTokensFormatted,
      estCostFormatted,
      estTimeFormatted,
      preprocessDone,
      outputFilename,
      outputFilenameClean,
      trainingLoading,
      // Step 3 (Train Wizard): Data file selection
      selectedDataFiles,
      toggleDataFile,
      toggleAllDataFiles,
      selectedDataExamples,
      selectedDataScale,
      selectedDataScaleLabel,
      selectedDataScalePct,
      startTraining,
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
  background: #ffffff;
  overflow: hidden;
}
.training-pane.dark {
  background: #0f172a;
  color: #e2e8f0;
}

/* ─── Loading ─── */
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

/* ─── Install screen ─── */
.tp-install-screen {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 2rem;
}
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

/* ─── Wizard container ─── */
.tp-wizard {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tp-step {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ─── Step actions bar (shared) ─── */
.tp-step-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  border-top: 1px solid #e2e8f0;
  flex-shrink: 0;
  gap: 12px;
}
.dark .tp-step-actions {
  border-top-color: #334155;
}

.tp-btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  font-size: 0.875rem;
  font-weight: 600;
  border: none;
  border-radius: 6px;
  background: #0284c7;
  color: #fff;
  cursor: pointer;
  transition: background 0.15s;
  margin-left: auto;
}
.tp-btn-primary:hover:not(:disabled) {
  background: #0369a1;
}
.tp-btn-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tp-btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 0.8125rem;
  font-weight: 600;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  color: #334155;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.tp-btn-secondary.dark {
  background: #1e293b;
  border-color: #334155;
  color: #cbd5e1;
}
.tp-btn-secondary:hover:not(:disabled) {
  background: #f1f5f9;
  border-color: #cbd5e1;
}
.tp-btn-secondary.dark:hover:not(:disabled) {
  background: #334155;
  border-color: #475569;
}
.tp-btn-secondary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tp-scheduled-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 0.8125rem;
  font-weight: 600;
  border-radius: 6px;
  background: #dcfce7;
  color: #16a34a;
}
.tp-scheduled-badge.dark {
  background: #14532d;
  color: #86efac;
}

.tp-btn-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 8px 14px;
  font-size: 0.8125rem;
  font-weight: 500;
  border: none;
  border-radius: 6px;
  background: none;
  color: #64748b;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.tp-btn-back:hover {
  color: #0f172a;
  background: #f1f5f9;
}
.tp-btn-back.dark:hover {
  color: #e2e8f0;
  background: #1e293b;
}

.tp-btn-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(51, 65, 85, 0.3);
  border-top-color: #334155;
  border-radius: 50%;
  animation: tp-spin 0.6s linear infinite;
  flex-shrink: 0;
}
@keyframes tp-spin {
  to { transform: rotate(360deg); }
}

/* ─── STEP 1: Select Documents ─── */
.tp-step-select {
  flex-direction: row;
}

.tp-select-tree {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tp-select-tree-header {
  padding: 12px 14px;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.dark .tp-select-tree-header {
  border-bottom-color: #334155;
}
.tp-select-tree-title {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #334155;
  margin-bottom: 2px;
}
.dark .tp-select-tree-title {
  color: #e2e8f0;
}
.tp-select-tree-count {
  font-size: 11px;
  color: #94a3b8;
}
.tp-select-tree-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}
.tp-tree-status {
  padding: 1.5rem;
  text-align: center;
  font-size: 12px;
  color: #94a3b8;
}
.tp-tree-error {
  color: #ef4444;
}
.tp-tree-list {
  padding: 4px 0;
}

/* Tree actions pinned at bottom */
.tp-select-tree-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-top: 1px solid #e2e8f0;
  flex-shrink: 0;
  gap: 8px;
}
.tp-select-tree-actions.dark {
  border-top-color: #334155;
}
.tp-btn-continue-sm {
  padding: 6px 14px;
  font-size: 0.8125rem;
}

/* Right info panel */
.tp-select-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tp-info-content {
  flex: 1;
  overflow-y: auto;
  padding: 32px 40px;
}
.tp-info-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0 0 8px 0;
}
.dark .tp-info-title {
  color: #f1f5f9;
}
.tp-info-desc {
  font-size: 0.9375rem;
  line-height: 1.6;
  color: #475569;
  margin: 0 0 28px 0;
  max-width: 600px;
}
.dark .tp-info-desc {
  color: #94a3b8;
}
.tp-info-section {
  margin-bottom: 24px;
}
.tp-info-subtitle {
  font-size: 0.8125rem;
  font-weight: 600;
  color: #334155;
  margin: 0 0 8px 0;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.dark .tp-info-subtitle {
  color: #cbd5e1;
}
.tp-info-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.tp-info-chip {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 0.8125rem;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-weight: 500;
  background: #f1f5f9;
  color: #475569;
  border: 1px solid #e2e8f0;
}
.dark .tp-info-chip {
  background: #1e293b;
  color: #94a3b8;
  border-color: #334155;
}
.tp-info-list {
  margin: 0;
  padding-left: 20px;
  font-size: 0.875rem;
  line-height: 1.8;
  color: #475569;
}
.dark .tp-info-list {
  color: #94a3b8;
}
.tp-info-text {
  font-size: 0.875rem;
  line-height: 1.6;
  color: #475569;
  margin: 0;
}
.dark .tp-info-text {
  color: #94a3b8;
}

/* ─── STEP 3: Generate Data ─── */
.tp-generate-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tp-generate-main-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}

/* ─── STEP 2: Review Data ─── */
.tp-step-review {
  flex-direction: column;
}
.tp-review-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}
.tp-review-title {
  font-size: 1.375rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0 0 6px 0;
}
.dark .tp-review-title {
  color: #f1f5f9;
}
.tp-review-desc {
  font-size: 0.9375rem;
  color: #64748b;
  margin: 0 0 24px 0;
}
.dark .tp-review-desc {
  color: #94a3b8;
}

/* Scale indicator */
.tp-scale {
  padding: 1rem;
  border: 1px solid #e2e8f0;
  border-radius: 0.5rem;
  background: #f8fafc;
  margin-bottom: 16px;
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
.tp-scale-badge.poor { background: #fef2f2; color: #dc2626; }
.dark .tp-scale-badge.poor { background: #450a0a; color: #fca5a5; }
.tp-scale-badge.fair { background: #fef3c7; color: #d97706; }
.dark .tp-scale-badge.fair { background: #78350f; color: #fcd34d; }
.tp-scale-badge.good { background: #dbeafe; color: #2563eb; }
.dark .tp-scale-badge.good { background: #1e3a5f; color: #60a5fa; }
.tp-scale-badge.great { background: #dcfce7; color: #16a34a; }
.dark .tp-scale-badge.great { background: #14532d; color: #4ade80; }

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
.tp-scale-fill.poor { background: #ef4444; }
.tp-scale-fill.fair { background: #f59e0b; }
.tp-scale-fill.good { background: #3b82f6; }
.tp-scale-fill.great { background: #22c55e; }

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

/* Stats cards */
.tp-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.75rem;
  margin-bottom: 16px;
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

/* Table section */
.tp-table-section {
  margin-top: 8px;
}
.tp-table-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0;
  border-bottom: 1px solid #e2e8f0;
}
.tp-table-header.dark {
  border-bottom-color: #334155;
}
.tp-table-title {
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
}
.dark .tp-table-title {
  color: #94a3b8;
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

.tp-table-wrapper {
  max-height: 400px;
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
.tp-table thead th:hover { color: #0f172a; }
.tp-table.dark thead th:hover { color: #e2e8f0; }
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
.tp-table tbody tr:hover { background: #f8fafc; }
.tp-table.dark tbody tr:hover { background: #1e293b; }
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
.tp-cell-examples {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.tp-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 600;
}
.tp-badge.documents { background: #dbeafe; color: #1e40af; }
.dark .tp-badge.documents { background: #1e3a5f; color: #60a5fa; }
.tp-badge.sessions { background: #fef3c7; color: #92400e; }
.dark .tp-badge.sessions { background: #78350f; color: #fcd34d; }
.tp-badge.processed { background: #dcfce7; color: #166534; }
.dark .tp-badge.processed { background: #14532d; color: #4ade80; }

/* ─── Select Data Files step ─── */
.tp-datafiles-list {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  overflow: hidden;
}
.dark .tp-datafiles-list {
  border-color: #334155;
}
.tp-datafiles-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  font-size: 12px;
}
.tp-datafiles-header.dark {
  background: #1e293b;
  border-bottom-color: #334155;
}
.tp-datafiles-check-all {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-weight: 600;
  color: #334155;
}
.dark .tp-datafiles-check-all {
  color: #e2e8f0;
}
.tp-datafiles-count {
  color: #94a3b8;
  font-size: 11px;
}
.tp-datafile-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  cursor: pointer;
  border-bottom: 1px solid #f1f5f9;
  transition: background 0.1s;
}
.tp-datafile-row:last-child {
  border-bottom: none;
}
.tp-datafile-row:hover {
  background: #f8fafc;
}
.tp-datafile-row.dark {
  border-bottom-color: #1e293b;
}
.tp-datafile-row.dark:hover {
  background: #1e293b;
}
.tp-datafile-row.selected {
  background: #eff6ff;
}
.tp-datafile-row.selected.dark {
  background: #1e3a5f;
}
.tp-datafile-info {
  flex: 1;
  min-width: 0;
}
.tp-datafile-name {
  font-size: 13px;
  font-weight: 500;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dark .tp-datafile-name {
  color: #f1f5f9;
}
.tp-datafile-meta {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 2px;
}
.tp-datafile-meta.dark {
  color: #64748b;
}
.tp-btn-sm {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
}

/* ─── STEP 3: Train Model ─── */
.tp-step-train {
  flex-direction: column;
}
.tp-train-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
  max-width: 700px;
}
.tp-train-title {
  font-size: 1.375rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0 0 6px 0;
}
.dark .tp-train-title {
  color: #f1f5f9;
}
.tp-train-desc {
  font-size: 0.9375rem;
  color: #64748b;
  margin: 0 0 24px 0;
}
.dark .tp-train-desc {
  color: #94a3b8;
}

/* Summary card */
.tp-train-summary {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
  padding: 0;
  margin-bottom: 20px;
  overflow: hidden;
}
.tp-train-summary.dark {
  background: #1e293b;
  border-color: #334155;
}
.tp-train-summary-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #e2e8f0;
}
.tp-train-summary.dark .tp-train-summary-row {
  border-bottom-color: #334155;
}
.tp-train-summary-row:last-child {
  border-bottom: none;
}
.tp-train-summary-label {
  font-size: 0.8125rem;
  color: #64748b;
}
.dark .tp-train-summary-label {
  color: #94a3b8;
}
.tp-train-summary-value {
  font-size: 0.875rem;
  font-weight: 600;
  color: #0f172a;
}
.dark .tp-train-summary-value {
  color: #f1f5f9;
}

/* Training config */
.tp-train-config {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
  padding: 20px;
  margin-bottom: 20px;
}
.tp-train-config.dark {
  background: #1e293b;
  border-color: #334155;
}
.tp-config-title {
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #334155;
  margin: 0 0 16px 0;
}
.dark .tp-config-title {
  color: #e2e8f0;
}
.tp-config-field {
  margin-bottom: 14px;
}
.tp-config-field:last-child {
  margin-bottom: 0;
}
.tp-config-label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 600;
  color: #334155;
  margin-bottom: 4px;
}
.dark .tp-config-label {
  color: #cbd5e1;
}
.tp-config-input {
  width: 100%;
  max-width: 200px;
  padding: 6px 10px;
  font-size: 0.875rem;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  color: #0f172a;
  outline: none;
  transition: border-color 0.15s;
}
.tp-config-input:focus {
  border-color: #0284c7;
}
.tp-config-input.dark {
  background: #0f172a;
  border-color: #475569;
  color: #e2e8f0;
}
.tp-config-input.dark:focus {
  border-color: #38bdf8;
}
.tp-config-hint {
  display: block;
  font-size: 0.75rem;
  color: #94a3b8;
  margin-top: 3px;
}

/* Warning */
.tp-train-warning {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid #fca5a5;
  background: #fef2f2;
  color: #991b1b;
  font-size: 0.8125rem;
  line-height: 1.5;
}
.tp-train-warning.dark {
  background: #450a0a;
  border-color: #7f1d1d;
  color: #fca5a5;
}
.tp-train-warning p {
  margin: 2px 0 0 0;
  font-weight: 400;
}
.tp-train-warning strong {
  font-weight: 600;
}

/* Train button */
.tp-btn-train {
  background: #16a34a;
  gap: 8px;
}
.tp-btn-train:hover:not(:disabled) {
  background: #15803d;
}

/* ─── Shared full-page content ─── */
.tp-fullpage-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}
.tp-page-title {
  font-size: 1.375rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0 0 6px 0;
}
.dark .tp-page-title {
  color: #f1f5f9;
}
.tp-page-desc {
  font-size: 0.9375rem;
  color: #64748b;
  margin: 0 0 24px 0;
  line-height: 1.6;
}
.dark .tp-page-desc {
  color: #94a3b8;
}
.tp-section-title {
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #334155;
  margin: 0 0 12px 0;
}
.dark .tp-section-title {
  color: #e2e8f0;
}
.tp-selection-summary {
  font-size: 0.8125rem;
  color: #64748b;
}
.tp-step-actions-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ─── Step 2: Prompt templates ─── */
.tp-prompt-templates {
  margin-bottom: 20px;
}
.tp-template-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
@media (max-width: 700px) {
  .tp-template-grid { grid-template-columns: 1fr; }
}
.tp-template-card {
  padding: 14px;
  border: 2px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, background 0.15s;
}
.tp-template-card.dark {
  background: #1e293b;
  border-color: #334155;
}
.tp-template-card:hover {
  border-color: #94a3b8;
}
.tp-template-card.dark:hover {
  border-color: #64748b;
}
.tp-template-card.selected {
  border-color: #0284c7;
  background: #eff6ff;
}
.tp-template-card.selected.dark {
  border-color: #38bdf8;
  background: #0c4a6e;
}
.tp-template-name {
  font-size: 0.875rem;
  font-weight: 600;
  color: #0f172a;
  margin-bottom: 4px;
}
.dark .tp-template-name {
  color: #f1f5f9;
}
.tp-template-desc {
  font-size: 0.75rem;
  color: #64748b;
  line-height: 1.4;
}
.dark .tp-template-desc {
  color: #94a3b8;
}

/* Prompt editor */
.tp-prompt-editor {
  margin-bottom: 16px;
}
.tp-prompt-textarea {
  width: 100%;
  padding: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  color: #0f172a;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.8125rem;
  line-height: 1.6;
  resize: vertical;
  outline: none;
  transition: border-color 0.15s;
}
.tp-prompt-textarea:focus {
  border-color: #0284c7;
}
.tp-prompt-textarea.dark {
  background: #0f172a;
  border-color: #475569;
  color: #e2e8f0;
}
.tp-prompt-textarea.dark:focus {
  border-color: #38bdf8;
}
.tp-prompt-hint {
  margin-top: 6px;
  font-size: 0.75rem;
  color: #94a3b8;
}
.tp-prompt-hint code {
  background: #f1f5f9;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.6875rem;
}
.dark .tp-prompt-hint code {
  background: #334155;
}

/* ─── Step 3: Model selection ─── */
.tp-model-section {
  margin-bottom: 24px;
}
.tp-model-section-desc {
  font-size: 0.8125rem;
  color: #64748b;
  margin: 0 0 12px 0;
  line-height: 1.5;
}
.tp-model-section-desc.dark {
  color: #94a3b8;
}
.tp-model-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 20px;
  font-size: 0.875rem;
  color: #64748b;
}
.tp-model-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 16px;
  text-align: center;
  border: 1px dashed #e2e8f0;
  border-radius: 8px;
  color: #94a3b8;
  font-size: 0.8125rem;
  line-height: 1.5;
}
.tp-model-empty.dark {
  border-color: #334155;
}
.tp-model-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tp-model-card {
  display: flex;
  align-items: center;
  padding: 12px 14px;
  border: 2px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, background 0.15s;
  width: 100%;
}
.tp-model-card.dark {
  background: #1e293b;
  border-color: #334155;
}
.tp-model-card:hover {
  border-color: #94a3b8;
}
.tp-model-card.dark:hover {
  border-color: #64748b;
}
.tp-model-card.selected {
  border-color: #0284c7;
  background: #eff6ff;
}
.tp-model-card.selected.dark {
  border-color: #38bdf8;
  background: #0c4a6e;
}
.tp-model-card-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tp-model-radio {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid #cbd5e1;
  flex-shrink: 0;
  transition: all 0.15s;
}
.dark .tp-model-radio {
  border-color: #475569;
}
.tp-model-radio.selected {
  border-color: #0284c7;
  border-width: 5px;
}
.dark .tp-model-radio.selected {
  border-color: #38bdf8;
}
.tp-model-name {
  font-size: 0.875rem;
  font-weight: 600;
  color: #0f172a;
  line-height: 1.3;
}
.dark .tp-model-name {
  color: #f1f5f9;
}
.tp-model-repo {
  font-size: 0.6875rem;
  color: #94a3b8;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  margin-top: 1px;
}
.dark .tp-model-repo {
  color: #64748b;
}

/* HuggingFace URL input (accordion) */
.tp-hf-section {
  margin-bottom: 24px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
  overflow: hidden;
}
.tp-hf-section.dark {
  background: #1e293b;
  border-color: #334155;
}
.tp-hf-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 12px 16px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 600;
  color: #334155;
  text-align: left;
}
.tp-hf-toggle:hover {
  background: #f1f5f9;
}
.tp-hf-toggle.dark {
  color: #e2e8f0;
}
.tp-hf-toggle.dark:hover {
  background: #334155;
}
.tp-hf-toggle-icon {
  flex-shrink: 0;
  transition: transform 0.2s;
  color: #64748b;
}
.tp-hf-toggle-icon.open {
  transform: rotate(45deg);
}
.tp-hf-body {
  padding: 0 16px 16px;
}
.tp-hf-input-row {
  display: flex;
  gap: 8px;
}
.tp-hf-input {
  flex: 1;
  padding: 9px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  color: #0f172a;
  font-size: 0.8125rem;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  outline: none;
  transition: border-color 0.15s;
}
.tp-hf-input:focus {
  border-color: #0284c7;
}
.tp-hf-input.dark {
  background: #0f172a;
  border-color: #475569;
  color: #e2e8f0;
}
.tp-hf-input.dark:focus {
  border-color: #38bdf8;
}
.tp-hf-input.error {
  border-color: #ef4444;
}
.tp-hf-error {
  margin-top: 6px;
  font-size: 0.75rem;
  color: #ef4444;
  line-height: 1.4;
}
.tp-hf-parsed {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 0.8125rem;
  color: #16a34a;
}
.tp-hf-parsed.dark {
  color: #4ade80;
}
.tp-hf-examples {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 0.6875rem;
  color: #94a3b8;
}
.tp-hf-examples.dark {
  color: #64748b;
}
.tp-hf-examples-label {
  font-weight: 600;
}
.tp-hf-examples code {
  background: #e2e8f0;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 0.625rem;
}
.dark .tp-hf-examples code {
  background: #334155;
}

/* Training config — single column stack */
.tp-config-stack {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.tp-config-doc {
  margin-top: 6px;
  font-size: 0.75rem;
  color: #64748b;
  line-height: 1.6;
}
.tp-config-doc.dark {
  color: #94a3b8;
}
.tp-config-doc strong {
  color: #334155;
  font-weight: 600;
}
.dark .tp-config-doc strong {
  color: #e2e8f0;
}
.tp-config-doc em {
  font-style: italic;
}

/* ─── Step 3: Pre-process — LLM selection + explainer + estimates ─── */
.tp-explainer {
  margin-bottom: 24px;
  padding: 16px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}
.tp-explainer.dark {
  background: #1e293b;
  border-color: #334155;
}
.tp-explainer-steps {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.tp-explainer-step {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 0.8125rem;
  color: #334155;
  line-height: 1.5;
}
.dark .tp-explainer-step {
  color: #cbd5e1;
}
.tp-explainer-num {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #0284c7;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.6875rem;
  font-weight: 700;
  flex-shrink: 0;
  margin-top: 1px;
}

/* LLM model groups */
.tp-llm-section {
  margin-bottom: 24px;
}
.tp-llm-group {
  margin-bottom: 16px;
}
.tp-llm-group-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #64748b;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid #e2e8f0;
}
.tp-llm-group-label.dark {
  color: #94a3b8;
  border-bottom-color: #334155;
}
.tp-llm-group-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 9999px;
  font-size: 0.625rem;
  font-weight: 700;
  background: #dcfce7;
  color: #166534;
}
.dark .tp-llm-group-badge {
  background: #14532d;
  color: #4ade80;
}
.tp-llm-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tp-llm-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1.5px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, background 0.15s;
  width: 100%;
}
.tp-llm-card.dark {
  background: #1e293b;
  border-color: #334155;
}
.tp-llm-card:hover {
  border-color: #94a3b8;
}
.tp-llm-card.dark:hover {
  border-color: #64748b;
}
.tp-llm-card.selected {
  border-color: #0284c7;
  background: #eff6ff;
}
.tp-llm-card.selected.dark {
  border-color: #38bdf8;
  background: #0c4a6e;
}
.tp-llm-card-info {
  flex: 1;
  min-width: 0;
}
.tp-llm-card-meta {
  font-size: 0.6875rem;
  color: #94a3b8;
  margin-top: 1px;
}
.dark .tp-llm-card-meta {
  color: #64748b;
}

/* Estimates panel */
.tp-estimates {
  margin-bottom: 24px;
}
.tp-estimates-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 8px;
}
@media (max-width: 600px) {
  .tp-estimates-grid { grid-template-columns: repeat(2, 1fr); }
}
.tp-estimate-card {
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #f8fafc;
}
.tp-estimate-card.dark {
  background: #1e293b;
  border-color: #334155;
}
.tp-estimate-label {
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #94a3b8;
  margin-bottom: 2px;
}
.tp-estimate-value {
  font-size: 0.9375rem;
  font-weight: 700;
  color: #0f172a;
}
.dark .tp-estimate-value {
  color: #f1f5f9;
}
.tp-estimate-free {
  color: #16a34a;
}
.dark .tp-estimate-free {
  color: #4ade80;
}
.tp-estimate-model {
  font-size: 0.75rem;
  font-weight: 600;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  word-break: break-all;
}
.tp-estimate-disclaimer {
  font-size: 0.6875rem;
  color: #94a3b8;
  line-height: 1.5;
  font-style: italic;
}
.tp-estimate-disclaimer.dark {
  color: #64748b;
}

/* ─── Step 4: Pre-process ─── */
.tp-output-filename {
  margin-bottom: 20px;
}
.tp-output-filename-row {
  display: flex;
  align-items: center;
  gap: 0;
}
.tp-output-filename-row .tp-config-input {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  flex: 1;
}
.tp-output-ext {
  display: flex;
  align-items: center;
  padding: 0 12px;
  height: 38px;
  background: #e2e8f0;
  border: 1px solid #e2e8f0;
  border-left: none;
  border-radius: 0 6px 6px 0;
  font-size: 0.8125rem;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  color: #64748b;
  font-weight: 600;
}
.dark .tp-output-ext {
  background: #334155;
  border-color: #475569;
  color: #94a3b8;
}

.tp-process-summary {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
  padding: 0;
  margin-bottom: 20px;
  overflow: hidden;
}
.tp-process-summary.dark {
  background: #1e293b;
  border-color: #334155;
}
.tp-process-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #e2e8f0;
}
.tp-process-summary.dark .tp-process-row {
  border-bottom-color: #334155;
}
.tp-process-row:last-child {
  border-bottom: none;
}
.tp-process-label {
  font-size: 0.8125rem;
  color: #64748b;
}
.dark .tp-process-label {
  color: #94a3b8;
}
.tp-process-value {
  font-size: 0.875rem;
  font-weight: 600;
  color: #0f172a;
}
.dark .tp-process-value {
  color: #f1f5f9;
}

.tp-process-ready {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px;
  text-align: center;
  color: #94a3b8;
  font-size: 0.875rem;
}

.tp-process-active {
  padding: 24px;
}
.tp-process-spinner-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.9375rem;
  color: #0284c7;
  font-weight: 500;
}
.dark .tp-process-spinner-row {
  color: #38bdf8;
}
.tp-spinner-lg {
  width: 18px;
  height: 18px;
  border-width: 2.5px;
  border-color: rgba(2, 132, 199, 0.3);
  border-top-color: #0284c7;
}
.dark .tp-spinner-lg {
  border-color: rgba(56, 189, 248, 0.3);
  border-top-color: #38bdf8;
}

.tp-process-done {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 8px;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  color: #166534;
  font-size: 0.875rem;
  line-height: 1.5;
}
.tp-process-done.dark {
  background: #14532d;
  border-color: #166534;
  color: #4ade80;
}
.tp-process-done p {
  margin: 2px 0 0 0;
  font-weight: 400;
}

/* ─── Step 6: Iterate ─── */
.tp-iterate-section {
  margin-bottom: 20px;
}
.tp-iterate-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 40px 20px;
  border: 1px dashed #e2e8f0;
  border-radius: 8px;
  text-align: center;
  color: #94a3b8;
  font-size: 0.875rem;
}
.dark .tp-iterate-placeholder {
  border-color: #334155;
}
</style>
