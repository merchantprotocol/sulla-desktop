<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="max-w-lg mx-0 p-6">
    <form v-if="step === 'account'" class="fr-account-step" @submit.prevent="handleAccountSubmit">
      <div class="fr-step-body">
      <h2 class="text-2xl font-bold mt-5 mb-4 heading-text">Create your Sulla account</h2>
      <p class="mb-6 secondary-text">This is the one account you use for Desktop, Mobile, and Sulla Cloud.</p>
      <rd-fieldset legend-text="About you" class="mb-6 heading-text">
        <div class="mb-4">
          <label for="primaryUserName" class="block text-sm font-medium mb-1 label-text">What should Sulla call you?</label>
          <input id="primaryUserName" v-model="primaryUserName" type="text" class="w-full p-2 border rounded-md form-input" placeholder="Your first name (optional)">
        </div>
        <div class="mb-4">
          <label for="email" class="block text-sm font-medium mb-1 label-text">Email</label>
          <input id="email" v-model="sullaEmail" type="email" class="w-full p-2 border rounded-md form-input" :class="{ 'input-error': !!emailError }" placeholder="you@company.com">
          <p v-if="emailError" class="text-sm mt-1 error-text">{{ emailError }}</p>
        </div>
      </rd-fieldset>
      <rd-fieldset legend-text="Updates" class="mb-6 heading-text">
        <label class="flex items-center"><input v-model="sullaSubscribeToUpdates" type="checkbox" class="mr-2"><span class="text-sm label-text">Email me product updates and new automation ideas</span></label>
      </rd-fieldset>
      </div>
      <div class="flex items-center justify-between mt-5 fr-account-actions">
        <button type="button" class="link-btn" @click="continueWithoutAccount">Continue without an account</button>
        <button type="submit" class="px-6 py-2 rounded-md transition-colors font-medium hover:opacity-90 btn-primary">Continue</button>
      </div>
    </form>

    <form v-if="step === 'cloud'" class="fr-account-step" @submit.prevent="handleCloudSubmit">
      <div class="fr-step-body">
      <h2 class="text-2xl font-bold mt-5 mb-4 heading-text">{{ cloudAccountExists ? 'Sign in to Sulla Cloud' : 'Choose your account password' }}</h2>
      <p class="mb-6 secondary-text"><template v-if="cloudAccountExists"><strong>{{ sullaEmail }}</strong> already has an account. Enter its password to connect this Mac.</template><template v-else>This password signs you in on Desktop, Mobile, and Cloud. You'll create your isolated local vault after setup.</template></p>
      <div class="mb-4">
        <label for="cloudPassword" class="block text-sm font-medium mb-1 label-text">Account password</label>
        <input id="cloudPassword" v-model="cloudPassword" type="password" autocomplete="current-password" class="w-full p-2 border rounded-md form-input" :class="{ 'input-error': !!cloudError }" placeholder="At least 8 characters">
        <p v-if="cloudError" class="text-sm mt-1 error-text">{{ cloudError }}</p>
        <button v-if="cloudAccountExists && emailRecoveryAvailable" type="button" class="link-btn mt-2" @click="sendRecoveryCode">Forgot password? Sign in with an email code</button>
      </div>
      <div v-if="cloudCodeSent" class="mb-4">
        <label for="cloudCode" class="block text-sm font-medium mb-1 label-text">Email code</label>
        <input id="cloudCode" v-model="cloudCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="w-full p-2 border rounded-md form-input" placeholder="6-digit code">
        <button type="button" class="link-btn mt-2" :disabled="cloudSubmitting" @click="verifyRecoveryCode">Verify code and continue</button>
      </div>
      </div>
      <div class="flex items-center justify-between mt-5 fr-account-actions">
        <button type="button" class="link-btn" @click="continueWithoutAccount">This Mac only, for now</button>
        <button type="submit" class="px-6 py-2 rounded-md transition-colors font-medium hover:opacity-90 btn-primary" :class="{ 'opacity-50 cursor-not-allowed': cloudSubmitting }" :disabled="cloudSubmitting">{{ cloudSubmitting ? 'Connecting…' : (cloudAccountExists ? 'Sign in and continue' : 'Create account and continue') }}</button>
      </div>
    </form>

    <div v-if="step === 'sync'" class="fr-account-step frs-sync">
      <div class="fr-step-body">
        <h2 class="text-2xl font-bold mt-5 mb-4 heading-text">Use Sulla on all your devices</h2>
        <p class="mb-8 secondary-text">Sync to Sulla Cloud and your chats, files and passwords follow you to your phone, the web and your other computers. Everything stays encrypted.</p>
        <p v-if="syncError" class="text-sm mb-4 error-text">{{ syncError }}</p>
      </div>
      <div class="frs-actions fr-account-actions">
        <button type="button" class="px-8 py-3 rounded-md transition-colors font-semibold hover:opacity-90 btn-primary frs-sync-all" :disabled="syncSubmitting" @click="handleSyncChoices(true)">{{ syncSubmitting ? 'Saving…' : (syncError ? 'Retry' : 'Sync everything') }}</button>
        <button type="button" class="link-btn" :disabled="syncSubmitting" @click="handleSyncChoices(false)">Keep it on this Mac only</button>
        <button v-if="syncError" type="button" class="link-btn" @click="finishSetup(true)">Continue anyway</button>
        <p class="text-xs secondary-text frs-note">You can turn individual things off later in Settings.</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ipcRenderer } from 'electron';
