<template>
  <div class="vault-unlock-screen">
    <div class="vault-unlock-card">
      <!-- Lock icon -->
      <div class="vault-unlock-icon">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          <circle cx="12" cy="16" r="1" />
        </svg>
      </div>

      <h1 class="vault-unlock-title">
        Sulla
      </h1>
      <p class="vault-unlock-subtitle">
        {{ unlockMode === 'password' ? 'Enter your master password to unlock' : 'Enter your recovery key' }}
      </p>

      <form
        class="vault-unlock-form"
        @submit.prevent="handleSubmit"
      >
        <!-- Password mode -->
        <template v-if="unlockMode === 'password'">
          <input
            ref="passwordInput"
            v-model="password"
            type="password"
            class="vault-unlock-input"
            :class="{ 'vault-unlock-input-error': !!unlockError }"
            placeholder="Master password"
            autocomplete="current-password"
            autofocus
          >
        </template>

        <!-- Recovery key mode -->
        <template v-else>
          <input
            ref="recoveryInput"
            v-model="recoveryKey"
            type="text"
            class="vault-unlock-input"
            :class="{ 'vault-unlock-input-error': !!unlockError }"
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
            autocomplete="off"
            spellcheck="false"
          >
        </template>

        <p
          v-if="unlockError"
          class="vault-unlock-error"
        >
          {{ unlockError }}
        </p>

        <button
          type="submit"
          class="vault-unlock-btn"
          :disabled="submitting"
        >
          {{ submitting ? 'Unlocking...' : 'Unlock' }}
        </button>
      </form>

      <button
        type="button"
        class="vault-unlock-toggle"
        @click="toggleMode"
      >
        {{ unlockMode === 'password' ? 'Use recovery key instead' : 'Use master password instead' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue';
import { useVaultUnlock } from '@pkg/composables/useVaultUnlock';

const emit = defineEmits<{
  unlocked: [];
}>();

const {
  unlockError,
  unlockMode,
  unlockWithPassword,
  unlockWithRecoveryKey,
} = useVaultUnlock();

const password = ref('');
const recoveryKey = ref('');
const submitting = ref(false);
const passwordInput = ref<HTMLInputElement | null>(null);
const recoveryInput = ref<HTMLInputElement | null>(null);

async function handleSubmit() {
  if (submitting.value) return;
  submitting.value = true;

  let success = false;

  if (unlockMode.value === 'password') {
    if (!password.value.trim()) {
      unlockError.value = 'Please enter your master password.';
      submitting.value = false;
      return;
    }
    success = await unlockWithPassword(password.value);
  } else {
    if (!recoveryKey.value.trim()) {
      unlockError.value = 'Please enter your recovery key.';
      submitting.value = false;
      return;
    }
    success = await unlockWithRecoveryKey(recoveryKey.value.trim());
  }

  submitting.value = false;

  if (success) {
    emit('unlocked');
  }
}

function toggleMode() {
  unlockError.value = '';
  if (unlockMode.value === 'password') {
    unlockMode.value = 'recovery';
    nextTick(() => recoveryInput.value?.focus());
  } else {
    unlockMode.value = 'password';
    nextTick(() => passwordInput.value?.focus());
  }
}
</script>

<style scoped>
.vault-unlock-screen {
  position: fixed;
  inset: 0;
  z-index: 99999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-surface, #0d1117);
  /* Allow window drag on the background */
  -webkit-app-region: drag;
}

.vault-unlock-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  max-width: 360px;
  padding: 2.5rem 2rem;
  /* Card content should not be draggable */
  -webkit-app-region: no-drag;
}

.vault-unlock-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 1rem;
  background: color-mix(in srgb, var(--accent-primary, #38bdf8) 12%, transparent);
  color: var(--accent-primary, #38bdf8);
  margin-bottom: 1.5rem;
}

.vault-unlock-title {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--text-primary, #e6edf3);
  margin: 0 0 0.375rem;
  letter-spacing: -0.02em;
}

.vault-unlock-subtitle {
  font-size: 0.875rem;
  color: var(--text-secondary, #8b949e);
  margin: 0 0 1.75rem;
  text-align: center;
}

.vault-unlock-form {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.vault-unlock-input {
  width: 100%;
  padding: 0.625rem 0.875rem;
  font-size: 0.875rem;
  background: var(--bg-input, #161b22);
  color: var(--text-primary, #e6edf3);
  border: 1px solid var(--border-default, #30363d);
  border-radius: 0.5rem;
  outline: none;
  transition: border-color 150ms, box-shadow 150ms;
  text-align: center;
  letter-spacing: 0.05em;
}

.vault-unlock-input:focus {
  border-color: var(--accent-primary, #38bdf8);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary, #38bdf8) 20%, transparent);
}

.vault-unlock-input-error {
  border-color: var(--text-error, #f85149);
}

.vault-unlock-input::placeholder {
  color: var(--text-muted, #484f58);
  letter-spacing: normal;
}

.vault-unlock-error {
  font-size: 0.75rem;
  color: var(--text-error, #f85149);
  text-align: center;
  margin: 0;
}

.vault-unlock-btn {
  width: 100%;
  padding: 0.625rem;
  font-size: 0.875rem;
  font-weight: 600;
  background: var(--accent-primary, #38bdf8);
  color: var(--text-on-accent, #0d1117);
  border: none;
  border-radius: 0.5rem;
  cursor: pointer;
  transition: background-color 150ms, opacity 150ms;
}

.vault-unlock-btn:hover:not(:disabled) {
  background: var(--accent-primary-hover, #7dd3fc);
}

.vault-unlock-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.vault-unlock-toggle {
  margin-top: 1.25rem;
  font-size: 0.75rem;
  color: var(--text-muted, #484f58);
  background: none;
  border: none;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
  transition: color 150ms;
}

.vault-unlock-toggle:hover {
  color: var(--text-secondary, #8b949e);
}
</style>
