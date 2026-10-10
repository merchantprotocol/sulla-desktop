<template>
  <div class="max-w-lg mx-0 p-6">
    <!-- Step 1: Account setup -->
    <form
      v-if="step === 'account'"
      @submit.prevent="handleAccountSubmit"
    >
      <h2 class="text-2xl font-bold mt-5 mb-4 heading-text">
        Create your account
      </h2>
      <p class="mb-6 secondary-text">
        Your email is your Sulla Cloud account, so you can reach this computer from the web and your phone.
        Your master password is separate: it locks Sulla and encrypts every login and API key you save, and it never leaves this computer.
      </p>

      <rd-fieldset
        legend-text="About you"
        class="mb-6 heading-text"
      >
        <div class="mb-4">
          <label
            for="primaryUserName"
            class="block text-sm font-medium mb-1 label-text"
          >What should Sulla call you?</label>
          <input
            id="primaryUserName"
            v-model="primaryUserName"
            type="text"
            class="w-full p-2 border rounded-md form-input"
            placeholder="Your first name (optional)"
          >
        </div>
        <div class="mb-4">
          <label
            for="email"
            class="block text-sm font-medium mb-1 label-text"
          >Email (your Sulla Cloud account)</label>
          <input
            id="email"
            v-model="sullaEmail"
            type="email"
            class="w-full p-2 border rounded-md form-input"
            :class="{ 'input-error': !!emailError }"
            placeholder="you@company.com"
          >
          <p
            v-if="emailError"
            class="text-sm mt-1 error-text"
          >
            {{ emailError }}
          </p>
        </div>
        <div class="mb-4">
          <label
            for="password"
            class="block text-sm font-medium mb-1 label-text"
          >Master password</label>
          <input
            id="password"
            v-model="sullaPassword"
            type="password"
            class="w-full p-2 border rounded-md form-input"
            :class="{ 'input-error': !!passwordError }"
            placeholder="At least 8 characters"
          >
          <p
            v-if="passwordError"
            class="text-sm mt-1 error-text"
          >
            {{ passwordError }}
          </p>
        </div>
        <div class="mb-4">
          <label
            for="passwordConfirm"
            class="block text-sm font-medium mb-1 label-text"
          >Confirm master password</label>
          <input
            id="passwordConfirm"
            v-model="sullaPasswordConfirm"
            type="password"
            class="w-full p-2 border rounded-md form-input"
            :class="{ 'input-error': !!passwordConfirmError }"
            placeholder="Type it again"
          >
          <p
            v-if="passwordConfirmError"
            class="text-sm mt-1 error-text"
          >
            {{ passwordConfirmError }}
          </p>
        </div>
      </rd-fieldset>

      <rd-fieldset
        legend-text="Updates"
        class="mb-6 heading-text"
      >
        <label class="flex items-center">
          <input
            v-model="sullaSubscribeToUpdates"
            type="checkbox"
            checked="true"
            class="mr-2"
          >
          <span class="text-sm label-text">Email me product updates and new automation ideas</span>
        </label>
      </rd-fieldset>

      <div class="flex justify-between mt-5">
        <button
          v-if="showBack"
          type="button"
          class="px-6 py-2 rounded-md transition-colors font-medium hover:opacity-90 cursor-pointer btn-back"
          @click="$emit('back')"
        >
          Back
        </button>
        <button
          type="submit"
          class="px-6 py-2 rounded-md transition-colors font-medium hover:opacity-90 btn-primary"
        >
          Next
        </button>
      </div>
    </form>

    <!-- Step 2: Recovery key display -->
    <div v-if="step === 'recovery'">
      <h2 class="text-2xl font-bold mt-5 mb-4 heading-text">
        Your Recovery Key
      </h2>
      <p class="mb-4 secondary-text">
        Write this recovery key down and store it somewhere safe. You will need it to restore your vault if you move to a new machine or reinstall your operating system.
      </p>
      <p class="mb-6 text-xs secondary-text">
        This key is shown only once and cannot be retrieved later.
      </p>

      <div class="recovery-key-box mb-6">
        <code class="text-lg font-mono tracking-wider">{{ recoveryKey }}</code>
      </div>

      <div class="mb-6">
        <label class="flex items-start">
          <input
            v-model="recoveryKeyAcknowledged"
            type="checkbox"
            class="mr-2 mt-1"
          >
          <span class="text-sm label-text">I have written down my recovery key and stored it in a safe place</span>
        </label>
      </div>

      <div class="flex justify-end mt-5">
        <button
          type="button"
          class="px-6 py-2 rounded-md transition-colors font-medium hover:opacity-90 btn-primary"
          :class="{ 'opacity-50 cursor-not-allowed': !recoveryKeyAcknowledged }"
          :disabled="!recoveryKeyAcknowledged"
          @click="handleRecoveryAcknowledged"
        >
          Continue
        </button>
      </div>
    </div>

    <!-- Step 3: Sulla Cloud account — sign in if the email exists, else create it -->
    <form
      v-if="step === 'cloud'"
      @submit.prevent="handleCloudSubmit"
    >
      <h2 class="text-2xl font-bold mt-5 mb-4 heading-text">
        {{ cloudAccountExists ? 'Sign in to Sulla Cloud' : 'Your Sulla Cloud account' }}
      </h2>
      <p class="mb-6 secondary-text">
        <template v-if="cloudAccountExists">
          <strong>{{ sullaEmail }}</strong> already has a Sulla Cloud account. Enter its password to connect this computer.
        </template>
        <template v-else>
          Enter a password for <strong>{{ sullaEmail }}</strong>. If you already have a Sulla Cloud account, use its password
          and we'll sign you in. Otherwise we'll create your account with it. This is the password you'll use on the web and
          your phone. It isn't your master password, which never leaves this computer.
        </template>
      </p>

      <div class="mb-4">
        <label
          for="cloudPassword"
          class="block text-sm font-medium mb-1 label-text"
        >Sulla Cloud password</label>
        <input
          id="cloudPassword"
          v-model="cloudPassword"
          type="password"
          autocomplete="current-password"
          class="w-full p-2 border rounded-md form-input"
          :class="{ 'input-error': !!cloudError }"
          placeholder="At least 8 characters"
        >
        <p
          v-if="cloudError"
          class="text-sm mt-1 error-text"
        >
          {{ cloudError }}
        </p>
      </div>

      <div class="flex items-center gap-4 mb-6 text-sm">
        <button
          type="button"
          class="link-btn"
          @click="editingEmail = !editingEmail"
        >
          Use a different email
        </button>
        <button
          type="button"
          class="link-btn"
          :disabled="cloudSubmitting"
          @click="finishSetup"
        >
          Skip for now
        </button>
      </div>

      <div
        v-if="editingEmail"
        class="mb-6"
      >
        <input
          v-model="sullaEmail"
          type="email"
          class="w-full p-2 border rounded-md form-input mb-2"
          placeholder="you@company.com"
        >
        <button
          type="button"
          class="px-4 py-1 rounded-md btn-back"
          @click="changeEmail"
        >
          Use this email
        </button>
      </div>

      <div class="flex justify-end mt-5">
        <button
          type="submit"
          class="px-6 py-2 rounded-md transition-colors font-medium hover:opacity-90 btn-primary"
          :class="{ 'opacity-50 cursor-not-allowed': cloudSubmitting }"
          :disabled="cloudSubmitting"
        >
          {{ cloudSubmitting ? 'Connecting…' : (cloudAccountExists ? 'Sign in and continue' : 'Continue') }}
        </button>
      </div>
    </form>

    <!-- Step 4: What this computer shares with Sulla Cloud (all off by default) -->
    <div v-if="step === 'sync'">
      <h2 class="text-2xl font-bold mt-5 mb-4 heading-text">
        What should sync to Sulla Cloud?
      </h2>
      <p class="mb-6 secondary-text">
        You're signed in, so this computer stays connected to your Sulla Cloud account while Sulla is running.
        Nothing below leaves this computer unless you turn it on. You can change this any time in Settings → Sulla Cloud.
      </p>

      <rd-fieldset
        legend-text="Sync"
        class="mb-6 heading-text"
      >
        <label class="flex items-start mb-3">
          <input
            v-model="syncConversations"
            type="checkbox"
            class="mr-2 mt-1"
          >
          <span class="text-sm label-text"><strong>Conversations</strong> — read and continue your chats from the web and your phone.</span>
        </label>
        <label class="flex items-start mb-3">
          <input
            v-model="syncVault"
            type="checkbox"
            class="mr-2 mt-1"
          >
          <span class="text-sm label-text"><strong>Password vault</strong> — an encrypted backup. It's locked with your master password; Sulla Cloud can't read it.</span>
        </label>
        <label class="flex items-start">
          <input
            v-model="syncProjects"
            type="checkbox"
            class="mr-2 mt-1"
          >
          <span class="text-sm label-text"><strong>Projects</strong> — see your projects and tasks on the web while this computer is off.</span>
        </label>
      </rd-fieldset>

      <p class="mb-6 text-xs secondary-text">
        Controlling this computer from the web is separate: the first time a browser asks, Sulla shows a code here and you approve it on this screen.
      </p>

      <div class="flex justify-end mt-5">
        <button
          type="button"
          class="px-6 py-2 rounded-md transition-colors font-medium hover:opacity-90 btn-primary"
          @click="handleSyncChoices"
        >
          Continue
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ipcRenderer } from 'electron';
import { ref, onMounted, computed } from 'vue';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import RdFieldset from '@pkg/components/form/RdFieldset.vue';

