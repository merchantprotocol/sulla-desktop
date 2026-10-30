<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import PrefCard from '../PrefCard.vue';
import PrefIcon from '../PrefIcon.vue';
import PrefRow from '../PrefRow.vue';
import PrefToggle from '../PrefToggle.vue';

import CloudConnectionCard from '@pkg/components/account/CloudConnectionCard.vue';
import { openMainTab } from '@pkg/composables/preferences/openInMain';
import { useAccountSettings } from '@pkg/composables/preferences/useAccountSettings';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const {
  userName, email, subscribeToUpdates, saveProfile, accountsLoading, accountsPending,
  accountsError, accountsNotice, accountsProfile, accountsDisplayName, accountsConnections,
  accountsMemberships, authorityUrl, authorityError, discoveredAuthority, selectedAudience,
  authorizationNotice, refreshAccounts, saveAccountsProfile, discoverAuthority, cancelAuthority,
  enrollAuthority, disconnectAccount, authorizeAccount, authorityHost, vaultStats, vaultStatsKnown,
  cloudStatus, relayStatus, cloudError, busy,
  cloudTab, phoneInput, otpSent, otpCode, sendOtp, verifyOtp, resetPhoneFlow, emailInput,
  emailPassword, emailName, emailMode, emailCodeSent, emailCode, sendEmailCode, verifyEmailCode,
  emailSubmit, openAppleInVault, signOut,
} = useAccountSettings();

const connection = ref<Record<string, any> | null>(null);
const connectionBusy = ref(false);
const showSync = ref(false);
const addingServer = ref(false);
const recoveryStatus = ref<{ label: string; checkedAt: string; location: string } | null>(null);
const recoveryKey = ref('');
const recoveryMadeAt = ref('');
const recoveryBusy = ref(false);
const recoveryNotice = ref('');

const remoteAccess = computed(() => !!connection.value?.preferences?.remoteAccess);
const syncOn = computed(() => !!connection.value?.preferences?.enabled);
const signedInAs = computed(() => cloudStatus.value.name || cloudStatus.value.phone || cloudStatus.value.userId);
const cloudLine = computed(() => {
  if (cloudStatus.value.signedIn) {
    return `Signed in as ${ signedInAs.value }.`;
  }

  return 'Sign in to reach this Mac from the web and your phone. Nothing syncs unless you turn it on.';
});
const syncLine = computed(() => {
  if (syncOn.value) {
    return 'On. Choose what Sulla copies to your Cloud account.';
  }

  return 'Off. Signing in never uploads your data.';
});
const canSaveName = computed(() => {
  const name = accountsDisplayName.value.trim();

  return !accountsPending.value && !!name && name !== accountsProfile.value?.displayName;
});

function servicesLine(count: number) {
  return `${ count } service${ count === 1 ? '' : 's' } available`;
}

function onConnectionStatus(_event: unknown, status: Record<string, any>) {
  connection.value = status;
}

function onRecoveryCreated(_event: unknown, result: any) {
  recoveryKey.value = result.recoveryKey;
  recoveryStatus.value = result.storage;
  recoveryMadeAt.value = result.madeAt;
}

function checkedLine() {
  if (!recoveryStatus.value?.checkedAt) return 'Not checked yet';
  const elapsed = Date.now() - Date.parse(recoveryStatus.value.checkedAt);
  if (elapsed < 60_000) return 'Last checked just now';
  const days = Math.max(1, Math.floor(elapsed / 86_400_000));
  return `Last checked ${ days } day${ days === 1 ? '' : 's' } ago`;
}

async function makeRecoveryKey() {
  if (!window.confirm('Make a new recovery key?\n\nYour current key stops working everywhere. The new one is saved to iCloud Keychain and Sulla Cloud for you.')) return;
  recoveryBusy.value = true; recoveryNotice.value = '';
  try { onRecoveryCreated(null, await ipcRenderer.invoke('sulla-cloud:recovery-key-rotate')); recoveryNotice.value = 'New key saved'; }
  catch (error) { recoveryNotice.value = error instanceof Error ? error.message : String(error) }
  finally { recoveryBusy.value = false }
}