import { onMounted, ref } from 'vue';

import RdFieldset from '@pkg/components/form/RdFieldset.vue';

const emit = defineEmits<{ next: []; back: [] }>();
defineProps<{ showBack?: boolean }>();
const step = ref<'account' | 'cloud' | 'sync'>('account');
const cloudPassword = ref('');
const cloudError = ref('');
const cloudSubmitting = ref(false);
const cloudAccountExists = ref(false);
const emailRecoveryAvailable = ref(false);
const cloudCode = ref('');
const cloudCodeSent = ref(false);
let cloudAttempt = 0;
const sullaEmail = ref('');
const primaryUserName = ref('');
const sullaSubscribeToUpdates = ref(true);
const emailError = ref('');
const syncError = ref('');
const syncSubmitting = ref(false);
const syncCategories = ref([
  { key: 'conversations', label: 'Conversations', description: 'continue chats on your other devices', enabled: true },
  { key: 'files', label: 'Files', description: 'make your Sulla Files available everywhere', enabled: true },
  { key: 'memory', label: 'Memory', description: 'keep what Sulla learns consistent', enabled: true },
  { key: 'vault', label: 'Password vault', description: 'store an encrypted backup', enabled: true },
  { key: 'skills', label: 'Skills', description: 'reuse your installed skills', enabled: true },
  { key: 'workflows', label: 'Workflows', description: 'keep automations available', enabled: true },
  { key: 'customAgents', label: 'Agents', description: 'sync your custom agents', enabled: true },
  { key: 'recipes', label: 'Recipes', description: 'sync installed recipes', enabled: true },
  { key: 'useCases', label: 'Use cases', description: 'sync saved starter jobs', enabled: true },
  { key: 'liveAgents', label: 'Live agents', description: 'sync agent configuration', enabled: true },
  { key: 'usage', label: 'Usage', description: 'sync usage history', enabled: true },
]);
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let testAutopilot = '';

function validateEmail() {
  const email = sullaEmail.value.trim();
  emailError.value = !email ? 'Email is required.' : !emailRegex.test(email) ? 'Please enter a valid email address.' : '';
  return !emailError.value;
}

onMounted(async() => {
  testAutopilot = await ipcRenderer.invoke('first-run-test-autopilot:get' as any).catch(() => '');
  const state = await ipcRenderer.invoke('first-run-state:get');
  const choices = state?.choices ?? {};
  sullaEmail.value = typeof choices.sullaEmail === 'string' ? choices.sullaEmail : '';
  primaryUserName.value = typeof choices.primaryUserName === 'string' ? choices.primaryUserName : '';
  sullaSubscribeToUpdates.value = choices.sullaSubscribeToUpdates !== false;
});

async function handleAccountSubmit() {
  if (!validateEmail()) return;
  await saveChoices({ primaryUserName: primaryUserName.value.trim(), sullaEmail: sullaEmail.value.trim(), sullaSubscribeToUpdates: sullaSubscribeToUpdates.value });
  step.value = 'cloud';
}

