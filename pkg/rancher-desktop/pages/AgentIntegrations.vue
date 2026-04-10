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
        <!-- Back to Vault button (only when embedded in vault flow) -->
        <div
          v-if="embedded"
          class="flex items-center px-4 py-2 bg-slate-900 border-b border-slate-700/50"
        >
          <button
            type="button"
            class="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
            @click="$emit('back-to-vault')"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-3.5 w-3.5">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            Back to Vault
          </button>
        </div>

        <div class="overflow-hidden bg-slate-900 dark:-mt-19 dark:-mb-32 dark:pt-19 dark:pb-32">
          <div class="py-16 sm:px-2 lg:relative lg:px-0 lg:py-20">
            <div class="mx-auto grid max-w-6xl md:grid-cols-2 items-center gap-x-8 gap-y-10 px-4 md:px-6 lg:px-8 xl:gap-x-16">
              <div class="relative z-10 md:text-center lg:text-left">
                <div class="relative">
                  <p class="inline bg-linear-to-r from-indigo-200 via-sky-400 to-indigo-200 bg-clip-text font-display text-5xl tracking-tight text-transparent">
                    Native Integrations.
                  </p>
                  <p class="mt-3 text-2xl tracking-tight text-slate-400">
                    Connect your favorite tools and services with Sulla.
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
                      placeholder="Search integrations"
                      class="h-11 w-full rounded-lg bg-white/95 pr-4 pl-12 text-sm text-slate-900 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-300/50 dark:bg-slate-800/75 dark:text-slate-100 dark:ring-white/5 dark:ring-inset"
                    >
                    <kbd class="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 font-medium text-slate-400 md:block dark:text-slate-500">
                      <kbd class="font-sans">⌘</kbd><kbd class="font-sans">K</kbd>
                    </kbd>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="flex-1 overflow-auto">
          <div class="mx-auto max-w-7xl px-4 py-6">
            <div class="flex gap-6">
              <!-- Category Sidebar -->
              <nav class="hidden md:block w-48 shrink-0">
                <div class="sticky top-6">
                  <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                    Categories
                  </h3>
                  <ul class="space-y-0.5">
                    <li>
                      <button
                        type="button"
                        class="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm transition-colors"
                        :class="activeCategory === null
                          ? 'bg-sky-500/10 text-sky-600 font-medium dark:bg-sky-400/10 dark:text-sky-400'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'"
                        @click="activeCategory = null"
                      >
                        <span>Popular</span>
                        <span
                          class="text-xs tabular-nums"
                          :class="activeCategory === null ? 'text-sky-500 dark:text-sky-400' : 'text-slate-400 dark:text-slate-500'"
                        >{{ popularCount }}</span>
                      </button>
                    </li>
                    <li
                      v-for="cat in categoriesWithCounts"
                      :key="cat.name"
                    >
                      <button
                        type="button"
                        class="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm transition-colors"
                        :class="activeCategory === cat.name
                          ? 'bg-sky-500/10 text-sky-600 font-medium dark:bg-sky-400/10 dark:text-sky-400'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'"
                        @click="activeCategory = cat.name"
                      >
                        <span>{{ cat.name }}</span>
                        <span
                          class="text-xs tabular-nums"
                          :class="activeCategory === cat.name ? 'text-sky-500 dark:text-sky-400' : 'text-slate-400 dark:text-slate-500'"
                        >{{ cat.count }}</span>
                      </button>
                    </li>
                  </ul>
                </div>
              </nav>

              <!-- Mobile category select -->
              <div class="md:hidden mb-4 w-full">
                <select
                  class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  :value="activeCategory ?? ''"
                  @change="activeCategory = ($event.target as HTMLSelectElement).value || null"
                >
                  <option value="">
                    Popular ({{ popularCount }})
                  </option>
                  <option
                    v-for="cat in categoriesWithCounts"
                    :key="cat.name"
                    :value="cat.name"
                  >
                    {{ cat.name }} ({{ cat.count }})
                  </option>
                </select>
              </div>

              <!-- Integration Grid -->
              <div class="flex-1 min-w-0">
                <!-- Search results: grouped by category -->
                <template v-if="isSearching">
                  <div
                    v-if="searchResultsByCategory.length === 0"
                    class="flex h-40 items-center justify-center text-sm text-[#0d0d0d]/60 dark:text-white/60"
                  >
                    No integrations found.
                  </div>
                  <div
                    v-else
                    class="space-y-8"
                  >
                    <div
                      v-for="group in searchResultsByCategory"
                      :key="group.category"
                    >
                      <h3 class="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                        {{ group.category }}
                        <span class="ml-1.5 text-xs font-normal tabular-nums text-slate-400 dark:text-slate-500">{{ group.integrations.length }}</span>
                      </h3>
                      <div class="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
                        <div
                          v-for="integration in group.integrations"
                          :key="integration.id"
                          class="group relative overflow-hidden rounded-xl bg-white shadow-sm border border-gray-200 transition-all duration-200 hover:shadow-lg hover:border-gray-300 dark:bg-slate-800 dark:border-gray-700 dark:hover:border-gray-600"
                        >
                          <div class="p-6">
                            <div class="flex items-start justify-between mb-4">
                              <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-700">
                                <img
                                  v-if="isImageIcon(integration.icon) && safeIconSrc(integration.icon!)"
                                  :src="safeIconSrc(integration.icon!)"
                                  :alt="integration.name"
                                  class="h-8 w-8 object-contain"
                                >
                                <span
                                  v-else
                                  class="text-2xl"
                                >{{ isImageIcon(integration.icon) ? '🔌' : integration.icon }}</span>
                              </div>
                              <div class="flex items-center gap-2">
                                <div
                                  v-if="!integration.comingSoon"
                                  class="flex items-center gap-2"
                                >
                                  <div
                                    class="h-2 w-2 rounded-full"
                                    :class="integration.connected ? 'bg-green-500' : 'bg-gray-300'"
                                  />
                                  <span class="text-xs text-slate-500 dark:text-slate-400">
                                    {{ integration.connected ? 'Connected' : 'Disconnected' }}
                                  </span>
                                </div>
                                <div class="flex gap-1 ml-2">
                                  <span
                                    v-if="integration.beta"
                                    class="inline-flex items-center rounded-full bg-blue-500 text-white text-xs px-2 py-0.5 font-medium"
                                  >
                                    BETA
                                  </span>
                                  <span
                                    v-if="integration.comingSoon"
                                    class="inline-flex items-center rounded-full bg-gray-400 text-white text-xs px-2 py-0.5 font-medium"
                                  >
                                    COMING SOON
                                  </span>
                                </div>
                              </div>
                            </div>

                            <h3 class="text-lg font-semibold text-slate-900 dark:text-white mb-2">
                              {{ integration.name }}
                            </h3>

                            <p class="text-sm text-slate-600 dark:text-slate-300 mb-4 line-clamp-2">
                              {{ integration.description }}
                            </p>

                            <div class="flex items-center justify-between">
                              <span class="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-800 dark:bg-slate-700 dark:text-slate-200">
                                {{ integration.category }}
                              </span>

                              <div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                                <span>Updated {{ formatFuzzyTime(integration.lastUpdated) }}</span>
                              </div>
                            </div>

                            <div class="flex items-center justify-between mt-3">
                              <button
                                type="button"
                                class="inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
                                :class="integration.comingSoon
                                  ? 'bg-gray-500 text-white hover:bg-gray-600'
                                  : 'bg-blue-600 text-white hover:bg-blue-700'"
                                @click="onIntegrationCardClick(integration)"
                              >
                                {{ integration.comingSoon ? 'Read more' : 'Connect Now' }}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </template>

                <!-- Normal view: flat list for active category / popular -->
                <template v-else>
                  <div
                    v-if="categoryLoading"
                    class="flex h-40 items-center justify-center text-sm text-slate-400 dark:text-slate-500"
                  >
                    <svg
                      class="animate-spin -ml-1 mr-2 h-4 w-4"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        class="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        stroke-width="4"
                      />
                      <path
                        class="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                    Loading integrations…
                  </div>
                  <div
                    v-else-if="filteredIntegrations.length === 0"
                    class="flex h-40 items-center justify-center text-sm text-[#0d0d0d]/60 dark:text-white/60"
                  >
                    No integrations found.
                  </div>

                  <div
                    v-else
                    class="grid md:grid-cols-2 xl:grid-cols-3 gap-6"
                  >
                    <div
                      v-for="integration in filteredIntegrations"
                      :key="integration.id"
                      class="group relative overflow-hidden rounded-xl bg-white shadow-sm border border-gray-200 transition-all duration-200 hover:shadow-lg hover:border-gray-300 dark:bg-slate-800 dark:border-gray-700 dark:hover:border-gray-600"
                    >
                      <div class="p-6">
                        <div class="flex items-start justify-between mb-4">
                          <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-700">
                            <img
                              v-if="isImageIcon(integration.icon) && safeIconSrc(integration.icon!)"
                              :src="safeIconSrc(integration.icon!)"
                              :alt="integration.name"
                              class="h-8 w-8 object-contain"
                            >
                            <span
                              v-else
                              class="text-2xl"
                            >{{ isImageIcon(integration.icon) ? '🔌' : integration.icon }}</span>
                          </div>
                          <div class="flex items-center gap-2">
                            <div
                              v-if="!integration.comingSoon"
                              class="flex items-center gap-2"
                            >
                              <div
                                class="h-2 w-2 rounded-full"
                                :class="integration.connected ? 'bg-green-500' : 'bg-gray-300'"
                              />
                              <span class="text-xs text-slate-500 dark:text-slate-400">
                                {{ integration.connected ? 'Connected' : 'Disconnected' }}
                              </span>
                            </div>
                            <div class="flex gap-1 ml-2">
                              <span
                                v-if="integration.beta"
                                class="inline-flex items-center rounded-full bg-blue-500 text-white text-xs px-2 py-0.5 font-medium"
                              >
                                BETA
                              </span>
                              <span
                                v-if="integration.comingSoon"
                                class="inline-flex items-center rounded-full bg-gray-400 text-white text-xs px-2 py-0.5 font-medium"
                              >
                                COMING SOON
                              </span>
                            </div>
                          </div>
                        </div>

                        <h3 class="text-lg font-semibold text-slate-900 dark:text-white mb-2">
                          {{ integration.name }}
                        </h3>

                        <p class="text-sm text-slate-600 dark:text-slate-300 mb-4 line-clamp-2">
                          {{ integration.description }}
                        </p>

                        <div class="flex items-center justify-between">
                          <span class="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-800 dark:bg-slate-700 dark:text-slate-200">
                            {{ integration.category }}
                          </span>

                          <div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                            <span>Updated {{ formatFuzzyTime(integration.lastUpdated) }}</span>
                          </div>
                        </div>

                        <div class="flex items-center justify-between mt-3">
                          <button
                            type="button"
                            class="inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
                            :class="integration.comingSoon
                              ? 'bg-gray-500 text-white hover:bg-gray-600'
                              : 'bg-blue-600 text-white hover:bg-blue-700'"
                            @click="onIntegrationCardClick(integration)"
                          >
                            {{ integration.comingSoon ? 'Read more' : 'Connect Now' }}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AgentHeader from './agent/AgentHeader.vue';
