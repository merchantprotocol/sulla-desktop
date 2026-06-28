<template>
  <div
    class="text-sm font-sans page-root h-full"
    :class="{ dark: isDark }"
    tabindex="-1"
    @keydown.esc="onKeyEsc"
    @keydown.n.exact="onKeyN"
    @keydown.up.exact.prevent="onKeyArrow(-1)"
    @keydown.down.exact.prevent="onKeyArrow(1)"
    @keydown.meta.enter.exact.prevent="onKeySave"
    @keydown.ctrl.enter.exact.prevent="onKeySave"
    @keydown="onGlobalKeydown"
    @click="showColumnsMenu = false; cancelCellEdit()"
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
              title="Add a new record type"
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
          <!-- bulk action bar — visible when rows are checked in table view -->
          <div
            v-if="selectedIds.size && viewMode === 'table'"
            class="flex items-center gap-3 px-6 py-3.5 border-b border-slate-200 dark:border-slate-700 bg-sky-50 dark:bg-sky-950/20"
          >
            <span class="flex-1 text-sm font-medium text-sky-700 dark:text-sky-300">
              {{ selectedIds.size }} record{{ selectedIds.size === 1 ? '' : 's' }} selected
            </span>
            <button
              type="button"
              class="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800 transition-colors"
              title="Archive selected (coming soon)"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8l1 12a2 2 0 002 2h8a2 2 0 002-2L19 8" />
              </svg>
              Archive
            </button>
            <button
              type="button"
              class="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800 transition-colors"
              title="Export selected (coming soon)"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export
            </button>
            <button
              type="button"
              class="h-8 px-3 rounded-lg text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              @click="clearSelection"
            >
              Clear
            </button>
          </div>

          <!-- toolbar -->
          <div v-else class="flex items-center gap-3 px-6 py-4 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
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
                <template v-if="recordsTotal"> · {{ recordsTotal }}</template>
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
                :class="['h-9 w-56 rounded-lg pl-9 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-400/40', searchQuery ? 'pr-8' : 'pr-3']"
              >
              <button
                v-if="searchQuery"
                type="button"
                class="absolute top-1/2 right-2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded transition-colors p-0.5"
                title="Clear search"
                @click="searchQuery = ''"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <!-- filter button — clears filters when active -->
            <button
              type="button"
              class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border transition-colors"
              :class="activeFilters.length
                ? 'border-sky-300 dark:border-sky-700 bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400 hover:bg-sky-100 dark:hover:bg-sky-900/40'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200'"
              :title="activeFilters.length ? `Clear ${activeFilters.length} active filter${activeFilters.length > 1 ? 's' : ''}` : 'Filter records'"
              @click="activeFilters.length ? clearFilters() : undefined"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 4h18M7 9h10M11 14h2" />
              </svg>
              Filter
              <span
                v-if="activeFilters.length"
                class="inline-flex items-center justify-center h-4 min-w-[1rem] rounded-full px-1 text-xs font-semibold bg-sky-500 text-white"
              >{{ activeFilters.length }}</span>
            </button>

            <!-- export button — placeholder -->
            <button
              type="button"
              class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
              title="Export as CSV (coming soon)"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export
            </button>

            <!-- columns toggle — table view only -->
            <div v-if="viewMode === 'table'" class="relative">
              <button
                type="button"
                class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border transition-colors"
                :class="hiddenColumnKeys.size
                  ? 'border-sky-400 dark:border-sky-500 text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/30 hover:bg-sky-100 dark:hover:bg-sky-950/50'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200'"
                title="Show / hide columns"
                @click.stop="showColumnsMenu = !showColumnsMenu"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                </svg>
                Columns<template v-if="hiddenColumnKeys.size"> ({{ hiddenColumnKeys.size }} hidden)</template>
              </button>

              <!-- columns dropdown -->
              <div
                v-if="showColumnsMenu"
                class="absolute right-0 top-full mt-1 z-30 w-48 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg py-1"
                @click.stop
              >
                <div class="px-3 py-2 text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide border-b border-slate-100 dark:border-slate-800">
                  Fields
                </div>
                <label
                  v-for="col in allColumns"
                  :key="col.key"
                  class="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer select-none"
                  :class="col.is_title
                    ? 'text-slate-400 dark:text-slate-600 cursor-not-allowed'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60'"
                >
                  <input
                    type="checkbox"
                    :checked="!hiddenColumnKeys.has(col.key)"
                    :disabled="col.is_title"
                    class="h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-600 text-sky-600 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                    @change="toggleColumnVisibility(col.key)"
                  >
                  {{ col.label }}
                  <span v-if="col.is_title" class="ml-auto text-xs text-slate-300 dark:text-slate-700">Title</span>
                </label>
                <div class="px-3 py-2 border-t border-slate-100 dark:border-slate-800">
                  <button
                    type="button"
                    class="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                    @click="hiddenColumnKeys = new Set()"
                  >
                    Show all
                  </button>
                </div>
              </div>
            </div>

            <!-- row density toggle — table view only -->
            <div
              v-if="viewMode === 'table'"
              class="flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden"
              title="Row density"
            >
              <button
                type="button"
                class="flex items-center px-2.5 h-9 transition-colors"
                :class="rowDensity === 'comfortable'
                  ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'
                  : 'text-slate-400 dark:text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/60'"
                title="Comfortable rows"
                @click="rowDensity = 'comfortable'"
              >
                <!-- 3 wide rows icon -->
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <button
                type="button"
                class="flex items-center px-2.5 h-9 border-l border-slate-200 dark:border-slate-700 transition-colors"
                :class="rowDensity === 'compact'
                  ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'
                  : 'text-slate-400 dark:text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/60'"
                title="Compact rows"
                @click="rowDensity = 'compact'"
              >
                <!-- 5 narrow rows icon -->
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 5h16M4 8.5h16M4 12h16M4 15.5h16M4 19h16" />
                </svg>
              </button>
            </div>

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

          <!-- active filter pills -->
          <div
            v-if="activeFilters.length"
            class="flex items-center gap-2 px-6 py-2.5 border-b border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-950/50 flex-wrap"
          >
            <span class="text-xs font-medium text-slate-500 dark:text-slate-400 shrink-0">Filtered by:</span>
            <div
              v-for="f in activeFilters"
              :key="f.fieldKey + ':' + f.value"
              class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-800 text-sky-700 dark:text-sky-300"
            >
              <span>{{ allColumns.find((c) => c.key === f.fieldKey)?.label }}: <b>{{ f.value }}</b></span>
              <button
                type="button"
                class="ml-0.5 text-sky-400 hover:text-sky-600 dark:hover:text-sky-200 transition-colors leading-none"
                :aria-label="`Remove ${f.fieldKey} filter`"
                @click="toggleFilter(f.fieldKey, f.value)"
              >
                <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <button
              type="button"
              class="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors ml-1"
              @click="clearFilters"
            >
              Clear all
            </button>
          </div>

          <!-- ── Table view ── -->
          <div v-if="viewMode === 'table'" class="flex-1 overflow-auto">
            <table class="min-w-full border-separate border-spacing-0">
              <thead class="sticky top-0 z-10">
                <tr>
                  <!-- select-all checkbox -->
                  <th class="w-9 pl-6 pr-2 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
                    <input
                      type="checkbox"
                      :checked="allSelected"
                      :indeterminate="selectedIds.size > 0 && !allSelected"
                      class="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-sky-600 cursor-pointer"
                      @change="toggleAll"
                    >
                  </th>
                  <th
                    v-for="col in visibleColumns"
                    :key="col.key"
                    class="px-4 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 whitespace-nowrap"
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
                  <th class="px-4 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 whitespace-nowrap">
                    <button
                      type="button"
                      class="flex items-center gap-1 text-left text-xs font-semibold uppercase tracking-wide transition-colors select-none"
                      :class="sortField === '__created_at__'
                        ? 'text-sky-600 dark:text-sky-400'
                        : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'"
                      @click="toggleSort('__created_at__')"
                    >
                      Added
                      <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                        <path v-if="sortField === '__created_at__' && sortDir === 'asc'" stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
                        <path v-else-if="sortField === '__created_at__' && sortDir === 'desc'" stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                        <path v-else stroke-linecap="round" stroke-linejoin="round" class="opacity-30" d="M8 9l4-4 4 4M8 15l4 4 4-4" />
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
                  <!-- row checkbox -->
                  <td class="pl-6 pr-2" :class="rowDensity === 'compact' ? 'py-1.5' : 'py-3'" @click.stop>
                    <input
                      type="checkbox"
                      :checked="selectedIds.has(record.id)"
                      class="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-sky-600 cursor-pointer"
                      @change="toggleSelect(record.id)"
                    >
                  </td>
                  <td
                    v-for="col in visibleColumns"
                    :key="col.key"
                    class="px-4 text-sm"
                    :class="[
                      rowDensity === 'compact' ? 'py-1.5' : 'py-3',
                      col.is_title
                        ? 'font-medium text-slate-900 dark:text-white'
                        : 'text-slate-600 dark:text-slate-400',
                    ]"
                  >
                    <div v-if="col.is_title" class="flex items-center gap-1.5">
                      <CrmCellValue :value="record.field_values[col.key]" :data-type="col.data_type" :format="col.format" />
                      <span
                        v-if="record.links?.length"
                        class="shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-xs tabular-nums bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500"
                      >{{ record.links.length }}</span>
                    </div>
                    <!-- inline cell editor (non-title columns) -->
                    <template v-else>
                      <div v-if="editingCell?.recordId === record.id && editingCell?.fieldKey === col.key" @click.stop>
                        <CrmCellEditor
                          :data-type="col.data_type"
                          :value="cellDraftValue"
                          :select-options="col.select_options ?? []"
                          @commit="commitCellEdit"
                          @cancel="cancelCellEdit"
                        />
                      </div>
                      <div
                        v-else
                        class="group/cell relative"
                        :class="col.data_type === 'select' && record.field_values[col.key] ? 'cursor-pointer' : ''"
                        @dblclick.stop="startCellEdit(record, col)"
                        @click.stop="col.data_type === 'select' && record.field_values[col.key]
                          ? toggleFilter(col.key, String(record.field_values[col.key]))
                          : undefined"
                      >
                        <CrmCellValue :value="record.field_values[col.key]" :data-type="col.data_type" :format="col.format" />
                        <!-- funnel icon on select cells to hint at click-to-filter -->
                        <span
                          v-if="col.data_type === 'select' && record.field_values[col.key]"
                          class="absolute right-0 top-1/2 -translate-y-1/2 transition-opacity pointer-events-none"
                          :class="activeFilters.some(f => f.fieldKey === col.key && f.value === String(record.field_values[col.key]))
                            ? 'opacity-60 text-sky-500'
                            : 'opacity-0 group-hover/cell:opacity-30'"
                        >
                          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M3 4h18M7 9h10M11 14h2" />
                          </svg>
                        </span>
                        <span
                          v-else-if="col.data_type !== 'boolean' && col.data_type !== 'select'"
                          class="absolute right-0 top-1/2 -translate-y-1/2 opacity-0 group-hover/cell:opacity-40 transition-opacity pointer-events-none"
                        >
                          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                        </span>
                      </div>
                    </template>
                  </td>
                  <td class="px-4 text-xs tabular-nums text-slate-400 dark:text-slate-500 whitespace-nowrap" :class="rowDensity === 'compact' ? 'py-1.5' : 'py-3'">
                    {{ formatDate(record.created_at) }}
                  </td>
                  <td class="w-10 px-3 text-right" :class="rowDensity === 'compact' ? 'py-1.5' : 'py-3'">
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
                    :colspan="visibleColumns.length + 3"
                    class="px-6 py-16 text-center"
                  >
                    <div class="mx-auto w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-3">
                      <svg class="h-5 w-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803M10.5 7.5v6m3-3h-6" />
                      </svg>
                    </div>
                    <p class="text-sm font-medium text-slate-600 dark:text-slate-400">No records found</p>
                    <p class="text-xs text-slate-400 dark:text-slate-500 mt-1">
                      {{ activeFilters.length ? 'No records match the active filters' : searchQuery ? 'Try a different search term' : `Create the first ${selectedType?.label ?? 'record'}` }}
                    </p>
                    <button
                      v-if="activeFilters.length"
                      type="button"
                      class="mt-3 rounded-lg px-3 py-1.5 text-xs font-medium text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/40 hover:bg-sky-100 dark:hover:bg-sky-900/40 transition-colors"
                      @click="clearFilters"
                    >
                      Clear filters
                    </button>
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

                  <!-- search no-matches indicator -->
                <div
                  v-if="searchQuery.trim() && !(kanbanGroups[col] ?? []).length"
                  class="py-4 text-center"
                >
                  <p class="text-xs text-slate-300 dark:text-slate-700 select-none">No matches</p>
                </div>

                <!-- add card placeholder -->
                  <button
                    type="button"
                    class="w-full text-left rounded-xl border border-dashed border-slate-200 dark:border-slate-800 p-3 text-xs text-slate-400 dark:text-slate-600 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-500 dark:hover:text-slate-500 transition-colors"
                    @click="openNewRecord(col)"
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
                  title="Add a new stage column"
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
                <h3 class="text-sm font-semibold text-slate-900 dark:text-white">
                  New {{ selectedType?.label ?? 'Record' }}
                </h3>
              </div>
              <button
                type="button"
                aria-label="Close"
                class="mt-0.5 shrink-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg p-1 transition-colors"
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
                <label
                  class="block text-xs font-medium transition-colors"
                  :class="createFormErrors.has(field.key) ? 'text-red-500 dark:text-red-400' : 'text-slate-400 dark:text-slate-500'"
                >
                  {{ field.label }}
                  <span v-if="field.is_required" class="text-red-400 ml-0.5">*</span>
                </label>
                <CrmFieldInput
                  :data-type="field.data_type"
                  :value="draftValues[field.key] ?? null"
                  :read-only="false"
                  :select-options="field.select_options ?? []"
                  :format="field.format"
                />
                <p v-if="createFormErrors.has(field.key)" class="text-xs text-red-500 dark:text-red-400">
                  This field is required.
                </p>
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
                  @click="saveNewRecord"
                >
                  Save {{ selectedType?.label ?? 'Record' }}
                </button>
                <button
                  type="button"
                  class="rounded-lg py-2 px-3 text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                  @click="closePanel"
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
                <button
                  v-if="navigationStack.length"
                  type="button"
                  class="flex items-center gap-1 mb-2 text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors max-w-full"
                  @click="goBack"
                >
                  <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                  <span class="truncate">{{ navigationStack[navigationStack.length - 1].record.title }}</span>
                </button>
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
                aria-label="Close"
                class="shrink-0 mt-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg p-1 transition-colors"
                @click="closePanel"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <!-- tab bar — hidden while editing -->
            <div v-if="!editingRecord" class="flex border-b border-slate-200 dark:border-slate-700 px-5">
              <button
                v-for="tab in ([
                  { key: 'details', label: 'Details' },
                  { key: 'activity', label: 'Activity', count: recordActivities.length },
                  { key: 'related', label: 'Related', count: openedRecord.links?.length ?? 0 },
                ] as const)"
                :key="tab.key"
                type="button"
                class="flex items-center gap-1 py-2.5 mr-5 text-xs font-medium border-b-2 transition-colors"
                :class="detailTab === tab.key
                  ? 'border-sky-500 text-sky-600 dark:text-sky-400'
                  : 'border-transparent text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'"
                @click="detailTab = tab.key"
              >
                {{ tab.label }}
                <span
                  v-if="tab.count"
                  class="text-xs tabular-nums rounded-full px-1.5 py-0.5 leading-none"
                  :class="detailTab === tab.key
                    ? 'bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500'"
                >{{ tab.count }}</span>
              </button>
            </div>

            <!-- schema-driven fields -->
            <div class="flex-1 px-5 py-4 space-y-4 overflow-y-auto">
              <!-- Details tab -->
              <template v-if="editingRecord || detailTab === 'details'">
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
              </template>

              <!-- Activity tab -->
              <template v-else-if="detailTab === 'activity'">
                <div class="flex items-center justify-between">
                  <p class="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">Activity</p>
                  <button
                    type="button"
                    class="text-xs text-sky-500 hover:text-sky-400 dark:text-sky-400 dark:hover:text-sky-300 transition-colors"
                    title="Log activity (coming soon)"
                  >
                    + Log
                  </button>
                </div>
                <div v-if="recordActivities.length" class="space-y-3">
                  <div v-for="act in recordActivities" :key="act.id" class="flex gap-2.5">
                    <span class="mt-0.5 h-6 w-6 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0 text-slate-500 dark:text-slate-400">
                      <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.75">
                        <path stroke-linecap="round" stroke-linejoin="round" :d="ACTIVITY_ICONS[act.type]" />
                      </svg>
                    </span>
                    <div class="flex-1 min-w-0 pb-3 border-b border-slate-50 dark:border-slate-800/60 last:border-0 last:pb-0">
                      <p class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">{{ act.content }}</p>
                      <p class="text-xs text-slate-400 dark:text-slate-500 mt-1">{{ act.author }} · {{ formatRelativeTime(act.created_at) }}</p>
                    </div>
                  </div>
                </div>
                <p v-else class="text-xs text-slate-400 dark:text-slate-500 italic">No activity logged yet.</p>
              </template>

              <!-- Related tab -->
              <template v-else-if="detailTab === 'related'">
                <p class="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">Related records</p>
                <div v-if="openedRecord.links?.length" class="space-y-1">
                  <button
                    v-for="link in openedRecord.links"
                    :key="link.target_id"
                    type="button"
                    class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 text-left transition-colors"
                    @click="openLinkedRecord(link)"
                  >
                    <span
                      class="h-5 w-5 rounded flex items-center justify-center shrink-0"
                      :style="{ background: (schema.find(rt => rt.key === link.target_type)?.color ?? '#64748b') + '22', color: schema.find(rt => rt.key === link.target_type)?.color ?? '#64748b' }"
                    >
                      <component :is="ICON_COMPONENTS[schema.find(rt => rt.key === link.target_type)?.icon ?? 'user']" class="h-3 w-3" />
                    </span>
                    <div class="flex-1 min-w-0">
                      <p class="text-xs font-medium text-slate-700 dark:text-slate-200 truncate">{{ link.target_title }}</p>
                      <p class="text-xs text-slate-400 dark:text-slate-500 capitalize">{{ link.target_type }}</p>
                    </div>
                    <svg class="h-3.5 w-3.5 text-slate-300 dark:text-slate-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                </div>
                <p v-else class="text-xs text-slate-400 dark:text-slate-500 italic">No related records.</p>
              </template>
            </div>

            <!-- panel footer — view mode -->
            <div v-if="!editingRecord" class="px-5 py-4 border-t border-slate-200 dark:border-slate-700 space-y-2">
              <p class="text-xs text-slate-400 dark:text-slate-500">
                Created {{ formatDate(openedRecord.created_at) }}
                <template v-if="filteredRecords.length > 1 && openedRecordIndex >= 0">
                  · {{ openedRecordIndex + 1 }} of {{ filteredRecords.length }}
                </template>
              </p>
              <div class="flex gap-2">
                <button
                  type="button"
                  class="flex-1 rounded-lg py-2 text-sm font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                  @click="editingRecord = true"
                >
                  Edit
                </button>
                <button
                  type="button"
                  aria-label="Duplicate record"
                  title="Duplicate record"
                  class="rounded-lg py-2 px-3 text-sm font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  @click="duplicateRecord(openedRecord)"
                >
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
                <button type="button" aria-label="Delete record" title="Delete record" class="rounded-lg py-2 px-3 text-sm font-medium text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors">
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

    <!-- keyboard shortcuts overlay — triggered by ? key -->
    <transition
      enter-active-class="transition-all duration-150"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition-all duration-100"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="showShortcuts"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        @click.self="showShortcuts = false"
      >
        <div class="w-80 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">
          <div class="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
            <h3 class="text-sm font-semibold text-slate-900 dark:text-white">Keyboard shortcuts</h3>
            <button
              type="button"
              class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg p-1 transition-colors"
              aria-label="Close"
              @click="showShortcuts = false"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div class="px-5 py-3 space-y-0.5">
            <template v-for="group in [
              { heading: 'Navigation', items: [
                { keys: ['N'], desc: 'New record' },
                { keys: ['↑', '↓'], desc: 'Prev / next record' },
                { keys: ['Esc'], desc: 'Close panel' },
                { keys: ['?'], desc: 'Toggle this overlay' },
              ]},
              { heading: 'Table', items: [
                { keys: ['Dbl-click'], desc: 'Edit cell inline' },
                { keys: ['Enter'], desc: 'Commit cell edit' },
                { keys: ['Esc'], desc: 'Cancel cell edit' },
              ]},
              { heading: 'Forms', items: [
                { keys: ['⌘', 'Enter'], desc: 'Save new record / edits' },
                { keys: ['Esc'], desc: 'Discard / close panel' },
              ]},
            ]" :key="group.heading">
              <p class="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500 pt-3 pb-1 first:pt-0">{{ group.heading }}</p>
              <div v-for="item in group.items" :key="item.desc" class="flex items-center justify-between py-1.5">
                <span class="text-sm text-slate-600 dark:text-slate-300">{{ item.desc }}</span>
                <span class="flex items-center gap-1">
                  <kbd
                    v-for="k in item.keys"
                    :key="k"
                    class="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
                  >{{ k }}</kbd>
                </span>
              </div>
            </template>
          </div>
          <div class="px-5 py-3 border-t border-slate-100 dark:border-slate-800">
            <p class="text-xs text-slate-400 dark:text-slate-500">Press <kbd class="inline-flex items-center rounded px-1 py-0.5 text-xs font-mono bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">?</kbd> to toggle this overlay</p>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, defineComponent, h, onMounted } from 'vue';
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

