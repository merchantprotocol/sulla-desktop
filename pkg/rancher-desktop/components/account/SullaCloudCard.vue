<template>
  <div class="account-card">
    <div class="account-card-header">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        class="account-card-icon"
      >
        <path d="M17.5 19H9a7 7 0 110-14 7 7 0 016.71 5H17.5a4.5 4.5 0 010 9z" />
      </svg>
      <h2 class="account-card-title">
        Sulla Cloud
      </h2>
      <span
        class="account-status-dot"
        :class="cloudStatus.signedIn ? 'account-status-on' : 'account-status-off'"
      />
    </div>

    <!-- Signed-in view -->
    <template v-if="cloudStatus.signedIn">
      <p class="account-hint">
        Signed in as <strong>{{ cloudStatus.name || cloudStatus.phone || cloudStatus.userId }}</strong>.
        User ID =
        <code class="account-mono">{{ cloudStatus.userId }}</code>
        <span
          v-if="cloudStatus.contractorCount > 1"
          class="account-relay-state"
        >
          · {{ cloudStatus.contractorCount }} businesses linked
        </span>
      </p>
      <p class="account-hint">
        Relay <span class="account-relay-state">({{ relayStatus.connected ? 'connected' : 'waiting for mobile' }})</span> —
        room
        <code class="account-mono">{{ relayStatus.pairedUserId || cloudStatus.userId }}</code>
      </p>
      <button
        type="button"
        class="account-action-btn"
        :disabled="busy"
        @click="signOut"
      >
        Sign out
      </button>
    </template>

    <!-- Signed-out view -->
    <template v-else>
      <p
        v-if="rationale"
        class="account-hint"
      >
        {{ rationale }}
      </p>

      <div class="account-tabs">
        <button
          type="button"
          :class="['account-tab', { 'account-tab-active': cloudTab === 'phone' }]"
          @click="cloudTab = 'phone'"
        >
          Phone
        </button>
        <button
          type="button"
          :class="['account-tab', { 'account-tab-active': cloudTab === 'email' }]"
          @click="cloudTab = 'email'"
        >
          Email
        </button>
        <button
          type="button"
          :class="['account-tab', { 'account-tab-active': cloudTab === 'apple' }]"
          @click="cloudTab = 'apple'"
        >
          Apple
        </button>
      </div>

      <!-- Phone OTP flow -->
      <template v-if="cloudTab === 'phone'">
        <div class="account-field">
          <label class="account-label">Phone (E.164)</label>
          <input
            v-model="phoneInput"
            type="tel"
            placeholder="+15551234567"
            class="account-input"
            :disabled="otpSent"
          >
        </div>
        <div
          v-if="otpSent"
          class="account-field"
        >
          <label class="account-label">Verification Code</label>
          <input
            v-model="otpCode"
            type="text"
            inputmode="numeric"
            maxlength="8"
            placeholder="123456"
            class="account-input"
          >
        </div>
        <p
          v-if="cloudError"
          class="account-error"
        >
          {{ cloudError }}
        </p>
        <div class="account-btn-row">
          <button
            v-if="!otpSent"
            type="button"
            class="account-save-btn"
            :disabled="busy || !phoneInput"
            @click="sendOtp"
          >
            {{ busy ? 'Sending...' : 'Send Code' }}
          </button>
          <template v-else>
            <button
              type="button"
              class="account-save-btn"
              :disabled="busy || !otpCode"
              @click="verifyOtp"
            >
              {{ busy ? 'Verifying...' : 'Verify' }}
            </button>
            <button
              type="button"
              class="account-action-btn"
              :disabled="busy"
              @click="resetPhoneFlow"
            >
              Use a different number
            </button>
          </template>
        </div>
      </template>

      <!-- Email flow -->
      <template v-else-if="cloudTab === 'email'">
        <div class="account-field">
          <label class="account-label">Email</label>
          <input
            v-model="emailInput"
            type="email"
            placeholder="you@example.com"
            class="account-input"
            autocomplete="email"
          >
        </div>
        <div class="account-field">
          <label class="account-label">Password</label>
          <input
            v-model="emailPassword"
            type="password"
            placeholder="••••••••"
            class="account-input"
            :autocomplete="emailMode === 'login' ? 'current-password' : 'new-password'"
          >
        </div>
        <div
          v-if="emailMode === 'register'"
          class="account-field"
        >
          <label class="account-label">Name (optional)</label>
          <input
            v-model="emailName"
            type="text"
            placeholder="Your name"
            class="account-input"
          >
        </div>
        <p
          v-if="cloudError"
          class="account-error"
        >
          {{ cloudError }}
        </p>
        <div class="account-btn-row">
          <button
            type="button"
            class="account-save-btn"
            :disabled="busy || !emailInput || !emailPassword"
            @click="emailSubmit"
          >
            {{ busy ? 'Working...' : (emailMode === 'login' ? 'Sign In' : 'Create Account') }}
          </button>
          <button
            type="button"
            class="account-action-btn"
            :disabled="busy"
            @click="emailMode = emailMode === 'login' ? 'register' : 'login'"
          >
            {{ emailMode === 'login' ? 'Register' : 'Back to sign in' }}
          </button>
        </div>
      </template>

      <!-- Apple flow -->
      <template v-else-if="cloudTab === 'apple'">
        <p class="account-hint">
          Sign in with Apple is managed as a vault integration. Clicking
          below opens the Apple Sign In integration in your vault, where
          you start the OAuth flow.
        </p>
        <p
          v-if="cloudError"
          class="account-error"
        >
          {{ cloudError }}
        </p>
        <button
          type="button"
          class="account-apple-btn"
          :disabled="busy"
          @click="openAppleInVault"
        >
          <svg
            viewBox="0 0 170 170"
            fill="currentColor"
            aria-hidden="true"
            class="account-apple-icon"
          >
            <path d="M150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.197-2.12-9.973-3.17-14.34-3.17-4.58 0-9.492 1.05-14.746 3.17-5.262 2.13-9.501 3.24-12.742 3.35-4.929.21-9.842-1.96-14.746-6.52-3.131-2.73-7.047-7.41-11.729-14.04-5.039-7.08-9.18-15.29-12.423-24.64-3.492-10.1-5.224-19.88-5.224-29.35 0-10.85 2.345-20.21 7.043-28.05 3.693-6.3 8.609-11.27 14.76-14.92 6.149-3.66 12.794-5.52 19.94-5.64 3.915 0 9.051 1.21 15.434 3.59 6.36 2.39 10.44 3.6 12.229 3.6 1.338 0 5.871-1.42 13.566-4.24 7.278-2.62 13.421-3.71 18.445-3.28 13.607 1.1 23.828 6.46 30.635 16.08-12.171 7.37-18.192 17.7-18.073 30.96.11 10.33 3.86 18.93 11.24 25.75 3.34 3.17 7.07 5.62 11.22 7.36-.9 2.61-1.85 5.11-2.86 7.51zM119.11 7.24c0 8.1-2.96 15.66-8.86 22.67-7.12 8.33-15.73 13.14-25.07 12.38-.12-.97-.19-1.99-.19-3.06 0-7.77 3.39-16.1 9.41-22.91 3.01-3.45 6.84-6.32 11.49-8.61 4.64-2.25 9.03-3.5 13.16-3.71.12 1.08.17 2.16.17 3.23z" />
          </svg>
          <span>Sign in with Apple</span>
        </button>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type CloudStatus = {
  signedIn:           boolean;
  userId:             string;
  activeContractorId: string;
  phone:              string;
  name:               string;
  contractorCount:    number;
  lastError?:         string;
};
type RelayStatus = { pairedUserId: string; connected: boolean; lastError?: string };

