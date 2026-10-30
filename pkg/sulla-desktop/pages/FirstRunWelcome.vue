<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="max-w-lg mx-0 p-6">
    <form v-if="step === 'account'" @submit.prevent="handleAccountSubmit">
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
      <div class="flex items-center justify-between mt-5">
        <button type="button" class="link-btn" @click="continueWithoutAccount">Continue without an account</button>
        <button type="submit" class="px-6 py-2 rounded-md transition-colors font-medium hover:opacity-90 btn-primary">Continue</button>
      </div>
    </form>

    <form v-if="step === 'cloud'" @submit.prevent="handleCloudSubmit">
      <h2 class="text-2xl font-bold mt-5 mb-4 heading-text">{{ cloudAccountExists ? 'Sign in to Sulla Cloud' : 'Choose your account password' }}</h2>
      <p class="mb-6 secondary-text"><template v-if="cloudAccountExists"><strong>{{ sullaEmail }}</strong> already has an account. Enter its password to connect this Mac.</template><template v-else>This password signs you in on Desktop, Mobile, and Cloud. Your local vault is created next and stays isolated on this Mac.</template></p>
      <div class="mb-4">
        <label for="cloudPassword" class="block text-sm font-medium mb-1 label-text">Account password</label>
        <input id="cloudPassword" v-model="cloudPassword" type="password" autocomplete="current-password" class="w-full p-2 border rounded-md form-input" :class="{ 'input-error': !!cloudError }" placeholder="At least 8 characters">
        <p v-if="cloudError" class="text-sm mt-1 error-text">{{ cloudError }}</p>
      </div>
      <div class="flex items-center justify-between mt-5">
        <button type="button" class="link-btn" @click="continueWithoutAccount">This Mac only, for now</button>
        <button type="submit" class="px-6 py-2 rounded-md transition-colors font-medium hover:opacity-90 btn-primary" :class="{ 'opacity-50 cursor-not-allowed': cloudSubmitting }" :disabled="cloudSubmitting">{{ cloudSubmitting ? 'Connecting…' : (cloudAccountExists ? 'Sign in and continue' : 'Create account and continue') }}</button>
      </div>
    </form>

    <div v-if="step === 'vault'" class="vault-step">
      <h2 class="text-2xl font-bold mt-5 mb-2 heading-text">Protect your vault</h2>
      <p class="mb-4 secondary-text">Create a vault password of at least 12 characters. It stays inside the isolated vault below. Confirm it carefully, then save the one-time recovery key before continuing.</p>
      <vault-page :active="true" :modal="true" parent-window="first-run" onboarding />
    </div>

    <div v-if="step === 'sync'">
      <h2 class="text-2xl font-bold mt-5 mb-4 heading-text">Choose what syncs</h2>
      <p class="mb-6 secondary-text">Synced data becomes available on your phone, your other desktops and Sulla Cloud. Turn any of it off here or later in Settings.</p>
      <rd-fieldset legend-text="Sync" class="mb-6 heading-text">
        <label class="sync-row"><input v-model="syncEnabled" type="checkbox"><span><strong>Sync this Sulla</strong> — master switch</span></label>
        <label v-for="category in syncCategories" :key="category.key" class="sync-row" :class="{ disabled: !syncEnabled }"><input v-model="category.enabled" type="checkbox" :disabled="!syncEnabled"><span><strong>{{ category.label }}</strong> — {{ category.description }}</span></label>
      </rd-fieldset>
      <p v-if="syncError" class="text-sm mt-1 error-text">{{ syncError }}</p>
      <div class="flex items-center justify-end gap-4 mt-5"><button v-if="syncError" type="button" class="link-btn" @click="finishSetup(true)">Continue anyway (change later in Settings)</button><button type="button" class="px-6 py-2 rounded-md transition-colors font-medium hover:opacity-90 btn-primary" :disabled="syncSubmitting" @click="handleSyncChoices">{{ syncSubmitting ? 'Saving…' : (syncError ? 'Retry' : 'Continue') }}</button></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ipcRenderer } from 'electron';
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import RdFieldset from '@pkg/components/form/RdFieldset.vue';
import VaultPage from '@pkg/pages/VaultPage.vue';

const emit = defineEmits<{ next: []; back: [] }>();
defineProps<{ showBack?: boolean }>();
const step = ref<'account' | 'cloud' | 'vault' | 'sync'>('account');
const cloudPassword = ref('');
const cloudError = ref('');
const cloudSubmitting = ref(false);
const cloudAccountExists = ref(false);
let cloudAttempt = 0;
const sullaEmail = ref('');
const primaryUserName = ref('');
const sullaSubscribeToUpdates = ref(false);
const emailError = ref('');
const accountLinked = ref(false);
const syncEnabled = ref(true);
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

function validateEmail() {
  const email = sullaEmail.value.trim();
  emailError.value = !email ? 'Email is required.' : !emailRegex.test(email) ? 'Please enter a valid email address.' : '';
  return !emailError.value;
}