interface CrmLink {
  target_id: string;
  target_type: string;
  target_title: string;
}

interface CrmRecord {
  id: string;
  record_type_key: string;
  title: string;
  field_values: Record<string, string | number | boolean | null>;
  created_at: string;
  links?: CrmLink[];
}

interface CrmActivity {
  id: string;
  record_id: string;
  type: 'note' | 'email' | 'call' | 'meeting';
  content: string;
  author: string;
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

const ACTIVITY_ICONS: Record<CrmActivity['type'], string> = {
  note:    'M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z',
  email:   'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  call:    'M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z',
  meeting: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
};

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
    field_values: { full_name: 'Jordan Mitchell', email: 'jordan@apexcoaching.com', phone: '+1 555-0142', company: 'Apex Coaching', status: 'Active' },
    links: [{ target_id: 'r5', target_type: 'company', target_title: 'Apex Coaching' }, { target_id: 'r8', target_type: 'deal', target_title: 'Apex Coaching — Q3 Expansion' }] },
  { id: 'r2', record_type_key: 'contact', title: 'Priya Sharma', created_at: '2026-05-28T09:04:00Z',
    field_values: { full_name: 'Priya Sharma', email: 'priya@scalelab.io', phone: '+1 555-0271', company: 'ScaleLab', status: 'Lead' },
    links: [{ target_id: 'r6', target_type: 'company', target_title: 'ScaleLab' }, { target_id: 'r9', target_type: 'deal', target_title: 'ScaleLab Renewal' }] },
  { id: 'r3', record_type_key: 'contact', title: 'Marcus Tran', created_at: '2026-06-01T11:50:00Z',
    field_values: { full_name: 'Marcus Tran', email: 'marcus@growthforge.co', phone: null, company: 'GrowthForge', status: 'Active' },
    links: [{ target_id: 'r7', target_type: 'company', target_title: 'GrowthForge' }, { target_id: 'r13', target_type: 'deal', target_title: 'GrowthForge Pilot' }] },
  { id: 'r4', record_type_key: 'contact', title: 'Sara Okonkwo', created_at: '2026-06-10T16:33:00Z',
    field_values: { full_name: 'Sara Okonkwo', email: 'sara@funnelworks.com', phone: '+1 555-0389', company: 'FunnelWorks', status: 'Churned' },
    links: [{ target_id: 'r17', target_type: 'company', target_title: 'FunnelWorks' }, { target_id: 'r14', target_type: 'deal', target_title: 'FunnelWorks Enterprise' }] },
  // Companies
  { id: 'r5', record_type_key: 'company', title: 'Apex Coaching', created_at: '2026-04-18T08:00:00Z',
    field_values: { name: 'Apex Coaching', domain: 'apexcoaching.com', industry: 'Education', employees: 24, annual_rev: 4200000 },
    links: [{ target_id: 'r1', target_type: 'contact', target_title: 'Jordan Mitchell' }, { target_id: 'r8', target_type: 'deal', target_title: 'Apex Coaching — Q3 Expansion' }] },
  { id: 'r6', record_type_key: 'company', title: 'ScaleLab', created_at: '2026-04-22T10:15:00Z',
    field_values: { name: 'ScaleLab', domain: 'scalelab.io', industry: 'Marketing', employees: 11, annual_rev: 1800000 },
    links: [{ target_id: 'r2', target_type: 'contact', target_title: 'Priya Sharma' }, { target_id: 'r9', target_type: 'deal', target_title: 'ScaleLab Renewal' }] },
  { id: 'r7', record_type_key: 'company', title: 'GrowthForge', created_at: '2026-05-05T14:30:00Z',
    field_values: { name: 'GrowthForge', domain: 'growthforge.co', industry: 'Consulting', employees: 7, annual_rev: 920000 },
    links: [{ target_id: 'r3', target_type: 'contact', target_title: 'Marcus Tran' }, { target_id: 'r13', target_type: 'deal', target_title: 'GrowthForge Pilot' }] },
  // Deals
  { id: 'r8', record_type_key: 'deal', title: 'Apex Coaching — Q3 Expansion', created_at: '2026-06-02T13:00:00Z',
    field_values: { name: 'Apex Coaching — Q3 Expansion', stage: 'Proposal', amount: 48000, close_date: '2026-07-31', probability: 65 },
    links: [{ target_id: 'r1', target_type: 'contact', target_title: 'Jordan Mitchell' }, { target_id: 'r5', target_type: 'company', target_title: 'Apex Coaching' }] },
  { id: 'r9', record_type_key: 'deal', title: 'ScaleLab Renewal', created_at: '2026-06-15T09:45:00Z',
    field_values: { name: 'ScaleLab Renewal', stage: 'Negotiation', amount: 24000, close_date: '2026-07-01', probability: 80 },
    links: [{ target_id: 'r2', target_type: 'contact', target_title: 'Priya Sharma' }, { target_id: 'r6', target_type: 'company', target_title: 'ScaleLab' }] },
  { id: 'r13', record_type_key: 'deal', title: 'GrowthForge Pilot', created_at: '2026-06-10T10:00:00Z',
    field_values: { name: 'GrowthForge Pilot', stage: 'Qualified', amount: 12000, close_date: '2026-08-15', probability: 40 },
    links: [{ target_id: 'r3', target_type: 'contact', target_title: 'Marcus Tran' }, { target_id: 'r7', target_type: 'company', target_title: 'GrowthForge' }] },
  { id: 'r14', record_type_key: 'deal', title: 'FunnelWorks Enterprise', created_at: '2026-06-18T15:00:00Z',
    field_values: { name: 'FunnelWorks Enterprise', stage: 'Lead', amount: 96000, close_date: '2026-09-30', probability: 20 },
    links: [{ target_id: 'r4', target_type: 'contact', target_title: 'Sara Okonkwo' }, { target_id: 'r17', target_type: 'company', target_title: 'FunnelWorks' }] },
  { id: 'r15', record_type_key: 'deal', title: 'TechSprint Coaching', created_at: '2026-06-22T09:00:00Z',
    field_values: { name: 'TechSprint Coaching', stage: 'Closed Won', amount: 18000, close_date: '2026-06-30', probability: 100 } },
  { id: 'r16', record_type_key: 'deal', title: 'MarketMind Advisory', created_at: '2026-06-24T11:00:00Z',
    field_values: { name: 'MarketMind Advisory', stage: 'Proposal', amount: 36000, close_date: '2026-08-01', probability: 55 },
    links: [{ target_id: 'r20', target_type: 'contact', target_title: 'Aisha Patel' }, { target_id: 'r18', target_type: 'company', target_title: 'MarketMind' }] },
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