const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false });
const emit = defineEmits<{ 'back-to-vault': []; 'create-account': [data: { integrationId: string }] }>();
import type { Integration } from '@pkg/agent/integrations/types';
import { popularIntegrations } from '@pkg/agent/integrations/popular';
import { integrations as fullCatalog } from '@pkg/agent/integrations/catalog';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { getExtensionService } from '@pkg/agent/services/ExtensionService';
import { formatFuzzyTime } from '@pkg/utils/dateFormat';
import { useTheme } from '@pkg/composables/useTheme';

import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const { isDark, toggleTheme, currentTheme, setTheme, availableThemes, themeGroups } = useTheme();
const integrationService = getIntegrationService();

/** Handle integration card click — emit when embedded, router push when standalone */
function onIntegrationCardClick(integration: Integration) {
  if (integration.comingSoon) return;
  if (props.embedded) {
    emit('create-account', { integrationId: integration.id });
  } else {
    router.push(`/Integrations/${ integration.id }`);
  }
}

/** Safely resolve an integration icon path — returns null if the asset doesn't exist */
function safeIconSrc(icon: string): string | null {
  try {
    return require(`@pkg/assets/images/${ icon }`);
  } catch {
    return null;
  }
}

function isImageIcon(icon?: string): boolean {
  if (!icon) return false;
  return /\.(svg|png|avif|jpg|jpeg|webp)$/i.test(icon);
}

