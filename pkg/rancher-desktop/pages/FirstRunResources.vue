<template>
  <div class="mx-auto p-6 dark:bg-gray-800/30">
    <div v-if="resourceError" class="mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded-md dark:bg-red-900 dark:border-red-600 dark:text-red-100">{{ resourceError }}</div>
    <form @submit.prevent="handleNext">
      <h2 class="text-2xl font-bold mt-5 mb-4 text-gray-900 dark:text-gray-100">Specify AI Resources</h2>
      <p class="mb-6 text-gray-600 dark:text-gray-400">Choose the resources allocated to your AI Agent and the local language model. Your agent and the model and all resources they manage will not be allowed to use more than the allocated resources.</p>

      <div class="mt-10"></div>
      <rd-fieldset
        legend-text="Virtual Machine Resources"
        legend-tooltip="Allocate CPU and memory for the AI services"
        class="mb-6 mt-6 dark:text-gray-100"
      >
        <system-preferences
          :memory-in-g-b="settings!.virtualMachine.memoryInGB"
          :number-c-p-us="settings!.virtualMachine.numberCPUs"
          :avail-memory-in-g-b="availMemoryInGB"
          :avail-num-c-p-us="availNumCPUs"
          :reserved-memory-in-g-b="6"
          :reserved-num-c-p-us="1"
          :is-locked-memory="false"
          :is-locked-cpu="false"
          @update:memory="onMemoryChange"
          @update:cpu="onCpuChange"
        />
      </rd-fieldset>

      <div class="mt-10"></div>

      <rd-fieldset legend-text="AI Model"
        legend-tooltip="Select the LLM model to use. Models are filtered based on your allocated resources."
        class="mb-6 mt-6 dark:text-gray-100"
      >
        <select class="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 mb-2" :class="{ 'border-red-500': !!modelError }" v-model="sullaModel">
          <option
            v-for="model in availableModels"
            :key="model.name"
            :value="model.name"
            :disabled="!model.available"
            :class="{ 'model-disabled': !model.available }"
          >
            {{ model.displayName }} ({{ model.size }}) {{ !model.available ? '- Requires more resources' : '' }}
          </option>
        </select>
        <p class="text-sm text-gray-500 dark:text-gray-400 italic">{{ selectedModelDescription }}</p>
        <p v-if="modelError" class="text-red-500 text-sm mt-1">{{ modelError }}</p>
      </rd-fieldset>

      <div class="mt-10"></div>

      <button type="button" @click="isOptionsOpen = !isOptionsOpen" class="w-full text-left p-2 hover:bg-gray-200 dark:hover:bg-gray-700 dark:text-gray-400 transition-colors text-sm font-medium">
        Options {{ isOptionsOpen ? '▲' : '▼' }}
      </button>

      <Transition name="slide">
        <div v-show="isOptionsOpen" class="mt-2 overflow-hidden">
          <div class="mb-4">
            <label class="flex items-center">
              <input type="checkbox" v-model="enableTelemetry" @change="onTelemetryChange" class="mr-2">
              <span class="text-sm dark:text-gray-400">Allow collection of anonymous statistics to help us improve Sulla Desktop</span>
            </label>
          </div>

          <div class="mb-4">
            <label class="flex items-center">
              <input type="checkbox" v-model="enableKubernetes" @change="onKubernetesChange" class="mr-2">
              <span class="text-sm dark:text-gray-400">Enable Kubernetes Mode (requires more resources)</span>
            </label>
          </div>
        </div>
      </Transition>

      <div class="flex justify-end mt-5">
        <button v-if="showBack" type="button" @click="$emit('back')" class="px-6 py-2 text-gray-500 rounded-md transition-colors font-medium hover:opacity-90 bg-gray-100 hover:bg-gray-200 cursor-pointer">Back</button>
        <button type="submit" class="px-6 py-2 text-white rounded-md transition-colors font-medium hover:opacity-90" :style="{ backgroundColor: '#30a5e9' }">Next</button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, onMounted } from 'vue';
import { Ref } from 'vue';
import os from 'os';
import RdFieldset from '@pkg/components/form/RdFieldset.vue';
import SystemPreferences from '@pkg/components/SystemPreferences.vue';
import { Settings } from '@pkg/config/settings';
import { ipcRenderer } from 'electron';
import { PathManagementStrategy } from '@pkg/integrations/pathManager';
import { highestStableVersion, VersionEntry } from '@pkg/utils/kubeVersions';
import { RecursivePartial } from '@pkg/utils/typeUtils';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