withDefaults(defineProps<{
  /** Optional explainer shown above the sign-in tabs (e.g. "Sign in to
   *  use the marketplace"). The signed-in view never shows it. */
  rationale?: string;
}>(), { rationale: '' });

const emit = defineEmits<{
  (e: 'signed-in', status: CloudStatus): void
  (e: 'signed-out', status: CloudStatus): void
}>();

const cloudStatus = ref<CloudStatus>({
  signedIn:           false,
  userId:             '',
  activeContractorId: '',
  phone:              '',
  name:               '',
  contractorCount:    0,
});
const relayStatus = ref<RelayStatus>({ pairedUserId: '', connected: false });
const cloudTab = ref<'phone' | 'email' | 'apple'>('phone');
const cloudError = ref('');
const busy = ref(false);

const phoneInput = ref('');
const otpSent = ref(false);
const otpCode = ref('');

const emailInput = ref('');
const emailPassword = ref('');
const emailName = ref('');
const emailMode = ref<'login' | 'register'>('login');

const router = useRouter();

async function refreshCloudStatus() {
  const prevSignedIn = cloudStatus.value.signedIn;
  try {
    cloudStatus.value = await ipcRenderer.invoke('sulla-cloud:get-status');
  } catch (err) {
    console.error('[SullaCloudCard] get-status failed:', err);
  }
  try {
    relayStatus.value = await ipcRenderer.invoke('desktop-relay:get-status');
  } catch (err) {
    console.error('[SullaCloudCard] desktop-relay get-status failed:', err);
  }
  // Emit once the truth changes so the parent can react (e.g. the
  // marketplace tab hides the gate and loads the catalog).
  if (!prevSignedIn && cloudStatus.value.signedIn) {
    emit('signed-in', cloudStatus.value);
  } else if (prevSignedIn && !cloudStatus.value.signedIn) {
    emit('signed-out', cloudStatus.value);
  }
}

function onRelayStatusChanged(_ev: unknown, status: RelayStatus) {
  relayStatus.value = status;
}

function resetPhoneFlow() {
  otpSent.value = false;
  otpCode.value = '';
  cloudError.value = '';
}

async function sendOtp() {
  cloudError.value = '';
  busy.value = true;
  try {
    const res = await ipcRenderer.invoke('sulla-cloud:send-otp', phoneInput.value.trim());
    cloudStatus.value = res.status;
    if (!res.ok) {
      cloudError.value = res.error || 'Failed to send code.';
      return;
    }
    otpSent.value = true;
  } finally {
    busy.value = false;
  }
}

