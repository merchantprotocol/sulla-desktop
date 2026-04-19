<template>
  <div class="account-page">
    <div class="account-scroll">
      <div
        v-if="loading"
        class="account-loading"
      >
        Loading...
      </div>

      <template v-else>
        <!-- Profile hero -->
        <div class="account-hero">
          <div class="account-avatar">
            {{ initials }}
          </div>
          <div class="account-hero-info">
            <h1 class="account-name">
              {{ userName || 'Sulla User' }}
            </h1>
            <p class="account-email">
              {{ email }}
            </p>
          </div>
        </div>

        <!-- Account details card -->
        <div class="account-card">
          <div class="account-card-header">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              class="account-card-icon"
            >
              <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
              <circle
                cx="12"
                cy="7"
                r="4"
              />
            </svg>
            <h2 class="account-card-title">
              Profile
            </h2>
          </div>

          <div class="account-field">
            <label class="account-label">Name</label>
            <input
              v-model="userName"
              type="text"
              placeholder="Your name"
              class="account-input"
            >
          </div>

          <div class="account-field">
            <label class="account-label">Email</label>
            <input
              v-model="email"
              type="email"
              placeholder="your@email.com"
              class="account-input"
            >
          </div>

          <div class="account-field">
            <label class="account-label">
              <input
                v-model="subscribeToUpdates"
                type="checkbox"
                class="account-checkbox"
              >
              Subscribe to updates and newsletters
            </label>
          </div>

          <button
            type="button"
            class="account-save-btn"
            :disabled="saving"
            @click="saveProfile"
          >
            {{ saving ? 'Saving...' : (saved ? 'Saved!' : 'Save Changes') }}
          </button>
        </div>

        <!-- Security card -->
        <div class="account-card">
          <div class="account-card-header">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              class="account-card-icon"
            >
              <rect
                x="3"
                y="11"
                width="18"
                height="11"
                rx="2"
              />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
            <h2 class="account-card-title">
              Security
            </h2>
          </div>

          <div class="account-field">
            <label class="account-label">Master Password</label>
            <p class="account-hint">
              Your master password protects all saved credentials. It is never stored — only used to derive your encryption key.
            </p>
            <button
              type="button"
              class="account-action-btn"
              @click="showChangePassword = !showChangePassword"
            >
              {{ showChangePassword ? 'Cancel' : 'Change Master Password' }}
            </button>
          </div>

          <template v-if="showChangePassword">
            <div class="account-field">
              <label class="account-label">Current Password</label>
              <input
                v-model="currentPassword"
                type="password"
                placeholder="Enter current password"
                class="account-input"
              >
            </div>
            <div class="account-field">
              <label class="account-label">New Password</label>
              <input
                v-model="newPassword"
                type="password"
                placeholder="Enter new password"
                class="account-input"
              >
            </div>
            <div class="account-field">
              <label class="account-label">Confirm New Password</label>
              <input
                v-model="confirmPassword"
                type="password"
                placeholder="Re-enter new password"
                class="account-input"
              >
            </div>
            <p
              v-if="passwordError"
              class="account-error"
            >
              {{ passwordError }}
            </p>
            <p
              v-if="passwordSuccess"
              class="account-success"
            >
              {{ passwordSuccess }}
            </p>
            <button
              type="button"
              class="account-save-btn"
              :disabled="changingPassword"
              @click="changePassword"
            >
              {{ changingPassword ? 'Updating...' : 'Update Password' }}
            </button>
          </template>
        </div>

        <!-- Vault stats card -->
        <div class="account-card">
          <div class="account-card-header">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              class="account-card-icon"
            >
              <path d="M12 20V10" />
              <path d="M18 20V4" />
              <path d="M6 20v-4" />
            </svg>
            <h2 class="account-card-title">
              Vault
            </h2>
          </div>
          <div class="account-stats">
            <div class="account-stat">
              <span class="account-stat-value">{{ vaultStats.totalAccounts }}</span>
              <span class="account-stat-label">Saved Accounts</span>
            </div>
            <div class="account-stat">
              <span class="account-stat-value">{{ vaultStats.integrationTypes }}</span>
              <span class="account-stat-label">Integration Types</span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const loading = ref(true);
const saving = ref(false);
const saved = ref(false);

const userName = ref('');
const email = ref('');
const subscribeToUpdates = ref(true);

// Password change
const showChangePassword = ref(false);
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const passwordError = ref('');
const passwordSuccess = ref('');
const changingPassword = ref(false);