// ── Mock activity feed ─────────────────────────────────────────────────────

const mockActivities: CrmActivity[] = [
  { id: 'a1',  record_id: 'r1',  type: 'call',    content: 'Discovery call — Jordan confirmed Q3 budget. Warm to expansion.', author: 'JB', created_at: '2026-06-25T14:30:00Z' },
  { id: 'a2',  record_id: 'r1',  type: 'email',   content: 'Sent proposal deck and pricing overview.', author: 'JB', created_at: '2026-06-20T11:00:00Z' },
  { id: 'a3',  record_id: 'r1',  type: 'note',    content: 'Met at MastermindLive event. Strong referral potential.', author: 'JB', created_at: '2026-05-14T09:00:00Z' },
  { id: 'a4',  record_id: 'r2',  type: 'email',   content: 'Intro email sent. Priya responded same day — high intent.', author: 'JB', created_at: '2026-06-22T10:00:00Z' },
  { id: 'a5',  record_id: 'r2',  type: 'meeting', content: 'Demo completed. Requested custom implementation timeline.', author: 'JB', created_at: '2026-06-17T15:00:00Z' },
  { id: 'a14', record_id: 'r3',  type: 'call',    content: 'Intro call — interested in pilot program, forwarded to Deals.', author: 'JB', created_at: '2026-06-05T10:30:00Z' },
  { id: 'a15', record_id: 'r4',  type: 'note',    content: 'Account churned. Cited budget constraints; open to returning Q1 2027.', author: 'JB', created_at: '2026-06-12T11:00:00Z' },
  { id: 'a11', record_id: 'r5',  type: 'note',    content: 'HQ visit confirmed for Q3. Will meet Jordan and 3 dept heads.', author: 'JB', created_at: '2026-06-12T09:00:00Z' },
  { id: 'a6',  record_id: 'r8',  type: 'note',    content: 'Proposal reviewed. Legal sign-off expected by July 15.', author: 'JB', created_at: '2026-06-26T09:30:00Z' },
  { id: 'a7',  record_id: 'r8',  type: 'call',    content: 'Contract review call. Two minor revisions requested.', author: 'JB', created_at: '2026-06-18T14:00:00Z' },
  { id: 'a8',  record_id: 'r8',  type: 'email',   content: 'Sent revised proposal with updated scope and pricing.', author: 'JB', created_at: '2026-06-10T11:00:00Z' },
  { id: 'a9',  record_id: 'r9',  type: 'call',    content: 'Negotiation call. Agreed to waive onboarding fee.', author: 'JB', created_at: '2026-06-24T16:00:00Z' },
  { id: 'a10', record_id: 'r9',  type: 'email',   content: 'Renewal terms sent. 15% YoY increase + new feature tier.', author: 'JB', created_at: '2026-06-15T10:00:00Z' },
  { id: 'a16', record_id: 'r16', type: 'meeting', content: 'Discovery meeting with Aisha. Strong alignment on advisory scope.', author: 'JB', created_at: '2026-06-25T10:00:00Z' },
  { id: 'a12', record_id: 'r10', type: 'note',    content: 'High score on webinar quiz. Followed up via email — no reply yet.', author: 'JB', created_at: '2026-06-21T12:00:00Z' },
  { id: 'a13', record_id: 'r11', type: 'call',    content: 'Converted — signed up for $1 Pool same day as first outreach.', author: 'JB', created_at: '2026-06-22T14:00:00Z' },
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
const rowDensity = ref<'comfortable' | 'compact'>('comfortable');
const creatingRecord = ref(false);
const draftValues = ref<Record<string, string | number | boolean | null>>({});
const createFormErrors = ref<Set<string>>(new Set());
const sortField = ref<string | null>(null);
const sortDir = ref<'asc' | 'desc'>('asc');
const navigationStack = ref<Array<{ record: CrmRecord; typeKey: string }>>([]);
const selectedIds = ref<Set<string>>(new Set());
const hiddenColumnKeys = ref<Set<string>>(new Set());
const showColumnsMenu = ref(false);
const detailTab = ref<'details' | 'activity' | 'related'>('details');
const editingCell = ref<{ recordId: string; fieldKey: string } | null>(null);
const cellDraftValue = ref<string | number | boolean | null>(null);
const showShortcuts = ref(false);
const activeFilters = ref<Array<{ fieldKey: string; value: string }>>([]);

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

const allColumns = computed(() =>
  (selectedType.value?.fields ?? [])
    .slice()
    .sort((a, b) => a.position - b.position),
);

const visibleColumns = computed(() =>
  allColumns.value.filter((c) => !hiddenColumnKeys.value.has(c.key)),
);

const filteredRecords = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const recs = mockRecords.filter((r) => r.record_type_key === selectedTypeKey.value);
  let filtered = q
    ? recs.filter((r) =>
        r.title.toLowerCase().includes(q) ||
        Object.values(r.field_values).some((v) => v != null && String(v).toLowerCase().includes(q))
      )
    : recs;

  if (activeFilters.value.length) {
    filtered = filtered.filter((r) =>
      activeFilters.value.every((f) => String(r.field_values[f.fieldKey] ?? '') === f.value),
    );
  }

  if (!sortField.value) return filtered;

  const key = sortField.value;
  const dir = sortDir.value === 'asc' ? 1 : -1;

  if (key === '__created_at__') {
    return [...filtered].sort((a, b) =>
      (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * dir,
    );
  }

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

// Aggregate total for types with a currency field — shown in toolbar as "6 records · $234k"
const recordsTotal = computed((): string | null => {
  const currencyField = selectedType.value?.fields.find((f) => f.format === 'currency');
  if (!currencyField) return null;
  const total = filteredRecords.value.reduce((sum, r) => {
    const v = r.field_values[currencyField.key];
    return sum + (v != null ? Number(v) : 0);
  }, 0);
  if (total === 0) return null;
  return formatCardValue(total, 'number', 'currency');
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

const openedRecordIndex = computed(() =>
  openedRecord.value
    ? filteredRecords.value.findIndex((r) => r.id === openedRecord.value!.id)
    : -1,
);

const recordActivities = computed(() =>
  openedRecord.value
    ? mockActivities
        .filter((a) => a.record_id === openedRecord.value!.id)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    : [],
);

const allSelected = computed(
  () =>
    filteredRecords.value.length > 0 &&
    filteredRecords.value.every((r) => selectedIds.value.has(r.id)),
);

// ── Actions ────────────────────────────────────────────────────────────────

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function toggleAll() {
  if (allSelected.value) {
    selectedIds.value = new Set();
  } else {
    selectedIds.value = new Set(filteredRecords.value.map((r) => r.id));
  }
}

function clearSelection() {
  selectedIds.value = new Set();
}

function toggleFilter(fieldKey: string, value: string) {
  const idx = activeFilters.value.findIndex((f) => f.fieldKey === fieldKey && f.value === value);
  if (idx >= 0) {
    activeFilters.value = activeFilters.value.filter((_, i) => i !== idx);
  } else {
    activeFilters.value = [...activeFilters.value, { fieldKey, value }];
  }
}

function clearFilters() {
  activeFilters.value = [];
}

function startCellEdit(record: CrmRecord, col: CrmField) {
  if (editingRecord.value || col.is_title || col.data_type === 'boolean') return;
  editingCell.value = { recordId: record.id, fieldKey: col.key };
  cellDraftValue.value = record.field_values[col.key] ?? null;
}

function commitCellEdit() {
  editingCell.value = null;
  cellDraftValue.value = null;
}

function cancelCellEdit() {
  editingCell.value = null;
  cellDraftValue.value = null;
}

function toggleColumnVisibility(key: string) {
  const next = new Set(hiddenColumnKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  hiddenColumnKeys.value = next;
}

function selectType(key: string) {
  selectedTypeKey.value = key;
  searchQuery.value = '';
  openedRecord.value = null;
  editingRecord.value = false;
  creatingRecord.value = false;
  draftValues.value = {};
  sortField.value = null;
  sortDir.value = 'asc';
  navigationStack.value = [];
  selectedIds.value = new Set();
  hiddenColumnKeys.value = new Set();
  showColumnsMenu.value = false;
  activeFilters.value = [];
  createFormErrors.value = new Set();
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

function closePanel() {
  openedRecord.value = null;
  editingRecord.value = false;
  creatingRecord.value = false;
  navigationStack.value = [];
  createFormErrors.value = new Set();
}

function openRecord(record: CrmRecord) {
  navigationStack.value = [];
  openedRecord.value = record;
  editingRecord.value = false;
  creatingRecord.value = false;
  detailTab.value = 'details';
}

function openNewRecord(stageValue?: string) {
  openedRecord.value = null;
  const fieldKey = kanbanField.value?.key;
  draftValues.value = fieldKey && stageValue ? { [fieldKey]: stageValue } : {};
  createFormErrors.value = new Set();
  creatingRecord.value = true;
}

function saveNewRecord() {
  const required = (selectedType.value?.fields ?? []).filter((f) => f.is_required);
  const missing = required
    .filter((f) => {
      const v = draftValues.value[f.key];
      return v == null || String(v).trim() === '';
    })
    .map((f) => f.key);
  if (missing.length) {
    createFormErrors.value = new Set(missing);
    return;
  }
  createFormErrors.value = new Set();
  creatingRecord.value = false;
}

function duplicateRecord(record: CrmRecord) {
  const newRecord: CrmRecord = {
    id: 'dup-' + record.id + '-' + String(mockRecords.length),
    record_type_key: record.record_type_key,
    title: 'Copy of ' + record.title,
    created_at: new Date().toISOString(),
    field_values: { ...record.field_values },
    links: [],
  };
  mockRecords.push(newRecord);
  openRecord(newRecord);
}

function goBack() {
  const prev = navigationStack.value[navigationStack.value.length - 1];
  if (!prev) return;
  navigationStack.value = navigationStack.value.slice(0, -1);
  if (prev.typeKey !== selectedTypeKey.value) {
    selectedTypeKey.value = prev.typeKey;
    searchQuery.value = '';
    sortField.value = null;
    sortDir.value = 'asc';
    viewMode.value = 'table';
  }
  openedRecord.value = prev.record;
  editingRecord.value = false;
  creatingRecord.value = false;
}

function openLinkedRecord(link: CrmLink) {
  const record = mockRecords.find((r) => r.id === link.target_id);
  if (!record) return;
  if (openedRecord.value) {
    navigationStack.value = [...navigationStack.value, { record: openedRecord.value, typeKey: selectedTypeKey.value }];
  }
  if (link.target_type !== selectedTypeKey.value) {
    selectedTypeKey.value = link.target_type;
    searchQuery.value = '';
    sortField.value = null;
    sortDir.value = 'asc';
    viewMode.value = 'table';
  }
  openedRecord.value = record;
  editingRecord.value = false;
  creatingRecord.value = false;
  detailTab.value = 'details';
}

function onKeyEsc() {
  if (showShortcuts.value) { showShortcuts.value = false; return; }
  closePanel();
}

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key !== '?') return;
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  showShortcuts.value = !showShortcuts.value;
}

function onKeyN(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  openNewRecord();
}

function onKeySave() {
  if (creatingRecord.value) { saveNewRecord(); return; }
  if (editingRecord.value) { editingRecord.value = false; }
}

function onKeyArrow(dir: 1 | -1) {
  if (!openedRecord.value || viewMode.value !== 'table') return;
  const tag = document.activeElement?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  const records = filteredRecords.value;
  const idx = records.findIndex((r) => r.id === openedRecord.value?.id);
  const next = records[idx + dir];
  if (next) openRecord(next);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
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

const CrmCellEditor = defineComponent({
  props: {
    value: { type: [String, Number, Boolean, null] as unknown as () => string | number | boolean | null, default: null },
    dataType: { type: String as () => DataType, required: true },
    selectOptions: { type: Array as () => string[], default: () => [] },
  },
  emits: ['commit', 'cancel'],
  setup(props, { emit }) {
    const elRef = ref<HTMLInputElement | HTMLSelectElement | null>(null);
    onMounted(() => (elRef.value as HTMLElement | null)?.focus());
    return () => {
      const cellClass = 'w-full rounded px-1.5 py-0.5 text-sm bg-white dark:bg-slate-950 border border-sky-400 dark:border-sky-500 text-slate-900 dark:text-slate-100 outline-none focus:ring-1 focus:ring-sky-400/40';
      const val = props.value;
      const common = {
        ref: elRef,
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') { e.preventDefault(); emit('commit'); }
          if (e.key === 'Escape') { e.stopPropagation(); emit('cancel'); }
        },
        onBlur: () => emit('commit'),
      };
      if (props.dataType === 'select') {
        return h('select', { ...common, class: cellClass + ' cursor-pointer appearance-none' }, [
          h('option', { value: '' }, '— select —'),
          ...props.selectOptions.map((o: string) => h('option', { value: o, selected: String(val) === o }, o)),
        ]);
      }
      const inputType = props.dataType === 'number' ? 'number'
        : props.dataType === 'date' ? 'date'
        : props.dataType === 'email' ? 'email'
        : props.dataType === 'phone' ? 'tel'
        : props.dataType === 'url' ? 'url'
        : 'text';
      return h('input', { ...common, type: inputType, value: val != null ? String(val) : '', class: cellClass });
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
          if (val == null || val === '') {
            return h('span', { class: 'text-slate-300 dark:text-slate-600 text-sm' }, '—');
          }
          return h('span', {
            class: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' + selectBadgeClass(String(val)),
          }, String(val));
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
      const inputType = props.dataType === 'number' ? 'number'
        : props.dataType === 'date' ? 'date'
        : props.dataType === 'email' ? 'email'
        : props.dataType === 'phone' ? 'tel'
        : props.dataType === 'url' ? 'url'
        : 'text';
      return h('input', {
        type: inputType,
        value: val != null ? String(val) : '',
        readonly: props.readOnly,
        class: baseClass + (props.readOnly ? ' opacity-80 cursor-default' : ''),
      });
    };
  },
});
</script>