async function recoveryAction(action: 'save' | 'print' | 'copy') {
  await ipcRenderer.invoke(`sulla-cloud:recovery-key-${ action }`, recoveryKey.value);
  recoveryNotice.value = action === 'copy' ? 'Recovery key copied' : action === 'print' ? 'Opening print dialog' : 'Saved to Files';
}

async function setRemoteAccess(on: boolean) {
  connectionBusy.value = true;
  cloudError.value = '';
  try {
    connection.value = await ipcRenderer.invoke('sulla-cloud-connection:set-preferences', { remoteAccess: on });
  } catch (err) {
    cloudError.value = err instanceof Error ? err.message : String(err);
  } finally {
    connectionBusy.value = false;
  }
}

const SIGN_IN_TABS = [
  { id: 'email', label: 'Email' },
  { id: 'phone', label: 'Phone' },
  { id: 'apple', label: 'Apple' },
] as const;

async function connectServer() {
  await enrollAuthority();
  if (!authorityError.value) {
    addingServer.value = false;
  }
}

function setSubscribe(on: boolean) {
  subscribeToUpdates.value = on;
  void saveProfile();
}

onMounted(async() => {
  ipcRenderer.on('sulla-cloud-connection:status-changed', onConnectionStatus);
  connection.value = await ipcRenderer.invoke('sulla-cloud-connection:get-status').catch(() => null);
  recoveryStatus.value = await ipcRenderer.invoke('sulla-cloud:recovery-key-status').catch(() => null);
  ipcRenderer.on('sulla-cloud:recovery-key-created', onRecoveryCreated);
});
onBeforeUnmount(() => {
  ipcRenderer.removeListener('sulla-cloud-connection:status-changed', onConnectionStatus);
  ipcRenderer.removeListener('sulla-cloud:recovery-key-created', onRecoveryCreated);
});
</script>

