<template>
  <div class="vault-unlock-screen">
    <WindowDragLogo
      :size="20"
      class="vault-drag-logo"
    />
    <div class="vault-unlock-card">
      <!-- Lock icon -->
      <div class="vault-unlock-icon">
        <span
          class="vault-unlock-mark"
          aria-hidden="true"
        >S</span>
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
          <rect
            x="3"
            y="11"
            width="18"
            height="11"
            rx="2"
            ry="2"
          />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          <circle
            cx="12"
            cy="16"
            r="1"
          />
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
      <p class="vault-unlock-hint">
        Encrypted locally · never leaves this computer
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue';

import WindowDragLogo from '@pkg/components/WindowDragLogo.vue';
import { useVaultUnlock } from '@pkg/composables/useVaultUnlock';

const emit = defineEmits<{
  unlocked: [];
}>();

const {
  unlockError,
  unlockMode,
  login,
  loginWithRecoveryKey,
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
    success = await login(password.value);
  } else {
    if (!recoveryKey.value.trim()) {
      unlockError.value = 'Please enter your recovery key.';
      submitting.value = false;
      return;
    }
    success = await loginWithRecoveryKey(recoveryKey.value.trim());
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
  background: var(--bg-page, #0d1117);
  /* Allow window drag on the background */
  -webkit-app-region: drag;
}

.vault-drag-logo {
  position: fixed;
  top: 10px;
  left: 80px;
  z-index: 100000;
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
  background: color-mix(in srgb, var(--accent-primary, #5096b3) 12%, transparent);
  color: var(--accent-primary, #5096b3);
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
  border-color: var(--accent-primary, #5096b3);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary, #5096b3) 20%, transparent);
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
  background: var(--accent-primary, #5096b3);
  color: var(--text-on-accent, #0d1117);
  border: none;
  border-radius: 0.5rem;
  cursor: pointer;
  transition: background-color 150ms, opacity 150ms;
}

.vault-unlock-btn:hover:not(:disabled) {
  background: var(--accent-primary-hover, #6ab0cc);
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

.vault-unlock-mark,
.vault-unlock-hint {
  display: none;
}

@keyframes vault-noir-shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-7px) rotate(-.25deg); }
  42% { transform: translateX(5px) rotate(.2deg); }
  62% { transform: translateX(-3px); }
  80% { transform: translateX(1px); }
}

:global(.theme-noir-dark) .vault-unlock-screen {
  --vault-spring: linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1);
  overflow: hidden;
  background:
    radial-gradient(58% 44% at 50% 38%, rgba(80, 150, 179, .16), transparent 66%),
    radial-gradient(62% 52% at 0% 100%, rgba(80, 150, 179, .07), transparent 72%),
    #01030a;
}

:global(.theme-noir-dark) .vault-unlock-screen::before {
  content: "";
  position: absolute;
  inset: -25%;
  pointer-events: none;
  background: radial-gradient(circle at center, transparent 0 32%, rgba(1, 3, 10, .3) 58%, rgba(1, 3, 10, .88) 100%);
}

:global(.theme-noir-dark) .vault-unlock-card {
  position: relative;
  max-width: 400px;
  padding: 36px 34px 28px;
  border-radius: 24px;
  background:
    linear-gradient(145deg, rgba(168, 192, 220, .055), rgba(168, 192, 220, .018)),
    rgba(7, 13, 26, .78);
  box-shadow: inset 0 0 0 1px rgba(168, 192, 220, .1), 0 30px 80px rgba(0, 0, 0, .58), 0 0 70px rgba(80, 150, 179, .08);
  backdrop-filter: blur(24px);
}

:global(.theme-noir-dark) .vault-unlock-card:has(.vault-unlock-error) {
  animation: vault-noir-shake .58s var(--vault-spring) both;
}

:global(.theme-noir-dark) .vault-unlock-icon {
  width: 72px;
  height: 72px;
  margin-bottom: 19px;
  border-radius: 50%;
  color: #03060c;
  background: linear-gradient(135deg, #a8c0dc, #5096b3);
  box-shadow: inset 0 0 0 .5px rgba(255, 255, 255, .25), 0 0 22px rgba(80, 150, 179, .44), 0 0 64px rgba(80, 150, 179, .2);
}

:global(.theme-noir-dark) .vault-unlock-icon svg { display: none; }

:global(.theme-noir-dark) .vault-unlock-mark {
  display: block;
  font-family: "Playfair Display", Georgia, serif;
  font-size: 32px;
  line-height: 1;
  font-weight: 700;
  text-shadow: 0 1px 0 rgba(255, 255, 255, .18);
}

:global(.theme-noir-dark) .vault-unlock-title {
  margin-bottom: 4px;
  font-family: "Playfair Display", Georgia, serif;
  font-size: 34px;
  line-height: 1.08;
  font-weight: 600;
  letter-spacing: -.02em;
  color: #f3f5f8;
  text-shadow: 0 0 28px rgba(80, 150, 179, .16);
}

:global(.theme-noir-dark) .vault-unlock-subtitle {
  margin-bottom: 23px;
  font-size: 13.5px;
  color: #a9b3c1;
}

:global(.theme-noir-dark) .vault-unlock-form { gap: 10px; }

:global(.theme-noir-dark) .vault-unlock-input {
  height: 44px;
  padding: 0 14px;
  border: 0;
  border-radius: 14px;
  background: rgba(3, 6, 12, .7);
  box-shadow: inset 0 0 0 1px rgba(168, 192, 220, .12);
  color: #f3f5f8;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 13px;
  caret-color: #6ab0cc;
  transition: box-shadow .22s ease, background .22s ease;
}

:global(.theme-noir-dark) .vault-unlock-input:hover {
  background: rgba(3, 6, 12, .78);
  box-shadow: inset 0 0 0 1px rgba(168, 192, 220, .2);
}

:global(.theme-noir-dark) .vault-unlock-input:focus {
  border-color: transparent;
  background: rgba(3, 6, 12, .86);
  box-shadow: inset 0 0 0 1px #6ab0cc, 0 0 0 3px rgba(80, 150, 179, .2), 0 0 22px rgba(80, 150, 179, .16);
}

:global(.theme-noir-dark) .vault-unlock-input-error,
:global(.theme-noir-dark) .vault-unlock-input-error:focus {
  box-shadow: inset 0 0 0 1px #f85149, 0 0 0 3px rgba(248, 81, 73, .1);
}

:global(.theme-noir-dark) .vault-unlock-input::placeholder {
  color: #484f5a;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

:global(.theme-noir-dark) .vault-unlock-error {
  color: #f4a39f;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
}

:global(.theme-noir-dark) .vault-unlock-btn {
  height: 42px;
  padding: 0 18px;
  border-radius: 21px;
  color: #fff;
  background: linear-gradient(180deg, #6ab0cc, #5096b3);
  box-shadow: inset 0 0 0 .5px rgba(255, 255, 255, .18), 0 0 20px rgba(80, 150, 179, .36);
  transition: transform .58s var(--vault-spring), box-shadow .2s ease, opacity .2s ease;
}

:global(.theme-noir-dark) .vault-unlock-btn:hover:not(:disabled) {
  background: linear-gradient(180deg, #72bad5, #5096b3);
  box-shadow: inset 0 0 0 .5px rgba(255, 255, 255, .22), 0 0 28px rgba(80, 150, 179, .5);
}

:global(.theme-noir-dark) .vault-unlock-btn:active:not(:disabled) { transform: scale(.96); }

:global(.theme-noir-dark) .vault-unlock-toggle {
  margin-top: 17px;
  color: #8cacc9;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  text-decoration: none;
}

:global(.theme-noir-dark) .vault-unlock-toggle:hover { color: #dee4ec; }

:global(.theme-noir-dark) .vault-unlock-hint {
  display: block;
  margin: 12px 0 0;
  color: #484f5a;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 9.5px;
  letter-spacing: .035em;
}

@media (prefers-reduced-motion: reduce) {
  :global(.theme-noir-dark) .vault-unlock-card:has(.vault-unlock-error) { animation: none; }
  :global(.theme-noir-dark) .vault-unlock-btn { transition-duration: .01ms; }
}
</style>
