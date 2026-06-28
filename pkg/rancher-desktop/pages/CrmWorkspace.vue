<template>
  <div
    class="text-sm font-sans page-root h-full"
    :class="{ dark: isDark }"
    tabindex="-1"
    @keydown.esc="openedRecord = null; creatingRecord = false; editingRecord = false"
    @keydown.n.exact="onKeyN"
  >
    <div class="flex flex-col h-full">
      <AgentHeader
        :is-dark="isDark"
        :toggle-theme="toggleTheme"
      />

      <div class="flex flex-1 min-h-0 overflow-hidden">
        <!-- ── Sidebar: record types nav ── -->
        <aside class="flex flex-col w-56 shrink-0 border-r border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-y-auto">
          <div class="px-4 pt-5 pb-3">
            <h2 class="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">
              Record Types
            </h2>
          </div>

          <nav class="flex-1 px-2 pb-4 space-y-0.5">
            <button
              v-for="rt in schema"
              :key="rt.id"
              type="button"
              class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors"
              :class="selectedTypeKey === rt.key
                ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white font-semibold'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-white'"
              @click="selectType(rt.key)"
            >
              <span
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                :style="{ background: rt.color + '22', color: rt.color }"
              >
                <component :is="ICON_COMPONENTS[rt.icon]" class="h-3.5 w-3.5" />
              </span>
              <span class="flex-1 truncate text-sm">{{ rt.label_plural }}</span>
              <span class="text-xs text-slate-400 dark:text-slate-500 tabular-nums">{{ recordCountByType[rt.key] ?? 0 }}</span>
            </button>
          </nav>

          <div class="px-2 py-3 border-t border-slate-200 dark:border-slate-700">
            <button
              type="button"
              class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-700 dark:hover:text-slate-200 transition-colors text-sm"
            >
              <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New type
            </button>
          </div>
        </aside>

        <!-- ── Main content ── -->
        <div class="flex flex-col flex-1 min-w-0 bg-slate-50 dark:bg-slate-950">
          <!-- toolbar -->
          <div class="flex items-center gap-3 px-6 py-4 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
            <div class="flex-1">
              <h1 class="text-base font-semibold text-slate-900 dark:text-white">
                {{ selectedType?.label_plural ?? 'CRM' }}
              </h1>
              <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                <template v-if="searchQuery.trim() && filteredRecords.length !== totalRecordsForType">
                  {{ filteredRecords.length }} of {{ totalRecordsForType }} record{{ totalRecordsForType === 1 ? '' : 's' }}
                </template>
                <template v-else>
                  {{ filteredRecords.length }} record{{ filteredRecords.length === 1 ? '' : 's' }}
                </template>
              </p>
            </div>

            <!-- search -->
            <div class="relative">
              <svg
                class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                stroke-width="2"
              >
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              <input
                v-model="searchQuery"
                type="text"
                :placeholder="`Search ${selectedType?.label_plural ?? 'records'}…`"
                class="h-9 w-56 rounded-lg pl-9 pr-3 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
              >
            </div>

            <!-- filter button — placeholder -->
            <button
              type="button"
              class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
              title="Filter records"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 4h18M7 9h10M11 14h2" />
              </svg>
              Filter
            </button>

            <!-- view toggle — only when the type has a groupable select field -->
            <div
              v-if="canKanban"
              class="flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden"
            >
              <button
                type="button"
                class="flex items-center gap-1.5 px-3 h-9 text-sm transition-colors"
                :class="viewMode === 'table'
                  ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white font-medium'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60'"
                @click="viewMode = 'table'"
              >
                <!-- rows icon -->
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                Table
              </button>
              <button
                type="button"
                class="flex items-center gap-1.5 px-3 h-9 text-sm border-l border-slate-200 dark:border-slate-700 transition-colors"
                :class="viewMode === 'kanban'
                  ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white font-medium'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60'"
                @click="viewMode = 'kanban'"
              >
                <!-- columns icon -->
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <rect x="3" y="3" width="5" height="18" rx="1" /><rect x="10" y="3" width="5" height="18" rx="1" /><rect x="17" y="3" width="4" height="18" rx="1" />
                </svg>
                Board
              </button>
            </div>

            <button
              type="button"
              class="flex items-center gap-1.5 h-9 px-4 rounded-lg text-sm font-medium text-white bg-sky-600 hover:bg-sky-500 transition-colors"
              title="New record (N)"
              @click="openNewRecord"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New {{ selectedType?.label ?? 'Record' }}
            </button>
          </div>

          <!-- ── Table view ── -->
          <div v-if="viewMode === 'table'" class="flex-1 overflow-auto">
            <table class="min-w-full border-separate border-spacing-0">
              <thead class="sticky top-0 z-10">
                <tr>
                  <th
                    v-for="col in visibleColumns"
                    :key="col.key"
                    class="px-4 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 first:pl-6 last:pr-6 whitespace-nowrap"
                  >
                    <button
                      type="button"
                      class="flex items-center gap-1 text-left text-xs font-semibold uppercase tracking-wide transition-colors select-none"
                      :class="sortField === col.key
                        ? 'text-sky-600 dark:text-sky-400'
                        : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'"
                      @click="toggleSort(col.key)"
                    >
                      {{ col.label }}
                      <!-- sort indicator -->
                      <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                        <path
                          v-if="sortField === col.key && sortDir === 'asc'"
                          stroke-linecap="round" stroke-linejoin="round"
                          d="M5 15l7-7 7 7"
                        />
                        <path
                          v-else-if="sortField === col.key && sortDir === 'desc'"
                          stroke-linecap="round" stroke-linejoin="round"
                          d="M19 9l-7 7-7-7"
                        />
                        <path
                          v-else
                          stroke-linecap="round" stroke-linejoin="round"
                          class="opacity-30"
                          d="M8 9l4-4 4 4M8 15l4 4 4-4"
                        />
                      </svg>
                    </button>
                  </th>
                  <th class="w-10 px-4 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800" />
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                <tr
                  v-for="record in filteredRecords"
                  :key="record.id"
                  class="group cursor-pointer transition-colors"
                  :class="openedRecord?.id === record.id
                    ? 'bg-sky-50 dark:bg-sky-950/20'
                    : 'hover:bg-white dark:hover:bg-slate-900'"
                  @click="openRecord(record)"
                >
                  <td
                    v-for="col in visibleColumns"
                    :key="col.key"
                    class="px-4 py-3 text-sm first:pl-6 last:pr-6"
                    :class="col.is_title
                      ? 'font-medium text-slate-900 dark:text-white'
                      : 'text-slate-600 dark:text-slate-400'"
                  >
                    <CrmCellValue :value="record.field_values[col.key]" :data-type="col.data_type" :format="col.format" />
                  </td>
                  <td class="w-10 px-3 py-3 text-right">
                    <button
                      type="button"
                      class="invisible group-hover:visible text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded p-0.5 transition-colors"
                      @click.stop="openRecord(record)"
                    >
                      <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </td>
                </tr>

                <tr v-if="filteredRecords.length === 0">
                  <td
                    :colspan="visibleColumns.length + 1"
                    class="px-6 py-16 text-center"
                  >
                    <div class="mx-auto w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-3">
                      <svg class="h-5 w-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803M10.5 7.5v6m3-3h-6" />
                      </svg>
                    </div>
                    <p class="text-sm font-medium text-slate-600 dark:text-slate-400">No records found</p>
                    <p class="text-xs text-slate-400 dark:text-slate-500 mt-1">
                      {{ searchQuery ? 'Try a different search term' : `Create the first ${selectedType?.label ?? 'record'}` }}
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- ── Kanban view ── -->
          <div v-else class="flex-1 overflow-x-auto overflow-y-hidden">
            <div class="flex gap-3 h-full p-5 min-w-max">
              <div
                v-for="col in kanbanColumns"
                :key="col"
                class="flex flex-col w-64 shrink-0"
              >
                <!-- column header -->
                <div class="flex items-center gap-2 px-1 mb-3">
                  <span
                    class="h-2 w-2 rounded-full shrink-0"
                    :class="stageDot(col)"
                  />
                  <span class="text-xs font-semibold text-slate-700 dark:text-slate-300 truncate">{{ col }}</span>
                  <span class="ml-auto text-xs tabular-nums text-slate-400 dark:text-slate-500 font-medium shrink-0">
                    {{ (kanbanGroups[col] ?? []).length }}
                    <template v-if="kanbanColumnTotals[col]"> · {{ kanbanColumnTotals[col] }}</template>
                  </span>
                </div>

                <!-- cards -->
                <div class="flex-1 space-y-2 overflow-y-auto pb-2 pr-0.5">
                  <button
                    v-for="record in (kanbanGroups[col] ?? [])"
                    :key="record.id"
                    type="button"
                    class="w-full text-left rounded-xl border p-3.5 shadow-sm transition-all"
                    :class="openedRecord?.id === record.id
                      ? 'bg-sky-50 dark:bg-sky-950/30 border-sky-200 dark:border-sky-800 shadow-md'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700'"
                    @click="openRecord(record)"
                  >
                    <p class="text-sm font-medium text-slate-900 dark:text-white leading-snug mb-2 line-clamp-2">
                      {{ record.title }}
                    </p>
                    <div class="space-y-1">
                      <div
                        v-for="f in kanbanCardFields"
                        :key="f.key"
                        class="flex items-center gap-1.5 text-xs"
                      >
                        <span class="text-slate-400 dark:text-slate-500 shrink-0">{{ f.label }}:</span>
                        <span class="truncate text-slate-600 dark:text-slate-300">{{ formatCardValue(record.field_values[f.key], f.data_type, f.format) }}</span>
                      </div>
                    </div>
                  </button>

                  <!-- add card placeholder -->
                  <button
                    type="button"
                    class="w-full text-left rounded-xl border border-dashed border-slate-200 dark:border-slate-800 p-3 text-xs text-slate-400 dark:text-slate-600 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-500 dark:hover:text-slate-500 transition-colors"
                    @click="openNewRecord"
                  >
                    + Add record
                  </button>
                </div>
              </div>

              <!-- add column placeholder -->
              <div class="flex flex-col w-48 shrink-0 opacity-60 hover:opacity-100 transition-opacity">
                <button
                  type="button"
                  class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  Add stage
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- ── New record form panel ── -->
        <transition
          enter-active-class="transition-all duration-200"
          enter-from-class="translate-x-4 opacity-0"
          enter-to-class="translate-x-0 opacity-100"
          leave-active-class="transition-all duration-150"
          leave-from-class="translate-x-0 opacity-100"
          leave-to-class="translate-x-4 opacity-0"
        >
          <aside
            v-if="creatingRecord && !openedRecord"
            class="w-80 shrink-0 flex flex-col border-l border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
          >
            <div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
              <h3 class="text-sm font-semibold text-slate-900 dark:text-white">
                New {{ selectedType?.label ?? 'Record' }}
              </h3>
              <button
                type="button"
                class="ml-2 shrink-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg p-1 transition-colors"
                @click="creatingRecord = false"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div class="flex-1 px-5 py-4 space-y-4 overflow-y-auto">
              <div
                v-for="field in (selectedType?.fields ?? []).slice().sort((a, b) => a.position - b.position)"
                :key="field.id"
                class="space-y-1"
              >
                <label class="block text-xs font-medium text-slate-400 dark:text-slate-500">
                  {{ field.label }}
                  <span v-if="field.is_required" class="text-red-400 ml-0.5">*</span>
                </label>
                <CrmFieldInput
                  :data-type="field.data_type"
                  :value="draftValues[field.key] ?? null"
                  :read-only="false"
                  :select-options="field.select_options ?? []"
                />
              </div>
            </div>

            <div class="px-5 py-4 border-t border-slate-200 dark:border-slate-700">
              <p class="text-xs text-slate-400 dark:text-slate-500 mb-3">
                Fields marked <span class="text-red-400">*</span> are required.
              </p>
              <div class="flex gap-2">
                <button
                  type="button"
                  class="flex-1 rounded-lg py-2 text-sm font-medium text-white bg-sky-600 hover:bg-sky-500 transition-colors"
                  @click="creatingRecord = false"
                >
                  Save {{ selectedType?.label ?? 'Record' }}
                </button>
                <button
                  type="button"
                  class="rounded-lg py-2 px-3 text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                  @click="creatingRecord = false"
                >
                  Cancel
                </button>
              </div>
            </div>
          </aside>
        </transition>

        <!-- ── Record detail panel ── -->
        <transition
          enter-active-class="transition-all duration-200"
          enter-from-class="translate-x-4 opacity-0"
          enter-to-class="translate-x-0 opacity-100"
          leave-active-class="transition-all duration-150"
          leave-from-class="translate-x-0 opacity-100"
          leave-to-class="translate-x-4 opacity-0"
        >
          <aside
            v-if="openedRecord"
            class="w-80 shrink-0 flex flex-col border-l border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden"
          >
            <!-- panel header -->
            <div class="flex items-start gap-2 px-5 py-4 border-b border-slate-200 dark:border-slate-700">
              <div class="flex-1 min-w-0">
                <p class="mb-1">
                  <span
                    class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium"
                    :style="{ background: (selectedType?.color ?? '#3b82f6') + '22', color: selectedType?.color ?? '#3b82f6' }"
                  >
                    <component :is="ICON_COMPONENTS[selectedType?.icon ?? 'user']" class="h-2.5 w-2.5" />
                    {{ selectedType?.label }}
                  </span>
                </p>
                <h3 class="text-sm font-semibold text-slate-900 dark:text-white truncate">
                  {{ openedRecord.title }}
                </h3>
              </div>
              <span
                v-if="editingRecord"
                class="shrink-0 mt-0.5 rounded-full px-2 py-0.5 text-xs font-medium bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400"
              >
                Editing
              </span>
              <button
                type="button"
                class="shrink-0 mt-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg p-1 transition-colors"
                @click="openedRecord = null; editingRecord = false"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <!-- schema-driven fields -->
            <div class="flex-1 px-5 py-4 space-y-4 overflow-y-auto">
              <div
                v-for="field in (selectedType?.fields ?? []).slice().sort((a, b) => a.position - b.position)"
                :key="field.id"
                class="space-y-1"
              >
                <label class="block text-xs font-medium text-slate-400 dark:text-slate-500">
                  {{ field.label }}
                  <span v-if="field.is_required" class="text-red-400 ml-0.5">*</span>
                </label>
                <CrmFieldInput
                  :data-type="field.data_type"
                  :value="openedRecord.field_values[field.key]"
                  :read-only="!editingRecord"
                  :select-options="field.select_options ?? []"
                  :format="field.format"
                />
              </div>
            </div>

            <!-- panel footer — view mode -->
            <div v-if="!editingRecord" class="px-5 py-4 border-t border-slate-200 dark:border-slate-700 space-y-2">
              <p class="text-xs text-slate-400 dark:text-slate-500">
                Created {{ formatDate(openedRecord.created_at) }}
              </p>
              <div class="flex gap-2">
                <button
                  type="button"
                  class="flex-1 rounded-lg py-2 text-sm font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                  @click="editingRecord = true"
                >
                  Edit
                </button>
                <button type="button" class="rounded-lg py-2 px-3 text-sm font-medium text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors">
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>

            <!-- panel footer — edit mode -->
            <div v-else class="px-5 py-4 border-t border-slate-200 dark:border-slate-700 space-y-2">
              <p class="text-xs text-slate-400 dark:text-slate-500">
                Fields marked <span class="text-red-400">*</span> are required.
              </p>
              <div class="flex gap-2">
                <button
                  type="button"
                  class="flex-1 rounded-lg py-2 text-sm font-medium text-white bg-sky-600 hover:bg-sky-500 transition-colors"
                  @click="editingRecord = false"
                >
                  Save changes
                </button>
                <button
                  type="button"
                  class="rounded-lg py-2 px-3 text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                  @click="editingRecord = false"
                >
                  Discard
                </button>
              </div>
            </div>
          </aside>
        </transition>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, defineComponent, h } from 'vue';