const emit = defineEmits<{
  next: [];
  back: [];
}>();

const props = defineProps<{
  showBack?: boolean;
}>();

// Step tracking: 'account' → 'recovery' → 'cloud' (Sulla Cloud) → 'sync'
const step = ref<'account' | 'recovery' | 'cloud' | 'sync'>('account');

// Sulla Cloud account state. No email is sent: the cloud creates the account
// for a new email, or checks the password when the email already has one.
const cloudPassword = ref('');
const cloudError = ref('');
const cloudSubmitting = ref(false);
const cloudAccountExists = ref(false);
const editingEmail = ref(false);

// Sync choices — all off unless the user opts in.
const syncConversations = ref(false);
const syncVault = ref(false);
const syncProjects = ref(false);

// Reactive data
const sullaEmail = ref('');
const sullaPassword = ref('');
const sullaPasswordConfirm = ref('');
const primaryUserName = ref('');
const sullaSubscribeToUpdates = ref(true);

// Recovery key state
const recoveryKey = ref('');
const recoveryKeyAcknowledged = ref(false);

// Reactive error states
const emailError = ref('');
const passwordError = ref('');
const passwordConfirmError = ref('');

// Email validation regex
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isEmailValid = computed(() => {
  const email = sullaEmail.value?.trim();
  return email && emailRegex.test(email);
});