const search = ref('');
const activeCategory = ref<string | null>(null);
const categoryLoading = ref(false);

const integrationsList = ref<Integration[]>([]);
const mergedIntegrations = ref<Record<string, Integration>>({});
const popularCount = computed(() => Object.keys(popularIntegrations).length);

// Stable category counts built from the full catalog (not view-dependent)
const allCategoryCounts = ref<Map<string, number>>(new Map());

function buildCategoryCounts() {
  const counts = new Map<string, number>();
  for (const integration of Object.values(fullCatalog)) {
    counts.set(integration.category, (counts.get(integration.category) || 0) + 1);
  }
  allCategoryCounts.value = counts;
}

// Cache of already-loaded category data so we don't re-import
const categoryCache = new Map<string, Record<string, Integration>>();

// Whether the activepieces integration gate is connected
const activepiecesEnabled = ref(false);

// All known categories (static list so sidebar renders immediately)
const allCategories = [
  'AI Infrastructure',
  'Communication',
  'Productivity',
  'Project Management',
  'Developer Tools',
  'CRM & Sales',
  'Customer Support',
  'Marketing',
  'Finance',
  'File Storage',
  'Social Media',
  'E-Commerce',
  'HR & Recruiting',
  'Analytics',
  'Automation',
  'Design',
  'AI & ML',
  'Database',
];