const settings = inject<Ref<Settings>>('settings')!;
const commitChanges = inject<(settings: RecursivePartial<Settings>) => Promise<void>>('commitChanges')!;
const emit = defineEmits<{
  next: [];
  back: [];
}>();

const props = defineProps<{
  showBack?: boolean;
}>();

// Reactive ref for sullaModel
const sullaModel = ref<string>('');

// Reactive ref for telemetry
const enableTelemetry = ref(false);

// Reactive ref for kubernetes mode
const enableKubernetes = ref(false);

// Reactive ref for options accordion
const isOptionsOpen = ref(false);

// Reactive ref for model error
const modelError = ref('');

// Reactive ref for resource error
const resourceError = ref('');

// Set defaults
settings.value.application.pathManagementStrategy = PathManagementStrategy.RcFiles;
settings.value.application.telemetry = { enabled: true };
settings.value.kubernetes.enabled = false;

onMounted(async () => {
  ipcRenderer.invoke('settings-read' as any).then((loadedSettings: Settings) => {
    settings.value = loadedSettings;
    // Ensure defaults are set after loading
    settings.value.application.pathManagementStrategy = PathManagementStrategy.RcFiles;
    settings.value.kubernetes.enabled = false;

    // Set checkbox state from loaded settings
    enableTelemetry.value = settings.value.application.telemetry.enabled;
    enableKubernetes.value = settings.value.kubernetes.enabled;

    // Save the initial settings
    commitChanges({
      application: { pathManagementStrategy: PathManagementStrategy.RcFiles, telemetry: { enabled: enableTelemetry.value } },
      kubernetes: { enabled: enableKubernetes.value },
    });
  });

  // Load sullaModel from SullaSettingsModel
  const loadedModel = await SullaSettingsModel.get('sullaModel', 'qwen3.5-9b');
  sullaModel.value = loadedModel;

  ipcRenderer.send('k8s-versions');
  ipcRenderer.on('k8s-versions', (event, versions: VersionEntry[]) => {
    const recommendedVersions = versions.filter((v: VersionEntry) => !!v.channels);
    const bestVersion = highestStableVersion(recommendedVersions) ?? versions[0];

    if (bestVersion) {
      settings.value.kubernetes.version = bestVersion.version;
      // Save the kubernetes version
      commitChanges({
        kubernetes: { version: bestVersion.version },
      });
    }
  });
});

// GGUF models sorted by resource requirements (smallest to largest)
// Keys match the GGUF_MODELS registry in LlamaCppService.ts
const GGUF_MODELS = [
  {
    name: 'qwen3.5-0.8b', displayName: 'Qwen3.5 0.8B', size: '600MB', minMemoryGB: 1, minCPUs: 1, description: 'Qwen3.5 0.8B \u2014 fast and lightweight',
  },
  {
    name: 'qwen3.5-4b', displayName: 'Qwen3.5 4B', size: '2.7GB', minMemoryGB: 4, minCPUs: 2, description: 'Qwen3.5 4B \u2014 balanced performance and speed',
  },
  {
    name: 'qwen3.5-9b', displayName: 'Qwen3.5 9B', size: '5.6GB', minMemoryGB: 8, minCPUs: 4, description: 'Qwen3.5 9B \u2014 strongest reasoning, recommended',
  },
];

// Dynamic system resources
const availMemoryInGB = computed(() => Math.ceil(os.totalmem() / 2 ** 30));
const availNumCPUs = computed(() => os.cpus().length);
const allocatedMemoryGB = computed(() => settings.value.virtualMachine.memoryInGB);
const allocatedCPUs = computed(() => settings.value.virtualMachine.numberCPUs);

// llama.cpp runs on bare metal — use ~70% of VM memory and ~75% of CPUs for model budget
const modelMemoryGB = computed(() => Math.floor(allocatedMemoryGB.value * 0.7));
const modelCPUs = computed(() => Math.floor(allocatedCPUs.value * 0.75));

const availableModels = computed(() =>
  GGUF_MODELS.map(model => ({
    ...model,
    available: modelMemoryGB.value >= model.minMemoryGB && modelCPUs.value >= model.minCPUs,
  }))
);

const selectedModelDescription = computed(() =>
  availableModels.value.find(m => m.name === sullaModel.value)?.description || ''
);

