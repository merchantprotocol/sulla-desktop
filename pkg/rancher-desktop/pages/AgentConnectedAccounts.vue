<template>
  <div
    class="text-sm font-sans page-root"
    :class="[{ dark: isDark }, 'h-full']"
  >
    <div class="flex flex-col h-full">
      <AgentHeader
        v-if="!embedded"
        :is-dark="isDark"
        :toggle-theme="toggleTheme"
      />

      <div class="flex w-full flex-col flex-1 accounts-page-wrap">
        <div class="overflow-hidden accounts-hero">
          <div class="py-16 sm:px-2 lg:relative lg:px-0 lg:py-20">
            <div class="mx-auto grid max-w-6xl md:grid-cols-2 items-center gap-x-8 gap-y-10 px-4 md:px-6 lg:px-8 xl:gap-x-16 vault-noir-head">
              <div class="relative z-10 md:text-center lg:text-left">
                <div class="relative">
                  <p class="vault-noir-eyebrow">
                    Password Vault
                  </p>
                  <p class="inline bg-linear-to-r from-indigo-200 via-sky-400 to-indigo-200 bg-clip-text font-display text-5xl tracking-tight text-transparent vault-title-default">
                    Password Manager.
                  </p>
                  <h1 class="vault-noir-title">
                    Everything important stays under your key.
                  </h1>
                  <p class="mt-3 text-2xl tracking-tight text-slate-400 vault-lead-default">
                    All your connected accounts and saved credentials in one place.
                  </p>
                  <p class="vault-noir-lead">
                    Connected accounts, saved credentials, and AI access — protected in one encrypted place.
                  </p>
                </div>
              </div>

              <div class="relative">
                <div class="flex flex-col gap-4">
                  <div class="relative">
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 20 20"
                      class="pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 fill-slate-400 dark:fill-slate-500"
                    >
                      <path d="M16.293 17.707a1 1 0 0 0 1.414-1.414l-1.414 1.414ZM9 14a5 5 0 0 1-5-5H2a7 7 0 0 0 7 7v-2ZM4 9a5 5 0 0 1 5-5V2a7 7 0 0 0-7 7h2Zm5-5a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7v2Zm8.707 12.293-3.757-3.757-1.414 1.414 3.757 3.757 1.414-1.414ZM14 9a4.98 4.98 0 0 1-1.464 3.536l1.414 1.414A6.98 6.98 0 0 0 16 9h-2Zm-1.464 3.536A4.98 4.98 0 0 1 9 14v2a6.98 6.98 0 0 0 4.95-2.05l-1.414-1.414Z" />
                    </svg>

                    <input
                      v-model="search"
                      type="text"
                      placeholder="Search accounts..."
                      class="h-11 w-full rounded-lg bg-white/95 pr-4 pl-12 text-sm text-slate-900 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-300/50 dark:bg-slate-800/75 dark:text-slate-100 dark:ring-white/5 dark:ring-inset"
                    >
                  </div>
                  <button
                    type="button"
                    class="h-11 px-4 rounded-lg text-white text-sm font-medium transition-colors flex items-center gap-2 accounts-btn-primary"
                    @click="$emit('new-account')"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      class="h-4 w-4"
                    >
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    New Account
                  </button>
                  <button
                    type="button"
                    class="h-11 px-4 rounded-lg border border-slate-600 hover:border-slate-500 text-slate-300 hover:text-white text-sm font-medium transition-colors flex items-center gap-2"
                    @click="$emit('generate-password')"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      class="h-4 w-4"
                    >
                      <rect
                        x="2"
                        y="4"
                        width="20"
                        height="16"
                        rx="2"
                      />
                      <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M6 16h8" />
                    </svg>
                    Generate Password
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="flex-1 overflow-auto accounts-body">
          <div class="mx-auto max-w-7xl px-4 py-6 vault-noir-body-inner">
            <!-- Vault status + Export / Import bar -->
            <div class="flex items-center gap-2 mb-4">
              <div
                v-if="vaultSecure"
                class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
                style="background: rgba(80, 150, 179, 0.08); color: #5096b3; border: 1px solid rgba(80, 150, 179, 0.2);"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  class="h-3 w-3"
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
                AES-256 Encrypted
              </div>
              <div class="flex-1" />
              <button
                v-if="vaultSecure"
                type="button"
                class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
                style="color: #f85149; border: 1px solid rgba(248, 81, 73, 0.2);"
                title="Lock the vault — zeroes encryption keys from memory. The AI will lose access to credentials until you unlock."
                @click="lockVault"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  class="h-3 w-3"
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
                Lock Vault
              </button>
            </div>
            <div class="flex items-center justify-end gap-2 mb-4">
              <button
                type="button"
                class="px-3 py-1.5 text-xs font-medium rounded-md text-slate-400 hover:text-slate-200 border border-slate-700 hover:border-slate-500 transition-colors"
                @click="exportVault(false)"
              >
                Export (JSON)
              </button>
              <button
                type="button"
                class="px-3 py-1.5 text-xs font-medium rounded-md text-slate-400 hover:text-slate-200 border border-slate-700 hover:border-slate-500 transition-colors"
                @click="exportVault(true)"
              >
                Export (Encrypted)
              </button>
              <button
                type="button"
                class="px-3 py-1.5 text-xs font-medium rounded-md text-slate-400 hover:text-slate-200 border border-slate-700 hover:border-slate-500 transition-colors"
                @click="importVault()"
              >
                Import
              </button>
            </div>
            <form
              v-if="importSecretFile"
              class="flex items-center justify-end gap-2 mb-4"
              @submit.prevent="submitImportSecret"
            >
              <span class="text-xs text-slate-400">This backup was made with a different vault key.</span>
              <input
                v-model="importSecret"
                type="password"
                autocomplete="off"
                placeholder="Its master password or recovery key"
                class="px-2 py-1 text-xs rounded-md bg-transparent border border-slate-700 text-slate-200 w-64"
              >
              <button
                type="submit"
                class="px-3 py-1.5 text-xs font-medium rounded-md text-slate-400 hover:text-slate-200 border border-slate-700 hover:border-slate-500 transition-colors"
              >
                Restore
              </button>
              <button
                type="button"
                class="px-3 py-1.5 text-xs font-medium rounded-md text-slate-400 hover:text-slate-200 border border-slate-700 hover:border-slate-500 transition-colors"
                @click="cancelImportSecret"
              >
                Cancel
              </button>
            </form>
            <p
              v-if="vaultNotice"
              class="mb-4 text-right text-xs"
              :class="vaultNoticeIsError ? 'text-red-400' : 'text-slate-400'"
            >
              {{ vaultNotice }}
            </p>
            <p
              v-else-if="backupSummary"
              class="mb-4 text-right text-xs text-slate-500"
            >
              {{ backupSummary }}
            </p>
            <div class="flex gap-6 vault-noir-shell">
              <!-- Filter Sidebar -->
              <nav class="hidden md:block w-48 shrink-0 vault-noir-nav">
                <div class="sticky top-6">
                  <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                    Filter by Type
                  </h3>
                  <ul
                    ref="filterNav"
                    class="space-y-0.5 vault-noir-nav-list"
                  >
                    <span
                      class="vault-noir-glass"
                      :style="filterGlassStyle"
                      aria-hidden="true"
                    />
                    <li>
                      <button
                        type="button"
                        class="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm transition-colors vault-noir-nav-row"
                        data-vault-filter="all"
                        :class="activeFilter === null
                          ? 'bg-[#5096b3]/10 text-[#5096b3] font-medium dark:bg-[#5096b3]/10 dark:text-[#6ab0cc]'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'"
                        @click="activeFilter = null"
                      >
                        <span>All</span>
                        <span
                          class="text-xs tabular-nums"
                          :class="activeFilter === null ? 'text-[#5096b3] dark:text-[#6ab0cc]' : 'text-slate-400 dark:text-slate-500'"
                        >{{ flatAccounts.length }}</span>
                      </button>
                    </li>
                    <li
                      v-for="type in integrationTypes"
                      :key="type"
                    >
                      <button
                        type="button"
                        class="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm transition-colors vault-noir-nav-row"
                        :data-vault-filter="type"
                        :class="activeFilter === type
                          ? 'bg-[#5096b3]/10 text-[#5096b3] font-medium dark:bg-[#5096b3]/10 dark:text-[#6ab0cc]'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'"
                        @click="activeFilter = type"
                      >
                        <span>{{ integrationName(type) }}</span>
                        <span
                          class="text-xs tabular-nums"
                          :class="activeFilter === type ? 'text-[#5096b3] dark:text-[#6ab0cc]' : 'text-slate-400 dark:text-slate-500'"
                        >{{ countByType(type) }}</span>
                      </button>
                    </li>
                  </ul>
                </div>
              </nav>

              <!-- Account List -->
              <div class="flex-1 min-w-0">
                <div
                  v-if="loading"
                  class="text-center py-12 text-slate-400"
                >
                  Loading accounts...
                </div>

                <div
                  v-else-if="filteredAccounts.length === 0"
                  class="text-center py-12 text-slate-400"
                >
                  <p class="text-lg mb-2">
                    No connected accounts found
                  </p>
                  <p class="text-sm">
                    Connect integrations or save website passwords to see them here.
                  </p>
                </div>

                <div
                  v-else
                  class="space-y-2"
                >
                  <div
                    v-for="account in filteredAccounts"
                    :key="`${account.integrationId}-${account.accountId}`"
                    class="group flex items-center gap-4 rounded-lg px-4 py-3 transition-colors cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/50 vault-noir-row"
                    @click="openAccount(account)"
                  >
                    <!-- Icon / Type badge -->
                    <div
                      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xs font-bold uppercase vault-noir-tile"
                      :class="typeBadgeClass(account.integrationId)"
                    >
                      {{ typeBadgeLabel(account.integrationId) }}
                    </div>

                    <!-- Account info -->
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="font-medium text-slate-900 dark:text-slate-100 truncate">
                          {{ account.label }}
                        </span>
                        <span
                          class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium vault-noir-state"
                          :class="account.connected
                            ? 'bg-[#5096b3]/10 text-[#5096b3] dark:text-[#6ab0cc]'
                            : 'bg-slate-500/10 text-slate-500 dark:text-slate-400'"
                        >
                          <span class="vault-noir-dot" />
                          {{ account.connected ? 'Connected' : 'Disconnected' }}
                        </span>
                      </div>
                      <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate vault-noir-meta">
                        {{ integrationName(account.integrationId) }}
                        <span
                          v-if="account.connectedAt"
                          class="vault-date-default"
                        > &middot; {{ formatDate(account.connectedAt) }}</span>
                      </div>
                    </div>

                    <div
                      v-if="account.connectedAt"
                      class="vault-noir-date"
                    >
                      <span>Connected</span>
                      {{ formatDate(account.connectedAt) }}
                    </div>

                    <!-- AI access badge -->
                    <div
                      v-if="account.llmAccess"
                      class="shrink-0"
                    >
                      <span
                        class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                        :class="llmAccessBadgeClass(account.llmAccess)"
                      >
                        AI: {{ account.llmAccess }}
                      </span>
                    </div>

                    <!-- Arrow -->
                    <svg
                      class="h-4 w-4 shrink-0 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';