const validateEmail = () => {
  const email = sullaEmail.value?.trim();
  if (!email) {
    emailError.value = 'Email is required.';
    return false;
  }
  if (!emailRegex.test(email)) {
    emailError.value = 'Please enter a valid email address.';
    return false;
  }
  emailError.value = '';
  return true;
};

const validatePassword = () => {
  if (!sullaPassword.value?.trim()) {
    passwordError.value = 'Master password is required.';
    return false;
  }
  if (sullaPassword.value.length < 8) {
    passwordError.value = 'Master password must be at least 8 characters.';
    return false;
  }
  passwordError.value = '';
  return true;
};

const validatePasswordConfirm = () => {
  if (sullaPasswordConfirm.value !== sullaPassword.value) {
    passwordConfirmError.value = 'Passwords do not match.';
    return false;
  }
  passwordConfirmError.value = '';
  return true;
};

// Load settings on mount
onMounted(async() => {
  const loadedEmail = await SullaSettingsModel.get('sullaEmail');
  sullaEmail.value = loadedEmail || '';

  const loadedPassword = await SullaSettingsModel.get('sullaPassword');
  sullaPassword.value = loadedPassword || '';

  const loadedSubscribe = await SullaSettingsModel.get('sullaSubscribeToUpdates');
  sullaSubscribeToUpdates.value = loadedSubscribe !== null ? loadedSubscribe : true;

  const loadedPrimaryUserName = await SullaSettingsModel.get('primaryUserName');
  primaryUserName.value = loadedPrimaryUserName || '';
});

