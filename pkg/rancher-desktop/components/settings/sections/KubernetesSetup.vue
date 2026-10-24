<script setup lang="ts">
import os from 'os';

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import PrefChoice from '../PrefChoice.vue';
import PrefIcon from '../PrefIcon.vue';
import PrefToggle from '../PrefToggle.vue';
import { fieldValue } from '../fieldValue';

import { useEngineSettings } from '@pkg/composables/preferences/useEngineSettings';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { highestStableVersion, type VersionEntry } from '@pkg/utils/kubeVersions';

const props = defineProps<{ versions: VersionEntry[], cachedOnly: boolean, state: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { get, setMany, held, applyHeld, error } = useEngineSettings();

const isWindows = os.platform() === 'win32';
const step = ref(1);
const chosen = ref(get<string>('kubernetes.version') || '');
const options = ref({
  traefik:       get<boolean>('kubernetes.options.traefik') ?? true,
  flannel:       get<boolean>('kubernetes.options.flannel') ?? true,
  localhostOnly: !!get<boolean>('kubernetes.ingress.localhostOnly'),
  showServices:  !!get<boolean>('portForwarding.includeKubernetesServices'),
  port:          get<number>('kubernetes.port') || 6443,
});
const progress = ref<{ current: number, max: number, description?: string }>({ current: 0, max: 0 });
const seen = ref<string[]>([]);
const startedAt = ref(0);
const tookSeconds = ref(0);

const recommended = computed(() => props.versions.filter(v => !!v.channels?.length));
const others = computed(() => props.versions.filter(v => !v.channels?.length));
const stable = computed(() => highestStableVersion(recommended.value)?.version);

const recommendedOptions = computed(() => recommended.value.slice(0, 3).map(v => {
  const channels = (v.channels ?? []).filter(ch => !/^v?\d+/.test(ch));

  return {
    value:    v.version,
    title:    `v${ v.version }`,
    subtitle: v.version === stable.value ? 'Stable. Matches most managed clusters today.' : channels.includes('latest') ? 'Latest release.' : 'Older, still supported.',
    tag:      v.version === stable.value ? 'Recommended' : '',
  };
}));

watch(() => props.versions, () => {
  if (!chosen.value || !props.versions.some(v => v.version === chosen.value)) {
    chosen.value = stable.value ?? props.versions[0]?.version ?? '';
  }
}, { immediate: true });

const percent = computed(() => progress.value.max > 0 ? Math.round((progress.value.current / progress.value.max) * 100) : 0);

watch(() => props.state, (state) => {
  if (step.value === 3 && state === 'STARTED') {
    tookSeconds.value = Math.max(1, Math.round((Date.now() - startedAt.value) / 1000));
    step.value = 4;
  }
});

function onProgress(_event: unknown, next: { current: number, max: number, description?: string }) {
  progress.value = next;
  if (next.description && seen.value[seen.value.length - 1] !== next.description) {
    seen.value.push(next.description);
  }
}

async function turnOn() {
  await setMany({
    'kubernetes.enabled':                       true,
    'kubernetes.version':                       chosen.value,
    'kubernetes.port':                          Number(options.value.port) || 6443,
    'kubernetes.options.traefik':               options.value.traefik,
    'kubernetes.options.flannel':               options.value.flannel,
    'portForwarding.includeKubernetesServices': options.value.showServices,
    ...(isWindows ? { 'kubernetes.ingress.localhostOnly': options.value.localhostOnly } : {}),
  });
  if (error.value) {
    return;
  }
  // The user asked to start it, so apply now instead of waiting for the restart bar.
  if (held.value) {
    await applyHeld();
  }
  if (!held.value && !error.value) {
    startedAt.value = Date.now();
    seen.value = [];
    step.value = 3;
  }
}

onMounted(() => {
  ipcRenderer.on('k8s-progress', onProgress);
});
onBeforeUnmount(() => ipcRenderer.removeListener('k8s-progress', onProgress));
</script>

<template>
  <div
    class="scrim"
    @click.self="step !== 3 && emit('close')"
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="k8s-setup-title"
    >
      <div class="mh">
        <h2 id="k8s-setup-title">
          {{ step === 4 ? 'All set' : 'Turn on Kubernetes' }}
        </h2>
        <p v-if="step < 4">
          {{ ['', 'Pick the Kubernetes version your project targets.', 'These can all be changed later in Kubernetes settings.', 'This takes about a minute.'][step] }}
        </p>
      </div>
      <div
        v-if="step < 4"
        class="steps"
      >
        <div
          v-for="(label, i) in ['Version', 'Options', 'Start']"
          :key="label"
          :class="{ on: step === i + 1, done: step > i + 1 }"
        >
          <i>{{ step > i + 1 ? '✓' : i + 1 }}</i>{{ label }}
        </div>
      </div>

      <div class="mb">
        <template v-if="step === 1">
          <PrefChoice
            v-if="recommendedOptions.length"
            v-model="chosen"
            :options="recommendedOptions"
          />
          <div
            v-if="others.length"
            class="k"
            style="margin-top: 12px"
          >
            <span class="muted">Other version</span>
            <select
              class="sel"
              aria-label="Other Kubernetes version"
              :value="others.some(v => v.version === chosen) ? chosen : ''"
              @change="chosen = fieldValue($event) || chosen"
            >
              <option value="">
                Choose…
              </option>
              <option
                v-for="v in others"
                :key="v.version"
                :value="v.version"
              >
                v{{ v.version }}
              </option>
            </select>
          </div>
          <p
            v-if="!versions.length"
            class="muted"
          >
            Loading the list of versions…
          </p>
          <div
            class="lst"
            style="margin-top: 14px"
          >
            <div><span class="dot" />Docker has {{ get('virtualMachine.memoryInGB') }} GB of memory. Kubernetes needs about 1 GB of it.</div>
            <div v-if="cachedOnly">
              <span class="dot warn" />Sulla is offline, so only versions already downloaded are listed.
            </div>
          </div>
        </template>

        <div
          v-else-if="step === 2"
          class="lst"
        >
          <div>
            <span style="flex: 1"><b>Traefik ingress</b><br><span class="dimc">Routes http://*.localhost to your services.</span></span>
            <PrefToggle
              v-model="options.traefik"
              label="Traefik ingress"
            />
          </div>
          <div>
            <span style="flex: 1"><b>Flannel networking</b><br><span class="dimc">Leave on unless you bring your own network plugin.</span></span>
            <PrefToggle
              v-model="options.flannel"
              label="Flannel networking"
            />
          </div>
          <div>
            <span style="flex: 1"><b>Only reachable from this Mac</b><template v-if="!isWindows"><br><span class="dimc">Windows only today.</span></template></span>
            <PrefToggle
              v-model="options.localhostOnly"
              :disabled="!isWindows"
              label="Only reachable from this computer"
            />
          </div>
          <div>
            <span style="flex: 1"><b>Show services in Docker › Ports</b></span>
            <PrefToggle
              v-model="options.showServices"
              label="Show services in Docker › Ports"
            />
          </div>
          <div>
            <span style="flex: 1"><b>API port</b></span>
            <input
              v-model.number="options.port"
              class="inp sm"
              type="number"
              min="1"
              max="65535"
              aria-label="Kubernetes API port"
            >
          </div>
        </div>

        <template v-else-if="step === 3">
          <ul class="prog">
            <li
              v-for="(line, i) in seen"
              :key="i"
              :class="i === seen.length - 1 && state !== 'STARTED' ? 'run' : 'done'"
            >
              <span class="s"><PrefIcon
                v-if="i < seen.length - 1 || state === 'STARTED'"
                name="check"
              /></span>{{ line }}
            </li>
            <li
              v-if="!seen.length"
              class="run"
            >
              <span class="s" />Starting Kubernetes v{{ chosen }}
            </li>
          </ul>
          <div
            class="bar"
            style="margin-top: 12px; height: 6px"
          >
            <i :style="{ width: `${ percent }%` }" />
          </div>
          <p
            v-if="state === 'ERROR'"
            class="badc"
            style="margin-top: 10px"
          >
            Kubernetes didn’t start. Check the logs under Advanced › Troubleshooting.
          </p>
        </template>

        <template v-else>
          <div class="big-ok">
            <span class="ic"><PrefIcon name="check" /></span>
            <div>
              <b style="font-size: 15px">Kubernetes is running</b>
              <div class="muted">
                v{{ chosen }} · started in {{ tookSeconds }} seconds
              </div>
            </div>
          </div>
          <div
            class="muted"
            style="margin-bottom: 6px"
          >
            Try it from Terminal:
          </div>
          <div class="code">
            kubectl get pods -A
          </div>
        </template>

        <p
          v-if="error && step < 3"
          class="badc"
          style="margin-top: 10px"
        >
          {{ error }}
        </p>
      </div>

      <div class="mf">
        <template v-if="step === 1">
          <button
            type="button"
            class="btn ghost"
            @click="emit('close')"
          >
            Cancel
          </button>
          <div class="r">
            <button
              type="button"
              class="btn pri"
              :disabled="!chosen"
              @click="step = 2"
            >
              Continue
            </button>
          </div>
        </template>
        <template v-else-if="step === 2">
          <button
            type="button"
            class="btn ghost"
            @click="step = 1"
          >
            Back
          </button>
          <div class="r">
            <button
              type="button"
              class="btn pri"
              @click="turnOn"
            >
              <PrefIcon name="power" />Turn on Kubernetes
            </button>
          </div>
        </template>
        <template v-else-if="step === 3">
          <span class="dimc">You can close this. Sulla keeps going.</span>
          <div class="r">
            <button
              type="button"
              class="btn"
              @click="emit('close')"
            >
              Hide
            </button>
          </div>
        </template>
        <template v-else>
          <span />
          <div class="r">
            <button
              type="button"
              class="btn pri"
              @click="emit('close')"
            >
              Done
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