import AgentHeader from './agent/AgentHeader.vue';

import { integrations as integrationCatalog } from '@pkg/agent/integrations/catalog';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { useTheme } from '@pkg/composables/useTheme';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{
  embedded?: boolean;
}>();

const emit = defineEmits<{
  'new-account':       [];
  'edit-account':      [data: { integrationId: string; accountId: string }];
  'generate-password': [];
}>();

const router = useRouter();
const { isDark, toggleTheme } = useTheme();

interface FlatAccount {
  integrationId: string;
  accountId:     string;
  label:         string;
  connected:     boolean;
  connectedAt?:  Date;
  llmAccess?:    string;
}

const loading = ref(true);
const vaultSecure = ref(false);
const search = ref('');
const activeFilter = ref<string | null>(null);
const flatAccounts = ref<FlatAccount[]>([]);
const filterNav = ref<HTMLElement | null>(null);
const filterGlassTop = ref(0);
const filterGlassHeight = ref(40);

const filterGlassStyle = computed(() => ({
  height:    `${ filterGlassHeight.value }px`,
  transform: `translateY(${ filterGlassTop.value }px)`,
}));

function updateFilterGlass() {
  const key = activeFilter.value ?? 'all';
  const row = Array.from(filterNav.value?.querySelectorAll<HTMLElement>('[data-vault-filter]') ?? [])
    .find(element => element.dataset.vaultFilter === key);

  if (!row) return;
  filterGlassTop.value = row.offsetTop;
  filterGlassHeight.value = row.offsetHeight;
}

