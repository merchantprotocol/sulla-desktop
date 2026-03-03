<template>
  <div class="h-screen overflow-hidden bg-white text-[#0d0d0d] dark:bg-slate-900 dark:text-neutral-50 font-sans" :class="{ dark: isDark }">
    <PostHogTracker page-name="FirstRun" />
    <div class="flex h-screen flex-col">

      <SimpleHeader :is-dark="isDark" :toggle-theme="toggleTheme" :on-stop="stopApp" :home-url="'#/FirstRun'"/>

      <!-- Main agent interface -->
      <div ref="chatScrollContainer" id="chat-scroll-container" class="flex min-h-0 flex-1 overflow-y-auto">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          <div class="relative flex w-full max-w-8xl flex-1 justify-center sm:px-2 lg:px-8 xl:px-12">
            <div class="hidden lg:relative lg:block lg:flex-none lg:w-72 xl:w-80 bg-slate-50 dark:bg-slate-800/30">
              <div class="sticky top-[15px] pt-[15px] h-[calc(100vh-5rem-15px)] w-full overflow-x-hidden overflow-y-auto">

                <div class="p-4">
                  <h3 class="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-4">Installation Steps</h3>
                  <div class="space-y-3">
                    <div v-for="(name, index) in stepNames" :key="index" class="p-4 rounded-lg border-2 transition-all" :class="index === currentStep ? 'bg-blue-50 dark:bg-blue-900/20' : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800'" :style="index === currentStep ? { borderColor: '#30a5e9' } : {}">
                      <div class="flex items-center">
                        <div class="w-10 h-10 rounded-full flex items-center justify-center mr-4 font-bold text-lg" :class="index === currentStep ? 'text-white' : 'bg-gray-300 dark:bg-gray-600 text-gray-800 dark:text-gray-200'" :style="index === currentStep ? { backgroundColor: '#30a5e9' } : {}">{{ index + 1 }}</div>
                        <div class="flex-1">
                          <div class="text-sm font-semibold" :class="index === currentStep ? '' : 'text-gray-700 dark:text-gray-300'" :style="index === currentStep ? { color: '#30a5e9' } : {}">{{ name }}</div>
                          <div class="text-xs mt-1" :class="index === currentStep ? '' : 'text-gray-500 dark:text-gray-400'" :style="index === currentStep ? { color: '#7d8f99' } : {}">
                            {{ index === currentStep ? 'In Progress' : index < currentStep ? 'Completed' : 'Pending' }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div v-if="currentStep > 0 && currentStep < 3 && (startupController.state.progressMax.value > 0 || startupController.state.progressMax.value === -1)" class="mt-6 p-4 bg-gray-100 dark:bg-gray-800 rounded-lg">
                    <h4 class="text-sm font-semibold mb-2 dark:text-gray-100">Startup Progress</h4>
                    <div class="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 mb-2">
                      <div class="h-2.5 rounded-full" :style="{ width: `${progressPercent}%`, backgroundColor: '#30a5e9' }"></div>
                    </div>
                    <p class="text-xs text-gray-600 dark:text-gray-400">{{ startupController.state.progressDescription }}</p>

                  </div>
                </div>

              </div>
            </div>

            <div class="max-w-2xl min-w-0 flex-auto px-4 lg:max-w-none lg:pr-0 lg:pl-8 xl:px-16">
              <div ref="transcriptEl" id="chat-messages-list" class="pb-40">
                <component :is="steps[currentStep]" @next="next" @back="back" :startup-controller="startupController" :show-back="currentStep > 0" />
              </div>
            </div>

            <div class="hidden xl:sticky xl:top-0 xl:-mr-6 xl:block xl:max-h-[calc(100vh-12rem)] xl:flex-none xl:overflow-y-auto xl:pr-6">
              <div class="w-72">

              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, provide, onMounted, computed } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { defaultSettings, Settings } from '@pkg/config/settings';
import PostHogTracker from '@pkg/components/PostHogTracker.vue';

import FirstRunResources from './FirstRunResources.vue';
import FirstRunWelcome from './FirstRunWelcome.vue';
import FirstRunRemoteModel from './FirstRunRemoteModel.vue';
import FirstRunWaiting from './FirstRunWaiting.vue';
import { RecursivePartial } from '@pkg/utils/typeUtils';

import { StartupProgressController } from './agent/StartupProgressController';

import SimpleHeader from './agent/SimpleHeader.vue';

const THEME_STORAGE_KEY = 'agentTheme';

const isDark = ref(false);

const toggleTheme = () => {
  isDark.value = !isDark.value;
  localStorage.setItem(THEME_STORAGE_KEY, isDark.value ? 'dark' : 'light');
};

const currentStep = ref(0);
const stepNames = ['Resources', 'Account', 'Remote Model', 'Waiting'];
const steps = [FirstRunResources, FirstRunWelcome, FirstRunRemoteModel, FirstRunWaiting];

const settings = ref(defaultSettings);

const startupController = new StartupProgressController(StartupProgressController.createState());

const stopApp = async () => {
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

onMounted(() => {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    isDark.value = saved === 'dark';
  } catch {
    isDark.value = false;
  }
});

provide('settings', settings);

const next = async () => {
  console.log('[FirstRun] next() called, currentStep before:', currentStep.value);

  currentStep.value += 1;
  console.log('[FirstRun] currentStep after:', currentStep.value);
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

const commitChanges = async (settings: RecursivePartial<Settings>) => {
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
.button-area {
  align-self: flex-end;
  margin-top: 1.5rem;
}

.welcome-text {
  color: var(--body-text);
  margin-bottom: 1rem;
  line-height: 1.5;
}

.first-run-container {
  width: 30rem;
}

.model-select {
  width: 100%;
  padding: 0.5rem;
  font-size: 0.9rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--input-bg);
  color: var(--input-text);
  margin-top: 0.5rem;

  option {
    padding: 0.5rem;
  }

  option:disabled {
    color: var(--disabled);
    font-style: italic;
  }
}

.model-description {
  margin-top: 0.5rem;
  font-size: 0.85rem;
  color: var(--muted);
  font-style: italic;
}

.model-disabled {
  color: var(--disabled);
}
</style>

<style lang="scss">
html {
  height: initial;
}

:root {
  --progress-bg: #ddd;
  --scrollbar-thumb: #999;
  --darker: #666;
  --error: #dc3545;
  --checkbox-tick-disabled: #999;
}

.dark {
  --progress-bg: #333;
  --scrollbar-thumb: #666;
  --darker: #333;
  --error: #dc3545;
  --checkbox-tick-disabled: #666;
}
</style>