<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="frw-container max-w-lg mx-0 p-6">
    <h2 class="frw-title text-2xl font-bold mt-5 mb-4">
      You're all set. Finishing setup…
    </h2>
    <p class="frw-subtitle mb-6">
      Sulla is preparing its private workspace. The first time takes a few minutes, depending on your internet speed.
      This window closes on its own when Sulla is ready.
    </p>

    <ul class="frw-lines">
      <li :class="aiLine.done ? 'frw-success' : 'frw-muted'">
        {{ aiLine.text }}
      </li>
      <li :class="credentials.saved ? 'frw-success' : 'frw-muted'">
        {{ credentials.saved ? 'Your sign-ins are saved in your vault.' : 'Saving your sign-ins to your vault…' }}
      </li>
      <li
        v-if="chatLine"
        :class="chatReady?.ready ? 'frw-success' : 'frw-muted'"
      >
        {{ chatLine }}
      </li>
    </ul>

    <div
      v-if="oldVaultLocked && !credentials.saved"
      class="frw-notice mt-4"
    >
      <p class="text-sm mb-2">
        This Mac already has a vault that uses a different password. Unlock it once with that password or its recovery key, and Sulla moves it to your Sulla password.
      </p>
      <button
        type="button"
        class="px-4 py-2 rounded-md font-medium frw-btn-accent"
        @click="openVaultUnlock"
      >
        Unlock old vault
      </button>
      <button
        v-if="offerOpenAnyway"
        type="button"
        class="px-4 py-2 rounded-md font-medium ml-2"
        :disabled="opening"
        @click="continueAnyway"
      >
        {{ opening ? 'Opening Sulla…' : 'Open Sulla anyway' }}
      </button>
    </div>

    <div
      v-else-if="offerOpenAnyway"
      class="frw-notice mt-4"
    >
      <p
        v-if="backendFailed"
        class="frw-error text-sm mb-2"
      >
        Sulla's private workspace didn't start. Use Try again at the top, or open Sulla now and fix it from there.
      </p>
      <p
        v-else-if="savingStalled"
        class="frw-error text-sm mb-2"
      >
        This is taking longer than it should. Still waiting on {{ credentials.waitingOn.join(', ') || 'your vault' }}.
      </p>
      <p
        v-else
        class="text-sm mb-2"
      >
        The first setup is still running. That's normal on some Macs. You can open Sulla now and it keeps setting up.
      </p>
      <button
        v-if="savingStalled && !backendFailed"
        type="button"
        class="px-4 py-2 rounded-md font-medium frw-btn-accent mr-2"
        :disabled="retrying"
        @click="retrySaving"
      >
        {{ retrying ? 'Trying…' : 'Try again' }}
      </button>
      <button
        type="button"
        class="px-4 py-2 rounded-md font-medium"
        :disabled="opening"
        @click="continueAnyway"
      >
        {{ opening ? 'Opening Sulla…' : 'Open Sulla anyway' }}
      </button>
      <p
        v-if="openFailed"
        class="frw-error text-sm mt-2"
      >
        Sulla couldn't open. Quit and reopen Sulla.
      </p>
      <p class="text-xs mt-2 opacity-70">
        Sulla keeps saving in the background. If you quit before it finishes, you'll sign in again next time.
      </p>
    </div>

    <div class="frw-progress mt-6">
      <div class="frw-progress-track w-full rounded-full h-2.5 mb-2">
        <div
          class="frw-progress-bar h-2.5 rounded-full"
          :style="{ width: `${progressPercent}%` }"
        />
      </div>
      <p class="frw-muted text-xs">
        {{ progressDescription }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

import { FIRST_RUN_AI_PROVIDERS } from './firstRunAiProviders';
import { traceFirstRun } from './firstRunWizard';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { StartupProgressSnapshot } from '@pkg/utils/startupProgress';

const props = defineProps<{
  startupSnapshot?: StartupProgressSnapshot | null;
}>();

// Saving the sign-ins should take seconds once the vault service is up. Past
// this, say what it's waiting on and offer Try again. Before the service is
// up the VM is still installing, which is slow but not stuck.
const SAVE_STALL_MS = 3 * 60_000;
// A first install this long still isn't wrong, but let the owner go on.
const INSTALL_SLOW_MS = 10 * 60_000;
const POLL_MS = 2_000;

const progressPercent = computed(() => {
  const percent = Number(props.startupSnapshot?.percent);

  return Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0;
});
const progressDescription = computed(() => props.startupSnapshot?.stepLabel || props.startupSnapshot?.stageLabel || 'Starting…');

// ─── Your AI ─────────────────────────────────────────────────────
// Information only: AI can be connected after setup.
const API_PROVIDER_NAMES: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', grok: 'Grok' };
const connectedNames = ref<string[]>([]);
const anyConnected = ref(false);
const apiProvider = ref('');
const aiLine = computed(() => {
  if (connectedNames.value.length) return { done: true, text: `${ connectedNames.value.join(' and ') } connected.` };
  if (anyConnected.value) return { done: true, text: 'Your AI is connected.' };
  if (apiProvider.value) return { done: false, text: `You'll add your ${ API_PROVIDER_NAMES[apiProvider.value] || apiProvider.value } API key right after setup.` };

  return { done: false, text: 'You\'ll connect AI after setup.' };
});

async function loadAi() {
  try {
    const status = await ipcRenderer.invoke('first-run-ai:connection-status' as any);
    const pending: string[] = Array.isArray(status?.pending) ? status.pending : [];

    const oauthNames = FIRST_RUN_AI_PROVIDERS.filter(p => pending.includes(p.id)).map(p => p.name);
    const apiNames = [
      pending.includes('anthropic') ? 'Anthropic API key' : '',
      pending.includes('openai') ? 'OpenAI API key' : '',
      pending.includes('grok') && !oauthNames.includes('Grok') ? 'Grok API key' : '',
    ].filter(Boolean);
    connectedNames.value = [...oauthNames, ...apiNames];
    anyConnected.value = status?.connected === true;
  } catch { /* shown as not connected */ }
  try {
    const state = await ipcRenderer.invoke('first-run-state:get');
    const choice = state?.choices?.aiApiProvider;

    apiProvider.value = typeof choice === 'string' ? choice : '';
  } catch { /* no API choice */ }
  traceFirstRun('finishing', 'AI line', { connected: connectedNames.value, anyConnected: anyConnected.value, apiProvider: apiProvider.value || undefined });
}

// ─── Saving sign-ins to the vault (the wizard closes after this) ──
const credentials = ref<{ saved: boolean; waitingOn: string[] }>({ saved: false, waitingOn: [] });
const oldVaultLocked = ref(false);
const savingStalled = ref(false);
const installSlow = ref(false);
const backendFailed = ref(false);
const retrying = ref(false);
const opening = ref(false);
const openFailed = ref(false);
const mountedAt = Date.now();
// When the vault service was first seen up: the stall clock starts here.
let vaultServiceReadyAt: number | undefined;
// "Open Sulla anyway" must always be reachable when something is wrong.
const offerOpenAnyway = computed(() => backendFailed.value || savingStalled.value || installSlow.value);
let pollTimer: ReturnType<typeof setInterval> | undefined;
let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const status = await ipcRenderer.invoke('first-run:credentials-status' as any).catch(() => null);

    if (status) credentials.value = { saved: status.saved === true, waitingOn: Array.isArray(status.waitingOn) ? status.waitingOn : [] };
    if (status?.vaultServiceReady === true && vaultServiceReadyAt === undefined) {
      vaultServiceReadyAt = Date.now();
      traceFirstRun('finishing', 'vault service is up; saving sign-ins can start', { afterMs: vaultServiceReadyAt - mountedAt });
    }
    if (!credentials.value.saved) {
      const session = await ipcRenderer.invoke('sulla-cloud:first-run-session' as any).catch(() => null);

      const locked = session?.oldVaultLocked === true;

      if (locked && !oldVaultLocked.value) traceFirstRun('finishing', 'an older vault on this Mac is locked; asking to unlock it');
      oldVaultLocked.value = locked;
    }
    const stalled = !credentials.value.saved && vaultServiceReadyAt !== undefined && Date.now() - vaultServiceReadyAt > SAVE_STALL_MS;

    if (stalled && !savingStalled.value) traceFirstRun('finishing', 'saving sign-ins is taking over 3 minutes; offering Try again', { waitingOn: credentials.value.waitingOn, oldVaultLocked: oldVaultLocked.value });
    savingStalled.value = stalled;
    // Still open this long: something is still installing or saving.
    const slow = Date.now() - mountedAt > INSTALL_SLOW_MS;

    if (slow && !installSlow.value) traceFirstRun('finishing', 'setup is still running after 10 minutes; offering Open Sulla anyway', { saved: credentials.value.saved, vaultServiceReady: vaultServiceReadyAt !== undefined });
    installSlow.value = slow;
  } finally {
    polling = false;
  }
}