const integrationTypes = computed(() => {
  const types = new Set(flatAccounts.value.map(a => a.integrationId));
  return Array.from(types).sort();
});

const countByType = (type: string) => {
  return flatAccounts.value.filter(a => a.integrationId === type).length;
};

const filteredAccounts = computed(() => {
  let accounts = flatAccounts.value;

  if (activeFilter.value) {
    accounts = accounts.filter(a => a.integrationId === activeFilter.value);
  }

  if (search.value.trim()) {
    const q = search.value.toLowerCase();
    accounts = accounts.filter(a =>
      a.label.toLowerCase().includes(q) ||
      a.integrationId.toLowerCase().includes(q) ||
      integrationName(a.integrationId).toLowerCase().includes(q),
    );
  }

  return accounts;
});

const integrationName = (id: string): string => {
  return integrationCatalog[id]?.name || id;
};

const typeBadgeLabel = (id: string): string => {
  const name = integrationName(id);
  return name.slice(0, 2);
};

const typeBadgeClass = (id: string): string => {
  if (id === 'website') return 'bg-[#5096b3]/20 text-[#5096b3] dark:text-[#6ab0cc]';
  const catalog = integrationCatalog[id];
  if (!catalog) return 'bg-slate-500/20 text-slate-500';

  const category = catalog.category?.toLowerCase() || '';
  if (category.includes('ai')) return 'bg-purple-500/20 text-purple-600 dark:text-purple-400';
  if (category.includes('communication')) return 'bg-blue-500/20 text-blue-600 dark:text-blue-400';
  if (category.includes('developer')) return 'bg-gray-500/20 text-gray-600 dark:text-gray-400';
  return 'bg-[#5096b3]/20 text-[#5096b3] dark:text-[#6ab0cc]';
};

