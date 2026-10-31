<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!--
  Sulla Desktop · https://sulladesktop.com
  Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
  the Apache License 2.0 (LICENSES/Apache-2.0.txt).
  Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
  GPL-2.0-or-later (LICENSE).
  "Sulla" is a trademark. See TRADEMARK.md.
-->
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
      >
        <!-- Step bar: where you are, and what's left -->
        <nav
          class="fr-steps"
          aria-label="Setup progress"
        >
          <div
            v-for="(name, index) in stepNames"
            :key="name"
            class="fr-step"
            :class="{ 'is-active': index === currentStep, 'is-done': index < currentStep }"
          >
            <span class="fr-step-n">{{ index < currentStep ? '✓' : index + 1 }}</span>
            <span class="fr-step-t">{{ name }}</span>
          </div>
        </nav>
      </SimpleHeader>

      <div
        v-if="backendFailure"
        class="fr-failure"
        role="alert"
      >
        <span class="fr-failure-text">
          <strong>{{ backendFailure.message }}</strong>
          {{ retryNote || 'Try again, or quit and reopen Sulla.' }}
        </span>
        <button
          type="button"
          class="fr-failure-btn"
          :disabled="retrying"
          @click="retryBackend"
        >
          {{ retrying ? 'Starting…' : 'Try again' }}
        </button>
      </div>

      <div
        v-if="quitting"
        class="fr-quitting"
        role="status"
      >
        Quitting…
      </div>

      <div
        v-if="showSetupProgress"
        class="fr-setup"
      >
        <div class="fr-setup-track">
          <div
            class="fr-setup-bar"
            :style="{ width: `${progressPercent}%` }"
          />
        </div>
        <span class="fr-setup-text">
          {{ setupStatusText }}
        </span>
      </div>

      <div
        id="chat-scroll-container"
        ref="chatScrollContainer"
        class="flex min-h-0 flex-1 overflow-y-auto"
        :class="{ 'fr-locked': quitting }"
      >
        <div class="fr-stage">
          <div
            id="chat-messages-list"
            ref="transcriptEl"
            class="fr-card"
          >
            <p
              v-if="resuming"
              class="fr-resuming"
              role="status"
            >
              Picking up where you left off…
            </p>
            <Transition
              v-else
              name="fr-pane"
              mode="out-in"
            >
              <component
                :is="steps[currentStep]"
                :key="currentStep"
                :step-index="currentStep"
                :startup-snapshot="startupSnapshot"
                :show-back="currentStep > 0"
                @next="next"
                @back="back"
              />
            </Transition>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, provide, computed, onMounted, onBeforeUnmount } from 'vue';

import FirstRunRemoteModel from './FirstRunRemoteModel.vue';
import FirstRunResources from './FirstRunResources.vue';
import FirstRunWaiting from './FirstRunWaiting.vue';
import FirstRunWelcome from './FirstRunWelcome.vue';
import { firstRunAccountSignedIn, traceFirstRun } from './firstRunWizard';
import SimpleHeader from './agent/SimpleHeader.vue';

import { useTheme } from '@pkg/composables/useTheme';
import { defaultSettings, Settings } from '@pkg/config/settings';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { StartupProgressSnapshot } from '@pkg/utils/startupProgress';
import { RecursivePartial } from '@pkg/utils/typeUtils';

const { isDark, toggleTheme } = useTheme();

const currentStep = ref(0);
// Guided setup, modeled on the TrueUp wizard: one clear question per screen.
// The backend starts after step 0 and installs in the background while the
// user answers the rest.
// Step indexes are part of the main-process contract: reaching the final
// "Finishing" screen (index 3) sets the wizardFinished condition in background.ts.
const stepNames = ['Welcome', 'Account', 'Your AI', 'Finishing'];
const steps = [FirstRunResources, FirstRunWelcome, FirstRunRemoteModel, FirstRunWaiting];

