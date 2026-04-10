<template>
  <div
    class="text-sm font-sans page-root h-full history-page"
    :class="{ dark: isDark }"
  >
    <div class="flex flex-col h-full">
      <!-- Hero header -->
      <div class="overflow-hidden history-header">
        <div class="py-12 sm:px-2 lg:relative lg:px-0 lg:py-16">
          <div class="mx-auto max-w-6xl px-4 md:px-6 lg:px-8">
            <div class="flex items-center justify-between gap-8">
              <div>
                <p class="inline bg-linear-to-r from-indigo-500 via-sky-500 to-indigo-500 dark:from-indigo-200 dark:via-sky-400 dark:to-indigo-200 bg-clip-text font-display text-5xl tracking-tight text-transparent">
                  History.
                </p>
                <p class="mt-3 text-2xl tracking-tight text-slate-500 dark:text-slate-400">
                  Your conversations and browsing activity.
                </p>
              </div>

              <div class="flex items-center gap-3">
                <!-- Search -->
                <div class="relative">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 20 20"
                    class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 fill-slate-400"
                  >
                    <path d="M16.293 17.707a1 1 0 0 0 1.414-1.414l-1.414 1.414ZM9 14a5 5 0 0 1-5-5H2a7 7 0 0 0 7 7v-2ZM4 9a5 5 0 0 1 5-5V2a7 7 0 0 0-7 7h2Zm5-5a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7v2Zm8.707 12.293-3.757-3.757-1.414 1.414 3.757 3.757 1.414-1.414ZM14 9a4.98 4.98 0 0 1-1.464 3.536l1.414 1.414A6.98 6.98 0 0 0 16 9h-2Zm-1.464 3.536A4.98 4.98 0 0 1 9 14v2a6.98 6.98 0 0 0 4.95-2.05l-1.414-1.414Z" />
                  </svg>
                  <input
                    v-model="searchQuery"
                    type="text"
                    placeholder="Search history..."
                    class="h-10 w-64 rounded-lg bg-white/95 pr-4 pl-10 text-sm text-slate-900 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-300/50 dark:bg-slate-800/75 dark:text-slate-100 dark:ring-white/5 dark:ring-inset"
                    @input="debouncedSearch"
                  >
                </div>

                <!-- Filter -->
                <select
                  v-model="filterType"
                  class="h-10 rounded-lg bg-white border border-slate-300 px-3 text-sm text-slate-700 dark:bg-slate-800/75 dark:text-slate-100 dark:ring-1 dark:ring-white/5 dark:border-none focus:outline-none focus:ring-2 focus:ring-sky-300/50"
                  @change="loadHistory"
                >
                  <option value="">
                    All
                  </option>
                  <option value="chat">
                    Chats
                  </option>
                  <option value="browser">
                    Browser
                  </option>
                  <option value="workflow">
                    Workflows
                  </option>
                </select>

                <!-- Clear History -->
                <button
                  type="button"
                  class="h-10 px-4 rounded-lg border border-red-300 hover:border-red-400 text-red-600 hover:text-red-700 dark:border-red-800/50 dark:hover:border-red-600 dark:text-red-400 dark:hover:text-red-300 text-sm font-medium transition-colors"
                  @click="showClearConfirm = true"
                >
                  Clear History
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- History list -->
      <div class="flex-1 overflow-auto">
        <div class="mx-auto max-w-6xl px-4 py-6">
          <!-- Loading state -->
          <div
            v-if="loading"
            class="flex items-center justify-center py-20 text-slate-500"
          >
            Loading history...
          </div>

          <!-- Empty state -->
          <div
            v-else-if="groupedEntries.length === 0"
            class="flex flex-col items-center justify-center py-20 text-slate-500"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              class="h-12 w-12 mb-4 opacity-40"
            >
              <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p class="text-lg">
              No history yet
            </p>
            <p class="mt-1 text-sm text-slate-600">
              Your conversations and browsing activity will appear here.
            </p>
          </div>

          <!-- Grouped entries by date -->
          <template
            v-for="group in groupedEntries"
            v-else
            :key="group.label"
          >
            <h3 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-500 mb-3 mt-6 first:mt-0">
              {{ group.label }}
            </h3>
            <div class="space-y-1 mb-4">
              <div
                v-for="entry in group.entries"
                :key="entry.id"
                class="history-entry group flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer transition-colors"
                @click="openEntry(entry)"
              >
                <!-- Type icon -->
                <div class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
                     :class="entry.type === 'chat' ? 'bg-sky-500/10 text-sky-400' : entry.type === 'workflow' ? 'bg-purple-500/10 text-purple-400' : 'bg-emerald-500/10 text-emerald-400'"
                >
                  <!-- Chat icon -->
                  <svg
                    v-if="entry.type === 'chat'"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    class="h-4 w-4"
                  >
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <!-- Workflow icon -->
                  <svg
                    v-else-if="entry.type === 'workflow'"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    class="h-4 w-4"
                  >
                    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                  </svg>
                  <!-- Browser icon -->
                  <svg
                    v-else
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    class="h-4 w-4"
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="10"
                    />
                    <line
                      x1="2"
                      y1="12"
                      x2="22"
                      y2="12"
                    />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                </div>

                <!-- Title and URL -->
                <div class="flex-1 min-w-0">
                  <p class="text-sm text-slate-800 dark:text-slate-200 truncate">
                    {{ entry.title || 'Untitled' }}
                  </p>
                  <p
                    v-if="entry.url && entry.url !== 'about:blank'"
                    class="text-xs text-slate-500 dark:text-slate-500 truncate mt-0.5"
                  >
                    {{ entry.url }}
                  </p>
                </div>

                <!-- Time -->
                <span class="flex-shrink-0 text-xs text-slate-500 dark:text-slate-600">
                  {{ formatTime(entry.last_active_at || entry.created_at) }}
                </span>

                <!-- Pin button -->
                <button
                  type="button"
                  class="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700"
                  :class="entry.pinned ? 'opacity-100 text-sky-500 dark:text-sky-400' : 'text-slate-400 dark:text-slate-500'"
                  title="Pin"
                  @click.stop="togglePin(entry)"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    class="h-3.5 w-3.5"
                  >
                    <path d="M12 2L12 22M17 7L12 2L7 7" />
                  </svg>
                </button>

                <!-- Delete button -->
                <button
                  type="button"
                  class="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400"
                  title="Delete"
                  @click.stop="deleteEntry(entry)"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    class="h-3.5 w-3.5"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- Clear confirmation dialog -->
      <div
        v-if="showClearConfirm"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-black/60"
        @click.self="showClearConfirm = false"
      >
        <div class="bg-white dark:bg-slate-800 rounded-xl p-6 w-96 shadow-2xl border border-slate-200 dark:border-slate-700">
          <h3 class="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
            Clear History
          </h3>
          <p class="text-sm text-slate-500 dark:text-slate-400 mb-4">
            This will permanently delete conversation history and associated log files from disk.
          </p>
          <label class="flex items-center gap-2 mb-4 text-sm text-slate-600 dark:text-slate-400 cursor-pointer select-none">
            <input
              v-model="includeTrainingData"
              type="checkbox"
              class="rounded border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-red-500 focus:ring-red-500/30"
            >
            <span>Also delete training data files <span class="text-red-500 dark:text-red-400">(irreversible)</span></span>
          </label>
          <div class="flex flex-col gap-2 mb-4">
            <button
              type="button"
              class="w-full px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-sm text-left transition-colors"
              @click="clearHistory('hour')"
            >
              Clear last hour
            </button>
            <button
              type="button"
              class="w-full px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-sm text-left transition-colors"
              @click="clearHistory('today')"
            >
              Clear today
            </button>
            <button
              type="button"
              class="w-full px-4 py-2 rounded-lg bg-red-100 hover:bg-red-200 dark:bg-red-900/50 dark:hover:bg-red-800/60 text-red-700 dark:text-red-300 text-sm text-left transition-colors"
              @click="clearHistory('all')"
            >
              Clear all history
            </button>
          </div>
          <button
            type="button"
            class="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 hover:border-slate-400 dark:hover:border-slate-500 text-slate-600 dark:text-slate-300 text-sm transition-colors"
            @click="showClearConfirm = false"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';