async function retrySaving() {
  if (retrying.value) return;
  retrying.value = true;
  traceFirstRun('finishing', 'Try again clicked', { waitingOn: credentials.value.waitingOn });
  try {
    await ipcRenderer.invoke('first-run:retry-credentials' as any);
  } catch (err) {
    console.warn('[FirstRunWaiting] Could not retry saving sign-ins:', err);
  } finally {
    retrying.value = false;
  }
  await poll();
}

async function continueAnyway() {
  if (opening.value) return;
  opening.value = true;
  openFailed.value = false;
  traceFirstRun('finishing', 'Open Sulla anyway clicked', { waitingOn: credentials.value.waitingOn, backendFailed: backendFailed.value, savingStalled: savingStalled.value, installSlow: installSlow.value });
  try {
    // Main closes this window and opens Sulla; nothing more to do here.
    await ipcRenderer.invoke('first-run:continue-anyway' as any);
  } catch (err) {
    console.warn('[FirstRunWaiting] Could not continue:', err);
    traceFirstRun('finishing', 'Open Sulla anyway failed', { error: err instanceof Error ? err.message : String(err) });
    openFailed.value = true;
    opening.value = false;
  }
}

// The workspace failed to start: offer Open Sulla anyway right away.
function onBackendFailed(_event: unknown, failure: { message: string } | null) {
  backendFailed.value = !!failure;
}