const categoriesWithCounts = computed(() => {
  const popularityCounts = new Map<string, number>();
  for (const integration of Object.values(popularIntegrations)) {
    popularityCounts.set(integration.category, (popularityCounts.get(integration.category) || 0) + 1);
  }

  const counts = allCategoryCounts.value;
  return allCategories
    .map(name => ({
      name,
      count:      counts.get(name) || 0,
      popularity: popularityCounts.get(name) || 0,
    }))
    .sort((a, b) => {
      if (a.name === 'AI Infrastructure' && b.name !== 'AI Infrastructure') return -1;
      if (b.name === 'AI Infrastructure' && a.name !== 'AI Infrastructure') return 1;
      if (b.popularity !== a.popularity) return b.popularity - a.popularity;
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    })
    .map(({ name, count }) => ({ name, count }));
});

const filteredIntegrations = computed(() => {
  const q = search.value.trim().toLowerCase();
  const category = activeCategory.value;

  return integrationsList.value
    .filter((integration) => {
      if (q) {
        // When searching, search across all categories
        const hay = `${ integration.name } ${ integration.description } ${ integration.category }`.toLowerCase();
        return hay.includes(q);
      }

      if (category && integration.category !== category) {
        return false;
      }

      return true;
    })
    .sort((a, b) => {
      // Use the sort field if available, otherwise fall back to name comparison
      if (a.sort !== undefined && b.sort !== undefined) {
        return a.sort - b.sort;
      }
      return a.name.localeCompare(b.name);
    });
});

const isSearching = computed(() => search.value.trim().length > 0);

/** When searching, group matching integrations by category across all categories */
const searchResultsByCategory = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return [];

  const byCategory = new Map<string, Integration[]>();

  for (const integration of Object.values(fullCatalog)) {
    const hay = `${ integration.name } ${ integration.description } ${ integration.category }`.toLowerCase();
    if (!hay.includes(q)) continue;

    if (!byCategory.has(integration.category)) {
      byCategory.set(integration.category, []);
    }
    byCategory.get(integration.category)!.push(integration);
  }

  const groups: { category: string; integrations: Integration[] }[] = [];
  for (const [category, integrations] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    groups.push({
      category,
      integrations: integrations.sort((a, b) => a.name.localeCompare(b.name)),
    });
  }

  return groups;
});

// Map category display name → file slug for dynamic imports
const categoryFileMap: Record<string, string> = {
  Communication:        'communication',
  Productivity:         'productivity',
  'Project Management': 'project_management',
  'Developer Tools':    'developer_tools',
  'CRM & Sales':        'crm_sales',
  'Customer Support':   'customer_support',
  Marketing:            'marketing',
  Finance:              'finance',
  'File Storage':       'file_storage',
  'Social Media':       'social_media',
  'E-Commerce':         'ecommerce',
  'HR & Recruiting':    'hr_recruiting',
  Analytics:            'analytics',
  Automation:           'automation',
  Design:               'design',
  'AI & ML':            'ai_ml',
  Database:             'database',
  'AI Infrastructure':  'ai_infrastructure',
};

