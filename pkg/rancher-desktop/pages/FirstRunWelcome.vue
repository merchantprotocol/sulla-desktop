<template>
  <div class="max-w-lg mx-0 p-6 bg-white dark:bg-gray-800/30">
    <form @submit.prevent="handleNextWelcome">
      <h2 class="text-2xl font-bold mt-5 mb-4 text-gray-900 dark:text-gray-100">Create Your Account</h2>
      <p class="mb-6 text-gray-600 dark:text-gray-400">Set up your account details and preferences.</p>

      <rd-fieldset legend-text="User Account" class="mb-6 dark:text-gray-100">
        <div class="mb-4">
          <label for="primaryUserName" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Primary User Name:</label>
          <input id="primaryUserName" type="text" v-model="primaryUserName" class="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100" placeholder="Enter your name (optional)">
        </div>
        <div class="mb-4">
          <label for="email" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email:</label>
          <input id="email" type="email" v-model="sullaEmail" class="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100" :class="{ 'border-red-500': !!emailError }" placeholder="Enter email">
          <p v-if="emailError" class="text-red-500 text-sm mt-1">{{ emailError }}</p>
        </div>
        <div class="mb-4">
          <label for="password" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password:</label>
          <input id="password" type="password" v-model="sullaPassword" class="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100" :class="{ 'border-red-500': !!passwordError }" placeholder="Enter password">
          <p v-if="passwordError" class="text-red-500 text-sm mt-1">{{ passwordError }}</p>
        </div>
      </rd-fieldset>

      <rd-fieldset legend-text="Updates" class="mb-6 dark:text-gray-100">
        <label class="flex items-center">
          <input type="checkbox" checked="true" v-model="sullaSubscribeToUpdates" class="mr-2">
          <span class="text-sm text-gray-700 dark:text-gray-300">Subscribe to updates and newsletters</span>
        </label>
      </rd-fieldset>

      <div class="flex justify-between mt-5">
        <button v-if="showBack" type="button" @click="$emit('back')" class="px-6 py-2 text-gray-500 rounded-md transition-colors font-medium hover:opacity-90 bg-gray-100 hover:bg-gray-200 cursor-pointer">Back</button>
        <button type="submit" class="px-6 py-2 text-white rounded-md transition-colors font-medium hover:opacity-90" :style="{ backgroundColor: '#30a5e9' }">Next</button>
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
onMounted(async () => {
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

const handleNextWelcome = async () => {
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


  // Save to SullaSettingsModel
  await SullaSettingsModel.set('primaryUserName', primaryUserName.value, 'string');
  await SullaSettingsModel.set('sullaEmail', sullaEmail.value, 'string');
  await SullaSettingsModel.set('sullaPassword', sullaPassword.value, 'string');
  await SullaSettingsModel.set('sullaSubscribeToUpdates', sullaSubscribeToUpdates.value, 'boolean');
  await SullaSettingsModel.set('firstRunCredentialsNeeded', false, 'boolean');

  console.log('[FirstRunWelcome] Settings committed successfully');

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

input[type="checkbox"]:checked {
  accent-color: #30a5e9;
}

/* Hover effects */
button:hover {
  cursor: pointer;
}

input:hover, select:hover {
  border-color: #374151; /* darker gray border */
  background-color: #f3f4f6; /* slightly darker background */
}

.dark input:hover, .dark select:hover {
  background-color: #4b5563 !important; /* darker background for dark mode */
}
</style>
