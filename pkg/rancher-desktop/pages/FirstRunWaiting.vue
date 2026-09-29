<template>
  <div class="frw-container max-w-lg mx-0 p-6">
    <h2 class="frw-title text-2xl font-bold mt-5 mb-4">
      You're all set. Finishing setup…
    </h2>
    <p class="frw-subtitle mb-3">
      Sulla is preparing its private workspace. The first time takes a few minutes, depending on your internet speed.
      Please leave this window open until it finishes.
    </p>
    <p class="frw-subtitle mb-6">
      When it's ready, you'll sign in to {{ provider?.name || 'your AI' }} and Sulla opens. If you picked a first automation, it's waiting in the chat box. Press Enter to start it.
    </p>

    <div class="frw-signin mt-6 p-4 rounded-lg">
      <h4 class="frw-title text-sm font-semibold mb-2">
        Sign in to {{ provider?.name || 'your AI' }}
      </h4>
      <div
        v-if="!provider"
        class="flex flex-wrap gap-2"
      >
        <button
          v-for="p in otherProviders"
          :key="p.id"
          type="button"
          class="px-4 py-2 rounded-md font-medium frw-btn-secondary"
          @click="switchTo(p.id)"
        >
          Sign in with {{ p.name }}
        </button>
      </div>
      <p
        v-else-if="signInState === 'waiting'"
        class="frw-muted text-sm"
      >
        The sign-in window opens as soon as your workspace is ready.
      </p>
      <p
        v-else-if="signInState === 'signing-in'"
        class="frw-muted text-sm"
      >
        Finish signing in with your {{ provider.plan }} account in the window that just opened.
      </p>
      <p
        v-else-if="signInState === 'done'"
        class="frw-success text-sm"
      >
        Signed in to {{ provider.name }}. Opening Sulla…
      </p>
      <template v-else-if="signInState === 'failed'">
        <p class="frw-error text-sm mb-3">
          {{ signInError }}
        </p>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="px-4 py-2 rounded-md font-medium frw-btn-accent"
            @click="signIn"
          >
            Sign in with {{ provider.name }}
          </button>
          <button
            v-for="p in otherProviders"
            :key="p.id"
            type="button"
            class="px-4 py-2 rounded-md font-medium frw-btn-secondary"
            @click="switchTo(p.id)"
          >
            Use {{ p.name }} instead
          </button>
        </div>
      </template>
    </div>

    <div class="frw-progress-box mt-6 p-4 rounded-lg">
      <h4 class="frw-title text-sm font-semibold mb-2">
        Startup Progress
      </h4>
      <div class="frw-progress-track w-full rounded-full h-2.5 mb-2">
        <div
          class="frw-progress-bar h-2.5 rounded-full"
          :style="{ width: `${progressPercent}%` }"
        />
      </div>
      <p class="frw-muted text-xs">
        {{ progressDescription || startupController.state.progressDescription }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineProps, onMounted, onUnmounted, ref } from 'vue';

import { StartupProgressController } from './agent/StartupProgressController';
import {
  FIRST_RUN_AI_PROVIDERS, FIRST_RUN_AI_PROVIDER_KEY, getFirstRunAiProvider, signInFirstRunAi, type FirstRunAiProviderId,
} from './firstRunAiProviders';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{
  startupController: StartupProgressController;
}>();

const progressPercent = ref(0);
const progressDescription = ref('');

const updateProgress = (event: any, progress: { current: number; max: number; description?: string }) => {
  if (progress.max > 0) {
    const current = Number(progress.current);
    const max = Number(progress.max);
    progressPercent.value = (current / max) * 100;
    if (progress.description) {
      progressDescription.value = progress.description;
    }
  }
};

// ─── AI sign-in ──────────────────────────────────────────────────
// Sign-in needs the VM and the database, so it waits for main's
// 'first-run-ai:ready'. The wizard stays open until it succeeds.
const providerId = ref<FirstRunAiProviderId | ''>('');
const provider = computed(() => getFirstRunAiProvider(providerId.value));
const otherProviders = computed(() => FIRST_RUN_AI_PROVIDERS.filter(p => p.id !== providerId.value));
const signInState = ref<'waiting' | 'signing-in' | 'done' | 'failed'>('waiting');
const signInError = ref('');
let workspaceReady = false;

const signIn = async() => {
  if (!provider.value || !workspaceReady || signInState.value === 'signing-in' || signInState.value === 'done') return;
  signInState.value = 'signing-in';
  signInError.value = '';
  const err = await signInFirstRunAi(provider.value.id);

  if (err) {
    signInError.value = err;
    signInState.value = 'failed';
  } else {
    signInState.value = 'done';
  }
};

const switchTo = async(id: FirstRunAiProviderId) => {
  providerId.value = id;
  try {
    await SullaSettingsModel.set(FIRST_RUN_AI_PROVIDER_KEY, id, 'string');
  } catch { /* the pick still applies to this sign-in */ }
  await signIn();
};

const onWorkspaceReady = () => {
  if (workspaceReady) return;
  workspaceReady = true;
  signIn();
};

onMounted(async() => {
  ipcRenderer.on('k8s-progress', updateProgress);
  ipcRenderer.on('first-run-ai:ready', onWorkspaceReady);

  try {
    providerId.value = await SullaSettingsModel.get(FIRST_RUN_AI_PROVIDER_KEY, '');
  } catch { /* no saved choice — prompt to go back */ }

  // The workspace may already be up if the user took their time.
  try {
    const { ready } = await ipcRenderer.invoke('first-run-ai:status');

    if (ready) onWorkspaceReady();
  } catch { /* wait for the event */ }
});

onUnmounted(() => {
  ipcRenderer.removeListener('k8s-progress', updateProgress);
  ipcRenderer.removeListener('first-run-ai:ready', onWorkspaceReady);
});
</script>

<style lang="scss" scoped>
.frw-container {
  background: var(--bg-surface);
}

.frw-title {
  color: var(--text-primary);
}

.frw-subtitle {
  color: var(--text-secondary);
}

.frw-progress-box {
  background: var(--bg-surface-alt);
}

.frw-progress-track {
  background: var(--bg-surface-hover);
}

.frw-progress-bar {
  background: var(--accent-primary);
}

.frw-muted {
  color: var(--text-muted);
}

.frw-signin {
  background: var(--bg-surface-alt);
}

.frw-success {
  color: var(--text-success);
}

.frw-error {
  color: var(--text-error);
}

.frw-btn-accent {
  background: var(--accent-primary);
  color: var(--text-on-accent);

  &:hover {
    background: var(--accent-primary-hover);
  }
}

.frw-btn-secondary {
  background: var(--bg-surface-hover);
  color: var(--text-primary);

  &:hover {
    filter: brightness(1.1);
  }
}
</style>