async function verifyOtp() {
  cloudError.value = '';
  busy.value = true;
  try {
    const res = await ipcRenderer.invoke(
      'sulla-cloud:verify-otp',
      phoneInput.value.trim(),
      otpCode.value.trim(),
    );
    cloudStatus.value = res.status;
    if (!res.ok) {
      cloudError.value = res.error || 'Verification failed.';
      return;
    }
    resetPhoneFlow();
    await refreshCloudStatus();
  } finally {
    busy.value = false;
  }
}

async function emailSubmit() {
  cloudError.value = '';
  busy.value = true;
  try {
    const channel = emailMode.value === 'login' ? 'sulla-cloud:email-login' : 'sulla-cloud:email-register';
    const args: [string, string, string?] = emailMode.value === 'login'
      ? [emailInput.value.trim(), emailPassword.value]
      : [emailInput.value.trim(), emailPassword.value, emailName.value.trim() || undefined];
    const res = await ipcRenderer.invoke(channel, ...args);
    cloudStatus.value = res.status;
    if (!res.ok) {
      cloudError.value = res.error || 'Sign-in failed.';
      return;
    }
    emailPassword.value = '';
    await refreshCloudStatus();
  } finally {
    busy.value = false;
  }
}

function openAppleInVault() {
  router.push('/Integrations/apple_signin').catch((err) => {
    console.error('[SullaCloudCard] Failed to navigate to Apple integration:', err);
    cloudError.value = 'Could not open the Apple integration in the vault.';
  });
}

async function signOut() {
  busy.value = true;
  try {
    cloudStatus.value = await ipcRenderer.invoke('sulla-cloud:logout');
    resetPhoneFlow();
    emailPassword.value = '';
    await refreshCloudStatus();
  } finally {
    busy.value = false;
  }
}

defineExpose({ refresh: refreshCloudStatus, status: cloudStatus });

onMounted(async() => {
  await refreshCloudStatus();
  ipcRenderer.on('desktop-relay:status-changed', onRelayStatusChanged);
});

onBeforeUnmount(() => {
  ipcRenderer.removeListener('desktop-relay:status-changed', onRelayStatusChanged);
});
</script>

<style scoped>
.account-card {
  padding: 20px;
  background: var(--bg-surface-alt, #161b22);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 12px;
  color: var(--text-primary, #e6edf3);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.account-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-default, #21262d);
}

.account-card-icon {
  width: 18px;
  height: 18px;
  color: var(--accent-primary, #38bdf8);
}

.account-card-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}

.account-field {
  margin-bottom: 14px;
}

.account-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #8b949e);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}

.account-input {
  width: 100%;
  padding: 10px 14px;
  font-size: 14px;
  background: var(--bg-surface, #0d1117);
  color: var(--text-primary, #e6edf3);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 8px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
  box-sizing: border-box;
}

.account-input:focus {
  border-color: var(--accent-primary, #38bdf8);
  box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15);
}

.account-hint {
  font-size: 12px;
  color: var(--text-muted, #484f58);
  line-height: 1.5;
  margin: 0 0 10px;
}

.account-error {
  font-size: 12px;
  color: #f85149;
  margin: 0 0 10px;
}

.account-save-btn {
  padding: 10px 20px;
  font-size: 13px;
  font-weight: 600;
  background: var(--accent-primary, #38bdf8);
  color: var(--bg-surface, #0d1117);
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}

.account-save-btn:hover:not(:disabled) {
  background: #7dd3fc;
}

.account-save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.account-action-btn {
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 500;
  background: transparent;
  color: var(--accent-primary, #38bdf8);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.account-action-btn:hover:not(:disabled) {
  background: rgba(56, 189, 248, 0.06);
  border-color: var(--accent-primary, #38bdf8);
}

.account-action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.account-status-dot {
  margin-left: auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.account-status-on {
  background: #3fb950;
  box-shadow: 0 0 8px rgba(63, 185, 80, 0.6);
}

.account-status-off {
  background: var(--text-muted, #484f58);
}

.account-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--text-primary, #e6edf3);
  background: var(--bg-surface, #0d1117);
  padding: 1px 6px;
  border-radius: 4px;
}

.account-relay-state {
  color: var(--text-muted, #484f58);
}

.account-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 14px;
  padding: 4px;
  background: var(--bg-surface, #0d1117);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 8px;
}

.account-tab {
  flex: 1;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 500;
  background: transparent;
  color: var(--text-secondary, #8b949e);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.account-tab:hover {
  color: var(--text-primary, #e6edf3);
}

.account-tab-active {
  background: var(--bg-surface-alt, #161b22);
  color: var(--accent-primary, #38bdf8);
}

.account-btn-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.account-apple-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  padding: 12px 20px;
  font-size: 14px;
  font-weight: 600;
  background: #000;
  color: #fff;
  border: 1px solid #000;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}

.account-apple-btn:hover:not(:disabled) {
  background: #1a1a1a;
}

.account-apple-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.account-apple-icon {
  width: 16px;
  height: 16px;
  margin-top: -2px;
}
</style>