import { useRouter } from 'vue-router';

import { useBrowserTabs } from '@pkg/composables/useBrowserTabs';
import { useTheme } from '@pkg/composables/useTheme';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

interface HistoryEntry {
  id:             string;
  type:           string;
  title:          string;
  url?:           string;
  tab_id?:        string;
  status:         string;
  created_at:     string;
  last_active_at: string;
  pinned:         boolean;
}

interface DateGroup {
  label:   string;
  entries: HistoryEntry[];
}

const { isDark } = useTheme();
const { createTab } = useBrowserTabs();
const router = useRouter();

const searchQuery = ref('');
const filterType = ref('');
const loading = ref(true);
const entries = ref<HistoryEntry[]>([]);
const showClearConfirm = ref(false);
const includeTrainingData = ref(false);

let searchTimeout: ReturnType<typeof setTimeout> | undefined;

const emit = defineEmits<{
  (e: 'navigate-entry', entry: HistoryEntry): void;
}>();

// ── Group entries by date ──

function dateLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const weekAgo = new Date(today.getTime() - 7 * 86_400_000);

  if (d >= today) return 'Today';
  if (d >= yesterday) return 'Yesterday';
  if (d >= weekAgo) return 'Last 7 Days';

  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (d >= today) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  return d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

const groupedEntries = computed<DateGroup[]>(() => {
  const groups = new Map<string, HistoryEntry[]>();

  // Pinned first
  const pinned = entries.value.filter(e => e.pinned);
  const unpinned = entries.value.filter(e => !e.pinned);

  if (pinned.length > 0) {
    groups.set('Pinned', pinned);
  }

  for (const entry of unpinned) {
    const label = dateLabel(entry.last_active_at || entry.created_at);

    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label)!.push(entry);
  }

  return Array.from(groups.entries()).map(([label, items]) => ({
    label,
    entries: items,
  }));
});

