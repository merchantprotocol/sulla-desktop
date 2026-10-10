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

:global(.theme-noir) .frw-container {
  --fr-wait-spring: linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1);
  background: transparent;
  color: var(--nx-read-2);
}

:global(.theme-noir) .frw-container::before {
  content: "FINISHING";
  display: block;
  margin-top: 5px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: .14em;
  color: var(--nx-accent-2);
}

:global(.theme-noir) .frw-container > .frw-title {
  max-width: 650px;
  margin: 7px 0 8px;
  font-family: "Playfair Display", Georgia, serif;
  font-size: 36px;
  line-height: 1.08;
  font-weight: 600;
  letter-spacing: -.02em;
  color: var(--nx-read-1);
}

:global(.theme-noir) .frw-subtitle {
  font-size: 14px;
  line-height: 1.6;
  color: var(--nx-read-3);
}

:global(.theme-noir) .frw-signin,
:global(.theme-noir) .frw-progress-box {
  border-radius: 18px;
  background: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 3.5%, transparent);
  box-shadow: inset 0 0 0 1px var(--nx-hair);
}

:global(.theme-noir) .frw-signin {
  background: linear-gradient(135deg, color-mix(in srgb, var(--nx-accent) 14%, transparent), color-mix(in srgb, var(--nx-accent) 2.5%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 22%, transparent);
}

:global(.theme-noir) .frw-signin h4,
:global(.theme-noir) .frw-progress-box h4 {
  color: var(--nx-read-1);
  font-weight: 600;
}

:global(.theme-noir) .frw-muted {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--nx-read-4);
}

:global(.theme-noir) .frw-progress-track {
  height: 5px;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .7);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 7%, transparent);
}

:global(.theme-noir) .frw-progress-bar {
  height: 5px;
  background: linear-gradient(90deg, var(--nx-accent), var(--nx-accent-2));
  box-shadow: 0 0 14px color-mix(in srgb, var(--nx-accent) 52%, transparent);
  transition: width .58s var(--fr-wait-spring);
}

:global(.theme-noir) .frw-success { color: var(--nx-success); }
:global(.theme-noir) .frw-error { color: rgb(from var(--nx-danger) calc(r - 4) calc(g + 82) calc(b + 86)); }

:global(.theme-noir) .frw-btn-accent,
:global(.theme-noir) .frw-btn-secondary {
  min-height: 36px;
  padding-inline: 16px;
  border-radius: 18px;
  font-size: 12.5px;
  transition: transform .58s var(--fr-wait-spring), box-shadow .2s ease;
}

:global(.theme-noir) .frw-btn-accent {
  color: #fff;
  background: linear-gradient(180deg, var(--nx-accent-2), var(--nx-accent));
  box-shadow: 0 0 18px color-mix(in srgb, var(--nx-accent) 34%, transparent);
}

:global(.theme-noir) .frw-btn-secondary {
  color: var(--nx-read-2);
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .5);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 12%, transparent);
}

:global(.theme-noir) .frw-btn-accent:active,
:global(.theme-noir) .frw-btn-secondary:active { transform: scale(.95); }

@media (prefers-reduced-motion: reduce) {
  :global(.theme-noir) .frw-progress-bar,
  :global(.theme-noir) .frw-btn-accent,
  :global(.theme-noir) .frw-btn-secondary {
    transition-duration: .01ms;
  }
}
</style>