async function continueWithoutAccount() {
  cloudAttempt += 1;
  cloudSubmitting.value = false;
  cloudPassword.value = '';
  await saveChoices({
    accountLinked: false,
    accountChoice: 'mac-only',
    primaryUserName: primaryUserName.value.trim(),
    sullaEmail: '',
    sullaSubscribeToUpdates: false,
    cloudPreferences: { enabled: false },
  });
  await finishSetup(true);
}

async function handleCloudSubmit() {
  if (cloudPassword.value.length < 8) { cloudError.value = 'Password must be at least 8 characters.'; return; }
  const attempt = ++cloudAttempt;
  cloudSubmitting.value = true; cloudError.value = '';
  try {
    const res = testAutopilot === 'cloud-fake'
      ? await ipcRenderer.invoke('first-run-test-autopilot:cloud-fake' as any)
      : await ipcRenderer.invoke('sulla-cloud:email-continue', sullaEmail.value.trim(), cloudPassword.value, primaryUserName.value.trim() || undefined);
    if (attempt !== cloudAttempt) return;
    if (!res.ok) {
      cloudAccountExists.value = !!res.accountExists;
      if (cloudAccountExists.value) {
        const availability = await ipcRenderer.invoke('sulla-cloud:email-code-availability');
        emailRecoveryAvailable.value = availability?.available === true;
      }
      cloudError.value = res.error || 'Could not connect to Sulla Cloud.'; return;
    }
    cloudPassword.value = '';
    await saveChoices({ accountLinked: true, accountChoice: 'cloud' });
    step.value = 'sync';
  } catch { if (attempt === cloudAttempt) cloudError.value = 'Could not reach Sulla Cloud. Check your connection or choose This Mac only.'; }
  finally { if (attempt === cloudAttempt) cloudSubmitting.value = false; }
}

async function sendRecoveryCode() {
  cloudSubmitting.value = true; cloudError.value = '';
  try {
    const res = await ipcRenderer.invoke('sulla-cloud:email-code-start', sullaEmail.value.trim());
    if (!res.ok) { cloudError.value = res.error || 'Could not send a sign-in code.'; return; }
    cloudCodeSent.value = true;
  } catch { cloudError.value = 'Could not reach Sulla Cloud. Check your connection or choose This Mac only.'; }
  finally { cloudSubmitting.value = false; }
}

async function verifyRecoveryCode() {
  if (!/^\d{6}$/.test(cloudCode.value.trim())) { cloudError.value = 'Enter the 6-digit code from the email.'; return; }
  cloudSubmitting.value = true; cloudError.value = '';
  try {
    const res = await ipcRenderer.invoke('sulla-cloud:email-code-verify', sullaEmail.value.trim(), cloudCode.value.trim(), primaryUserName.value.trim() || undefined);
    if (!res.ok) { cloudError.value = res.error || 'That code could not be verified.'; return; }
    cloudPassword.value = ''; cloudCode.value = '';
    await saveChoices({ accountLinked: true, accountChoice: 'cloud' });
    step.value = 'sync';
  } catch { cloudError.value = 'Could not reach Sulla Cloud. Check your connection or choose This Mac only.'; }
  finally { cloudSubmitting.value = false; }
}

async function saveChoices(patch: Record<string, unknown>) {
  const state = await ipcRenderer.invoke('first-run-state:get');
  await ipcRenderer.invoke('first-run-state:set', { choices: { ...(state?.choices ?? {}), ...patch } });
}

async function handleSyncChoices(syncAll: boolean) {
  syncSubmitting.value = true;
  syncError.value = '';
  // One choice: everything syncs, or nothing does. Individual categories stay
  // adjustable later in Settings.
  const patch: Record<string, boolean> = { enabled: syncAll };
  for (const category of syncCategories.value) patch[category.key] = syncAll;
  try { await saveChoices({ cloudPreferences: patch }); }
  catch (err) {
    console.warn('[FirstRunWelcome] Could not save sync choices:', err);
    syncError.value = 'We could not save your sync choice. Retry, or continue and change it later in Settings.';
    syncSubmitting.value = false;
    return;
  }
  syncSubmitting.value = false;
  await finishSetup(true);
}