const llmAccessBadgeClass = (level: string): string => {
  switch (level) {
  case 'none': return 'bg-red-500/10 text-red-600 dark:text-red-400';
  case 'metadata': return 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400';
  case 'autofill': return 'bg-blue-500/10 text-blue-600 dark:text-blue-400';
  case 'full': return 'bg-[#5096b3]/10 text-[#5096b3] dark:text-[#6ab0cc]';
  default: return 'bg-slate-500/10 text-slate-500';
  }
};

const formatDate = (date: Date): string => {
  return new Date(date).toLocaleDateString(undefined, {
    year:  'numeric',
    month: 'short',
    day:   'numeric',
  });
};

const openAccount = (account: FlatAccount) => {
  if (props.embedded) {
    emit('edit-account', { integrationId: account.integrationId, accountId: account.accountId });
  } else {
    router.push({
      name:   'AgentIntegrationDetail',
      params: { id: account.integrationId },
      query:  { account: account.accountId },
    });
  }
};

const loadAccounts = async() => {
  loading.value = true;
  try {
    const service = getIntegrationService();
    const enabled = await service.getEnabledIntegrations();
    const accounts: FlatAccount[] = [];

    for (const { integrationId, accounts: accts } of enabled) {
      for (const acct of accts) {
        // Try to get llm_access property
        let llmAccess: string | undefined;
        try {
          const llmValue = await service.getIntegrationValue(integrationId, 'llm_access', acct.account_id);
          llmAccess = llmValue?.value;
        } catch { /* no llm_access set */ }

        accounts.push({
          integrationId,
          accountId:   acct.account_id,
          label:       acct.label,
          connected:   acct.connected,
          connectedAt: acct.connected_at,
          llmAccess,
        });
      }
    }

    flatAccounts.value = accounts;
  } catch (err) {
    console.error('[ConnectedAccounts] Failed to load accounts:', err);
  } finally {
    loading.value = false;
  }
};