/** Lazy-load a category's integrations (activepieces if enabled) */
async function loadCategory(categoryName: string): Promise<Record<string, Integration>> {
  const cacheKey = `${ categoryName }:ap=${ activepiecesEnabled.value }`;
  if (categoryCache.has(cacheKey)) {
    return categoryCache.get(cacheKey)!;
  }

  const slug = categoryFileMap[categoryName];
  if (!slug) return {};

  const result: Record<string, Integration> = {};

  // Load native category file (always available — slack, github, AI providers, etc.)
  try {
    const nativeMod = await import(`@pkg/agent/integrations/native/${ slug }.ts`);
    const nativeEntries: Record<string, Integration> = Object.values(nativeMod)[0] as any || {};
    Object.assign(result, nativeEntries);
  } catch { /* no native file for this category */ }

  // Load activepieces-backed integrations only if AP extension is connected
  if (activepiecesEnabled.value) {
    try {
      const apMod = await import(`@pkg/agent/integrations/activepieces/${ slug }.ts`);
      const apEntries: Record<string, Integration> = Object.values(apMod)[0] as any || {};
      Object.assign(result, apEntries);
    } catch { /* no activepieces file for this category */ }
  }

  categoryCache.set(cacheKey, result);
  return result;
}

/** Load popular view (default) and hydrate connection status */
async function loadPopularView() {
  const merged: Record<string, Integration> = { ...popularIntegrations };

  // Also merge extension integrations
  try {
    const extensionService = getExtensionService();
    await extensionService.initialize();
    for (const extInt of extensionService.getExtensionIntegrations()) {
      merged[extInt.id] = extInt;
    }
  } catch { /* ignore */ }

  await hydrateConnectionStatus(merged);
  mergedIntegrations.value = merged;
  integrationsList.value = Object.values(merged);
}

/** Load a specific category view and hydrate connection status */
async function loadCategoryView(categoryName: string) {
  categoryLoading.value = true;
  try {
    const categoryData = await loadCategory(categoryName);
    const merged: Record<string, Integration> = { ...categoryData };
    await hydrateConnectionStatus(merged);
    mergedIntegrations.value = merged;
    integrationsList.value = Object.values(merged);
  } finally {
    categoryLoading.value = false;
  }
}

/** Hydrate connection status from IntegrationService for all entries */
async function hydrateConnectionStatus(entries: Record<string, Integration>) {
  const ids = Object.keys(entries);
  const results = await Promise.all(ids.map(async(id) => {
    try {
      const connected = await integrationService.isAnyAccountConnected(id);
      return { id, connected };
    } catch {
      return { id, connected: false };
    }
  }));
  for (const { id, connected } of results) {
    if (entries[id]) entries[id].connected = connected;
  }
}

// Watch category changes → lazy-load or return to popular
watch(activeCategory, async(newCategory) => {
  if (newCategory === null) {
    await loadPopularView();
  } else {
    await loadCategoryView(newCategory);
  }
});

const connectIntegration = async(id: string) => {
  try {
    await integrationService.setConnectionStatus(id, true);
    const integration = mergedIntegrations.value[id];
    if (integration) {
      integration.connected = true;
      const index = integrationsList.value.findIndex(i => i.id === id);
      if (index !== -1) {
        integrationsList.value[index] = { ...integration };
      }
    }
  } catch (error) {
    console.error('Failed to connect integration:', error);
  }
};

const disconnectIntegration = async(id: string) => {
  try {
    await integrationService.setConnectionStatus(id, false);
    const integration = mergedIntegrations.value[id];
    if (integration) {
      integration.connected = false;
      const index = integrationsList.value.findIndex(i => i.id === id);
      if (index !== -1) {
        integrationsList.value[index] = { ...integration };
      }
    }
  } catch (error) {
    console.error('Failed to disconnect integration:', error);
  }
};

onMounted(async() => {
  // Build stable sidebar counts from the full catalog
  buildCategoryCounts();

  try {
    await integrationService.initialize();

    // Check if activepieces gate is enabled
    try {
      const apStatus = await integrationService.getConnectionStatus('activepieces');
      activepiecesEnabled.value = apStatus.connected;
    } catch {
      activepiecesEnabled.value = false;
    }

    // Load the popular/default view
    await loadPopularView();
  } catch (error) {
    console.error('Failed to load integrations:', error);
  }
});
</script>

<style scoped>
.page-root {
  background: var(--bg-page, #ffffff);
  color: var(--text-primary, #0d0d0d);
}

.page-root.dark {
  background: var(--bg-page, #0f172a);
  color: var(--text-primary, #fafafa);
}

/* Integration cards styles */
.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-clamp: 2;
}
</style>
