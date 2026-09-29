<template>
  <div class="frw p-6">
    <form @submit.prevent="handleNext">
      <div class="frw-eyebrow">
        Welcome to Sulla
      </div>
      <h1 class="frw-title">
        Let's get your first automation running.
      </h1>
      <p class="frw-lead">
        Sulla is your executive assistant. You describe a job in plain English, and Sulla builds the automation,
        runs it on schedule, and keeps it working. Setup takes a few minutes.
      </p>

      <div class="frw-how">
        <div>
          <span class="frw-num">1</span>
          <b>Create your account</b>
          <span>A master password keeps your saved logins encrypted on this computer.</span>
        </div>
        <div>
          <span class="frw-num">2</span>
          <b>Choose your AI</b>
          <span>Sign in with your Claude, ChatGPT or Grok subscription. No API keys.</span>
        </div>
        <div>
          <span class="frw-num">3</span>
          <b>Pick your first job</b>
          <span>Choose a starter automation and Sulla sets it up for you.</span>
        </div>
      </div>

      <div class="frw-resources">
        <div>
          <b>Sulla will use {{ settings!.virtualMachine.memoryInGB }} GB of memory and {{ settings!.virtualMachine.numberCPUs }} CPUs</b>
          <span>Recommended for this computer. Sulla's agents work inside this private, sandboxed space.</span>
        </div>
        <button
          type="button"
          class="frw-link"
          @click="isOptionsOpen = !isOptionsOpen"
        >
          {{ isOptionsOpen ? 'Done' : 'Adjust' }}
        </button>
      </div>

      <Transition name="slide">
        <div
          v-show="isOptionsOpen"
          class="mt-2 overflow-hidden"
        >
          <rd-fieldset
            legend-text="Memory and CPUs"
            legend-tooltip="Allocate CPU and memory for the AI services"
            class="mb-4 mt-2 fr-fieldset"
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

          <div class="mb-3">
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

          <div class="mb-3">
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

      <div
        v-if="resourceError"
        class="my-4 p-3 border rounded-md fr-error-box"
      >
        {{ resourceError }}
      </div>

      <div class="frw-actions">
        <button
          type="submit"
          class="frw-btn"
        >
          Get started →
        </button>
        <span class="frw-trust">🔒 Your data, memory and passwords stay on this computer.</span>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import os from 'os';

import { ipcRenderer } from 'electron';
import { ref, computed, inject, onMounted, Ref } from 'vue';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import SystemPreferences from '@pkg/components/SystemPreferences.vue';
import RdFieldset from '@pkg/components/form/RdFieldset.vue';
import { Settings } from '@pkg/config/settings';
import { PathManagementStrategy } from '@pkg/integrations/pathManager';
import { highestStableVersion, VersionEntry } from '@pkg/utils/kubeVersions';
import { RecursivePartial } from '@pkg/utils/typeUtils';

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

    applyRecommendedResources();

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

// Minimums the AI services need (enforced in handleNext).
const MIN_MEMORY_GB = 5;
const MIN_CPUS = 3;

/**
 * Pick sensible VM resources so nobody has to understand sliders before they
 * see any value: half the machine, clamped to the service minimums and a
 * reasonable ceiling. Existing allocations that already meet the minimums are
 * kept, so re-running setup never shrinks a user's choice.
 */
function applyRecommendedResources() {
  const vm = settings.value.virtualMachine;

  if (vm.memoryInGB < MIN_MEMORY_GB) {
    vm.memoryInGB = Math.min(Math.max(MIN_MEMORY_GB, Math.floor(availMemoryInGB.value / 2)), 16);
  }
  if (vm.numberCPUs < MIN_CPUS) {
    vm.numberCPUs = Math.min(Math.max(MIN_CPUS, Math.floor(availNumCPUs.value / 2)), 8);
  }
}

// Show the recommendation immediately; settings-read re-applies it to the loaded values.
applyRecommendedResources();

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
  if (settings.value.virtualMachine.memoryInGB < MIN_MEMORY_GB || settings.value.virtualMachine.numberCPUs < MIN_CPUS) {
    resourceError.value = `Sulla needs at least ${ MIN_MEMORY_GB } GB of memory and ${ MIN_CPUS } CPUs. Use Adjust to raise them.`;
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

/* ---- welcome ---- */
.frw-eyebrow {
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--accent-primary, #3d7fa0);
  margin-top: 8px;
}

.frw-title {
  font-size: 34px;
  line-height: 1.12;
  font-weight: 800;
  letter-spacing: -.02em;
  margin: 10px 0 12px;
  color: var(--text-primary, #0f172a);
}

.frw-lead {
  font-size: 16px;
  line-height: 1.6;
  color: var(--text-secondary, #475569);
  max-width: 620px;
}

.frw-how {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin: 24px 0;

  > div {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 14px;
    border: 1px solid var(--border-default, #e2e8f0);
    border-radius: 12px;
    background: var(--bg-surface-alt, #f8fafc);
    font-size: 13.5px;
    color: var(--text-secondary, #475569);
  }

  b {
    color: var(--text-primary, #0f172a);
    font-size: 14.5px;
  }
}

.frw-num {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 800;
  color: var(--accent-primary, #3d7fa0);
  background: var(--bg-surface-hover, #e4f0f6);
  margin-bottom: 4px;
}

.frw-resources {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px dashed var(--border-default, #cbd5e1);
  font-size: 13.5px;
  color: var(--text-muted, #64748b);

  > div { display: flex; flex-direction: column; gap: 2px; flex: 1; }

  b { color: var(--text-primary, #0f172a); font-size: 14px; }
}

.frw-link {
  background: none;
  border: none;
  color: var(--accent-primary, #3d7fa0);
  font-weight: 700;
  cursor: pointer;
  font-size: 14px;
}

.frw-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 24px;
}

.frw-btn {
  padding: 12px 22px;
  border-radius: 11px;
  font-weight: 700;
  font-size: 15px;
  color: #fff;
  background: var(--accent-primary, #3d7fa0);
  border: none;
  cursor: pointer;

  &:hover { filter: brightness(1.06); }
}

.frw-trust {
  font-size: 13px;
  color: var(--text-muted, #64748b);
}
</style>