const onMemoryChange = (value: number) => {
  settings.value.virtualMachine.memoryInGB = value;
  autoSelectBestModel();
};

const onCpuChange = (value: number) => {
  settings.value.virtualMachine.numberCPUs = value;
  autoSelectBestModel();
};

const autoSelectBestModel = () => {
  // If current selection is no longer available, select the best available model
  const currentModel = availableModels.value.find(m => m.name === sullaModel.value);

  if (!currentModel?.available) {
    // Find the best (largest) available model
    const available = availableModels.value.filter(m => m.available);

    if (available.length > 0) {
      sullaModel.value = available[available.length - 1].name;
    } else {
      // Fallback to smallest model
      sullaModel.value = 'qwen3.5-9b';
    }
  }
};

const onKubernetesChange = async () => {
  await commitChanges({
    kubernetes: { enabled: enableKubernetes.value },
  });
};

const onTelemetryChange = async () => {
  await commitChanges({
    application: { telemetry: { enabled: enableTelemetry.value } },
  });
};

const validateModel = () => {
  if (!sullaModel.value || sullaModel.value.trim() === '') {
    modelError.value = 'Please select an AI model.';
    return false;
  }
  modelError.value = '';
  return true;
};

const handleNext = async () => {
  validateModel();  // Always validate to set error

  if ((settings.value as any).virtualMachine.memoryInGB <= 4 || (settings.value as any).virtualMachine.numberCPUs <= 2) {
    resourceError.value = 'Please allocate at least 5GB memory and 3 CPUs for the AI services.';
  } else {
    resourceError.value = '';
  }

  if (modelError.value || resourceError.value) {
    return;
  }

  // Save the VM resources and model choice
  await commitChanges({
    virtualMachine: {
      memoryInGB: (settings.value as any).virtualMachine.memoryInGB,
      numberCPUs: (settings.value as any).virtualMachine.numberCPUs,
    },
  });

  // Save sullaModel to SullaSettingsModel
  await SullaSettingsModel.set('sullaModel', sullaModel.value, 'string');

  emit('next');
};
</script>

<style lang="scss" scoped>
.model-disabled {
  color: var(--disabled);
}

.rd-fieldset {
  width: 100%;
}

.rd-slider {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 2rem;
  margin-bottom: 1rem;
}

.rd-slider-rail {
  flex-grow: 1;
}

.labeled-input .vue-slider {
  margin: 2em 1em;
  flex: 1;
}

/* Basic vue-slider styles */
.vue-slider {
  position: relative;
  width: 100%;
  height: 6px;
  background: #ddd;
  border-radius: 3px;
  cursor: pointer;
}

.vue-slider :deep(.vue-slider-rail) {
  position: relative;
  width: 100%;
  height: 100%;
  background: #ddd;
  border-radius: 3px;
}

.vue-slider :deep(.vue-slider-process) {
  position: absolute;
  height: 100%;
  background: #007bff;
  border-radius: 3px;
  top: 0;
  left: 0;
}

.vue-slider :deep(.vue-slider-mark) {
  position: absolute;
  top: -6px;
  width: 2px;
  height: 18px;
  background: #999;
}

.vue-slider :deep(.vue-slider-mark-step) {
  background: #ccc;
  opacity: 0.5;
}

.vue-slider :deep(.vue-slider-dot) {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 20px;
  height: 20px;
  background: #fff;
  border: 2px solid #007bff;
  border-radius: 50%;
  cursor: grab;
  box-shadow: 0 2px 4px rgba(0,0,0,0.2);
}

.vue-slider :deep(.vue-slider-dot-handle) {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: #007bff;
  cursor: grab;
}

.vue-slider :deep(.vue-slider-dot-handle:active) {
  cursor: grabbing;
}

.slider-input, .slider-input:focus, .slider-input:hover {
  max-width: 6rem;
}

.empty-content {
  display: none;
}

/* Hover effects */
button:hover {
  cursor: pointer;
}

input:hover, select:hover {
  border-color: #374151; /* darker gray border */
  background-color: #f3f4f6; /* slightly darker background */
}

dark input:hover, .dark select:hover {
  background-color: #4b5563 !important; /* darker background for dark mode */
}

/* Slide transition for accordion */
.slide-enter-active,
.slide-leave-active {
  transition: all 0.3s ease;
}

.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  max-height: 0;
}

.slide-enter-to,
.slide-leave-from {
  opacity: 1;
  max-height: 200px;
}
</style>