async function openVaultUnlock() {
  traceFirstRun('finishing', 'Unlock old vault clicked');
  await ipcRenderer.invoke('first-run:open-vault-unlock' as any).catch((err: unknown) => console.warn('[FirstRunWaiting] Could not open the vault unlock:', err));
}

// ─── Chat readiness: once chat is ready, this window closes ──────
// Main closes it as soon as chat is ready and the sign-ins are saved. If it is
// still open a little later, open Sulla anyway: "ready" must never sit here.
const OPEN_WHEN_READY_MS = 15_000;
let openWhenReadyTimer: ReturnType<typeof setTimeout> | undefined;
const chatReady = ref<{ ready: boolean; waitingOn: string[] } | null>(null);
const chatLine = computed(() => {
  if (!chatReady.value) return '';
  if (chatReady.value.ready) return 'Chat is ready. Opening Sulla…';
  const waiting = chatReady.value.waitingOn;

  return waiting.length ? `Getting chat ready: waiting on ${ waiting.join(', ') }.` : 'Getting chat ready…';
});

function onChatReady(_event: unknown, status: { ready?: boolean; waitingOn?: string[] } | null) {
  if (!status) return;
  chatReady.value = { ready: status.ready === true, waitingOn: Array.isArray(status.waitingOn) ? status.waitingOn : [] };
  traceFirstRun('finishing', 'chat readiness', chatReady.value);
  if (chatReady.value.ready && !openWhenReadyTimer) {
    openWhenReadyTimer = setTimeout(() => {
      // Never skip unlocking an older vault: that is the one thing the user must do here.
      if (oldVaultLocked.value) return;
      traceFirstRun('finishing', 'chat ready but the window is still open; opening Sulla', { saved: credentials.value.saved, waitingOn: credentials.value.waitingOn });
      void continueAnyway();
    }, OPEN_WHEN_READY_MS);
  }
}