import AgentHeader from '@pkg/pages/agent/AgentHeader.vue';
import { useTheme } from '@pkg/composables/useTheme';

const { isDark, toggleTheme } = useTheme();

// ── Types ──────────────────────────────────────────────────────────────────

type DataType = 'text' | 'number' | 'email' | 'phone' | 'url' | 'boolean' | 'date' | 'select';
type IconKey = 'user' | 'building' | 'chart' | 'target';

type FieldFormat = 'currency' | 'percent' | undefined;

interface CrmField {
  id: string;
  key: string;
  label: string;
  data_type: DataType;
  is_title: boolean;
  is_required: boolean;
  position: number;
  select_options?: string[];
  format?: FieldFormat;
}

interface CrmRecordType {
  id: string;
  key: string;
  label: string;
  label_plural: string;
  icon: IconKey;
  color: string;
  fields: CrmField[];
}

interface CrmRecord {
  id: string;
  record_type_key: string;
  title: string;
  field_values: Record<string, string | number | boolean | null>;
  created_at: string;
}

// ── Icon components (memoized — one component per icon key) ───────────────

const ICON_PATHS: Record<IconKey, string> = {
  user:     'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
  building: 'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2zM9 22V12h6v10',
  chart:    'M3 3v18h18M7 16l4-4 4 4 4-4',
  target:   'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 18a6 6 0 100-12 6 6 0 000 12zM12 14a2 2 0 100-4 2 2 0 000 4z',
};