const settings = ref(defaultSettings);
const lastStep = steps.length - 1;
// One step change at a time: a double-click must not skip a screen. Held
// until the saved step is restored on mount.
let navigating = true;

const quitting = ref(false);
// True while mount works out which step to resume at; no step shows meanwhile.
const resuming = ref(true);
const backendFailure = ref<{ message: string; detail?: string } | null>(null);
const retrying = ref(false);
const retryNote = ref('');

// The header Quit asks main to close the wizard, which shows the same
// "Setup isn't finished" confirmation as the window's close button.
const stopApp = async() => {
  traceFirstRun('wizard', 'Quit clicked', { step: stepNames[currentStep.value] });
  await ipcRenderer.invoke('first-run:quit' as any);
};

// The startup hub's snapshot drives every progress bar in setup, the same one
// the main window's overlay uses. Its percent never goes backwards.
const startupSnapshot = ref<StartupProgressSnapshot | null>(null);

function onStartupProgress(_event: unknown, snapshot: StartupProgressSnapshot) {
  if (snapshot && (!startupSnapshot.value || snapshot.startedAt !== startupSnapshot.value.startedAt || snapshot.percent >= startupSnapshot.value.percent)) {
    startupSnapshot.value = snapshot;
  }
}

function onBackendFailed(_event: unknown, failure: { message: string; detail?: string } | null) {
  backendFailure.value = failure;
  retryNote.value = '';
  traceFirstRun('wizard', failure ? 'showing the workspace failure banner' : 'workspace failure banner cleared');
}

function onQuitting() {
  quitting.value = true;
  traceFirstRun('wizard', 'app is quitting; wizard locked', { step: stepNames[currentStep.value] });
}

async function retryBackend() {
  if (retrying.value) return;
  retrying.value = true;
  traceFirstRun('wizard', 'Try again clicked on the workspace failure banner');
  try {
    const result = await ipcRenderer.invoke('first-run:retry-backend' as any);

    if (result?.started) {
      backendFailure.value = null;
    } else {
      retryNote.value = 'Sulla is still trying. Try again in a moment.';
    }
  } catch (err) {
    console.warn('[FirstRun] Could not restart the workspace:', err);
    retryNote.value = 'That didn\'t work. Quit and reopen Sulla.';
  } finally {
    retrying.value = false;
  }
}

const showSetupProgress = computed(() => currentStep.value > 0 && currentStep.value < lastStep);

const setupStatusText = computed(() => {
  const detail = startupSnapshot.value?.stepLabel || startupSnapshot.value?.stageLabel;

  return detail ? `Setting up your private workspace in the background · ${ detail }` : 'Setting up your private workspace in the background';
});

const progressPercent = computed(() => {
  const percent = Number(startupSnapshot.value?.percent);

  return Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0;
});

provide('settings', settings);

// After a relaunch the vault may hold the sign-in but take a while to start.
const RESUME_VAULT_WAIT_MS = 90_000;

/**
 * Tell main which step the wizard is on. Main saves it and sets the
 * coordinator condition in one call. A failed save never strands the user.
 */
async function reportStep(step: number) {
  try {
    await ipcRenderer.invoke('first-run-wizard-step', step);
  } catch (err) {
    console.warn('[FirstRun] Could not record the step:', err);
  }
}