onMounted(() => {
  ipcRenderer.on('first-run:chat-ready-status' as any, onChatReady);
  ipcRenderer.on('first-run:backend-failed' as any, onBackendFailed);
  ipcRenderer.invoke('first-run:wizard-status' as any).then(status => onBackendFailed(undefined, status?.backendFailure ?? null)).catch(() => undefined);
  ipcRenderer.invoke('first-run:chat-ready-status' as any).then(status => onChatReady(undefined, status)).catch(() => undefined);
  void loadAi();
  void poll();
  pollTimer = setInterval(() => { void poll() }, POLL_MS);
});

onUnmounted(() => {
  ipcRenderer.removeListener('first-run:chat-ready-status' as any, onChatReady);
  ipcRenderer.removeListener('first-run:backend-failed' as any, onBackendFailed);
  if (pollTimer) clearInterval(pollTimer);
  clearTimeout(openWhenReadyTimer);
});
</script>

<style lang="scss" scoped>
.frw-title {
  color: var(--text-primary);
}

.frw-subtitle {
  color: var(--text-secondary);
}

.frw-lines {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;
}

.frw-notice p {
  color: var(--text-secondary);
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

.frw-btn-accent:disabled {
  opacity: .6;
  cursor: wait;
}

.theme-noir .frw-container {
  --fr-wait-spring: linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1);
  background: transparent;
  color: var(--nx-read-2);
}

.theme-noir .frw-container::before {
  content: "FINISHING";
  display: block;
  margin-top: 5px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: .14em;
  color: var(--nx-accent-2);
}

.theme-noir .frw-container > .frw-title {
  max-width: 650px;
  margin: 7px 0 8px;
  font-family: "Playfair Display", Georgia, serif;
  font-size: 36px;
  line-height: 1.08;
  font-weight: 600;
  letter-spacing: -.02em;
  color: var(--nx-read-1);
}

.theme-noir .frw-subtitle {
  font-size: 14px;
  line-height: 1.6;
  color: var(--nx-read-3);
}

.theme-noir .frw-muted {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--nx-read-4);
}

.theme-noir .frw-progress-track {
  height: 5px;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .7);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 7%, transparent);
}

.theme-noir .frw-progress-bar {
  height: 5px;
  background: linear-gradient(90deg, var(--nx-accent), var(--nx-accent-2));
  box-shadow: 0 0 14px color-mix(in srgb, var(--nx-accent) 52%, transparent);
  transition: width .58s var(--fr-wait-spring);
}

.theme-noir .frw-success { color: var(--nx-success); }
.theme-noir .frw-error { color: rgb(from var(--nx-danger) calc(r - 4) calc(g + 82) calc(b + 86)); }

.theme-noir .frw-btn-accent {
  min-height: 36px;
  padding-inline: 16px;
  border-radius: 18px;
  font-size: 12.5px;
  transition: transform .58s var(--fr-wait-spring), box-shadow .2s ease;
}

.theme-noir .frw-btn-accent {
  color: #fff;
  background: linear-gradient(180deg, var(--nx-accent-2), var(--nx-accent));
  box-shadow: 0 0 18px color-mix(in srgb, var(--nx-accent) 34%, transparent);
}

.theme-noir .frw-btn-accent:active { transform: scale(.95); }

@media (prefers-reduced-motion: reduce) {
  .theme-noir .frw-progress-bar,
  .theme-noir .frw-btn-accent {
    transition-duration: .01ms;
  }
}
</style>