const ICON_COMPONENTS = Object.fromEntries(
  (Object.keys(ICON_PATHS) as IconKey[]).map((key) => [
    key,
    defineComponent({
      render: () =>
        h('svg', { fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24', 'stroke-width': '2', class: 'h-3.5 w-3.5' }, [
          h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: ICON_PATHS[key] }),
        ]),
    }),
  ]),
) as Record<IconKey, ReturnType<typeof defineComponent>>;

// ── Mock schema (mirrors crm_record_types + crm_fields) ───────────────────

const schema: CrmRecordType[] = [
  {
    id: 'rt_contact', key: 'contact', label: 'Contact', label_plural: 'Contacts',
    icon: 'user', color: '#3b82f6',
    fields: [
      { id: 'f_cn1', key: 'full_name',  label: 'Full name',  data_type: 'text',   is_title: true,  is_required: true,  position: 0 },
      { id: 'f_cn2', key: 'email',      label: 'Email',      data_type: 'email',  is_title: false, is_required: true,  position: 1 },
      { id: 'f_cn3', key: 'phone',      label: 'Phone',      data_type: 'phone',  is_title: false, is_required: false, position: 2 },
      { id: 'f_cn4', key: 'company',    label: 'Company',    data_type: 'text',   is_title: false, is_required: false, position: 3 },
      { id: 'f_cn5', key: 'status',     label: 'Status',     data_type: 'select', is_title: false, is_required: false, position: 4, select_options: ['Lead', 'Prospect', 'Active', 'Churned'] },
    ],
  },
  {
    id: 'rt_company', key: 'company', label: 'Company', label_plural: 'Companies',
    icon: 'building', color: '#8b5cf6',
    fields: [
      { id: 'f_co1', key: 'name',        label: 'Name',         data_type: 'text',   is_title: true,  is_required: true,  position: 0 },
      { id: 'f_co2', key: 'domain',      label: 'Domain',       data_type: 'url',    is_title: false, is_required: false, position: 1 },
      { id: 'f_co3', key: 'industry',    label: 'Industry',     data_type: 'select', is_title: false, is_required: false, position: 2, select_options: ['Education', 'Marketing', 'Consulting', 'Technology', 'Finance', 'Healthcare', 'Other'] },
      { id: 'f_co4', key: 'employees',   label: 'Employees',    data_type: 'number', is_title: false, is_required: false, position: 3 },
      { id: 'f_co5', key: 'annual_rev',  label: 'Annual rev.',  data_type: 'number', is_title: false, is_required: false, position: 4, format: 'currency' },
    ],
  },
  {
    id: 'rt_deal', key: 'deal', label: 'Deal', label_plural: 'Deals',
    icon: 'chart', color: '#10b981',
    fields: [
      { id: 'f_dl1', key: 'name',        label: 'Deal name',  data_type: 'text',   is_title: true,  is_required: true,  position: 0 },
      { id: 'f_dl2', key: 'stage',       label: 'Stage',      data_type: 'select', is_title: false, is_required: true,  position: 1, select_options: ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'] },
      { id: 'f_dl3', key: 'amount',      label: 'Amount',     data_type: 'number', is_title: false, is_required: false, position: 2, format: 'currency' },
      { id: 'f_dl4', key: 'close_date',  label: 'Close date', data_type: 'date',   is_title: false, is_required: false, position: 3 },
      { id: 'f_dl5', key: 'probability', label: 'Win %',      data_type: 'number', is_title: false, is_required: false, position: 4, format: 'percent' },
    ],
  },
  {
    id: 'rt_lead', key: 'lead', label: 'Lead', label_plural: 'Leads',
    icon: 'target', color: '#f59e0b',
    fields: [
      { id: 'f_ld1', key: 'name',      label: 'Name',      data_type: 'text',    is_title: true,  is_required: true,  position: 0 },
      { id: 'f_ld2', key: 'email',     label: 'Email',     data_type: 'email',   is_title: false, is_required: false, position: 1 },
      { id: 'f_ld3', key: 'source',    label: 'Source',    data_type: 'select',  is_title: false, is_required: false, position: 2, select_options: ['Webinar', 'LinkedIn', 'Referral', 'Paid Social', 'Organic', 'Direct'] },
      { id: 'f_ld4', key: 'score',     label: 'Score',     data_type: 'number',  is_title: false, is_required: false, position: 3 },
      { id: 'f_ld5', key: 'converted', label: 'Converted', data_type: 'boolean', is_title: false, is_required: false, position: 4 },
    ],
  },
];

// ── Mock records ───────────────────────────────────────────────────────────

const mockRecords: CrmRecord[] = [
  // Contacts
  { id: 'r1', record_type_key: 'contact', title: 'Jordan Mitchell', created_at: '2026-05-12T14:22:00Z',
    field_values: { full_name: 'Jordan Mitchell', email: 'jordan@apexcoaching.com', phone: '+1 555-0142', company: 'Apex Coaching', status: 'Active' } },
  { id: 'r2', record_type_key: 'contact', title: 'Priya Sharma', created_at: '2026-05-28T09:04:00Z',
    field_values: { full_name: 'Priya Sharma', email: 'priya@scalelab.io', phone: '+1 555-0271', company: 'ScaleLab', status: 'Lead' } },
  { id: 'r3', record_type_key: 'contact', title: 'Marcus Tran', created_at: '2026-06-01T11:50:00Z',
    field_values: { full_name: 'Marcus Tran', email: 'marcus@growthforge.co', phone: null, company: 'GrowthForge', status: 'Active' } },
  { id: 'r4', record_type_key: 'contact', title: 'Sara Okonkwo', created_at: '2026-06-10T16:33:00Z',
    field_values: { full_name: 'Sara Okonkwo', email: 'sara@funnelworks.com', phone: '+1 555-0389', company: 'FunnelWorks', status: 'Churned' } },
  // Companies
  { id: 'r5', record_type_key: 'company', title: 'Apex Coaching', created_at: '2026-04-18T08:00:00Z',
    field_values: { name: 'Apex Coaching', domain: 'apexcoaching.com', industry: 'Education', employees: 24, annual_rev: 4200000 } },
  { id: 'r6', record_type_key: 'company', title: 'ScaleLab', created_at: '2026-04-22T10:15:00Z',
    field_values: { name: 'ScaleLab', domain: 'scalelab.io', industry: 'Marketing', employees: 11, annual_rev: 1800000 } },
  { id: 'r7', record_type_key: 'company', title: 'GrowthForge', created_at: '2026-05-05T14:30:00Z',
    field_values: { name: 'GrowthForge', domain: 'growthforge.co', industry: 'Consulting', employees: 7, annual_rev: 920000 } },
  // Deals
  { id: 'r8', record_type_key: 'deal', title: 'Apex Coaching — Q3 Expansion', created_at: '2026-06-02T13:00:00Z',
    field_values: { name: 'Apex Coaching — Q3 Expansion', stage: 'Proposal', amount: 48000, close_date: '2026-07-31', probability: 65 } },
  { id: 'r9', record_type_key: 'deal', title: 'ScaleLab Renewal', created_at: '2026-06-15T09:45:00Z',
    field_values: { name: 'ScaleLab Renewal', stage: 'Negotiation', amount: 24000, close_date: '2026-07-01', probability: 80 } },
  { id: 'r13', record_type_key: 'deal', title: 'GrowthForge Pilot', created_at: '2026-06-10T10:00:00Z',
    field_values: { name: 'GrowthForge Pilot', stage: 'Qualified', amount: 12000, close_date: '2026-08-15', probability: 40 } },
  { id: 'r14', record_type_key: 'deal', title: 'FunnelWorks Enterprise', created_at: '2026-06-18T15:00:00Z',
    field_values: { name: 'FunnelWorks Enterprise', stage: 'Lead', amount: 96000, close_date: '2026-09-30', probability: 20 } },
  { id: 'r15', record_type_key: 'deal', title: 'TechSprint Coaching', created_at: '2026-06-22T09:00:00Z',
    field_values: { name: 'TechSprint Coaching', stage: 'Closed Won', amount: 18000, close_date: '2026-06-30', probability: 100 } },
  { id: 'r16', record_type_key: 'deal', title: 'MarketMind Advisory', created_at: '2026-06-24T11:00:00Z',
    field_values: { name: 'MarketMind Advisory', stage: 'Proposal', amount: 36000, close_date: '2026-08-01', probability: 55 } },
  // Companies (cont.)
  { id: 'r17', record_type_key: 'company', title: 'FunnelWorks', created_at: '2026-05-14T09:30:00Z',
    field_values: { name: 'FunnelWorks', domain: 'funnelworks.com', industry: 'Marketing', employees: 18, annual_rev: 2400000 } },
  { id: 'r18', record_type_key: 'company', title: 'MarketMind', created_at: '2026-05-20T11:00:00Z',
    field_values: { name: 'MarketMind', domain: 'marketmind.co', industry: 'Consulting', employees: 5, annual_rev: 680000 } },
  // Contacts (cont.)
  { id: 'r19', record_type_key: 'contact', title: 'Ryan Torres', created_at: '2026-06-14T10:00:00Z',
    field_values: { full_name: 'Ryan Torres', email: 'ryan@funnelworks.com', phone: '+1 555-0412', company: 'FunnelWorks', status: 'Prospect' } },
  { id: 'r20', record_type_key: 'contact', title: 'Aisha Patel', created_at: '2026-06-16T14:20:00Z',
    field_values: { full_name: 'Aisha Patel', email: 'aisha@marketmind.co', phone: null, company: 'MarketMind', status: 'Lead' } },
  // Leads
  { id: 'r10', record_type_key: 'lead', title: 'Alex Rivera', created_at: '2026-06-20T11:20:00Z',
    field_values: { name: 'Alex Rivera', email: 'alex@creativehq.io', source: 'Webinar', score: 82, converted: false } },
  { id: 'r11', record_type_key: 'lead', title: 'Nina Kowalski', created_at: '2026-06-21T15:10:00Z',
    field_values: { name: 'Nina Kowalski', email: 'nina@marketmind.co', source: 'LinkedIn', score: 91, converted: true } },
  { id: 'r12', record_type_key: 'lead', title: 'David Chen', created_at: '2026-06-22T08:55:00Z',
    field_values: { name: 'David Chen', email: 'dchen@techsprint.dev', source: 'Referral', score: 74, converted: false } },
  { id: 'r21', record_type_key: 'lead', title: 'Chris Nakamura', created_at: '2026-06-25T09:30:00Z',
    field_values: { name: 'Chris Nakamura', email: 'chris@organicflow.io', source: 'Organic', score: 68, converted: false } },
];

// ── Kanban stage ordering per record type ─────────────────────────────────

const STAGE_ORDER: Record<string, string[]> = {
  deal:    ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'],
  contact: ['Lead', 'Prospect', 'Active', 'Churned'],
  lead:    ['Webinar', 'LinkedIn', 'Referral', 'Paid Social', 'Organic', 'Direct'],
  company: ['Education', 'Marketing', 'Consulting', 'Technology', 'Finance', 'Healthcare', 'Other'],
};

// Tailwind classes for select badge pills — semantic color by value keyword
function selectBadgeClass(val: string): string {
  const v = val.toLowerCase();
  if (['won', 'active', 'converted', 'done'].some((k) => v.includes(k)))
    return 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400';
  if (['lost', 'churn', 'inactive'].some((k) => v.includes(k)))
    return 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400';
  if (['negotiat', 'qualif', 'proposal'].some((k) => v.includes(k)))
    return 'bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-400';
  if (['lead', 'prospect', 'webinar', 'referral', 'linkedin', 'paid', 'organic', 'direct'].some((k) => v.includes(k)))
    return 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-500';
  return 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300';
}

// dot color per semantic stage value
function stageDot(stage: string): string {
  const s = stage.toLowerCase();
  if (s.includes('won') || s.includes('active') || s.includes('converted')) return 'bg-emerald-500';
  if (s.includes('lost') || s.includes('churn')) return 'bg-red-400';
  if (s.includes('negotiat') || s.includes('qualif')) return 'bg-violet-500';
  if (s.includes('proposal') || s.includes('prospect')) return 'bg-sky-500';
  if (s.includes('lead') || s.includes('new')) return 'bg-amber-400';
  return 'bg-slate-400';
}

// ── State ──────────────────────────────────────────────────────────────────

const selectedTypeKey = ref<string>(schema[0].key);
const searchQuery = ref('');
const openedRecord = ref<CrmRecord | null>(null);
const editingRecord = ref(false);
const viewMode = ref<'table' | 'kanban'>('table');
const creatingRecord = ref(false);
const draftValues = ref<Record<string, string | number | boolean | null>>({});
const sortField = ref<string | null>(null);
const sortDir = ref<'asc' | 'desc'>('asc');

// ── Computed ───────────────────────────────────────────────────────────────

const selectedType = computed(() =>
  schema.find((rt) => rt.key === selectedTypeKey.value) ?? null,
);

const totalRecordsForType = computed(() =>
  mockRecords.filter((r) => r.record_type_key === selectedTypeKey.value).length,
);

const recordCountByType = computed(() => {
  const counts: Record<string, number> = {};
  for (const rt of schema) counts[rt.key] = 0;
  for (const r of mockRecords) {
    if (counts[r.record_type_key] != null) counts[r.record_type_key]++;
  }
  return counts;
});

const visibleColumns = computed(() =>
  (selectedType.value?.fields ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .filter((_, i) => i < 5),
);

const filteredRecords = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const recs = mockRecords.filter((r) => r.record_type_key === selectedTypeKey.value);
  const filtered = q
    ? recs.filter((r) =>
        r.title.toLowerCase().includes(q) ||
        Object.values(r.field_values).some((v) => v != null && String(v).toLowerCase().includes(q))
      )
    : recs;

  if (!sortField.value) return filtered;

  const key = sortField.value;
  const dir = sortDir.value === 'asc' ? 1 : -1;
  const col = selectedType.value?.fields.find((f) => f.key === key);

  return [...filtered].sort((a, b) => {
    const av = a.field_values[key];
    const bv = b.field_values[key];
    if (av == null && bv == null) return 0;
    if (av == null) return dir;
    if (bv == null) return -dir;
    if (col?.data_type === 'number') return (Number(av) - Number(bv)) * dir;
    if (col?.data_type === 'boolean') return ((av ? 1 : 0) - (bv ? 1 : 0)) * dir;
    if (col?.data_type === 'date') {
      return (new Date(String(av)).getTime() - new Date(String(bv)).getTime()) * dir;
    }
    return String(av).localeCompare(String(bv)) * dir;
  });
});

