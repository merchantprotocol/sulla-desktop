<template>
  <div
    class="h-full overflow-hidden font-sans page-root"
    :class="{ dark: isDark }"
  >
    <div class="flex h-full flex-col">
      <SimpleHeader
        :is-dark="isDark"
        :toggle-theme="toggleTheme"
        :on-stop="stopApp"
        :home-url="'#/FirstRun'"
      />

      <!-- Main agent interface -->
      <div
        id="chat-scroll-container"
        ref="chatScrollContainer"
        class="flex min-h-0 flex-1 overflow-y-auto"
      >
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          <div class="relative flex w-full max-w-8xl flex-1 justify-center sm:px-2 lg:px-8 xl:px-12">
            <div class="hidden lg:relative lg:block lg:flex-none lg:w-72 xl:w-80 sidebar-bg">
              <div class="sticky top-[15px] pt-[15px] h-[calc(100vh-5rem-15px)] w-full overflow-x-hidden overflow-y-auto">
                <div class="p-4">
                  <h3 class="text-lg font-semibold mb-4 sidebar-title">
                    Installation Steps
                  </h3>
                  <div class="space-y-3">
                    <div
                      v-for="(name, index) in stepNames"
                      :key="index"
                      class="p-4 rounded-lg border-2 transition-all"
                      :class="index === currentStep ? 'step-active' : 'step-inactive'"
                    >
                      <div class="flex items-center">
                        <div
                          class="w-10 h-10 rounded-full flex items-center justify-center mr-4 font-bold text-lg"
                          :class="index === currentStep ? 'step-number-active' : 'step-number-inactive'"
                        >
                          {{ index + 1 }}
                        </div>
                        <div class="flex-1">
                          <div
                            class="text-sm font-semibold"
                            :class="index === currentStep ? 'step-name-active' : 'step-name-inactive'"
                          >
                            {{ name }}
                          </div>
                          <div
                            class="text-xs mt-1"
                            :class="index === currentStep ? 'step-desc-active' : 'step-desc-inactive'"
                          >
                            {{ index === currentStep ? 'In Progress' : index < currentStep ? 'Completed' : 'Pending' }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div
                    v-if="currentStep > 0 && currentStep < 3 && (startupController.state.progressMax.value > 0 || startupController.state.progressMax.value === -1)"
                    class="mt-6 p-4 rounded-lg progress-container"
                  >
                    <h4 class="text-sm font-semibold mb-2 progress-title">
                      Startup Progress
                    </h4>
                    <div class="w-full rounded-full h-2.5 mb-2 progress-track">
                      <div
                        class="h-2.5 rounded-full progress-bar"
                        :style="{ width: `${progressPercent}%` }"
                      />
                    </div>
                    <p class="text-xs progress-description">
                      {{ startupController.state.progressDescription }}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div class="max-w-[768px] min-w-0 flex-auto px-4 lg:pr-0 lg:pl-8 xl:px-16">
              <div
                id="chat-messages-list"
                ref="transcriptEl"
                class="pb-40"
              >
                <component
                  :is="steps[currentStep]"
                  :startup-controller="startupController"
                  :show-back="currentStep > 0"
                  @next="next"
                  @back="back"
                />
              </div>
            </div>

            <div class="hidden xl:sticky xl:top-0 xl:-mr-6 xl:block xl:max-h-[calc(100vh-12rem)] xl:flex-none xl:overflow-y-auto xl:pr-6">
              <div class="w-72" />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, provide, computed } from 'vue';

import FirstRunRemoteModel from './FirstRunRemoteModel.vue';
import FirstRunResources from './FirstRunResources.vue';
import FirstRunWaiting from './FirstRunWaiting.vue';
import FirstRunWelcome from './FirstRunWelcome.vue';
import SimpleHeader from './agent/SimpleHeader.vue';
import { StartupProgressController } from './agent/StartupProgressController';

import { useTheme } from '@pkg/composables/useTheme';
import { defaultSettings, Settings } from '@pkg/config/settings';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { RecursivePartial } from '@pkg/utils/typeUtils';

const { isDark, toggleTheme } = useTheme();

const currentStep = ref(0);
const stepNames = ['Resources', 'Account', 'Remote Model', 'Waiting'];
const steps = [FirstRunResources, FirstRunWelcome, FirstRunRemoteModel, FirstRunWaiting];

const settings = ref(defaultSettings);

const startupController = new StartupProgressController(StartupProgressController.createState());

const stopApp = async() => {
  await ipcRenderer.invoke('app-quit');
};

// Prevent overlay in first-run view
startupController.state.showOverlay.value = false;

// Listen to backend progress updates and forward to startupController
ipcRenderer.on('k8s-progress', (event, progress) => {
  if (progress && startupController.state) {
    startupController.state.progressCurrent.value = progress.current || 0;
    startupController.state.progressMax.value = progress.max || 100;
    startupController.state.progressDescription.value = progress.description || '';
  }
});

const progressPercent = computed(() => {
  const percent = (startupController.state.progressCurrent.value / Math.max(startupController.state.progressMax.value, 1)) * 100;
  console.log('[FirstRun] progressPercent computed:', percent, 'current:', startupController.state.progressCurrent.value, 'max:', startupController.state.progressMax.value);
  return percent;
});

provide('settings', settings);

const next = async() => {
  console.log('[FirstRun] next() called, currentStep before:', currentStep.value);

  currentStep.value += 1;
  console.log('[FirstRun] currentStep after:', currentStep.value);
  ipcRenderer.invoke('first-run-wizard-step', currentStep.value);
  if (currentStep.value === 1) {
    console.log('[FirstRun] starting controller');
    startupController.start();
    await ipcRenderer.invoke('start-backend' as any);
  }
};