async function lockVault() {
  try {
    await ipcRenderer.invoke('vault:lock-vault');
    // Also update local UI state to show login screen
    const { useVaultUnlock } = await import('@pkg/composables/useVaultUnlock');
    useVaultUnlock().loggedIn.value = false;
  } catch (err) {
    console.error('[Vault] Lock failed:', err);
  }
}

const vaultNotice = ref('');
const vaultNoticeIsError = ref(false);
const importSecretFile = ref('');
const importSecret = ref('');
const backupSummary = ref('');

function showVaultNotice(message: string, isError = false) {
  vaultNotice.value = message;
  vaultNoticeIsError.value = isError;
}

async function loadBackupSummary() {
  try {
    const status = await ipcRenderer.invoke('vault:backup-status');
    const count = status?.snapshots?.length ?? 0;

    backupSummary.value = count > 0
      ? `Automatic encrypted backups: ${ count } snapshot${ count === 1 ? '' : 's' } in ${ status.dir }`
      : '';
  } catch { /* older main process */ }
}

async function exportVault(encrypted: boolean) {
  try {
    const result = await ipcRenderer.invoke('vault:export', { encrypted });
    if (result.success) {
      showVaultNotice(encrypted
        ? `Encrypted backup of ${ result.count } accounts saved to ${ result.path }. Restore it with your master password or recovery key.`
        : `Exported ${ result.count } accounts in PLAIN TEXT to ${ result.path }. Delete that file once you no longer need it.`);
    } else if (!result.canceled) {
      showVaultNotice(`Export failed: ${ result.error }`, true);
    }
  } catch (err) {
    showVaultNotice(`Export failed: ${ (err as Error).message }`, true);
  }
}

async function importVault(args?: { filePath: string; password: string; recoveryKey: string }) {
  try {
    const result = await ipcRenderer.invoke('vault:import', args);
    if (result.success) {
      importSecretFile.value = '';
      showVaultNotice(result.format === 'sulla-snapshot'
        ? `Restored ${ result.inserted } credentials (${ result.skipped } already present${ result.unreadable ? `, ${ result.unreadable } unreadable` : '' }).`
        : `Imported ${ result.count } accounts.`);
      await loadAccounts(); // Refresh the list
    } else if (result.needsSecret) {
      importSecretFile.value = result.filePath;
      showVaultNotice('');
    } else if (!result.canceled) {
      showVaultNotice(`Import failed: ${ result.error }`, true);
    }
  } catch (err) {
    showVaultNotice(`Import failed: ${ (err as Error).message }`, true);
  }
}

async function submitImportSecret() {
  const secret = importSecret.value;

  importSecret.value = '';
  // The same string is tried as both; only the matching one can open the backup.
  await importVault({ filePath: importSecretFile.value, password: secret, recoveryKey: secret });
}

function cancelImportSecret() {
  importSecretFile.value = '';
  importSecret.value = '';
}