onMounted(async() => {
  ipcRenderer.on('startup-progress', onStartupProgress);
  ipcRenderer.on('first-run:backend-failed' as any, onBackendFailed);
  ipcRenderer.on('first-run:quitting' as any, onQuitting);
  ipcRenderer.invoke('startup-progress').then(snapshot => onStartupProgress(undefined, snapshot)).catch(() => undefined);
  ipcRenderer.invoke('first-run:wizard-status' as any).then((status) => {
    if (status?.backendFailure) backendFailure.value = status.backendFailure;
  }).catch(() => undefined);

  const state = await ipcRenderer.invoke('first-run-state:get').catch(() => null);
  const saved = Number.isInteger(state?.step) ? Math.min(Math.max(state.step, 0), lastStep) : 0;
  let resumeStep = saved;

  // Your AI needs the Cloud sign-in, which lives only in main's memory. After
  // a restart it's gone, so go back to Account, which asks for the password.
  if (saved > 1 && saved < lastStep) {
    const account = state?.choices?.accountChoice ? await firstRunAccountSignedIn({ waitForVaultMs: RESUME_VAULT_WAIT_MS }) : null;

    if (!account?.signedIn) resumeStep = 1;
  }
  traceFirstRun('wizard', resumeStep === saved ? `resumed at ${ stepNames[resumeStep] }` : `saved step was ${ stepNames[saved] }; sent back to ${ stepNames[resumeStep] }`, {
    reason: resumeStep === saved ? undefined : state?.choices?.accountChoice ? 'Cloud sign-in no longer held' : 'no account choice saved',
  });
  currentStep.value = resumeStep;
  resuming.value = false;
  // Re-sent on every load: a crash between saving Finishing and telling main
  // must not leave the coordinator waiting.
  if (resumeStep !== saved || resumeStep === lastStep) await reportStep(resumeStep);
  navigating = false;

  const autopilot = await ipcRenderer.invoke('first-run-test-autopilot:get' as any).catch(() => '');

  if (autopilot) {
    void runTestAutopilot(autopilot).catch(async(error) => {
      console.error(error);
      await ipcRenderer.invoke('first-run-test-autopilot:failed' as any, error instanceof Error ? error.message : String(error));
    });
  }
});

async function waitForElement<T extends Element>(find: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const element = find();

    if (element) return element;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`[FirstRunAutopilot] Timed out waiting for ${ description }`);
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text && !button.disabled);
}

async function clickButton(text: string) {
  (await waitForElement(() => buttonWithText(text), `button "${ text }"`)).click();
}

async function runTestAutopilot(mode: 'mac-only' | 'cloud-fake') {
  console.log(`[FirstRunAutopilot] Starting ${ mode } renderer click-through`);
  await clickButton('Get started →');
  const email = await waitForElement(() => document.querySelector<HTMLInputElement>('#email') || undefined, 'account email');

  email.value = 'first-run-autopilot@example.invalid';
  email.dispatchEvent(new Event('input', { bubbles: true }));
  await clickButton('Continue');
  // Setup always creates or connects a Cloud account; there is no Mac-only path.
  const password = await waitForElement(() => document.querySelector<HTMLInputElement>('#cloudPassword') || undefined, 'fake Cloud password');

  password.value = 'not-a-real-password';
  password.dispatchEvent(new Event('input', { bubbles: true }));
  await clickButton('Create account and continue');
  await clickButton('Sync everything');
  await clickButton("I'll do this later");
  console.log(`[FirstRunAutopilot] Finished ${ mode } renderer click-through`);
}

onBeforeUnmount(() => {
  ipcRenderer.removeListener('startup-progress', onStartupProgress);
  ipcRenderer.removeListener('first-run:backend-failed' as any, onBackendFailed);
  ipcRenderer.removeListener('first-run:quitting' as any, onQuitting);
});

/** Move to `to`. Ignored when a move is already running or `from` is stale. */
async function goTo(to: number, from?: number) {
  if (navigating || quitting.value || (typeof from === 'number' && from !== currentStep.value)) {
    traceFirstRun('wizard', 'ignored a repeated step change', { from, to, current: currentStep.value });

    return;
  }
  const target = Math.min(Math.max(to, 0), lastStep);

  if (target === currentStep.value) return;
  navigating = true;
  try {
    await reportStep(target);
    traceFirstRun('wizard', `left ${ stepNames[currentStep.value] }, entered ${ stepNames[target] }`);
    currentStep.value = target;
    // Welcome passed: start (or resize) the workspace. Not awaited, so a slow
    // start never holds the next screen.
    if (target === 1) {
      ipcRenderer.invoke('start-backend' as any).catch((err: unknown) => console.warn('[FirstRun] start-backend failed:', err));
    }
  } finally {
    navigating = false;
  }
}