const handleAccountSubmit = async() => {
  const emailValid = validateEmail();
  const passwordValid = validatePassword();
  const confirmValid = validatePasswordConfirm();

  if (!emailValid || !passwordValid || !confirmValid) {
    return;
  }

  // Load and set service password and encryption key
  console.log('[FirstRunWelcome] Loading service password and encryption key...');

  const sullaServicePassword = await SullaSettingsModel.get('sullaServicePassword', SullaSettingsModel.generatePassword());
  await SullaSettingsModel.set('sullaServicePassword', sullaServicePassword, 'string');

  // Shared install secret. The name is historical (it began as n8n's key);
  // marketplace recipes use it as their generic secret via {{sullaN8nEncryptionKey}}.
  const loadedKey = await SullaSettingsModel.get('sullaN8nEncryptionKey', SullaSettingsModel.generateEncryptionKey());
  await SullaSettingsModel.set('sullaN8nEncryptionKey', loadedKey, 'string');

  // Generate API bearer token for the chat completions API
  const sullaApiToken = await SullaSettingsModel.get('sullaApiToken');
  if (!sullaApiToken) {
    const generatedToken = SullaSettingsModel.generateEncryptionKey(48);
    await SullaSettingsModel.set('sullaApiToken', generatedToken, 'string');
    console.log('[FirstRunWelcome] Generated sullaApiToken');
  }

  // Save to SullaSettingsModel
  // Note: the master password is NOT stored in settings — it's only used to derive the vault key.
  // We store a flag so the system knows first-run credentials were set.
  await SullaSettingsModel.set('primaryUserName', primaryUserName.value, 'string');
  await SullaSettingsModel.set('sullaEmail', sullaEmail.value, 'string');
  await SullaSettingsModel.set('sullaPassword', 'vault-protected', 'string');
  await SullaSettingsModel.set('sullaSubscribeToUpdates', sullaSubscribeToUpdates.value, 'boolean');
  await SullaSettingsModel.set('firstRunCredentialsNeeded', false, 'boolean');

  console.log('[FirstRunWelcome] Settings committed successfully');

  // Set up the vault with the master password via IPC (main process handles safeStorage)
  try {
    const result = await ipcRenderer.invoke('vault:setup', { masterPassword: sullaPassword.value });
    recoveryKey.value = result.recoveryKey;
    console.log('[FirstRunWelcome] Vault setup complete');

    // Show recovery key step
    step.value = 'recovery';
  } catch (err) {
    console.error('[FirstRunWelcome] Vault setup failed:', err);
    // Continue to the Sulla Cloud account anyway — vault can be set up later.
    step.value = 'cloud';
  }
};

const handleRecoveryAcknowledged = () => {
  step.value = 'cloud';
};

async function changeEmail() {
  if (!validateEmail()) {
    cloudError.value = emailError.value;
    return;
  }
  await SullaSettingsModel.set('sullaEmail', sullaEmail.value.trim(), 'string');
  editingEmail.value = false;
  cloudAccountExists.value = false;
  cloudError.value = '';
}