// The first select field drives the kanban grouping dimension
const kanbanField = computed(() =>
  selectedType.value?.fields.find((f) => f.data_type === 'select') ?? null,
);

const canKanban = computed(() => kanbanField.value != null);

const kanbanColumns = computed((): string[] => {
  if (!kanbanField.value) return [];
  const fieldKey = kanbanField.value.key;
  const order = STAGE_ORDER[selectedTypeKey.value] ?? [];
  // collect values present in records not already in the predefined order
  const extra = [...new Set(
    filteredRecords.value
      .map((r) => r.field_values[fieldKey] as string)
      .filter((v): v is string => Boolean(v) && !order.includes(v)),
  )];
  return [...order, ...extra];
});

const kanbanGroups = computed((): Record<string, CrmRecord[]> => {
  if (!kanbanField.value) return {};
  const fieldKey = kanbanField.value.key;
  const groups: Record<string, CrmRecord[]> = {};
  for (const col of kanbanColumns.value) groups[col] = [];
  for (const r of filteredRecords.value) {
    const val = (r.field_values[fieldKey] as string) ?? '';
    if (Object.prototype.hasOwnProperty.call(groups, val)) {
      groups[val].push(r);
    }
  }
  return groups;
});

// Per-column currency totals for types that have a currency field (e.g. deal.amount)
const kanbanColumnTotals = computed((): Record<string, string | null> => {
  const currencyField = selectedType.value?.fields.find((f) => f.format === 'currency');
  if (!currencyField) return {};
  const result: Record<string, string | null> = {};
  for (const col of kanbanColumns.value) {
    const records = kanbanGroups.value[col] ?? [];
    const sum = records.reduce((acc, r) => {
      const v = r.field_values[currencyField.key];
      return acc + (v != null ? Number(v) : 0);
    }, 0);
    result[col] = sum > 0 ? formatCardValue(sum, 'number', 'currency') : null;
  }
  return result;
});