// Vault stats
const vaultStats = ref({ totalAccounts: 0, integrationTypes: 0 });

const initials = computed(() => {
  const name = userName.value.trim();
  if (!name) return 'SU';
  const parts = name.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
});

async function loadProfile() {
  loading.value = true;
  try {
    userName.value = await SullaSettingsModel.get('primaryUserName') || '';
    email.value = await SullaSettingsModel.get('sullaEmail') || '';
    const sub = await SullaSettingsModel.get('sullaSubscribeToUpdates');
    subscribeToUpdates.value = sub !== null ? sub : true;

    // Load vault stats
    const service = getIntegrationService();
    const enabled = await service.getEnabledIntegrations();
    let total = 0;
    for (const { accounts } of enabled) {
      total += accounts.length;
    }
    vaultStats.value = {
      totalAccounts:    total,
      integrationTypes: enabled.length,
    };
  } catch (err) {
    console.error('[MyAccount] Load failed:', err);
  } finally {
    loading.value = false;
  }
}

async function saveProfile() {
  saving.value = true;
  saved.value = false;
  try {
    await SullaSettingsModel.set('primaryUserName', userName.value, 'string');
    await SullaSettingsModel.set('sullaEmail', email.value, 'string');
    await SullaSettingsModel.set('sullaSubscribeToUpdates', subscribeToUpdates.value, 'boolean');
    saved.value = true;
    setTimeout(() => { saved.value = false }, 2000);
  } catch (err) {
    console.error('[MyAccount] Save failed:', err);
  } finally {
    saving.value = false;
  }
}

async function changePassword() {
  passwordError.value = '';
  passwordSuccess.value = '';

  if (!currentPassword.value) {
    passwordError.value = 'Current password is required.';
    return;
  }
  if (newPassword.value.length < 8) {
    passwordError.value = 'New password must be at least 8 characters.';
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    passwordError.value = 'Passwords do not match.';
    return;
  }

  changingPassword.value = true;
  try {
    // Verify current password
    const verified = await ipcRenderer.invoke('vault:unlock-password', { password: currentPassword.value });
    if (!verified) {
      passwordError.value = 'Current password is incorrect.';
      changingPassword.value = false;
      return;
    }

    // Change password and re-encrypt all credentials with the new key
    await ipcRenderer.invoke('vault:change-password', { newPassword: newPassword.value });
    passwordSuccess.value = 'Master password updated successfully.';
    currentPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
    showChangePassword.value = false;
  } catch (err) {
    passwordError.value = 'Failed to change password. Please try again.';
    console.error('[MyAccount] Password change failed:', err);
  } finally {
    changingPassword.value = false;
  }
}

onMounted(loadProfile);
</script>

<style scoped>
.account-page {
  height: 100%;
  color: var(--text-primary, #e6edf3);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.account-scroll {
  max-width: 560px;
  margin: 0 auto;
  padding: 32px 20px 48px;
}

.account-scroll > * + * {
  margin-top: 20px;
}

.account-loading {
  text-align: center;
  padding: 60px 0;
  color: var(--text-muted, #484f58);
}

/* ── Hero ── */
.account-hero {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 24px;
  background: var(--bg-surface-alt, #161b22);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 12px;
}

.account-avatar {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--accent-primary, #38bdf8);
  color: var(--bg-surface, #0d1117);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.05em;
  flex-shrink: 0;
}

.account-name {
  font-size: 20px;
  font-weight: 700;
  margin: 0 0 2px;
}

.account-email {
  font-size: 13px;
  color: var(--text-secondary, #8b949e);
  margin: 0;
}

/* ── Cards ── */
.account-card {
  padding: 20px;
  background: var(--bg-surface-alt, #161b22);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 12px;
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

/* ── Fields ── */
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
}

.account-input:focus {
  border-color: var(--accent-primary, #38bdf8);
  box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15);
}

.account-checkbox {
  width: 16px;
  height: 16px;
  accent-color: var(--accent-primary, #38bdf8);
  cursor: pointer;
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

.account-success {
  font-size: 12px;
  color: #3fb950;
  margin: 0 0 10px;
}

/* ── Buttons ── */
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

.account-action-btn:hover {
  background: rgba(56, 189, 248, 0.06);
  border-color: var(--accent-primary, #38bdf8);
}

/* ── Stats ── */
.account-stats {
  display: flex;
  gap: 24px;
}

.account-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.account-stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--accent-primary, #38bdf8);
}

.account-stat-label {
  font-size: 11px;
  color: var(--text-muted, #484f58);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
</style>