onMounted(async() => {
  window.addEventListener('resize', updateFilterGlass);

  // Check if vault encryption is active
  try {
    const isSetUp = await ipcRenderer.invoke('vault:is-setup');
    const isUnlocked = await ipcRenderer.invoke('vault:is-unlocked');
    vaultSecure.value = isSetUp && isUnlocked;
  } catch { /* vault IPC not available */ }
  loadBackupSummary();

  await loadAccounts();
  await nextTick();
  updateFilterGlass();
});

watch([activeFilter, integrationTypes], async() => {
  await nextTick();
  updateFilterGlass();
});

onBeforeUnmount(() => window.removeEventListener('resize', updateFilterGlass));
</script>

<style scoped>
.accounts-page-wrap {
  background: var(--bg-page);
}

.accounts-hero {
  background: var(--bg-page);
}

.accounts-body {
  background: var(--bg-page);
}

.accounts-btn-primary {
  background: #5096b3;
}

.accounts-btn-primary:hover {
  background: #4485a0;
}

.vault-noir-eyebrow,
.vault-noir-title,
.vault-noir-lead,
.vault-noir-glass,
.vault-noir-date,
.vault-noir-dot {
  display: none;
}

.theme-noir .page-root,
.theme-noir .accounts-page-wrap,
.theme-noir .accounts-hero,
.theme-noir .accounts-body {
  background: var(--nx-paper);
  color: var(--nx-read-1);
}

.theme-noir .accounts-hero {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--nx-hair);
}

.theme-noir .vault-noir-head {
  max-width: none;
  min-height: 176px;
  padding: 30px 34px;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 390px);
}

.theme-noir .vault-title-default,
.theme-noir .vault-lead-default,
.theme-noir .vault-date-default {
  display: none;
}

.theme-noir .vault-noir-eyebrow,
.theme-noir .vault-noir-title,
.theme-noir .vault-noir-lead {
  display: block;
}

.theme-noir .vault-noir-eyebrow {
  margin: 0 0 8px;
  color: var(--nx-accent-2);
  font-family: ui-monospace, 'SF Mono', monospace;
  font-size: 10.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.theme-noir .vault-noir-title {
  max-width: 720px;
  margin: 0;
  color: var(--nx-read-1);
  font-family: 'Playfair Display', Georgia, serif;
  font-size: clamp(28px, 3vw, 38px);
  font-weight: 600;
  letter-spacing: -0.025em;
  line-height: 1.12;
}

.theme-noir .vault-noir-lead {
  max-width: 680px;
  margin: 10px 0 0;
  color: var(--nx-read-3);
  font-size: 14px;
  line-height: 1.55;
}

.theme-noir .vault-noir-head input[type="text"] {
  height: 40px;
  border: 0;
  border-radius: 12px;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / 0.72);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 12%, transparent);
  color: var(--nx-read-1);
}

.theme-noir .vault-noir-head input[type="text"]:focus {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 58%, transparent), 0 0 0 3px color-mix(in srgb, var(--nx-accent) 10%, transparent);
}

.theme-noir .vault-noir-head button {
  height: 40px;
  border-radius: 20px;
  transition: transform 0.58s linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1), background 0.2s, border-color 0.2s;
}

.theme-noir .vault-noir-head button:active {
  transform: scale(0.96);
}

.theme-noir .accounts-btn-primary {
  background: linear-gradient(180deg, var(--nx-accent-2), var(--nx-accent));
  box-shadow: 0 0 18px color-mix(in srgb, var(--nx-accent) 26%, transparent);
}

.theme-noir .vault-noir-body-inner {
  max-width: none;
  padding: 24px 34px 40px;
}

.theme-noir .vault-noir-shell {
  gap: 24px;
  min-height: 420px;
}

.theme-noir .vault-noir-nav {
  width: 230px;
  padding: 18px 14px;
  border: 1px solid var(--nx-hair);
  border-radius: 20px;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / 0.6);
  box-shadow: inset 0 1px 0 rgb(from var(--nx-ink) calc(r + 12) calc(g + 10) calc(b + 7) / 0.018);
  backdrop-filter: blur(14px);
}