<template>
  <div>
    <div class="ph">
      <div>
        <h1>Account &amp; Cloud</h1>
        <p>Your profile, Sulla Cloud and connected servers.</p>
      </div>
    </div>

    <PrefCard title="Profile">
      <PrefRow title="Name">
        <input
          v-model="userName"
          class="inp"
          aria-label="Name"
          placeholder="Your name"
          @change="saveProfile"
        >
      </PrefRow>
      <PrefRow title="Email">
        <input
          v-model="email"
          class="inp"
          type="email"
          aria-label="Email"
          placeholder="you@example.com"
          @change="saveProfile"
        >
      </PrefRow>
      <PrefRow title="Product news by email">
        <PrefToggle
          :model-value="subscribeToUpdates"
          label="Product news by email"
          @update:model-value="setSubscribe"
        />
      </PrefRow>
    </PrefCard>

    <PrefCard
      title="Sulla Cloud"
      :subtitle="cloudLine"
    >
      <template
        v-if="cloudStatus.signedIn"
        #actions
      >
        <button
          type="button"
          class="btn sm ghost"
          :disabled="busy"
          @click="signOut"
        >
          Sign out
        </button>
      </template>

      <template v-if="cloudStatus.signedIn">
        <PrefRow
          title="Reach this Mac from the web and your phone"
          :subtitle="relayStatus.connected ? 'Phone relay connected.' : 'Phone relay waiting for your phone.'"
        >
          <PrefToggle
            :model-value="remoteAccess"
            :disabled="connectionBusy || !connection"
            label="Reach this Mac from the web and your phone"
            @update:model-value="setRemoteAccess"
          />
        </PrefRow>
        <PrefRow
          title="Copy Desktop data to Sulla Cloud"
          :subtitle="syncLine"
        >
          <button
            type="button"
            class="btn sm"
            @click="showSync = !showSync"
          >
            {{ showSync ? 'Close' : 'Choose…' }}
          </button>
        </PrefRow>
        <div
          v-if="showSync"
          class="set col"
        >
          <CloudConnectionCard />
        </div>
      </template>

      <template v-else>
        <PrefRow title="Sign in with">
          <div class="seg">
            <button
              v-for="tab in SIGN_IN_TABS"
              :key="tab.id"
              type="button"
              :class="{ on: cloudTab === tab.id }"
              @click="cloudTab = tab.id"
            >
              {{ tab.label }}
            </button>
          </div>
        </PrefRow>

        <template v-if="cloudTab === 'email' && emailMode === 'code'">
          <PrefRow title="Email">
            <input
              v-model="emailInput"
              class="inp"
              type="email"
              autocomplete="email"
              placeholder="you@example.com"
              aria-label="Email for Sulla Cloud"
              :disabled="emailCodeSent"
            >
          </PrefRow>
          <PrefRow
            v-if="emailCodeSent"
            title="Code from the email"
          >
            <input
              v-model="emailCode"
              class="inp sm"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="7"
              placeholder="123456"
              aria-label="Code from the email"
            >
          </PrefRow>
          <PrefRow>
            <button
              type="button"
              class="btn sm ghost"
              :disabled="busy"
              @click="emailMode = 'login'"
            >
              Use a password instead
            </button>
            <button
              v-if="emailCodeSent"
              type="button"
              class="btn sm ghost"
              :disabled="busy"
              @click="emailCodeSent = false; emailCode = ''"
            >
              Use a different email
            </button>
            <button
              v-if="!emailCodeSent"
              type="button"
              class="btn sm pri"
              :disabled="busy || !emailInput"
              @click="sendEmailCode"
            >
              {{ busy ? 'Sending…' : 'Email me a code' }}
            </button>
            <button
              v-else
              type="button"
              class="btn sm pri"
              :disabled="busy || !emailCode"
              @click="verifyEmailCode"
            >
              {{ busy ? 'Checking…' : 'Sign in' }}
            </button>
          </PrefRow>
        </template>

        <template v-else-if="cloudTab === 'email'">
          <PrefRow title="Email">
            <input
              v-model="emailInput"
              class="inp"
              type="email"
              autocomplete="email"
              aria-label="Email for Sulla Cloud"
            >
          </PrefRow>
          <PrefRow title="Password">
            <input
              v-model="emailPassword"
              class="inp"
              type="password"
              autocomplete="current-password"
              aria-label="Sulla Cloud password"
            >
          </PrefRow>
          <PrefRow
            v-if="emailMode === 'register'"
            title="Name"
            subtitle="Optional."
          >
            <input
              v-model="emailName"
              class="inp"
              aria-label="Name for the new account"
            >
          </PrefRow>
          <PrefRow>
            <button
              type="button"
              class="btn sm ghost"
              :disabled="busy"
              @click="emailMode = 'code'"
            >
              Email me a code instead
            </button>
            <button
              type="button"
              class="btn sm ghost"
              :disabled="busy"
              @click="emailMode = emailMode === 'login' ? 'register' : 'login'"
            >
              {{ emailMode === 'login' ? 'Create an account' : 'I have an account' }}
            </button>
            <button
              type="button"
              class="btn sm pri"
              :disabled="busy || !emailInput || !emailPassword"
              @click="emailSubmit"
            >
              {{ busy ? 'Working…' : emailMode === 'login' ? 'Sign in' : 'Create account' }}
            </button>
          </PrefRow>
        </template>

        <template v-else-if="cloudTab === 'phone'">
          <PrefRow
            title="Phone"
            subtitle="With country code, like +15551234567."
          >
            <input
              v-model="phoneInput"
              class="inp"
              type="tel"
              placeholder="+15551234567"
              aria-label="Phone number"
              :disabled="otpSent"
            >
          </PrefRow>
          <PrefRow
            v-if="otpSent"
            title="Code from the text"
          >
            <input
              v-model="otpCode"
              class="inp sm"
              inputmode="numeric"
              maxlength="8"
              aria-label="Code from the text message"
            >
          </PrefRow>
          <PrefRow>
            <button
              v-if="otpSent"
              type="button"
              class="btn sm ghost"
              :disabled="busy"
              @click="resetPhoneFlow"
            >
              Use a different number
            </button>
            <button
              v-if="!otpSent"
              type="button"
              class="btn sm pri"
              :disabled="busy || !phoneInput"
              @click="sendOtp"
            >
              {{ busy ? 'Sending…' : 'Text me a code' }}
            </button>
            <button
              v-else
              type="button"
              class="btn sm pri"
              :disabled="busy || !otpCode"
              @click="verifyOtp"
            >
              {{ busy ? 'Checking…' : 'Sign in' }}
            </button>
          </PrefRow>
        </template>

        <PrefRow
          v-else
          title="Sign in with Apple"
          subtitle="Apple sign-in is set up from Integrations in the main window."
        >
          <button
            type="button"
            class="btn sm"
            :disabled="busy"
            @click="openAppleInVault"
          >
            Open Integrations
          </button>
        </PrefRow>
      </template>

      <p
        v-if="cloudError"
        class="note badc"
      >
        {{ cloudError }}
      </p>
    </PrefCard>

    <PrefCard title="Accounts & servers">
      <template #actions>
        <button
          type="button"
          class="btn sm"
          :disabled="accountsLoading || !!accountsError"
          @click="addingServer = !addingServer"
        >
          <PrefIcon name="plus" />Add server
        </button>
      </template>
      <div class="set col">
        <div
          v-if="accountsLoading"
          class="dimc"
        >
          Loading…
        </div>
        <div
          v-else-if="accountsError"
          class="k"
        >
          <span class="badc">{{ accountsError }}</span>
          <button
            type="button"
            class="btn sm"
            :disabled="!!accountsPending"
            @click="refreshAccounts"
          >
            Retry
          </button>
        </div>
        <div
          v-else
          class="lst"
        >
          <div>
            <span class="dot" />
            <b>This Mac</b>
            <span class="dimc">{{ accountsProfile?.displayName || 'Local profile' }}</span>
            <span class="r">Active</span>
          </div>
          <div
            v-for="conn in accountsConnections"
            :key="conn.id"
          >
            <span
              class="dot"
              :class="{ warn: !conn.subject }"
            />
            <span class="grow">
              <b>{{ authorityHost(conn.issuer) }}</b>
              <small>{{ conn.subject ? 'Authorized' : 'Needs authorization' }}</small>
            </span>
            <span class="r">
              <select
                v-if="conn.resourceAudiences.length > 1"
                v-model="selectedAudience[conn.id]"
                class="sel"
                aria-label="Service"
                :disabled="!!accountsPending"
              >
                <option
                  v-for="audience in conn.resourceAudiences"
                  :key="audience"
                  :value="audience"
                >{{ audience }}</option>
              </select>
              <button
                v-if="conn.resourceAudiences.length"
                type="button"
                class="btn sm"
                :disabled="!!accountsPending || !selectedAudience[conn.id]"
                @click="authorizeAccount(conn.id)"
              >{{ conn.subject ? 'Authorize again' : 'Authorize' }}</button>
              <button
                type="button"
                class="btn sm ghost"
                :disabled="!!accountsPending"
                @click="disconnectAccount(conn.id)"
              >Disconnect</button>
            </span>
          </div>
          <div
            v-for="m in [...accountsMemberships.local, ...accountsMemberships.remoteDisplayHints]"
            :key="`${ m.authorityId }:${ m.organizationId }`"
          >
            <span class="grow">
              <b>{{ m.organizationId }}</b>
              <small>{{ authorityHost(m.issuer) }} · {{ m.roles.join(', ') || 'member' }}</small>
            </span>
          </div>
        </div>
      </div>
      <div
        v-if="addingServer"
        class="adv"
      >
        <PrefRow
          title="Server address"
          subtitle="Sulla checks the server’s published details before saving anything."
        >
          <input
            v-model="authorityUrl"
            class="inp"
            type="url"
            placeholder="https://sulla.example.com"
            aria-label="Server address"
            :disabled="!!accountsPending || !!discoveredAuthority"
            @keydown.enter.prevent="discoverAuthority"
          >
          <button
            v-if="!discoveredAuthority"
            type="button"
            class="btn sm"
            :disabled="!!accountsPending || !authorityUrl.trim()"
            @click="discoverAuthority"
          >
            {{ accountsPending === 'discover' ? 'Checking…' : 'Check' }}
          </button>
        </PrefRow>
        <PrefRow
          v-if="discoveredAuthority"
          :title="authorityHost(discoveredAuthority.issuer)"
          :subtitle="servicesLine(discoveredAuthority.resourceAudiences.length)"
        >
          <button
            type="button"
            class="btn sm ghost"
            :disabled="!!accountsPending"
            @click="cancelAuthority"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn sm pri"
            :disabled="!!accountsPending"
            @click="connectServer"
          >
            {{ accountsPending === 'enroll' ? 'Connecting…' : 'Connect' }}
          </button>
        </PrefRow>
        <PrefRow
          title="Name for this Mac"
          subtitle="Shown to servers you connect."
        >
          <input
            v-model="accountsDisplayName"
            class="inp"
            maxlength="120"
            aria-label="Name for this Mac"
            :disabled="!!accountsPending"
          >
          <button
            type="button"
            class="btn sm"
            :disabled="!canSaveName"
            @click="saveAccountsProfile"
          >
            Save
          </button>
        </PrefRow>
      </div>
      <p
        v-if="authorityError || authorizationNotice || accountsNotice"
        class="note"
        :class="{ badc: !!authorityError }"
      >
        {{ authorityError || authorizationNotice || accountsNotice }}
      </p>
    </PrefCard>

    <PrefCard
      title="Password and recovery"
      subtitle="Follows you across organizations"
    >
      <PrefRow
        title="Sulla password"
        subtitle="One password signs you in and unlocks Passwords and Files."
      >
        <button
          type="button"
          class="btn sm"
          disabled
        >
          Change
        </button>
        <span class="soon">Change password</span>
      </PrefRow>
      <PrefRow
        title="Recovery key"
        subtitle="Gets your vault back if you forget your password."
        layout="col"
      >
        <div class="recovery-key-card">
          <div><b>{{ recoveryStatus?.label || 'Checking recovery key…' }}</b><small>{{ checkedLine() }}</small></div>
          <div><b>Encrypted copy in Sulla Cloud</b><small>Stored with your vault. Useless without the key itself.</small></div>
          <div v-if="recoveryMadeAt"><b>Made on this Mac</b><small>{{ new Date(recoveryMadeAt).toLocaleString() }}</small></div>
          <div
            v-if="recoveryKey"
            class="new-recovery-key"
          >
            <p>Your new recovery key. It's saved already. Keep a copy somewhere safe if you like.</p>
            <code>{{ recoveryKey }}</code>
            <div class="recovery-actions">
              <button class="btn sm" type="button" @click="recoveryAction('save')">Save to Files</button>
              <button class="btn sm" type="button" @click="recoveryAction('print')">Print</button>
              <button class="btn sm" type="button" @click="recoveryAction('copy')">Copy</button>
              <button class="btn sm pri" type="button" @click="recoveryKey = ''">Done</button>
            </div>
          </div>
          <div class="recovery-foot"><span>{{ recoveryNotice || 'Old keys stop working when you make a new one' }}</span><button class="btn sm" type="button" :disabled="recoveryBusy || !cloudStatus.signedIn" @click="makeRecoveryKey">{{ recoveryBusy ? 'Making key…' : 'Make a new one' }}</button></div>
        </div>
      </PrefRow>
      <PrefRow
        title="Passwords"
        :subtitle="vaultStatsKnown ? `${ vaultStats.totalAccounts } saved` : ''"
      >
        <button
          type="button"
          class="link"
          @click="openMainTab('vault')"
        >
          Open Passwords
        </button>
      </PrefRow>
    </PrefCard>
  </div>
</template>

<style scoped>
.recovery-key-card{display:grid;gap:12px;width:100%}.recovery-key-card>div{display:grid;gap:3px}.recovery-key-card small{color:var(--muted)}
.new-recovery-key{padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--body-bg)}
.new-recovery-key code{display:block;padding:12px;margin:8px 0;font-size:15px;overflow-wrap:anywhere}.recovery-actions,.recovery-foot{display:flex!important;gap:8px;align-items:center;flex-wrap:wrap}.recovery-foot{justify-content:space-between}
</style>
