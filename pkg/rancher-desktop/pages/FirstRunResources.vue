<template>
  <div class="mx-auto p-6">
    <form @submit.prevent="handleNext">
      <h2 class="text-2xl font-bold mt-5 mb-4 fr-heading">
        Specify AI Resources
      </h2>
      <p class="mb-6 fr-body">
        Choose the resources allocated to your AI Agent and the local language model. Your agent and the model and all resources they manage will not be allowed to use more than the allocated resources.
      </p>

      <div class="mt-10" />
      <rd-fieldset
        legend-text="Virtual Machine Resources"
        legend-tooltip="Allocate CPU and memory for the AI services"
        class="mb-6 mt-6 fr-fieldset"
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

      <div
        v-if="resourceError"
        class="my-4 p-3 border rounded-md fr-error-box"
      >
        {{ resourceError }}
      </div>

      <button
        type="button"
        class="w-full text-left p-2 transition-colors text-sm font-medium fr-btn-toggle"
        @click="isOptionsOpen = !isOptionsOpen"
      >
        Options {{ isOptionsOpen ? '▲' : '▼' }}
      </button>

      <Transition name="slide">
        <div
          v-show="isOptionsOpen"
          class="mt-2 overflow-hidden"
        >
          <div class="mb-4">
            <label class="flex items-center">
              <input
                v-model="enableTelemetry"
                type="checkbox"
                class="mr-2"
                @change="onTelemetryChange"
              >
              <span class="text-sm fr-muted">Allow collection of anonymous statistics to help us improve Sulla Desktop</span>
            </label>
          </div>

          <div class="mb-4">
            <label class="flex items-center">
              <input
                v-model="enableKubernetes"
                type="checkbox"
                class="mr-2"
                @change="onKubernetesChange"
              >
              <span class="text-sm fr-muted">Enable Kubernetes Mode (requires more resources)</span>
            </label>
          </div>
        </div>
      </Transition>

      <div class="flex justify-end mt-5">
        <button
          v-if="showBack"
          type="button"
          class="px-6 py-2 rounded-md transition-colors font-medium hover:opacity-90 cursor-pointer fr-btn-secondary"
          @click="$emit('back')"
        >
          Back
        </button>
        <button
          type="submit"
          class="px-6 py-2 rounded-md transition-colors font-medium hover:opacity-90 fr-btn-primary"
        >
          Next
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, onMounted, Ref } from 'vue';
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

// Reactive ref for telemetry
const enableTelemetry = ref(false);

// Reactive ref for kubernetes mode
const enableKubernetes = ref(false);

// Reactive ref for options accordion
const isOptionsOpen = ref(false);

// Reactive ref for resource error
const resourceError = ref('');

// Set defaults
settings.value.application.pathManagementStrategy = PathManagementStrategy.RcFiles;
settings.value.application.telemetry = { enabled: true };
settings.value.kubernetes.enabled = false;

onMounted(async() => {
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
      kubernetes:  { enabled: enableKubernetes.value },
    });
  });

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

// Dynamic system resources
const availMemoryInGB = computed(() => Math.ceil(os.totalmem() / 2 ** 30));
const availNumCPUs = computed(() => os.cpus().length);

const onMemoryChange = (value: number) => {
  settings.value.virtualMachine.memoryInGB = value;
};

const onCpuChange = (value: number) => {
  settings.value.virtualMachine.numberCPUs = value;
};

const onKubernetesChange = async() => {
  await commitChanges({
    kubernetes: { enabled: enableKubernetes.value },
  });
};

const onTelemetryChange = async() => {
  await commitChanges({
    application: { telemetry: { enabled: enableTelemetry.value } },
  });
};

const handleNext = async() => {
  if ((settings.value as any).virtualMachine.memoryInGB <= 4 || (settings.value as any).virtualMachine.numberCPUs <= 2) {
    resourceError.value = 'Please allocate at least 5GB memory and 3 CPUs for the AI services.';
  } else {
    resourceError.value = '';
  }

  if (resourceError.value) {
    return;
  }

  // Save the VM resources
  await commitChanges({
    virtualMachine: {
      memoryInGB: (settings.value as any).virtualMachine.memoryInGB,
      numberCPUs: (settings.value as any).virtualMachine.numberCPUs,
    },
  });

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
  background: var(--bg-surface-hover);
  border-radius: 3px;
  cursor: pointer;
}

.vue-slider :deep(.vue-slider-rail) {
  position: relative;
  width: 100%;
  height: 100%;
  background: var(--bg-surface-hover);
  border-radius: 3px;
}

.vue-slider :deep(.vue-slider-process) {
  position: absolute;
  height: 100%;
  background: var(--accent-primary);
  border-radius: 3px;
  top: 0;
  left: 0;
}

.vue-slider :deep(.vue-slider-mark) {
  position: absolute;
  top: -6px;
  width: 2px;
  height: 18px;
  background: var(--text-muted);
}

.vue-slider :deep(.vue-slider-mark-step) {
  background: var(--bg-surface-hover);
  opacity: 0.5;
}

.vue-slider :deep(.vue-slider-dot) {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 20px;
  height: 20px;
  background: var(--bg-surface);
  border: 2px solid var(--accent-primary);
  border-radius: 50%;
  cursor: grab;
  box-shadow: 0 2px 4px rgba(0,0,0,0.2);
}

.vue-slider :deep(.vue-slider-dot-handle) {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: var(--accent-primary);
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
  border-color: var(--border-strong);
  background-color: var(--bg-surface-alt);
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

/* Theme-aware color classes */
.fr-heading {
  color: var(--text-primary);
}

.fr-body {
  color: var(--text-secondary);
}

.fr-fieldset {
  color: var(--text-primary);
}

.fr-input {
  background-color: var(--bg-input);
  border-color: var(--border-default);
  color: var(--text-primary);
}

.fr-border-error {
  border-color: var(--border-error);
}

.fr-muted {
  color: var(--text-muted);
}

.fr-error {
  color: var(--text-error);
}

.fr-error-box {
  background-color: var(--bg-error);
  border-color: var(--border-error);
  color: var(--text-error);
}

.fr-btn-toggle {
  color: var(--text-muted);

  &:hover {
    background-color: var(--bg-surface-hover);
  }
}

.fr-btn-secondary {
  color: var(--text-secondary);
  background-color: var(--bg-surface-hover);

  &:hover {
    background-color: var(--bg-elevated);
  }
}

.fr-btn-primary {
  color: var(--text-on-accent);
  background-color: var(--accent-primary);

  &:hover {
    background-color: var(--accent-primary-hover);
  }
}
</style>