.theme-noir .vault-noir-nav h3 {
  margin: 0 10px 12px;
  color: var(--nx-read-4);
  font-family: ui-monospace, 'SF Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.14em;
}

.theme-noir .vault-noir-nav-list {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.theme-noir .vault-noir-nav-list > li {
  position: relative;
  z-index: 1;
}

.theme-noir .vault-noir-glass {
  position: absolute;
  inset: 0 0 auto;
  z-index: 0;
  display: block;
  border-radius: 20px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--nx-accent) 30%, transparent), color-mix(in srgb, var(--nx-accent) 14%, transparent));
  box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--nx-accent-2) 50%, transparent), 0 0 22px color-mix(in srgb, var(--nx-accent) 22%, transparent);
  pointer-events: none;
  transition: transform 0.58s linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1), height 0.2s;
}

.theme-noir .vault-noir-glass::before {
  position: absolute;
  top: 50%;
  left: 0;
  width: 3px;
  height: 22px;
  border-radius: 0 3px 3px 0;
  background: var(--nx-accent-2);
  box-shadow: 0 0 10px color-mix(in srgb, var(--nx-accent-2) 72%, transparent);
  content: '';
  transform: translateY(-50%);
}

.theme-noir .vault-noir-nav-row {
  height: 40px;
  padding: 0 14px;
  border-radius: 20px;
  color: var(--nx-read-3);
  background: transparent !important;
}

.theme-noir .vault-noir-nav-row:hover {
  color: var(--nx-read-1);
  background: color-mix(in srgb, var(--nx-accent) 8%, transparent) !important;
}

.theme-noir .vault-noir-row {
  min-height: 72px;
  margin-bottom: 8px;
  padding: 12px 16px;
  border: 1px solid var(--nx-hair);
  border-radius: 16px;
  background: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 3.5%, transparent);
  box-shadow: inset 0 1px 0 rgb(from var(--nx-ink) calc(r + 12) calc(g + 10) calc(b + 7) / 0.015);
}

.theme-noir .vault-noir-row:hover {
  border-color: color-mix(in srgb, var(--nx-accent-2) 22%, transparent);
  background: color-mix(in srgb, var(--nx-accent) 7.5%, transparent) !important;
}

.theme-noir .vault-noir-tile {
  border: 1px solid color-mix(in srgb, var(--nx-accent-2) 20%, transparent);
  border-radius: 12px;
  background: linear-gradient(145deg, color-mix(in srgb, var(--nx-accent) 22%, transparent), color-mix(in srgb, var(--nx-accent) 7%, transparent));
  color: rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16));
  box-shadow: inset 0 1px 0 rgb(from var(--nx-ink) calc(r + 12) calc(g + 10) calc(b + 7) / 0.04);
}

.theme-noir .vault-noir-state {
  gap: 5px;
  padding: 0;
  background: transparent !important;
  color: var(--nx-read-3) !important;
  font-family: ui-monospace, 'SF Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.04em;
}

.theme-noir .vault-noir-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--nx-success);
  box-shadow: 0 0 8px color-mix(in srgb, var(--nx-success) 72%, transparent);
}

.theme-noir .vault-noir-state.text-slate-500 .vault-noir-dot {
  background: var(--nx-read-5);
  box-shadow: none;
}

.theme-noir .vault-noir-meta,
.theme-noir .vault-noir-date {
  color: var(--nx-read-4);
  font-family: ui-monospace, 'SF Mono', monospace;
  font-size: 10.5px;
}

.theme-noir .vault-noir-date {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.theme-noir .vault-noir-date span {
  color: var(--nx-read-5);
  font-size: 9px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

@media (max-width: 820px) {
  .theme-noir .vault-noir-head {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .theme-noir .vault-noir-glass,
  .theme-noir .vault-noir-head button {
    transition-duration: 0.01ms;
  }
}
</style>
