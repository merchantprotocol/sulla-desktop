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

      <div class="flex w-full flex-col">
        <div class="overflow-hidden bg-slate-900 dark:-mt-19 dark:-mb-32 dark:pt-19 dark:pb-32">
          <div class="py-16 sm:px-2 lg:relative lg:px-0 lg:py-20">
            <div class="mx-auto grid max-w-6xl md:grid-cols-2 items-center gap-x-8 gap-y-10 px-4 md:px-6 lg:px-8 xl:gap-x-16">
              <div class="relative z-10 md:text-center lg:text-left">
                <div class="relative">
                  <p class="inline bg-linear-to-r from-indigo-200 via-sky-400 to-indigo-200 bg-clip-text font-display text-5xl tracking-tight text-transparent">
                    Password Manager.
                  </p>
                  <p class="mt-3 text-2xl tracking-tight text-slate-400">
                    All your connected accounts and saved credentials in one place.
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
                    class="h-11 px-4 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium transition-colors flex items-center gap-2"
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

        <div class="flex-1 overflow-auto">
          <div class="mx-auto max-w-7xl px-4 py-6">
            <!-- Vault status + Export / Import bar -->
            <div class="flex items-center gap-2 mb-4">
              <div
                v-if="vaultSecure"
                class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
                style="background: rgba(56, 189, 248, 0.08); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.15);"
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
                @click="importVault"
              >
                Import
              </button>
            </div>
            <div class="flex gap-6">
              <!-- Filter Sidebar -->
              <nav class="hidden md:block w-48 shrink-0">
                <div class="sticky top-6">
                  <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                    Filter by Type
                  </h3>
                  <ul class="space-y-0.5">
                    <li>
                      <button
                        type="button"
                        class="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm transition-colors"
                        :class="activeFilter === null
                          ? 'bg-sky-500/10 text-sky-600 font-medium dark:bg-sky-400/10 dark:text-sky-400'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'"
                        @click="activeFilter = null"
                      >
                        <span>All</span>
                        <span
                          class="text-xs tabular-nums"
                          :class="activeFilter === null ? 'text-sky-500 dark:text-sky-400' : 'text-slate-400 dark:text-slate-500'"
                        >{{ flatAccounts.length }}</span>
                      </button>
                    </li>
                    <li
                      v-for="type in integrationTypes"
                      :key="type"
                    >
                      <button
                        type="button"
                        class="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm transition-colors"
                        :class="activeFilter === type
                          ? 'bg-sky-500/10 text-sky-600 font-medium dark:bg-sky-400/10 dark:text-sky-400'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'"
                        @click="activeFilter = type"
                      >
                        <span>{{ integrationName(type) }}</span>
                        <span
                          class="text-xs tabular-nums"
                          :class="activeFilter === type ? 'text-sky-500 dark:text-sky-400' : 'text-slate-400 dark:text-slate-500'"
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
                    class="group flex items-center gap-4 rounded-lg px-4 py-3 transition-colors cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/50"
                    @click="openAccount(account)"
                  >
                    <!-- Icon / Type badge -->
                    <div
                      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xs font-bold uppercase"
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
                          class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                          :class="account.connected
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : 'bg-slate-500/10 text-slate-500 dark:text-slate-400'"
                        >
                          {{ account.connected ? 'Connected' : 'Disconnected' }}
                        </span>
                      </div>
                      <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                        {{ integrationName(account.integrationId) }}
                        <span v-if="account.connectedAt"> &middot; {{ formatDate(account.connectedAt) }}</span>
                      </div>
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
import { ref, computed, onMounted } from 'vue';
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
  if (id === 'website') return 'bg-sky-500/20 text-sky-600 dark:text-sky-400';
  const catalog = integrationCatalog[id];
  if (!catalog) return 'bg-slate-500/20 text-slate-500';

  const category = catalog.category?.toLowerCase() || '';
  if (category.includes('ai')) return 'bg-purple-500/20 text-purple-600 dark:text-purple-400';
  if (category.includes('communication')) return 'bg-blue-500/20 text-blue-600 dark:text-blue-400';
  if (category.includes('developer')) return 'bg-gray-500/20 text-gray-600 dark:text-gray-400';
  return 'bg-sky-500/20 text-sky-600 dark:text-sky-400';
};

const llmAccessBadgeClass = (level: string): string => {
  switch (level) {
  case 'none': return 'bg-red-500/10 text-red-600 dark:text-red-400';
  case 'metadata': return 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400';
  case 'autofill': return 'bg-blue-500/10 text-blue-600 dark:text-blue-400';
  case 'full': return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
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

async function exportVault(encrypted: boolean) {
  try {
    const result = await ipcRenderer.invoke('vault:export', { encrypted });
    if (result.success) {
      console.log(`[Vault] Exported ${ result.count } accounts to ${ result.path }`);
    } else if (!result.canceled) {
      console.error('[Vault] Export failed:', result.error);
    }
  } catch (err) {
    console.error('[Vault] Export error:', err);
  }
}

async function importVault() {
  try {
    const result = await ipcRenderer.invoke('vault:import');
    if (result.success) {
      console.log(`[Vault] Imported ${ result.count } accounts`);
      await loadAccounts(); // Refresh the list
    } else if (!result.canceled) {
      console.error('[Vault] Import failed:', result.error);
    }
  } catch (err) {
    console.error('[Vault] Import error:', err);
  }
}

onMounted(async() => {
  // Check if vault encryption is active
  try {
    const isSetUp = await ipcRenderer.invoke('vault:is-setup');
    const isUnlocked = await ipcRenderer.invoke('vault:is-unlocked');
    vaultSecure.value = isSetUp && isUnlocked;
  } catch { /* vault IPC not available */ }

  loadAccounts();
});
</script>