async function finishSetup(allowMarketing: boolean) {
  await saveChoices({ sullaSubscribeToUpdates: allowMarketing && sullaSubscribeToUpdates.value });
  sessionStorage.setItem('sulla-startup-splash-seen', 'true');
  await ipcRenderer.invoke('start-sulla-custom-env');
  emit('next');
}
</script>

<style lang="scss" scoped>
.max-w-lg.mx-0.p-6, .fr-account-step { height: 100%; min-height: 0; }
.fr-account-step { display: flex; flex-direction: column; }
.fr-step-body { min-height: 0; overflow-y: auto; }
.fr-account-actions { flex: none; }

.button-area {
  align-self: flex-end;
  margin-top: 1.5rem;
}

/* Text color classes */
.heading-text {
  color: var(--text-primary);
}

.secondary-text {
  color: var(--text-secondary);
}

.label-text {
  color: var(--text-secondary);
}

.error-text {
  color: var(--text-error);
}

/* Form input styling */
.form-input {
  background-color: var(--bg-input);
  border-color: var(--border-default);
  color: var(--text-primary);
}

.input-error {
  border-color: var(--border-error);
}

/* Recovery key display */
.recovery-key-box {
  padding: 1rem 1.5rem;
  border: 2px dashed var(--border-strong);
  border-radius: 0.5rem;
  background-color: var(--bg-surface-alt);
  text-align: center;
  user-select: all;

  code {
    color: var(--accent-primary);
    letter-spacing: 0.15em;
  }
}

/* Button styles */
.btn-back {
  color: var(--text-secondary);
  background-color: var(--bg-surface-alt);

  &:hover {
    background-color: var(--bg-surface-hover);
  }
}

.btn-primary {
  background-color: var(--accent-primary);
  color: var(--text-on-accent);

  &:hover {
    background-color: var(--accent-primary-hover);
  }
}

.link-btn {
  color: var(--accent-primary);
  background: none;
  border: none;
  padding: 0;

  &:disabled {
    color: var(--text-secondary);
    cursor: default;
  }
}

input[type="checkbox"]:checked {
  accent-color: var(--accent-primary);
}

/* Hover effects */
button:hover {
  cursor: pointer;
}

input:hover, select:hover {
  border-color: var(--border-strong);
  background-color: var(--bg-surface-alt);
}

.theme-noir .heading-text,
.theme-noir .secondary-text,
.theme-noir .label-text {
  color: var(--nx-read-2);
}

.theme-noir .max-w-lg.mx-0.p-6 {
  --fr-account-spring: linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1);
  color: var(--nx-read-2);
}

.theme-noir .max-w-lg.mx-0.p-6 > form::before,
.theme-noir .max-w-lg.mx-0.p-6 > div::before {
  content: "ACCOUNT & VAULT";
  display: block;
  margin-top: 5px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: .14em;
  color: var(--nx-accent-2);
}

.theme-noir .max-w-lg.mx-0.p-6 h2 {
  margin: 7px 0 8px;
  font-family: "Playfair Display", Georgia, serif;
  font-size: 34px;
  line-height: 1.08;
  font-weight: 600;
  letter-spacing: -.02em;
  color: var(--nx-read-1);
}

.theme-noir .secondary-text {
  font-size: 14px;
  line-height: 1.6;
  color: var(--nx-read-3);
}

.theme-noir .max-w-lg.mx-0.p-6 :deep(fieldset) {
  padding: 14px 16px 4px;
  border-color: var(--nx-hair);
  border-radius: 18px;
  background: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 3.5%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 4%, transparent);
}

.theme-noir .max-w-lg.mx-0.p-6 :deep(legend) {
  padding: 0 7px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--nx-read-4);
}

.theme-noir .max-w-lg.mx-0.p-6 label:not(.flex) {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--nx-read-4);
}

.theme-noir .form-input {
  min-height: 40px;
  padding: 0 13px;
  border-color: transparent;
  border-radius: 12px;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .62);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 12%, transparent);
  color: var(--nx-read-1);
  outline: none;
  transition: box-shadow .2s ease, background .2s ease;
}

.theme-noir .form-input:hover {
  border-color: transparent;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .72);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 20%, transparent);
}

.theme-noir .form-input:focus {
  border-color: transparent;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .78);
  box-shadow: inset 0 0 0 1px var(--nx-accent-2), 0 0 0 3px color-mix(in srgb, var(--nx-accent) 18%, transparent), 0 0 18px color-mix(in srgb, var(--nx-accent) 12%, transparent);
}