const back = () => {
  console.log('[FirstRun] back() called, currentStep before:', currentStep.value);
  if (currentStep.value > 0) {
    currentStep.value -= 1;
    console.log('[FirstRun] currentStep after:', currentStep.value);
  }
};

const commitChanges = async(settings: RecursivePartial<Settings>) => {
  try {
    return await ipcRenderer.invoke('settings-write' as any, settings);
  } catch (ex) {
    console.log('settings-write failed:', ex);
  }
};

provide('commitChanges', commitChanges);

// Expose for template
defineExpose({ isDark, toggleTheme, stepNames, currentStep, steps, next });
</script>
<style lang="scss" scoped>
.page-root {
  background: var(--bg-page, var(--body-bg, #ffffff));
  color: var(--text-primary, var(--body-text, #1f2937));
}

.page-root.dark {
  background: var(--bg-page, #0d1117);
  color: var(--text-primary, #e6edf3);
}

.button-area {
  align-self: flex-end;
  margin-top: 1.5rem;
}

.welcome-text {
  color: var(--text-primary, var(--body-text, #1f2937));
  margin-bottom: 1rem;
  line-height: 1.5;
}

.dark .welcome-text {
  color: var(--text-primary, #e6edf3);
}

.first-run-container {
  width: 30rem;
}

.model-select {
  width: 100%;
  padding: 0.5rem;
  font-size: var(--fs-body);
  border: 1px solid var(--border-default, var(--header-border, #e5e7eb));
  border-radius: 4px;
  background: var(--bg-input, var(--input-bg, #ffffff));
  color: var(--text-primary, var(--body-text, #1f2937));
  margin-top: 0.5rem;

  option {
    padding: 0.5rem;
  }

  option:disabled {
    color: var(--text-dim, var(--muted, #9ca3af));
    font-style: italic;
  }
}

.dark .model-select {
  background: var(--bg-input, #21262d);
  color: var(--text-primary, #e6edf3);
  border-color: var(--border-default, #30363d);
}

.model-description {
  margin-top: 0.5rem;
  font-size: var(--fs-code);
  color: var(--text-muted, var(--muted, #6b7280));
  font-style: italic;
}

.dark .model-description {
  color: var(--text-muted, #8b949e);
}

.model-disabled {
  color: var(--text-dim, var(--muted, #9ca3af));
}

.dark .model-disabled {
  color: var(--text-dim, #6e7681);
}

/* Sidebar */
.sidebar-bg {
  background: var(--bg-surface, var(--body-bg, #f9fafb));
}

.dark .sidebar-bg {
  background: var(--bg-surface, #161b22);
}

.sidebar-title {
  color: var(--text-primary, var(--body-text, #1f2937));
}

.dark .sidebar-title {
  color: var(--text-primary, #e6edf3);
}

/* Step items */
.step-active {
  background: var(--bg-surface-alt, #eff6ff);
  border-color: var(--accent-primary, #3b82f6);
}

.dark .step-active {
  background: var(--bg-surface-alt, #1c2026);
  border-color: var(--accent-primary, #58a6ff);
}

.step-inactive {
  background: var(--bg-surface, var(--body-bg, #ffffff));
  border-color: var(--border-default, var(--header-border, #e5e7eb));
}

.dark .step-inactive {
  background: var(--bg-surface, #161b22);
  border-color: var(--border-default, #30363d);
}

.step-number-active {
  background-color: var(--accent-primary, #3b82f6);
  color: #fff;
}

.dark .step-number-active {
  background-color: var(--accent-primary, #58a6ff);
}

.step-number-inactive {
  background-color: var(--bg-surface-hover, #f3f4f6);
  color: var(--text-primary, var(--body-text, #1f2937));
}

.dark .step-number-inactive {
  background-color: var(--bg-surface-hover, #21262d);
  color: var(--text-primary, #e6edf3);
}

.step-name-active {
  color: var(--accent-primary, #3b82f6);
}

.dark .step-name-active {
  color: var(--accent-primary, #58a6ff);
}

.step-name-inactive {
  color: var(--text-secondary, var(--muted, #4b5563));
}

.dark .step-name-inactive {
  color: var(--text-secondary, #8b949e);
}

.step-desc-active {
  color: var(--text-muted, var(--muted, #6b7280));
}

.dark .step-desc-active {
  color: var(--text-muted, #8b949e);
}

.step-desc-inactive {
  color: var(--text-dim, var(--muted, #9ca3af));
}

.dark .step-desc-inactive {
  color: var(--text-dim, #6e7681);
}

/* Progress */
.progress-container {
  background: var(--bg-surface, var(--body-bg, #f9fafb));
}

.dark .progress-container {
  background: var(--bg-surface, #161b22);
}

.progress-title {
  color: var(--text-primary, var(--body-text, #1f2937));
}

.dark .progress-title {
  color: var(--text-primary, #e6edf3);
}

.progress-track {
  background: var(--bg-surface-hover, #e5e7eb);
}

.dark .progress-track {
  background: var(--bg-surface-hover, #21262d);
}

.progress-bar {
  background-color: var(--accent-primary, #3b82f6);
}

.dark .progress-bar {
  background-color: var(--accent-primary, #58a6ff);
}

.progress-description {
  color: var(--text-muted, var(--muted, #6b7280));
}

.dark .progress-description {
  color: var(--text-muted, #8b949e);
}
</style>

<style lang="scss">
html {
  height: initial;
}

:root {
  --progress-bg: var(--bg-surface-hover);
  --scrollbar-thumb: var(--text-muted);
  --darker: var(--text-dim);
  --error: var(--text-error);
  --checkbox-tick-disabled: var(--text-muted);
}
</style>
