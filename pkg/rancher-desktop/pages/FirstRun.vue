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
      >
        <div class="fr-stage">
          <div
            id="chat-messages-list"
            ref="transcriptEl"
            class="fr-card"
          >
            <Transition
              name="fr-pane"
              mode="out-in"
            >
              <component
                :is="steps[currentStep]"
                :key="currentStep"
                :startup-controller="startupController"
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
import { ref, provide, computed } from 'vue';

import FirstRunFirstAutomation from './FirstRunFirstAutomation.vue';
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
// Guided setup, modeled on the TrueUp wizard: one clear question per screen,
// ending in the user's first automation. The backend starts after step 0 and
// installs in the background while the user answers the rest.
// Step indexes are part of the main-process contract: reaching the final
// "Finishing" screen (index 4) sets the wizardFinished condition in background.ts.
const stepNames = ['Welcome', 'Account', 'Your AI', 'First automation', 'Finishing'];
const steps = [FirstRunResources, FirstRunWelcome, FirstRunRemoteModel, FirstRunFirstAutomation, FirstRunWaiting];

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

const showSetupProgress = computed(() => currentStep.value > 0 && currentStep.value < steps.length - 1);

const setupStatusText = computed(() => {
  const detail = startupController.state.progressDescription.value;

  return detail ? `Setting up your private workspace in the background · ${ detail }` : 'Setting up your private workspace in the background';
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
defineExpose({ isDark, toggleTheme, stepNames, currentStep, steps, next, showSetupProgress });
</script>
<style lang="scss" scoped>
.page-root {
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
  gap: 6px 22px;
  flex-wrap: wrap;
  padding: 14px 24px;
  border-bottom: 1px solid var(--border-default, #e2e8f0);
}

.dark .fr-steps { border-color: var(--border-default, #262d36); }

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

/* ---- stage + card ---- */
.fr-stage {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 32px 24px 64px;
}

.fr-card {
  width: 100%;
  max-width: 760px;
  background: var(--bg-surface, #fff);
  border: 1px solid var(--border-default, #e2e8f0);
  border-radius: 18px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, .04), 0 16px 40px -18px rgba(15, 23, 42, .22);
  padding: 12px 20px 20px;
}

.dark .fr-card {
  background: var(--bg-surface, #161b22);
  border-color: var(--border-default, #262d36);
  box-shadow: 0 16px 40px -18px rgba(0, 0, 0, .7);
}

.fr-card :deep(> div) { max-width: none; }

/* Noir is opt-in: the first-run window uses the saved theme when one exists,
 * while a fresh install keeps useTheme's existing Protocol Dark fallback. */
:global(.theme-noir) .page-root {
  --fr-spring: linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1);
  background:
    radial-gradient(90% 64% at 50% -8%, color-mix(in srgb, var(--nx-accent) 18%, transparent), transparent 60%),
    radial-gradient(52% 44% at 0% 100%, color-mix(in srgb, var(--nx-accent) 8%, transparent), transparent 72%),
    var(--nx-paper);
  color: var(--nx-read-2);
}

:global(.theme-noir) .fr-steps {
  gap: 6px;
  padding: 13px 22px;
  border-color: var(--nx-hair);
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .48);
  backdrop-filter: blur(16px);
}

:global(.theme-noir) .fr-step {
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

:global(.theme-noir) .fr-step.is-active {
  color: var(--nx-read-1);
  background: linear-gradient(180deg, color-mix(in srgb, var(--nx-accent) 28%, transparent), color-mix(in srgb, var(--nx-accent) 12%, transparent));
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--nx-accent-2) 50%, transparent), 0 0 20px color-mix(in srgb, var(--nx-accent) 18%, transparent);
}

:global(.theme-noir) .fr-step.is-active::before {
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

:global(.theme-noir) .fr-step.is-done { color: var(--nx-read-3); }

:global(.theme-noir) .fr-step-n {
  width: 20px;
  height: 20px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
  color: var(--nx-read-4);
  background: var(--nx-hair);
  box-shadow: inset 0 0 0 1px var(--nx-hair);
}

:global(.theme-noir) .fr-step.is-active .fr-step-n,
:global(.theme-noir) .fr-step.is-done .fr-step-n {
  color: var(--nx-read-1);
  background: color-mix(in srgb, var(--nx-accent) 24%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 45%, transparent), 0 0 10px color-mix(in srgb, var(--nx-accent) 20%, transparent);
}

:global(.theme-noir) .fr-setup {
  padding: 9px 24px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  color: var(--nx-read-4);
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .34);
  border-bottom: 1px solid color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 6%, transparent);
}

:global(.theme-noir) .fr-setup-track {
  height: 4px;
  background: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 10%, transparent);
}

:global(.theme-noir) .fr-setup-bar {
  background: linear-gradient(90deg, var(--nx-accent), var(--nx-accent-2));
  box-shadow: 0 0 10px color-mix(in srgb, var(--nx-accent) 50%, transparent);
}

:global(.theme-noir) .fr-stage {
  align-items: center;
  padding: 34px 28px 58px;
}

:global(.theme-noir) .fr-card {
  max-width: 820px;
  padding: 12px 22px 22px;
  border-color: var(--nx-hair);
  border-radius: 24px;
  background:
    linear-gradient(145deg, color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 4.5%, transparent), color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 1.8%, transparent)),
    color-mix(in srgb, var(--nx-surface) 78%, transparent);
  box-shadow: inset 0 0 0 .5px var(--nx-hair), 0 30px 80px rgba(0, 0, 0, .48), 0 0 70px color-mix(in srgb, var(--nx-accent) 6%, transparent);
  backdrop-filter: blur(22px);
}

:global(.theme-noir) .fr-pane-enter-active,
:global(.theme-noir) .fr-pane-leave-active {
  transition: opacity .34s ease, transform .58s var(--fr-spring), filter .34s ease;
}

:global(.theme-noir) .fr-pane-enter-from {
  opacity: 0;
  transform: translateY(10px) scale(.985);
  filter: blur(8px);
}

:global(.theme-noir) .fr-pane-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(.99);
  filter: blur(5px);
}

@media (prefers-reduced-motion: reduce) {
  :global(.theme-noir) .fr-step,
  :global(.theme-noir) .fr-pane-enter-active,
  :global(.theme-noir) .fr-pane-leave-active {
    transition-duration: .01ms;
  }
}

/* Noir Light softens dark-only elevation shadows for paper surfaces. */
:global(.theme-noir-light) .fr-card {
  box-shadow: inset 0 0 0 .5px var(--nx-hair), 0 30px 80px color-mix(in srgb, var(--nx-ink) 14%, transparent), 0 0 70px color-mix(in srgb, var(--nx-accent) 6%, transparent);
}
</style>