// Secondary fields shown on each kanban card (first 2 non-title, non-groupBy fields)
const kanbanCardFields = computed(() => {
  const groupKey = kanbanField.value?.key;
  return (selectedType.value?.fields ?? [])
    .filter((f) => !f.is_title && f.key !== groupKey && f.data_type !== 'boolean')
    .sort((a, b) => a.position - b.position)
    .slice(0, 2);
});

// ── Actions ────────────────────────────────────────────────────────────────

function selectType(key: string) {
  selectedTypeKey.value = key;
  searchQuery.value = '';
  openedRecord.value = null;
  editingRecord.value = false;
  creatingRecord.value = false;
  draftValues.value = {};
  sortField.value = null;
  sortDir.value = 'asc';
  // If the new type has no groupable field, fall back to table view
  const newType = schema.find((rt) => rt.key === key);
  if (!newType?.fields.some((f) => f.data_type === 'select')) {
    viewMode.value = 'table';
  }
}

function toggleSort(fieldKey: string) {
  if (sortField.value === fieldKey) {
    if (sortDir.value === 'asc') {
      sortDir.value = 'desc';
    } else {
      sortField.value = null;
      sortDir.value = 'asc';
    }
  } else {
    sortField.value = fieldKey;
    sortDir.value = 'asc';
  }
}