.theme-noir .form-input.input-error {
  box-shadow: inset 0 0 0 1px var(--nx-danger), 0 0 0 3px color-mix(in srgb, var(--nx-danger) 10%, transparent);
}

.theme-noir .error-text { color: rgb(from var(--nx-danger) calc(r - 4) calc(g + 82) calc(b + 86)); }

.theme-noir .max-w-lg.mx-0.p-6 input[type="checkbox"] {
  width: 38px;
  height: 22px;
  flex: none;
  margin-right: 11px;
  appearance: none;
  border: 0;
  border-radius: 11px;
  background: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 14%, transparent);
  cursor: pointer;
}

.theme-noir .max-w-lg.mx-0.p-6 input[type="checkbox"]::after {
  content: "";
  display: block;
  width: 16px;
  height: 16px;
  margin: 3px;
  border-radius: 50%;
  background: var(--nx-read-2);
  box-shadow: 0 2px 6px rgba(0, 0, 0, .4);
  transition: transform .58s var(--fr-account-spring), background .2s ease;
}

.theme-noir .max-w-lg.mx-0.p-6 input[type="checkbox"]:checked {
  background: linear-gradient(180deg, var(--nx-accent-2), var(--nx-accent));
  box-shadow: 0 0 14px color-mix(in srgb, var(--nx-accent) 42%, transparent);
}

.theme-noir .max-w-lg.mx-0.p-6 input[type="checkbox"]:checked::after {
  transform: translateX(16px);
  background: #fff;
}

.theme-noir .recovery-key-box {
  border: 0;
  border-radius: 16px;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .62);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 30%, transparent), 0 0 28px color-mix(in srgb, var(--nx-accent) 8%, transparent);
}

.theme-noir .recovery-key-box code {
  color: rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16));
  text-shadow: 0 0 12px color-mix(in srgb, var(--nx-accent-2) 28%, transparent);
}

.theme-noir .btn-primary {
  min-height: 40px;
  padding-inline: 20px;
  border-radius: 20px;
  color: #fff;
  background: linear-gradient(180deg, var(--nx-accent-2), var(--nx-accent));
  box-shadow: 0 0 18px color-mix(in srgb, var(--nx-accent) 34%, transparent);
  transition: transform .58s var(--fr-account-spring), box-shadow .2s ease;
}

.theme-noir .btn-primary:hover {
  background: linear-gradient(180deg, rgb(from var(--nx-accent-2) calc(r + 8) calc(g + 10) calc(b + 9)), var(--nx-accent));
  box-shadow: 0 0 24px color-mix(in srgb, var(--nx-accent) 48%, transparent);
}

.theme-noir .btn-primary:active { transform: scale(.95); }

.theme-noir .btn-back {
  min-height: 40px;
  padding-inline: 18px;
  border-radius: 20px;
  color: var(--nx-read-3);
  background: transparent;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 12%, transparent);
}

.theme-noir .link-btn {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  color: rgb(from var(--nx-accent-2) calc(r + 34) calc(g - 4) calc(b - 3));
  text-decoration: none;
}

@media (prefers-reduced-motion: reduce) {
  .theme-noir .max-w-lg.mx-0.p-6 input[type="checkbox"]::after,
  .theme-noir .btn-primary {
    transition-duration: .01ms;
  }
}

/* Noir Light softens dark-only elevation shadows for paper surfaces. */
.theme-noir-light .max-w-lg.mx-0.p-6 input[type="checkbox"]::after {
  box-shadow: 0 2px 6px color-mix(in srgb, var(--nx-ink) 14%, transparent);
}

.vault-step { width: min(780px, calc(100vw - 5rem)); }
.vault-step :deep(.vault-host) { height: 520px; border: 1px solid var(--border-default); border-radius: .5rem; overflow: hidden; }
.frs-sync { text-align: center; }
.frs-sync p { max-width: 34rem; margin-inline: auto; }
.frs-actions { display: flex; flex-direction: column; align-items: center; gap: .75rem; }
.frs-sync-all { min-width: 16rem; font-size: 1.05rem; }
.frs-note { margin: .25rem 0 0; }
</style>