async function handleCloudSubmit() {
  if (cloudPassword.value.length < 8) {
    cloudError.value = 'Password must be at least 8 characters.';
    return;
  }
  cloudSubmitting.value = true;
  cloudError.value = '';
  try {
    const res = await ipcRenderer.invoke('sulla-cloud:email-continue', sullaEmail.value.trim(), cloudPassword.value, primaryUserName.value.trim() || undefined);
    if (!res.ok) {
      cloudAccountExists.value = !!res.accountExists;
      cloudError.value = res.error || 'Could not connect to Sulla Cloud.';
      return;
    }
    cloudPassword.value = '';
    await SullaSettingsModel.set('sullaCloudLinked', true, 'boolean');
    step.value = 'sync';
  } catch (err) {
    cloudError.value = 'Could not reach Sulla Cloud. Check your connection and try again.';
  } finally {
    cloudSubmitting.value = false;
  }
}

async function handleSyncChoices() {
  try {
    await ipcRenderer.invoke('sulla-cloud-connection:set-preferences', {
      conversations: syncConversations.value,
      vault:         syncVault.value,
      projects:      syncProjects.value,
    });
  } catch (err) {
    console.warn('[FirstRunWelcome] Could not save sync choices:', err);
  }
  await finishSetup();
}

const finishSetup = async() => {
  // Submit email subscription to worker if opted in
  if (sullaSubscribeToUpdates.value && sullaEmail.value?.trim()) {
    fetch('https://email-submission.merchantprotocol.workers.dev/', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        email:  sullaEmail.value.trim(),
        name:   primaryUserName.value?.trim() || '',
        source: 'sulla-desktop',
      }),
    }).then((res) => {
      if (!res.ok) {
        console.warn('[FirstRunWelcome] Subscription request failed:', res.status);
      } else {
        console.log('[FirstRunWelcome] Subscription submitted successfully');
      }
    }).catch((err) => {
      console.warn('[FirstRunWelcome] Subscription request error:', err);
    });
  }

  // Check if ready to trigger custom environment
  if (await SullaSettingsModel.get('sullaEmail', false) &&
      await SullaSettingsModel.get('sullaPassword', false)) {
    console.log('[FirstRunWelcome] Triggering custom environment...');

    sessionStorage.setItem('sulla-startup-splash-seen', 'true');
    ipcRenderer.invoke('start-sulla-custom-env');
  } else {
    console.log('[FirstRunWelcome] Not ready to trigger custom environment yet');
    console.log('[FirstRunWelcome] firstRunSullaNetworking:', await SullaSettingsModel.get('firstRunSullaNetworking'));
    // Never log credential values — only whether they are present.
    console.log('[FirstRunWelcome] sullaEmail set:', !!(await SullaSettingsModel.get('sullaEmail')));
    console.log('[FirstRunWelcome] sullaPassword set:', !!(await SullaSettingsModel.get('sullaPassword')));
  }

  emit('next');
};
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

:global(.theme-noir) .heading-text,
:global(.theme-noir) .secondary-text,
:global(.theme-noir) .label-text {
  color: var(--nx-read-2);
}

:global(.theme-noir) .max-w-lg.mx-0.p-6 {
  --fr-account-spring: linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1);
  color: var(--nx-read-2);
}

:global(.theme-noir) .max-w-lg.mx-0.p-6 > form::before,
:global(.theme-noir) .max-w-lg.mx-0.p-6 > div::before {
  content: "ACCOUNT & VAULT";
  display: block;
  margin-top: 5px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: .14em;
  color: var(--nx-accent-2);
}

:global(.theme-noir) .max-w-lg.mx-0.p-6 h2 {
  margin: 7px 0 8px;
  font-family: "Playfair Display", Georgia, serif;
  font-size: 34px;
  line-height: 1.08;
  font-weight: 600;
  letter-spacing: -.02em;
  color: var(--nx-read-1);
}

:global(.theme-noir) .secondary-text {
  font-size: 14px;
  line-height: 1.6;
  color: var(--nx-read-3);
}

:global(.theme-noir) .max-w-lg.mx-0.p-6 :deep(fieldset) {
  padding: 14px 16px 4px;
  border-color: var(--nx-hair);
  border-radius: 18px;
  background: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 3.5%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 4%, transparent);
}

