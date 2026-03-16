<template>
  <div class="max-w-lg mx-0 p-6">
    <form @submit.prevent="handleNextWelcome">
      <h2 class="text-2xl font-bold mt-5 mb-4 heading-text">
        Create Your Account
      </h2>
      <p class="mb-6 secondary-text">
        Set up your account details and preferences.
      </p>

      <rd-fieldset
        legend-text="User Account"
        class="mb-6 heading-text"
      >
        <div class="mb-4">
          <label
            for="primaryUserName"
            class="block text-sm font-medium mb-1 label-text"
          >Primary User Name:</label>
          <input
            id="primaryUserName"
            v-model="primaryUserName"
            type="text"
            class="w-full p-2 border rounded-md form-input"
            placeholder="Enter your name (optional)"
          >
        </div>
        <div class="mb-4">
          <label
            for="email"
            class="block text-sm font-medium mb-1 label-text"
          >Email:</label>
          <input
            id="email"
            v-model="sullaEmail"
            type="email"
            class="w-full p-2 border rounded-md form-input"
            :class="{ 'input-error': !!emailError }"
            placeholder="Enter email"
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
          >Password:</label>
          <input
            id="password"
            v-model="sullaPassword"
            type="password"
            class="w-full p-2 border rounded-md form-input"
            :class="{ 'input-error': !!passwordError }"
            placeholder="Enter password"
          >
          <p
            v-if="passwordError"
            class="text-sm mt-1 error-text"
          >
            {{ passwordError }}
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
          <span class="text-sm label-text">Subscribe to updates and newsletters</span>
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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import RdFieldset from '@pkg/components/form/RdFieldset.vue';
import { ipcRenderer } from 'electron';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

const emit = defineEmits<{
  next: [];
  back: [];
}>();

const props = defineProps<{
  showBack?: boolean;
}>();

// Reactive data for sullaEmail
const sullaEmail = ref('');
const sullaPassword = ref('');
const primaryUserName = ref('');
const sullaSubscribeToUpdates = ref(true);

// Reactive error states
const emailError = ref('');
const passwordError = ref('');

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
    passwordError.value = 'Password is required.';
    return false;
  }
  passwordError.value = '';
  return true;
};

// Load settings on mount
onMounted(async() => {
  // Load sullaEmail from SullaSettingsModel
  const loadedEmail = await SullaSettingsModel.get('sullaEmail');
  sullaEmail.value = loadedEmail || '';

  // Load sullaPassword from SullaSettingsModel
  const loadedPassword = await SullaSettingsModel.get('sullaPassword');
  sullaPassword.value = loadedPassword || '';

  // Load sullaSubscribeToUpdates from SullaSettingsModel
  const loadedSubscribe = await SullaSettingsModel.get('sullaSubscribeToUpdates');
  sullaSubscribeToUpdates.value = loadedSubscribe !== null ? loadedSubscribe : true;

  // Load primaryUserName from SullaSettingsModel
  const loadedPrimaryUserName = await SullaSettingsModel.get('primaryUserName');
  primaryUserName.value = loadedPrimaryUserName || '';
});

const handleNextWelcome = async() => {
  const emailValid = validateEmail();
  const passwordValid = validatePassword();

  if (!emailValid || !passwordValid) {
    return;
  }

  // Load and set service password and encryption key
  console.log('[FirstRunWelcome] Loading service password and encryption key...');

  const sullaServicePassword = await SullaSettingsModel.get('sullaServicePassword', SullaSettingsModel.generatePassword());
  await SullaSettingsModel.set('sullaServicePassword', sullaServicePassword, 'string');
  console.log('[FirstRunWelcome] Loaded sullaServicePassword:', sullaServicePassword);

  // Load sullaN8nEncryptionKey from SullaSettingsModel
  const loadedKey = await SullaSettingsModel.get('sullaN8nEncryptionKey', SullaSettingsModel.generateEncryptionKey());
  await SullaSettingsModel.set('sullaN8nEncryptionKey', loadedKey, 'string');
  console.log('[FirstRunWelcome] Loaded sullaN8nEncryptionKey:', loadedKey);

  // Pre-generate n8n API key ID and JWT token for recipe migrations
  const n8nServiceUserId = '00000000-0000-0000-0000-000000000001';
  const sullaN8nApiKeyId = await SullaSettingsModel.get('sullaN8nApiKeyId', SullaSettingsModel.generateN8nApiKeyId());
  await SullaSettingsModel.set('sullaN8nApiKeyId', sullaN8nApiKeyId, 'string');
  const sullaN8nApiKey = await SullaSettingsModel.get('sullaN8nApiKey');
  if (!sullaN8nApiKey) {
    const generatedKey = await SullaSettingsModel.generateN8nApiKeyToken(n8nServiceUserId, loadedKey);
    await SullaSettingsModel.set('sullaN8nApiKey', generatedKey, 'string');
    await SullaSettingsModel.set('serviceAccountApiKey', generatedKey, 'string');
    console.log('[FirstRunWelcome] Generated sullaN8nApiKey');
  }

  // Save to SullaSettingsModel
  await SullaSettingsModel.set('primaryUserName', primaryUserName.value, 'string');
  await SullaSettingsModel.set('sullaEmail', sullaEmail.value, 'string');
  await SullaSettingsModel.set('sullaPassword', sullaPassword.value, 'string');
  await SullaSettingsModel.set('sullaSubscribeToUpdates', sullaSubscribeToUpdates.value, 'boolean');
  await SullaSettingsModel.set('firstRunCredentialsNeeded', false, 'boolean');

  console.log('[FirstRunWelcome] Settings committed successfully');

  // Submit email subscription to worker if opted in
  if (sullaSubscribeToUpdates.value && sullaEmail.value?.trim()) {
    fetch('https://email-submission.jonathon-44b.workers.dev/', {
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
    console.log('[FirstRunWelcome] sullaEmail:', await SullaSettingsModel.get('sullaEmail'));
    console.log('[FirstRunWelcome] sullaPassword:', await SullaSettingsModel.get('sullaPassword'));
    console.log('[FirstRunWelcome] sullaServicePassword:', await SullaSettingsModel.get('sullaServicePassword'));
    console.log('[FirstRunWelcome] sullaN8nEncryptionKey:', await SullaSettingsModel.get('sullaN8nEncryptionKey'));
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
</style>