// ── Data loading ──

async function loadHistory() {
  loading.value = true;
  try {
    if (searchQuery.value.trim()) {
      entries.value = await ipcRenderer.invoke(
        'conversation-history:search' as any,
        searchQuery.value.trim(),
      );
    } else {
      entries.value = await ipcRenderer.invoke(
        'conversation-history:get-recent' as any,
        200,
        filterType.value || undefined,
      );
    }
  } catch {
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

function debouncedSearch() {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(loadHistory, 300);
}

// ── Actions ──

function openEntry(entry: HistoryEntry) {
  let tab;

  if (entry.type === 'browser' && entry.url && entry.url !== 'about:blank') {
    tab = createTab(entry.url);
  } else {
    tab = createTab('about:blank', { mode: 'chat' as any });
  }

  // Switch to the new tab
  router.push(`/Browser/${ tab.id }`);
  emit('navigate-entry', entry);
}

async function togglePin(entry: HistoryEntry) {
  try {
    // Toggle via IPC — for now we just reload after
    // The pin method is on the model but not exposed via IPC yet,
    // so we'll do a direct call pattern
    entry.pinned = !entry.pinned;
  } catch {
    // ignore
  }
}

async function deleteEntry(entry: HistoryEntry) {
  try {
    await ipcRenderer.invoke('conversation-history:delete' as any, entry.id);
    entries.value = entries.value.filter(e => e.id !== entry.id);
  } catch {
    // ignore
  }
}

function clearHistory(scope: 'hour' | 'today' | 'all') {
  let olderThan: string | undefined;

  if (scope === 'hour') {
    olderThan = new Date(Date.now() - 3_600_000).toISOString();
  } else if (scope === 'today') {
    const today = new Date();

    today.setHours(0, 0, 0, 0);
    olderThan = today.toISOString();
  }

  ipcRenderer.send('conversation-history:clear' as any, olderThan, includeTrainingData.value);
  showClearConfirm.value = false;
  includeTrainingData.value = false;

  // Reload after a short delay to let the clear complete
  setTimeout(loadHistory, 500);
}

function onHistoryCleared() {
  loadHistory();
}

onMounted(() => {
  loadHistory();
  ipcRenderer.on('conversation-history:cleared' as any, onHistoryCleared);
});

onUnmounted(() => {
  ipcRenderer.removeListener('conversation-history:cleared' as any, onHistoryCleared);
  if (searchTimeout) clearTimeout(searchTimeout);
});
</script>

<style scoped>
.history-page {
  background: var(--bg-page, #ffffff);
  color: var(--text-primary, #0d0d0d);
}

.history-page.dark {
  background: var(--bg-page, #0f172a);
  color: var(--text-primary, #e0e0e0);
}

.history-header {
  background: var(--bg-surface, #f8fafc);
}

.history-page.dark .history-header {
  background: #0f172a;
}

.history-entry {
  background: transparent;
}

.history-entry:hover {
  background: var(--bg-surface-hover, rgba(0, 0, 0, 0.04));
}

.history-page.dark .history-entry:hover {
  background: rgba(255, 255, 255, 0.03);
}
</style>