:global(.theme-noir) .max-w-lg.mx-0.p-6 :deep(legend) {
  padding: 0 7px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--nx-read-4);
}

:global(.theme-noir) .max-w-lg.mx-0.p-6 label:not(.flex) {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--nx-read-4);
}

:global(.theme-noir) .form-input {
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

:global(.theme-noir) .form-input:hover {
  border-color: transparent;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .72);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 20%, transparent);
}

:global(.theme-noir) .form-input:focus {
  border-color: transparent;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .78);
  box-shadow: inset 0 0 0 1px var(--nx-accent-2), 0 0 0 3px color-mix(in srgb, var(--nx-accent) 18%, transparent), 0 0 18px color-mix(in srgb, var(--nx-accent) 12%, transparent);
}

:global(.theme-noir) .form-input.input-error {
  box-shadow: inset 0 0 0 1px var(--nx-danger), 0 0 0 3px color-mix(in srgb, var(--nx-danger) 10%, transparent);
}

:global(.theme-noir) .error-text { color: rgb(from var(--nx-danger) calc(r - 4) calc(g + 82) calc(b + 86)); }

:global(.theme-noir) .max-w-lg.mx-0.p-6 input[type="checkbox"] {
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

:global(.theme-noir) .max-w-lg.mx-0.p-6 input[type="checkbox"]::after {
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

:global(.theme-noir) .max-w-lg.mx-0.p-6 input[type="checkbox"]:checked {
  background: linear-gradient(180deg, var(--nx-accent-2), var(--nx-accent));
  box-shadow: 0 0 14px color-mix(in srgb, var(--nx-accent) 42%, transparent);
}

:global(.theme-noir) .max-w-lg.mx-0.p-6 input[type="checkbox"]:checked::after {
  transform: translateX(16px);
  background: #fff;
}

:global(.theme-noir) .recovery-key-box {
  border: 0;
  border-radius: 16px;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .62);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 30%, transparent), 0 0 28px color-mix(in srgb, var(--nx-accent) 8%, transparent);
}

:global(.theme-noir) .recovery-key-box code {
  color: rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16));
  text-shadow: 0 0 12px color-mix(in srgb, var(--nx-accent-2) 28%, transparent);
}

:global(.theme-noir) .btn-primary {
  min-height: 40px;
  padding-inline: 20px;
  border-radius: 20px;
  color: #fff;
  background: linear-gradient(180deg, var(--nx-accent-2), var(--nx-accent));
  box-shadow: 0 0 18px color-mix(in srgb, var(--nx-accent) 34%, transparent);
  transition: transform .58s var(--fr-account-spring), box-shadow .2s ease;
}

:global(.theme-noir) .btn-primary:hover {
  background: linear-gradient(180deg, rgb(from var(--nx-accent-2) calc(r + 8) calc(g + 10) calc(b + 9)), var(--nx-accent));
  box-shadow: 0 0 24px color-mix(in srgb, var(--nx-accent) 48%, transparent);
}

:global(.theme-noir) .btn-primary:active { transform: scale(.95); }

:global(.theme-noir) .btn-back {
  min-height: 40px;
  padding-inline: 18px;
  border-radius: 20px;
  color: var(--nx-read-3);
  background: transparent;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 12%, transparent);
}

:global(.theme-noir) .link-btn {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  color: rgb(from var(--nx-accent-2) calc(r + 34) calc(g - 4) calc(b - 3));
  text-decoration: none;
}

@media (prefers-reduced-motion: reduce) {
  :global(.theme-noir) .max-w-lg.mx-0.p-6 input[type="checkbox"]::after,
  :global(.theme-noir) .btn-primary {
    transition-duration: .01ms;
  }
}

/* Noir Light softens dark-only elevation shadows for paper surfaces. */
:global(.theme-noir-light) .max-w-lg.mx-0.p-6 input[type="checkbox"]::after {
  box-shadow: 0 2px 6px color-mix(in srgb, var(--nx-ink) 14%, transparent);
}
</style>