const next = (from?: number) => goTo((typeof from === 'number' ? from : currentStep.value) + 1, from);

const back = (from?: number) => goTo((typeof from === 'number' ? from : currentStep.value) - 1, from);

const commitChanges = async(settings: RecursivePartial<Settings>) => {
  try {
    return await ipcRenderer.invoke('settings-write' as any, settings);
  } catch (ex) {
    console.log('settings-write failed:', ex);
  }
};

provide('commitChanges', commitChanges);

// Expose for template
defineExpose({ isDark, toggleTheme, stepNames, currentStep, steps, next, showSetupProgress });
</script>
<style lang="scss" scoped>
.page-root {
  height: 100vh;
  min-height: 0;
  background: var(--bg-page, var(--body-bg, #f7f8fa));
  color: var(--text-primary, var(--body-text, #0f172a));
}

.page-root.dark {
  background: var(--bg-page, #0d1117);
  color: var(--text-primary, #e6edf3);
}

/* ---- step bar ---- */
.fr-steps {
  display: flex;
  justify-content: center;
  gap: 6px 18px;
  flex-wrap: wrap;
}

.fr-step {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-muted, #94a3b8);
}

.fr-step-n {
  width: 22px;
  height: 22px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 800;
  background: var(--bg-surface-alt, #eef2f6);
  color: var(--text-muted, #64748b);
}

.dark .fr-step-n { background: var(--bg-surface-alt, #1c2128); }

.fr-step.is-active { color: var(--text-primary, #0f172a); }
.dark .fr-step.is-active { color: var(--text-primary, #e6edf3); }

.fr-step.is-active .fr-step-n,
.fr-step.is-done .fr-step-n {
  background: var(--accent-primary, #3d7fa0);
  color: #fff;
}

.fr-step.is-done { color: var(--text-secondary, #475569); }

/* ---- background setup progress ---- */
.fr-setup {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: center;
  padding: 8px 24px;
  font-size: 12.5px;
  color: var(--text-muted, #64748b);
}

.fr-setup-track {
  width: 140px;
  height: 5px;
  border-radius: 99px;
  background: var(--bg-surface-hover, #e2e8f0);
  overflow: hidden;
  flex: none;
}

.dark .fr-setup-track { background: var(--bg-surface-hover, #262d36); }

.fr-setup-bar {
  height: 100%;
  border-radius: 99px;
  background: var(--accent-primary, #3d7fa0);
  transition: width .4s ease;
}

.fr-setup-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 560px;
}

.fr-resuming {
  text-align: center;
  font-size: 14px;
  color: var(--text-muted, #64748b);
}

/* ---- stage: the step sits directly on the page, centered ---- */
.fr-stage {
  flex: 1;
  min-width: 0;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
}

.fr-card {
  width: 100%;
  max-width: 760px;
  display: flex;
  flex-direction: column;
}

.fr-card :deep(> div) {
  width: 100%;
  max-width: none;
}

/* No scroll box inside a step: if a step is taller than the window, the page
 * scrolls as a whole. */
.fr-card :deep(.fr-step-body) {
  overflow: visible;
}

@media (max-width: 900px) {
  .fr-step-t { display: none; }
}

/* Noir is opt-in: the first-run window uses the saved theme when one exists,
 * while a fresh install keeps useTheme's existing Protocol Dark fallback. */
.theme-noir .page-root {
  height: 100vh;
  min-height: 0;
  --fr-spring: linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1);
  background:
    radial-gradient(90% 64% at 50% -8%, color-mix(in srgb, var(--nx-accent) 18%, transparent), transparent 60%),
    radial-gradient(52% 44% at 0% 100%, color-mix(in srgb, var(--nx-accent) 8%, transparent), transparent 72%),
    var(--nx-paper);
  color: var(--nx-read-2);
}

.theme-noir .fr-steps {
  gap: 6px;
}

.theme-noir .fr-step {
  position: relative;
  height: 34px;
  gap: 8px;
  padding: 0 13px 0 8px;
  border-radius: 17px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: .045em;
  color: var(--nx-read-4);
  transition: color .2s ease, background .58s var(--fr-spring), box-shadow .58s var(--fr-spring), transform .58s var(--fr-spring);
}

.theme-noir .fr-step.is-active {
  color: var(--nx-read-1);
  background: linear-gradient(180deg, color-mix(in srgb, var(--nx-accent) 28%, transparent), color-mix(in srgb, var(--nx-accent) 12%, transparent));
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--nx-accent-2) 50%, transparent), 0 0 20px color-mix(in srgb, var(--nx-accent) 18%, transparent);
}

.theme-noir .fr-step.is-active::before {
  content: "";
  position: absolute;
  left: -1px;
  top: 8px;
  width: 3px;
  height: 18px;
  border-radius: 3px;
  background: var(--nx-accent-2);
  box-shadow: 0 0 10px color-mix(in srgb, var(--nx-accent-2) 90%, transparent);
}

.theme-noir .fr-step.is-done { color: var(--nx-read-3); }

.theme-noir .fr-step-n {
  width: 20px;
  height: 20px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
  color: var(--nx-read-4);
  background: var(--nx-hair);
  box-shadow: inset 0 0 0 1px var(--nx-hair);
}

.theme-noir .fr-step.is-active .fr-step-n,
.theme-noir .fr-step.is-done .fr-step-n {
  color: var(--nx-read-1);
  background: color-mix(in srgb, var(--nx-accent) 24%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 45%, transparent), 0 0 10px color-mix(in srgb, var(--nx-accent) 20%, transparent);
}

.theme-noir .fr-setup {
  padding: 9px 24px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  color: var(--nx-read-4);
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .34);
  border-bottom: 1px solid color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 6%, transparent);
}

.theme-noir .fr-setup-track {
  height: 4px;
  background: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 10%, transparent);
}

.theme-noir .fr-setup-bar {
  background: linear-gradient(90deg, var(--nx-accent), var(--nx-accent-2));
  box-shadow: 0 0 10px color-mix(in srgb, var(--nx-accent) 50%, transparent);
}

.theme-noir .fr-stage {
  padding: 0 16px;
}

.theme-noir .fr-card {
  max-width: 820px;
}

.theme-noir .fr-pane-enter-active,
.theme-noir .fr-pane-leave-active {
  transition: opacity .34s ease, transform .58s var(--fr-spring), filter .34s ease;
}

.theme-noir .fr-pane-enter-from {
  opacity: 0;
  transform: translateY(10px) scale(.985);
  filter: blur(8px);
}

.theme-noir .fr-pane-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(.99);
  filter: blur(5px);
}

@media (prefers-reduced-motion: reduce) {
  .theme-noir .fr-step,
  .theme-noir .fr-pane-enter-active,
  .theme-noir .fr-pane-leave-active {
    transition-duration: .01ms;
  }
}

/* ---- backend failure and quitting ---- */
.fr-failure {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 10px 24px;
  font-size: 13px;
  color: var(--text-error, #b91c1c);
  background: var(--bg-error, #fef2f2);
}

.fr-failure-btn {
  flex: none;
  padding: 6px 14px;
  border-radius: 8px;
  font-weight: 600;
  background: var(--accent-primary, #3d7fa0);
  color: var(--text-on-accent, #fff);

  &:disabled { opacity: .6; cursor: wait; }
}

.fr-quitting {
  padding: 8px 24px;
  text-align: center;
  font-size: 13px;
  color: var(--text-muted, #64748b);
}

.fr-locked {
  pointer-events: none;
  opacity: .6;
}
</style>