onMounted(async() => {
  sullaEmail.value = await SullaSettingsModel.get('sullaEmail') || '';
  primaryUserName.value = await SullaSettingsModel.get('primaryUserName') || '';
  const subscribed = await SullaSettingsModel.get('sullaSubscribeToUpdates');
  sullaSubscribeToUpdates.value = subscribed === true;
  ipcRenderer.on('vault:onboarding-complete', handleVaultComplete);
});
onBeforeUnmount(() => ipcRenderer.removeListener('vault:onboarding-complete', handleVaultComplete));

async function handleAccountSubmit() {
  if (!validateEmail()) return;
  await SullaSettingsModel.set('primaryUserName', primaryUserName.value.trim(), 'string');
  await SullaSettingsModel.set('sullaEmail', sullaEmail.value.trim(), 'string');
  await SullaSettingsModel.set('sullaSubscribeToUpdates', sullaSubscribeToUpdates.value, 'boolean');
  step.value = 'cloud';
}

function continueWithoutAccount() {
  cloudAttempt += 1;
  cloudSubmitting.value = false;
  accountLinked.value = false;
  cloudPassword.value = '';
  step.value = 'vault';
}

async function handleCloudSubmit() {
  if (cloudPassword.value.length < 8) { cloudError.value = 'Password must be at least 8 characters.'; return; }
  const attempt = ++cloudAttempt;
  cloudSubmitting.value = true; cloudError.value = '';
  try {
    const res = await ipcRenderer.invoke('sulla-cloud:email-continue', sullaEmail.value.trim(), cloudPassword.value, primaryUserName.value.trim() || undefined);
    if (attempt !== cloudAttempt) return;
    if (!res.ok) { cloudAccountExists.value = !!res.accountExists; cloudError.value = res.error || 'Could not connect to Sulla Cloud.'; return; }
    cloudPassword.value = '';
    accountLinked.value = true;
    await SullaSettingsModel.set('sullaCloudLinked', true, 'boolean');
    step.value = 'vault';
  } catch { if (attempt === cloudAttempt) cloudError.value = 'Could not reach Sulla Cloud. Check your connection or choose This Mac only.'; }
  finally { if (attempt === cloudAttempt) cloudSubmitting.value = false; }
}

async function handleVaultComplete() {
  // The isolated vault owns the password and recovery key. Only its completion signal crosses this boundary.
  await persistInstallSettings();
  if (accountLinked.value) step.value = 'sync';
  else await finishSetup(false);
}

async function persistInstallSettings() {
  const servicePassword = await SullaSettingsModel.get('sullaServicePassword', SullaSettingsModel.generatePassword());
  await SullaSettingsModel.set('sullaServicePassword', servicePassword, 'string');
  const encryptionKey = await SullaSettingsModel.get('sullaN8nEncryptionKey', SullaSettingsModel.generateEncryptionKey());
  await SullaSettingsModel.set('sullaN8nEncryptionKey', encryptionKey, 'string');
  if (!await SullaSettingsModel.get('sullaApiToken')) await SullaSettingsModel.set('sullaApiToken', SullaSettingsModel.generateEncryptionKey(48), 'string');
  // These flags are deliberately last: a failed or abandoned vault setup must resume first run.
  await SullaSettingsModel.set('sullaPassword', 'vault-protected', 'string');
  await SullaSettingsModel.set('firstRunCredentialsNeeded', false, 'boolean');
}

async function handleSyncChoices() {
  syncSubmitting.value = true;
  syncError.value = '';
  const patch: Record<string, boolean> = { enabled: syncEnabled.value };
  for (const category of syncCategories.value) patch[category.key] = category.enabled;
  try { await ipcRenderer.invoke('sulla-cloud-connection:set-preferences', patch); }
  catch (err) {
    console.warn('[FirstRunWelcome] Could not save sync choices:', err);
    syncError.value = 'We could not save your sync choices. Retry, or continue and change them later in Settings.';
    syncSubmitting.value = false;
    return;
  }
  syncSubmitting.value = false;
  await finishSetup(true);
}

async function finishSetup(allowMarketing: boolean) {
  if (allowMarketing && sullaSubscribeToUpdates.value && sullaEmail.value.trim()) {
    void fetch('https://email-submission.merchantprotocol.workers.dev/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: sullaEmail.value.trim(), name: primaryUserName.value.trim(), source: 'sulla-desktop' }) }).catch(err => console.warn('[FirstRunWelcome] Subscription request error:', err));
  }
  sessionStorage.setItem('sulla-startup-splash-seen', 'true');
  await ipcRenderer.invoke('start-sulla-custom-env');
  emit('next');
}
</script>

<style lang="scss" scoped>
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
.sync-row { display: flex; align-items: flex-start; gap: .5rem; margin-bottom: .75rem; }
.sync-row.disabled { opacity: .55; }
</style>