function openRecord(record: CrmRecord) {
  openedRecord.value = record;
  editingRecord.value = false;
  creatingRecord.value = false;
}

function openNewRecord() {
  openedRecord.value = null;
  draftValues.value = {};
  creatingRecord.value = true;
}

function onKeyN(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  openNewRecord();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatCardValue(val: string | number | boolean | null | undefined, dataType: DataType, format?: FieldFormat): string {
  if (val == null || val === '') return '—';
  if (dataType === 'number') {
    const n = Number(val);
    if (format === 'currency') {
      if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
      if (n >= 1_000) return '$' + Math.round(n / 1_000) + 'k';
      return '$' + n;
    }
    if (format === 'percent') return n + '%';
    return n.toLocaleString();
  }
  if (dataType === 'date') return new Date(String(val)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return String(val);
}

// ── Inline sub-components ──────────────────────────────────────────────────

const CrmCellValue = defineComponent({
  props: {
    value: { type: [String, Number, Boolean, null] as unknown as () => string | number | boolean | null, default: null },
    dataType: { type: String as () => DataType, required: true },
    format: { type: String as () => FieldFormat, default: undefined },
  },
  setup(props) {
    return () => {
      if (props.value == null || props.value === '') {
        return h('span', { class: 'text-slate-300 dark:text-slate-600' }, '—');
      }
      if (props.dataType === 'boolean') {
        return h('span', {
          class: props.value
            ? 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400'
            : 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
        }, props.value ? 'Yes' : 'No');
      }
      if (props.dataType === 'number') {
        const n = Number(props.value);
        let display: string;
        if (props.format === 'currency') {
          display = '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        } else if (props.format === 'percent') {
          display = n + '%';
        } else {
          display = n.toLocaleString();
        }
        return h('span', { class: 'tabular-nums' }, display);
      }
      if (props.dataType === 'email') {
        return h('a', {
          href: 'mailto:' + String(props.value),
          class: 'text-sky-600 dark:text-sky-400 hover:underline truncate max-w-[180px] block',
          onClick: (e: Event) => e.stopPropagation(),
        }, String(props.value));
      }
      if (props.dataType === 'url') {
        const href = String(props.value).startsWith('http') ? String(props.value) : 'https://' + String(props.value);
        return h('a', {
          href,
          target: '_blank',
          rel: 'noopener noreferrer',
          class: 'text-sky-600 dark:text-sky-400 hover:underline truncate max-w-[180px] block',
          onClick: (e: Event) => e.stopPropagation(),
        }, String(props.value));
      }
      if (props.dataType === 'phone') {
        return h('a', {
          href: 'tel:' + String(props.value),
          class: 'text-sky-600 dark:text-sky-400 hover:underline tabular-nums',
          onClick: (e: Event) => e.stopPropagation(),
        }, String(props.value));
      }
      if (props.dataType === 'select') {
        return h('span', {
          class: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' + selectBadgeClass(String(props.value)),
        }, String(props.value));
      }
      if (props.dataType === 'date') {
        const d = new Date(String(props.value));
        const fmt = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return h('span', { class: 'tabular-nums' }, fmt);
      }
      return h('span', { class: 'truncate max-w-[180px] block' }, String(props.value));
    };
  },
});

const CrmFieldInput = defineComponent({
  props: {
    value: { type: [String, Number, Boolean, null] as unknown as () => string | number | boolean | null, default: null },
    dataType: { type: String as () => DataType, required: true },
    readOnly: { type: Boolean, default: false },
    selectOptions: { type: Array as () => string[], default: () => [] },
    format: { type: String as () => FieldFormat, default: undefined },
  },
  setup(props) {
    return () => {
      const baseClass = 'w-full rounded-lg px-3 py-2 text-sm border bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100';
      const val = props.value;
      if (props.dataType === 'boolean') {
        return h('div', { class: 'flex items-center gap-2 py-1' }, [
          h('div', {
            class: `h-5 w-5 rounded border-2 flex items-center justify-center ${val ? 'bg-sky-500 border-sky-500' : 'border-slate-300 dark:border-slate-600'}`,
          }, val ? h('svg', { class: 'h-3 w-3 text-white', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24', 'stroke-width': '3' },
            [h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M5 13l4 4L19 7' })]) : null),
          h('span', { class: 'text-sm text-slate-700 dark:text-slate-300' }, val ? 'Yes' : 'No'),
        ]);
      }
      if (props.dataType === 'select') {
        const opts = props.selectOptions;
        if (props.readOnly) {
          return h('select', {
            disabled: true,
            class: baseClass + ' opacity-80 cursor-default appearance-none',
          }, [
            h('option', { value: val != null ? String(val) : '', selected: true }, val != null ? String(val) : '—'),
          ]);
        }
        return h('select', {
          class: baseClass + ' appearance-none cursor-pointer',
        }, [
          h('option', { value: '' }, '— select —'),
          ...opts.map((o) => h('option', { value: o, selected: String(val) === o }, o)),
        ]);
      }
      if (props.readOnly && (props.dataType === 'email' || props.dataType === 'phone' || props.dataType === 'url')) {
        if (val == null || val === '') {
          return h('span', { class: baseClass + ' opacity-60 cursor-default inline-flex items-center' }, '—');
        }
        const href = props.dataType === 'email' ? 'mailto:' + String(val)
          : props.dataType === 'phone' ? 'tel:' + String(val)
          : String(val).startsWith('http') ? String(val) : 'https://' + String(val);
        return h('a', {
          href,
          target: props.dataType === 'url' ? '_blank' : undefined,
          rel: props.dataType === 'url' ? 'noopener noreferrer' : undefined,
          class: baseClass + ' text-sky-600 dark:text-sky-400 hover:underline inline-flex items-center opacity-90',
        }, String(val));
      }
      if (props.readOnly && props.dataType === 'date') {
        const fmt = val != null && val !== ''
          ? new Date(String(val)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          : '';
        return h('input', {
          type: 'text',
          value: fmt,
          readonly: true,
          class: baseClass + ' opacity-80 cursor-default',
        });
      }
      if (props.readOnly && props.dataType === 'number' && props.format) {
        let displayVal = '';
        if (val != null && val !== '') {
          const n = Number(val);
          if (props.format === 'currency') {
            displayVal = '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
          } else if (props.format === 'percent') {
            displayVal = n + '%';
          }
        }
        return h('input', {
          type: 'text',
          value: displayVal,
          readonly: true,
          class: baseClass + ' opacity-80 cursor-default tabular-nums',
        });
      }
      return h('input', {
        type: props.dataType === 'number' ? 'number' : props.dataType === 'date' ? 'date' : 'text',
        value: val != null ? String(val) : '',
        readonly: props.readOnly,
        class: baseClass + (props.readOnly ? ' opacity-80 cursor-default' : ''),
      });
    };
  },
});
</script>
