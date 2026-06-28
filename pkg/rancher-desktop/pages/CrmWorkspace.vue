<template>
  <div
    class="text-sm font-sans page-root h-full"
    :class="{ dark: isDark }"
    tabindex="-1"
    @keydown.esc="onKeyEsc"
    @keydown.n.exact="onKeyN"
    @keydown.d.exact="onKeyD"
    @keydown.e.exact="onKeyE"
    @keydown.p.exact="onKeyP"
    @keydown.w.exact="onKeyW"
    @keydown.r.exact="onKeyR"
    @keydown.t.exact="onKeyT"
    @keydown.b.exact="onKeyB"
    @keydown.s.exact="onKeyS"
    @keydown.f.exact="onKeyF"
    @keydown.g.exact="onKeyG"
    @keydown.bracket-left.exact="onKeyBracketLeft"
    @keydown.up.exact.prevent="onKeyArrow(-1)"
    @keydown.down.exact.prevent="onKeyArrow(1)"
    @keydown.meta.enter.exact.prevent="onKeySave"
    @keydown.ctrl.enter.exact.prevent="onKeySave"
    @keydown="onGlobalKeydown"
    @click="showColumnsMenu = false; cancelCellEdit(); closeContextMenu(); bulkStageDropdown = false; showFilterDropdown = false; kanbanCardMenu = null; showSaveViewPopover = false; colHeaderMenu = null"
  >
    <div class="flex flex-col h-full">
      <AgentHeader
        :is-dark="isDark"
        :toggle-theme="toggleTheme"
      />

      <div class="flex flex-1 min-h-0 overflow-hidden">
        <!-- ── Sidebar: record types nav ── -->
        <aside
          class="flex flex-col shrink-0 border-r border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-y-auto transition-all duration-200"
          :class="sidebarCollapsed ? 'w-14' : 'w-56'"
        >
          <div v-if="!sidebarCollapsed" class="px-4 pt-5 pb-3">
            <h2 class="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">
              Record Types
            </h2>
          </div>
          <div v-else class="pt-3 pb-1 flex justify-center">
            <span class="h-5" />
          </div>

          <nav class="flex-1 space-y-0.5" :class="sidebarCollapsed ? 'px-1.5 pb-4' : 'px-2 pb-4'">
            <!-- icon-only mode when collapsed -->
            <template v-if="sidebarCollapsed">
              <button
                v-for="rt in schema"
                :key="rt.id"
                type="button"
                class="w-full flex items-center justify-center h-10 rounded-lg transition-colors"
                :class="selectedTypeKey === rt.key
                  ? 'bg-slate-100 dark:bg-slate-800'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'"
                :title="rt.label_plural"
                @click="selectType(rt.key)"
              >
                <span
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                  :style="{ background: rt.color + '22', color: rt.color }"
                >
                  <component :is="ICON_COMPONENTS[rt.icon]" class="h-4 w-4" />
                </span>
              </button>
            </template>
            <!-- full mode -->
            <template v-else>
              <div
                v-for="rt in schema"
                :key="rt.id"
                class="group/type flex items-center rounded-lg transition-colors"
                :class="selectedTypeKey === rt.key
                  ? 'bg-slate-100 dark:bg-slate-800'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'"
              >
                <button
                  type="button"
                  class="flex-1 flex items-center gap-2.5 px-3 py-2 text-left transition-colors min-w-0"
                  :class="selectedTypeKey === rt.key
                    ? 'text-slate-900 dark:text-white font-semibold'
                    : 'text-slate-600 dark:text-slate-400 group-hover/type:text-slate-900 dark:group-hover/type:text-white'"
                  @click="selectType(rt.key)"
                >
                  <span
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                    :style="{ background: rt.color + '22', color: rt.color }"
                  >
                    <component :is="ICON_COMPONENTS[rt.icon]" class="h-3.5 w-3.5" />
                  </span>
                  <span class="flex-1 truncate text-sm">{{ rt.label_plural }}</span>
                  <span
                    class="shrink-0 h-1.5 w-1.5 rounded-full"
                    :class="(completenessRateByType[rt.key] ?? 0) >= 80 ? 'bg-emerald-400 dark:bg-emerald-500' : (completenessRateByType[rt.key] ?? 0) >= 50 ? 'bg-amber-400 dark:bg-amber-500' : 'bg-rose-400 dark:bg-rose-500'"
                    :title="`${completenessRateByType[rt.key] ?? 0}% of ${rt.label_plural.toLowerCase()} fully complete`"
                  />
                  <span class="text-xs text-slate-400 dark:text-slate-500 tabular-nums group-hover/type:opacity-0 transition-opacity">{{ recordCountByType[rt.key] ?? 0 }}</span>
                </button>
                <!-- quick-create + button, appears on hover -->
                <button
                  type="button"
                  :title="`New ${rt.label}`"
                  class="shrink-0 mr-2 h-5 w-5 rounded flex items-center justify-center opacity-0 group-hover/type:opacity-100 transition-all text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700"
                  @click.stop="selectType(rt.key); openNewRecord()"
                >
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                </button>
              </div>
            </template>
          </nav>

          <!-- saved views (hidden when collapsed) -->
          <div v-if="savedViews.length && !sidebarCollapsed" class="px-2 pb-2 border-t border-slate-200 dark:border-slate-700">
            <p class="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">
              Views
            </p>
            <div
              v-for="sv in savedViews"
              :key="sv.id"
              class="group/sv flex items-center rounded-lg transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60"
            >
              <button
                type="button"
                class="flex-1 flex items-center gap-2 px-3 py-1.5 text-left text-xs min-w-0 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
                @click="applySavedView(sv)"
              >
                <svg class="h-3 w-3 shrink-0 text-violet-400 dark:text-violet-500" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
                <span class="truncate">{{ sv.name }}</span>
                <span class="shrink-0 text-xs text-slate-300 dark:text-slate-700 font-medium capitalize">{{ sv.typeKey }}</span>
              </button>
              <button
                type="button"
                class="shrink-0 mr-2 h-4 w-4 rounded flex items-center justify-center opacity-0 group-hover/sv:opacity-100 transition-all text-slate-400 hover:text-red-400 dark:hover:text-red-400"
                :title="`Delete '${sv.name}'`"
                @click.stop="deleteSavedView(sv.id)"
              >
                <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <!-- recent records (hidden when collapsed) -->
          <div v-if="recentRecords.length && !sidebarCollapsed" class="px-2 pb-2 border-t border-slate-200 dark:border-slate-700">
            <p class="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">
              Recent
            </p>
            <button
              v-for="rec in recentRecords"
              :key="rec.id"
              type="button"
              class="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-left transition-colors text-xs"
              :class="openedRecord?.id === rec.id
                ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white'
                : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-white'"
              @click="openFromPalette(rec)"
            >
              <span
                class="shrink-0 h-5 w-5 rounded-full flex items-center justify-center text-[9px] font-bold select-none"
                :style="{ background: (schema.find(rt => rt.key === rec.record_type_key)?.color ?? '#3b82f6') + '22', color: schema.find(rt => rt.key === rec.record_type_key)?.color ?? '#3b82f6' }"
              >{{ recordInitials(rec.title) }}</span>
              <span class="flex-1 truncate">{{ rec.title }}</span>
            </button>
          </div>

          <!-- watching section (hidden when collapsed) -->
          <div v-if="watchedRecords.length && !sidebarCollapsed" class="px-2 pb-2 border-t border-slate-200 dark:border-slate-700">
            <p class="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">
              Watching
            </p>
            <button
              v-for="rec in watchedRecords"
              :key="rec.id"
              type="button"
              class="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-left transition-colors text-xs"
              :class="openedRecord?.id === rec.id
                ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white'
                : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-white'"
              @click="openFromPalette(rec)"
            >
              <span
                class="shrink-0 h-5 w-5 rounded-full flex items-center justify-center text-[9px] font-bold select-none"
                :style="{ background: (schema.find(rt => rt.key === rec.record_type_key)?.color ?? '#3b82f6') + '22', color: schema.find(rt => rt.key === rec.record_type_key)?.color ?? '#3b82f6' }"
              >{{ recordInitials(rec.title) }}</span>
              <span class="flex-1 truncate">{{ rec.title }}</span>
              <!-- eye icon indicates watched state -->
              <svg class="shrink-0 h-3 w-3 text-sky-400 dark:text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </button>
          </div>

          <div class="px-2 py-3 border-t border-slate-200 dark:border-slate-700 flex flex-col gap-1">
            <button
              v-if="!sidebarCollapsed"
              type="button"
              class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-700 dark:hover:text-slate-200 transition-colors text-sm"
              title="Add a new record type"
            >
              <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New type
            </button>
            <!-- collapse toggle -->
            <button
              type="button"
              class="flex items-center justify-center rounded-lg p-2 text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
              :title="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
              @click="sidebarCollapsed = !sidebarCollapsed"
            >
              <svg class="h-4 w-4 transition-transform" :class="sidebarCollapsed ? 'rotate-180' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              </svg>
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
              :title="`Log a note for ${selectedIds.size} record${selectedIds.size === 1 ? '' : 's'}`"
              @click="showBulkNoteModal = true"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Log note
            </button>
            <button
              type="button"
              class="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm border transition-colors"
              :class="[...selectedIds].every(id => pinnedIds.has(id))
                ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800'"
              :title="[...selectedIds].every(id => pinnedIds.has(id)) ? `Unpin ${selectedIds.size} record${selectedIds.size === 1 ? '' : 's'}` : `Pin ${selectedIds.size} record${selectedIds.size === 1 ? '' : 's'}`"
              @click="bulkPinToggle"
            >
              <svg
                class="h-4 w-4"
                :fill="[...selectedIds].every(id => pinnedIds.has(id)) ? 'currentColor' : 'none'"
                stroke="currentColor"
                viewBox="0 0 24 24"
                stroke-width="1.8"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              {{ [...selectedIds].every(id => pinnedIds.has(id)) ? 'Unpin' : 'Pin' }}
            </button>
            <button
              type="button"
              class="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm border transition-colors"
              :class="[...selectedIds].every(id => watchedIds.has(id))
                ? 'border-sky-300 dark:border-sky-700 bg-sky-50 dark:bg-sky-950/30 text-sky-600 dark:text-sky-400 hover:bg-sky-100 dark:hover:bg-sky-900/40'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800'"
              :title="[...selectedIds].every(id => watchedIds.has(id)) ? `Unwatch ${selectedIds.size} record${selectedIds.size === 1 ? '' : 's'}` : `Watch ${selectedIds.size} record${selectedIds.size === 1 ? '' : 's'}`"
              @click="bulkWatchToggle"
            >
              <svg
                class="h-4 w-4"
                :fill="[...selectedIds].every(id => watchedIds.has(id)) ? 'currentColor' : 'none'"
                stroke="currentColor"
                viewBox="0 0 24 24"
                stroke-width="2"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              {{ [...selectedIds].every(id => watchedIds.has(id)) ? 'Unwatch' : 'Watch' }}
            </button>
            <!-- bulk move to stage — visible when type has a select/stage field -->
            <div v-if="kanbanField" class="relative" @click.stop>
              <button
                type="button"
                class="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800 transition-colors"
                :title="`Move ${selectedIds.size} selected record${selectedIds.size === 1 ? '' : 's'} to a stage`"
                @click="bulkStageDropdown = !bulkStageDropdown"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                Move to stage
                <svg class="h-3 w-3 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              <div
                v-if="bulkStageDropdown"
                class="absolute top-full mt-1 left-0 z-30 min-w-max rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl py-1"
              >
                <button
                  v-for="stage in kanbanColumns.filter(c => c !== KANBAN_UNASSIGNED)"
                  :key="stage"
                  type="button"
                  class="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                  @click="bulkMoveToStage(stage)"
                >
                  <span class="h-2 w-2 rounded-full shrink-0" :class="stageDot(stage)" />
                  {{ stage }}
                </button>
              </div>
            </div>

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
              :title="`Export ${selectedIds.size} selected record${selectedIds.size === 1 ? '' : 's'} as CSV`"
              @click="exportCsv(filteredRecords.filter(r => selectedIds.has(r.id)))"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export
            </button>
            <button
              type="button"
              class="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm border border-red-200 dark:border-red-900 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
              :title="`Delete ${selectedIds.size} selected record${selectedIds.size === 1 ? '' : 's'}`"
              @click="bulkDelete"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Delete
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
                <template v-if="pinnedInView > 0">
                  <span class="mx-1 opacity-40">·</span>
                  <span class="text-amber-500 dark:text-amber-400">{{ pinnedInView }} pinned</span>
                </template>
                <template v-if="watchedInView > 0">
                  <span class="mx-1 opacity-40">·</span>
                  <span class="text-sky-500 dark:text-sky-400">{{ watchedInView }} watching</span>
                </template>
                <template v-if="recordsTotal">
                  <span class="mx-1 opacity-40">·</span>{{ recordsTotal }}
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
                ref="searchInputEl"
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

            <!-- filter button + dropdown -->
            <div class="relative">
              <button
                type="button"
                class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border transition-colors"
                :class="activeFilters.length || showFilterDropdown
                  ? 'border-sky-300 dark:border-sky-700 bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400 hover:bg-sky-100 dark:hover:bg-sky-900/40'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200'"
                title="Filter records"
                @click.stop="showFilterDropdown = !showFilterDropdown; filterPickerField = null"
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
              <!-- filter picker dropdown -->
              <transition
                enter-active-class="transition-all duration-150"
                enter-from-class="opacity-0 scale-95 -translate-y-1"
                enter-to-class="opacity-100 scale-100 translate-y-0"
                leave-active-class="transition-all duration-100"
                leave-from-class="opacity-100 scale-100 translate-y-0"
                leave-to-class="opacity-0 scale-95 -translate-y-1"
              >
                <div
                  v-if="showFilterDropdown"
                  class="absolute top-full left-0 mt-1 z-40 w-52 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-lg overflow-hidden"
                  @click.stop
                >
                  <template v-if="!filterPickerField">
                    <p class="px-3 pt-2.5 pb-1 text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Filter by</p>
                    <button
                      v-for="col in allColumns.filter(c => c.data_type === 'select' && (c.select_options?.length ?? 0) > 0)"
                      :key="col.key"
                      type="button"
                      class="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                      @click="filterPickerField = col.key"
                    >
                      <svg class="h-3.5 w-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M3 4h18M7 9h10M11 14h2" />
                      </svg>
                      {{ col.label }}
                    </button>
                    <div v-if="activeFilters.length" class="border-t border-slate-100 dark:border-slate-800 mt-1">
                      <button
                        type="button"
                        class="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors"
                        @click="clearFilters(); showFilterDropdown = false"
                      >
                        <svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        Clear all filters
                      </button>
                    </div>
                  </template>
                  <template v-else>
                    <div class="flex items-center gap-1 px-3 pt-2.5 pb-1">
                      <button
                        type="button"
                        class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
                        @click="filterPickerField = null"
                      >
                        <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
                        </svg>
                      </button>
                      <p class="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                        {{ allColumns.find(c => c.key === filterPickerField)?.label }}
                      </p>
                    </div>
                    <button
                      v-for="opt in allColumns.find(c => c.key === filterPickerField)?.select_options ?? []"
                      :key="opt"
                      type="button"
                      class="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors"
                      :class="activeFilters.some(f => f.fieldKey === filterPickerField && f.value === opt)
                        ? 'text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/30'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'"
                      @click="toggleFilter(filterPickerField, opt); showFilterDropdown = false"
                    >
                      <span
                        class="h-2 w-2 rounded-full shrink-0"
                        :class="stageDot(opt)"
                      />
                      {{ opt }}
                    </button>
                  </template>
                </div>
              </transition>
            </div>

            <!-- active sort chip -->
            <div
              v-if="sortField && viewMode === 'table'"
              class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium bg-violet-50 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400 border border-violet-200 dark:border-violet-800"
            >
              <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path v-if="sortDir === 'asc'" stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
                <path v-else stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
              <span>{{ activeSortLabel }}</span>
              <button
                type="button"
                class="ml-0.5 rounded-full hover:bg-violet-200 dark:hover:bg-violet-800 p-0.5 transition-colors"
                aria-label="Clear sort"
                title="Clear sort"
                @click.stop="sortField = null; sortDir = 'asc'"
              >
                <svg class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <!-- pinned filter chip -->
            <div
              v-if="pinnedCountForType > 0"
              class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium cursor-pointer select-none transition-colors"
              :class="showPinnedOnly
                ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 border border-amber-300 dark:border-amber-700'
                : 'bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-amber-300 dark:hover:border-amber-700 hover:text-amber-500 dark:hover:text-amber-400'"
              :title="showPinnedOnly ? 'Show all records' : `Show ${pinnedCountForType} pinned record${pinnedCountForType === 1 ? '' : 's'} only`"
              @click="showPinnedOnly = !showPinnedOnly"
            >
              <svg class="h-3 w-3 shrink-0" :fill="showPinnedOnly ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              <span>{{ showPinnedOnly ? 'Pinned only' : `${pinnedCountForType} pinned` }}</span>
              <button
                v-if="showPinnedOnly"
                type="button"
                class="ml-0.5 rounded-full hover:bg-amber-200 dark:hover:bg-amber-800 p-0.5 transition-colors"
                aria-label="Show all records"
                title="Show all records"
                @click.stop="showPinnedOnly = false"
              >
                <svg class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <!-- watching filter chip -->
            <div
              v-if="watchedCountForType > 0"
              class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium cursor-pointer select-none transition-colors"
              :class="showWatchedOnly
                ? 'bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400 border border-sky-300 dark:border-sky-700'
                : 'bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-sky-300 dark:hover:border-sky-700 hover:text-sky-500 dark:hover:text-sky-400'"
              :title="showWatchedOnly ? 'Show all records' : `Show ${watchedCountForType} watched record${watchedCountForType === 1 ? '' : 's'} only`"
              @click="showWatchedOnly = !showWatchedOnly"
            >
              <svg class="h-3 w-3 shrink-0" :fill="showWatchedOnly ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              <span>{{ showWatchedOnly ? 'Watching only' : `${watchedCountForType} watching` }}</span>
              <button
                v-if="showWatchedOnly"
                type="button"
                class="ml-0.5 rounded-full hover:bg-sky-200 dark:hover:bg-sky-800 p-0.5 transition-colors"
                aria-label="Show all records"
                title="Show all records"
                @click.stop="showWatchedOnly = false"
              >
                <svg class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <!-- incomplete filter chip -->
            <div
              v-if="incompleteCountForType > 0"
              class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium cursor-pointer select-none transition-colors"
              :class="showIncompleteOnly
                ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border border-rose-300 dark:border-rose-700'
                : 'bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-rose-300 dark:hover:border-rose-700 hover:text-rose-500 dark:hover:text-rose-400'"
              :title="showIncompleteOnly ? 'Show all records' : `Show ${incompleteCountForType} incomplete record${incompleteCountForType === 1 ? '' : 's'} only`"
              @click="showIncompleteOnly = !showIncompleteOnly"
            >
              <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <circle cx="12" cy="12" r="10" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4M12 16h.01" />
              </svg>
              <span>{{ showIncompleteOnly ? 'Incomplete only' : `${incompleteCountForType} incomplete` }}</span>
              <button
                v-if="showIncompleteOnly"
                type="button"
                class="ml-0.5 rounded-full hover:bg-rose-200 dark:hover:bg-rose-800 p-0.5 transition-colors"
                aria-label="Show all records"
                title="Show all records"
                @click.stop="showIncompleteOnly = false"
              >
                <svg class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <!-- stage distribution mini bar -->
            <div
              v-if="stageDistribution.length && viewMode === 'table'"
              class="flex items-center gap-1"
              title="Stage distribution — click to filter"
            >
              <div class="flex h-1.5 rounded-full overflow-hidden gap-px" style="width: 72px">
                <button
                  v-for="seg in stageDistribution"
                  :key="seg.label"
                  type="button"
                  class="h-full rounded-full transition-opacity hover:opacity-80"
                  :class="[stageSegmentBg(seg.label), activeFilters.some(f => f.value === seg.label) ? 'ring-1 ring-offset-1 ring-current' : '']"
                  :style="{ width: `${seg.pct}%` }"
                  :title="`${seg.label}: ${seg.count} (${seg.pct}%) — click to filter`"
                  @click="toggleFilter(kanbanField?.key ?? '', seg.label)"
                />
              </div>
            </div>

            <!-- export button -->
            <button
              type="button"
              class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
              :title="`Export ${filteredRecords.length} record${filteredRecords.length === 1 ? '' : 's'} as CSV`"
              @click="exportCsv"
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

            <!-- save view popover -->
            <div class="relative" @click.stop>
              <button
                type="button"
                class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border transition-colors"
                :class="showSaveViewPopover
                  ? 'border-violet-300 dark:border-violet-700 bg-violet-50 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400'
                  : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200'"
                title="Save this view"
                @click="showSaveViewPopover = !showSaveViewPopover"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
              </button>
              <transition
                enter-active-class="transition-all duration-150"
                enter-from-class="opacity-0 scale-95 -translate-y-1"
                enter-to-class="opacity-100 scale-100 translate-y-0"
                leave-active-class="transition-all duration-100"
                leave-from-class="opacity-100 scale-100 translate-y-0"
                leave-to-class="opacity-0 scale-95 -translate-y-1"
              >
                <div
                  v-if="showSaveViewPopover"
                  class="absolute top-full right-0 mt-1 z-40 w-64 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-lg p-3 space-y-2"
                >
                  <p class="text-xs font-semibold text-slate-500 dark:text-slate-400">Save current view</p>
                  <input
                    ref="saveViewInputEl"
                    v-model="saveViewName"
                    type="text"
                    placeholder="View name…"
                    class="h-8 w-full rounded-lg px-3 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-400/40"
                    @keydown.enter.prevent="saveCurrentView"
                    @keydown.esc.stop="showSaveViewPopover = false"
                  />
                  <div class="text-xs text-slate-400 dark:text-slate-500 leading-relaxed">
                    Saves: type, filters, sort{{ activeFilters.length ? ` (${activeFilters.length} filter${activeFilters.length === 1 ? '' : 's'})` : '' }}{{ sortField ? `, sorted by ${activeSortLabel}` : '' }}, view mode
                  </div>
                  <div class="flex gap-2">
                    <button
                      type="button"
                      class="flex-1 h-8 rounded-lg text-sm font-medium text-white bg-violet-600 hover:bg-violet-500 transition-colors disabled:opacity-40"
                      :disabled="!saveViewName.trim()"
                      @click="saveCurrentView"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      class="h-8 px-3 rounded-lg text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                      @click="showSaveViewPopover = false"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </transition>
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
                    @contextmenu.prevent="openColHeaderMenu(col.key, $event)"
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
                    <div class="flex items-center gap-2">
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
                      <button
                        type="button"
                        class="flex items-center gap-1 text-left text-xs font-semibold uppercase tracking-wide transition-colors select-none"
                        :class="sortField === '__updated_at__'
                          ? 'text-sky-600 dark:text-sky-400'
                          : 'text-slate-300 dark:text-slate-700 hover:text-slate-500 dark:hover:text-slate-400'"
                        title="Sort by last updated"
                        @click="toggleSort('__updated_at__')"
                      >
                        / Upd
                        <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                          <path v-if="sortField === '__updated_at__' && sortDir === 'asc'" stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
                          <path v-else-if="sortField === '__updated_at__' && sortDir === 'desc'" stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                          <path v-else stroke-linecap="round" stroke-linejoin="round" class="opacity-30" d="M8 9l4-4 4 4M8 15l4 4 4-4" />
                        </svg>
                      </button>
                    </div>
                  </th>
                  <th class="w-10 px-4 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800" />
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                <template v-for="(record, idx) in filteredRecords" :key="record.id">
                <tr
                  class="group cursor-pointer transition-colors"
                  :class="openedRecord?.id === record.id
                    ? 'bg-sky-50 dark:bg-sky-950/20'
                    : 'hover:bg-white dark:hover:bg-slate-900'"
                  @click="openRecord(record)"
                  @contextmenu.prevent="openContextMenu(record, $event)"
                >
                  <!-- row checkbox -->
                  <td class="pl-6 pr-2" :class="rowDensity === 'compact' ? 'py-1.5' : 'py-3'" @click.stop>
                    <input
                      type="checkbox"
                      :checked="selectedIds.has(record.id)"
                      class="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-sky-600 cursor-pointer"
                      @click="onCheckboxClick(record, idx, $event)"
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
                    <div
                      v-if="col.is_title"
                      class="flex items-center gap-1.5"
                      @mouseenter="showPreview($event, record)"
                      @mousemove="updatePreviewPos"
                      @mouseleave="hidePreview"
                    >
                      <span v-if="searchQuery.trim()" class="truncate max-w-[180px]">
                        <template v-for="(part, i) in highlightText(String(record.field_values[col.key] ?? ''), searchQuery.trim())" :key="i">
                          <mark
                            v-if="part.match"
                            class="bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-100 rounded-sm not-italic"
                          >{{ part.text }}</mark>
                          <span v-else>{{ part.text }}</span>
                        </template>
                      </span>
                      <CrmCellValue v-else :value="record.field_values[col.key]" :data-type="col.data_type" :format="col.format" />
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
                        <!-- highlight matching text in text-like cells when search is active -->
                        <span
                          v-if="searchQuery.trim() && ['text', 'email', 'phone', 'url'].includes(col.data_type) && record.field_values[col.key]"
                          class="truncate"
                        >
                          <template v-for="(part, j) in highlightText(String(record.field_values[col.key] ?? ''), searchQuery.trim())" :key="j">
                            <mark v-if="part.match" class="bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-100 rounded-sm not-italic">{{ part.text }}</mark>
                            <span v-else>{{ part.text }}</span>
                          </template>
                        </span>
                        <CrmCellValue v-else :value="record.field_values[col.key]" :data-type="col.data_type" :format="col.format" />
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
                  <td
                    class="px-4 text-xs tabular-nums whitespace-nowrap"
                    :class="[
                      rowDensity === 'compact' ? 'py-1.5' : 'py-3',
                      (Date.now() - new Date(record.created_at).getTime()) > 30 * 24 * 60 * 60 * 1000
                        ? 'text-rose-300 dark:text-rose-800'
                        : 'text-slate-400 dark:text-slate-500',
                    ]"
                    :title="record.updated_at ? `Added ${formatDate(record.created_at)} · Updated ${formatDate(record.updated_at)}` : formatDate(record.created_at)"
                  >
                    <div>{{ formatAge(record.updated_at ?? record.created_at) }}</div>
                    <div v-if="record.updated_at" class="text-[10px] text-slate-300 dark:text-slate-700 leading-none mt-0.5">upd</div>
                  </td>
                  <td class="w-20 px-3" :class="rowDensity === 'compact' ? 'py-1.5' : 'py-3'">
                    <div class="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        class="rounded p-0.5 transition-colors"
                        :class="pinnedIds.has(record.id)
                          ? 'text-amber-400 hover:text-amber-500'
                          : 'invisible group-hover:visible text-slate-300 dark:text-slate-600 hover:text-amber-400 dark:hover:text-amber-400'"
                        :title="pinnedIds.has(record.id) ? 'Unpin record' : 'Pin record'"
                        :aria-label="pinnedIds.has(record.id) ? 'Unpin record' : 'Pin record'"
                        @click.stop="togglePin(record.id)"
                      >
                        <svg v-if="pinnedIds.has(record.id)" class="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                        </svg>
                        <svg v-else class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        class="rounded p-0.5 transition-colors"
                        :class="watchedIds.has(record.id)
                          ? 'text-sky-400 hover:text-sky-500'
                          : 'invisible group-hover:visible text-slate-300 dark:text-slate-600 hover:text-sky-400 dark:hover:text-sky-400'"
                        :title="watchedIds.has(record.id) ? 'Unwatch record' : 'Watch record'"
                        :aria-label="watchedIds.has(record.id) ? 'Unwatch record' : 'Watch record'"
                        @click.stop="toggleWatch(record.id)"
                      >
                        <svg class="h-3.5 w-3.5" :fill="watchedIds.has(record.id) ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        class="invisible group-hover:visible text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded p-0.5 transition-colors"
                        aria-label="Open record"
                        @click.stop="openRecord(record)"
                      >
                        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
                <!-- pinned/unpinned separator — shows after the last pinned record -->
                <tr
                  v-if="!showPinnedOnly && pinnedIds.has(record.id) && idx < filteredRecords.length - 1 && !pinnedIds.has(filteredRecords[idx + 1]?.id ?? '')"
                >
                  <td :colspan="visibleColumns.length + 3" class="p-0">
                    <div class="h-px bg-amber-200 dark:bg-amber-800/40 mx-4" />
                  </td>
                </tr>
                </template>

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
                <!-- inline quick-add row -->
                <tr
                  v-if="!creatingRecord"
                  class="group/addrow"
                >
                  <td :colspan="visibleColumns.length + 3" class="px-6 py-1.5">
                    <button
                      type="button"
                      class="flex items-center gap-1.5 text-xs text-slate-300 dark:text-slate-700 hover:text-sky-500 dark:hover:text-sky-400 transition-colors py-1"
                      @click="openNewRecord()"
                    >
                      <svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
                      </svg>
                      Add {{ selectedType?.label ?? 'record' }}
                    </button>
                  </td>
                </tr>
              </tbody>
              <!-- column totals footer — only when at least one numeric column exists -->
              <tfoot v-if="hasTableTotals && filteredRecords.length > 1">
                <tr class="bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800">
                  <td class="pl-6 pr-2 py-2" />
                  <td
                    v-for="col in visibleColumns"
                    :key="col.key"
                    class="px-4 py-2 text-xs font-medium"
                    :class="tableColumnTotals[col.key] !== null ? 'text-slate-700 dark:text-slate-300 tabular-nums' : 'text-transparent'"
                  >
                    <span v-if="tableColumnTotals[col.key] !== null" :title="`Total: ${tableColumnTotals[col.key]}`">
                      {{ formatCardValue(tableColumnTotals[col.key], 'number', col.format) }}
                    </span>
                  </td>
                  <!-- Added column -->
                  <td class="px-4 py-2" />
                  <!-- action column -->
                  <td class="w-10 px-4 py-2" />
                </tr>
              </tfoot>
            </table>
          </div>

          <!-- ── Kanban view ── -->
          <div v-else class="flex-1 overflow-x-auto overflow-y-hidden">
            <div class="flex gap-3 h-full p-5 min-w-max">
              <div
                v-for="col in kanbanColumns"
                :key="col"
                class="flex shrink-0 transition-all duration-200"
                :class="collapsedColumns.has(col) ? 'flex-col w-9' : 'flex-col w-64'"
              >
                <!-- column header — sky accent when the open record lives in this column -->
                <div
                  class="flex items-center gap-2 px-2 py-1 mb-3 rounded-lg transition-colors cursor-pointer select-none"
                  :class="[
                    collapsedColumns.has(col) ? 'flex-col gap-1 h-auto px-1' : '',
                    openedRecord && kanbanField && String(openedRecord.field_values[kanbanField.key] ?? (col === KANBAN_UNASSIGNED ? col : '')) === col
                      ? 'bg-sky-50 dark:bg-sky-950/20 ring-1 ring-sky-200 dark:ring-sky-800/60'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
                  ]"
                  :title="collapsedColumns.has(col) ? `Expand ${col === KANBAN_UNASSIGNED ? 'Unassigned' : col}` : `Collapse ${col === KANBAN_UNASSIGNED ? 'Unassigned' : col}`"
                  @click="toggleColumnCollapse(col)"
                >
                  <span
                    class="h-2 w-2 rounded-full shrink-0"
                    :class="col === KANBAN_UNASSIGNED ? 'bg-slate-300 dark:bg-slate-600' : stageDot(col)"
                  />
                  <span
                    v-if="!collapsedColumns.has(col)"
                    class="text-xs font-semibold truncate"
                    :class="col === KANBAN_UNASSIGNED ? 'text-slate-400 dark:text-slate-500 italic' : 'text-slate-700 dark:text-slate-300'"
                  >
                    {{ col === KANBAN_UNASSIGNED ? 'Unassigned' : col }}
                  </span>
                  <span
                    v-if="!collapsedColumns.has(col)"
                    class="ml-auto text-xs tabular-nums text-slate-400 dark:text-slate-500 font-medium shrink-0"
                  >
                    <template v-if="(searchQuery || activeFilters.length) && (kanbanGroups[col] ?? []).length !== (kanbanGroupsTotal[col] ?? 0)">
                      <span class="text-sky-500 dark:text-sky-400">{{ (kanbanGroups[col] ?? []).length }}</span> of {{ kanbanGroupsTotal[col] ?? 0 }}
                    </template>
                    <template v-else>{{ (kanbanGroups[col] ?? []).length }}</template>
                    <template v-if="kanbanColumnTotals[col]"> · {{ kanbanColumnTotals[col] }}</template>
                  </span>
                  <span
                    v-else
                    class="text-xs tabular-nums font-semibold text-slate-500 dark:text-slate-400"
                  >{{ (kanbanGroups[col] ?? []).length }}</span>
                </div>

                <!-- cards -->
                <div v-if="!collapsedColumns.has(col)" class="flex-1 space-y-2 overflow-y-auto pb-2 pr-0.5">
                  <button
                    v-for="record in (kanbanGroups[col] ?? [])"
                    :key="record.id"
                    type="button"
                    class="group/card w-full text-left rounded-xl border p-3.5 shadow-sm transition-all"
                    :class="openedRecord?.id === record.id
                      ? 'bg-sky-50 dark:bg-sky-950/30 border-sky-200 dark:border-sky-800 shadow-md'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700'"
                    @click="openRecord(record)"
                  >
                    <p class="text-sm font-medium text-slate-900 dark:text-white leading-snug mb-2 line-clamp-2 flex items-start gap-1.5">
                      <span class="flex-1">
                        <template v-if="searchQuery.trim()">
                          <template v-for="(part, pi) in highlightText(record.title, searchQuery.trim())" :key="pi">
                            <mark v-if="part.match" class="bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-100 rounded-sm not-italic">{{ part.text }}</mark>
                            <span v-else>{{ part.text }}</span>
                          </template>
                        </template>
                        <template v-else>{{ record.title }}</template>
                      </span>
                      <button
                        type="button"
                        class="shrink-0 mt-0.5 rounded transition-colors"
                        :class="pinnedIds.has(record.id)
                          ? 'text-amber-400 hover:text-amber-500'
                          : 'text-slate-200 dark:text-slate-700 hover:text-amber-400 dark:hover:text-amber-400'"
                        :title="pinnedIds.has(record.id) ? 'Unpin' : 'Pin'"
                        :aria-label="pinnedIds.has(record.id) ? 'Unpin record' : 'Pin record'"
                        @click.stop="togglePin(record.id)"
                      >
                        <svg v-if="pinnedIds.has(record.id)" class="h-3 w-3" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                        </svg>
                        <svg v-else class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                        </svg>
                      </button>
                      <span
                        v-if="record.links?.length"
                        class="shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-xs tabular-nums bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500"
                      >{{ record.links.length }}</span>
                      <button
                        type="button"
                        class="shrink-0 mt-0.5 rounded p-0.5 text-slate-300 dark:text-slate-700 hover:text-slate-500 dark:hover:text-slate-400 transition-colors opacity-0 group-hover/card:opacity-100"
                        title="More actions"
                        aria-label="More actions"
                        @click.stop="kanbanCardMenu = kanbanCardMenu?.recordId === record.id ? null : { recordId: record.id, x: $event.clientX, y: $event.clientY }"
                      >
                        <svg class="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                          <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
                        </svg>
                      </button>
                    </p>
                    <div class="space-y-1">
                      <div
                        v-for="f in kanbanCardFields"
                        :key="f.key"
                        class="flex items-center gap-1.5 text-xs"
                      >
                        <span class="text-slate-400 dark:text-slate-500 shrink-0">{{ f.label }}:</span>
                        <span
                          v-if="f.data_type === 'select' && record.field_values[f.key]"
                          class="inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium shrink-0"
                          :class="selectBadgeClass(String(record.field_values[f.key]))"
                        >{{ record.field_values[f.key] }}</span>
                        <span v-else class="truncate text-slate-600 dark:text-slate-300">{{ formatCardValue(record.field_values[f.key], f.data_type, f.format) }}</span>
                      </div>
                    </div>
                    <!-- card hover actions: stage move + pin + watch -->
                    <div class="flex items-center justify-between mt-2 opacity-0 group-hover/card:opacity-100 transition-opacity">
                      <!-- prev stage -->
                      <button
                        v-if="kanbanField && kanbanColumns.filter(c => c !== KANBAN_UNASSIGNED).indexOf(String(record.field_values[kanbanField.key] ?? '')) > 0"
                        type="button"
                        class="flex items-center gap-0.5 text-xs text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded px-1 py-0.5 transition-colors"
                        title="Move to previous stage"
                        @click.stop="moveCardStage(record, -1)"
                      >
                        <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
                        </svg>
                        Prev
                      </button>
                      <span v-else class="w-10" />
                      <!-- pin + watch quick actions -->
                      <div class="flex items-center gap-0.5">
                        <button
                          type="button"
                          class="rounded p-1 transition-colors"
                          :class="pinnedIds.has(record.id)
                            ? 'text-amber-500 hover:text-amber-400'
                            : 'text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400'"
                          :title="pinnedIds.has(record.id) ? 'Unpin' : 'Pin'"
                          @click.stop="togglePin(record.id)"
                        >
                          <svg class="h-3 w-3" :fill="pinnedIds.has(record.id) ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          class="rounded p-1 transition-colors"
                          :class="watchedIds.has(record.id)
                            ? 'text-sky-500 hover:text-sky-400'
                            : 'text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400'"
                          :title="watchedIds.has(record.id) ? 'Unwatch' : 'Watch'"
                          @click.stop="toggleWatch(record.id)"
                        >
                          <svg class="h-3 w-3" :fill="watchedIds.has(record.id) ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                        </button>
                      </div>
                      <!-- next stage -->
                      <button
                        v-if="kanbanField && kanbanColumns.filter(c => c !== KANBAN_UNASSIGNED).indexOf(String(record.field_values[kanbanField.key] ?? '')) < kanbanColumns.filter(c => c !== KANBAN_UNASSIGNED).length - 1 && kanbanColumns.filter(c => c !== KANBAN_UNASSIGNED).indexOf(String(record.field_values[kanbanField.key] ?? '')) >= 0"
                        type="button"
                        class="flex items-center gap-0.5 text-xs text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded px-1 py-0.5 transition-colors"
                        title="Move to next stage"
                        @click.stop="moveCardStage(record, 1)"
                      >
                        Next
                        <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
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
                    @click="openNewRecord(col === KANBAN_UNASSIGNED ? undefined : col)"
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
              <!-- Autofocused title input — always rendered at top, excluded from field loop below -->
              <div
                v-if="selectedType?.fields.find(f => f.is_title)"
                class="pb-1 border-b border-slate-100 dark:border-slate-800"
              >
                <input
                  ref="newRecordTitleInputEl"
                  type="text"
                  :value="draftValues[selectedType?.fields.find(f => f.is_title)?.key ?? ''] ?? ''"
                  :placeholder="`${selectedType?.label ?? 'Record'} name`"
                  class="w-full text-base font-semibold text-slate-900 dark:text-white bg-transparent outline-none placeholder:text-slate-300 dark:placeholder:text-slate-600"
                  @input="draftValues[selectedType?.fields.find(f => f.is_title)?.key ?? ''] = ($event.target as HTMLInputElement).value; createFormErrors.delete(selectedType?.fields.find(f => f.is_title)?.key ?? '')"
                  @keydown.enter.prevent="saveNewRecord"
                />
                <p
                  v-if="createFormErrors.has(selectedType?.fields.find(f => f.is_title)?.key ?? '')"
                  class="text-xs text-red-500 dark:text-red-400 mt-1"
                >
                  This field is required.
                </p>
              </div>

              <div
                v-for="field in (selectedType?.fields ?? []).filter(f => !f.is_title).slice().sort((a, b) => a.position - b.position)"
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
                  @update:value="draftValues[field.key] = $event; createFormErrors.delete(field.key)"
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
            <div class="flex items-start gap-3 px-5 py-4 border-b border-slate-200 dark:border-slate-700">
              <!-- record avatar -->
              <div
                class="shrink-0 mt-0.5 h-9 w-9 rounded-full flex items-center justify-center text-xs font-bold select-none"
                :style="{ background: (selectedType?.color ?? '#3b82f6') + '22', color: selectedType?.color ?? '#3b82f6' }"
              >
                {{ recordInitials(openedRecord.title) }}
              </div>
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
                <input
                  v-if="editingTitle"
                  ref="titleInputEl"
                  :value="titleDraft"
                  type="text"
                  class="w-full text-sm font-semibold text-slate-900 dark:text-white bg-transparent border-b border-sky-400 dark:border-sky-500 outline-none pb-0.5"
                  @input="titleDraft = ($event.target as HTMLInputElement).value"
                  @keydown.enter.prevent="commitTitleEdit(openedRecord)"
                  @keydown.esc.stop="cancelTitleEdit"
                  @blur="commitTitleEdit(openedRecord)"
                />
                <h3
                  v-else
                  class="text-sm font-semibold text-slate-900 dark:text-white truncate cursor-text hover:opacity-80 transition-opacity"
                  :title="editingRecord ? undefined : 'Click to rename'"
                  @click="!editingRecord && startTitleEdit(openedRecord)"
                >
                  {{ openedRecord.title }}
                </h3>
              </div>
              <span
                v-if="editingRecord"
                class="shrink-0 mt-0.5 rounded-full px-2 py-0.5 text-xs font-medium bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400"
              >
                Editing
              </span>
              <!-- copy record link -->
              <button
                type="button"
                aria-label="Copy record link"
                title="Copy link to this record (C)"
                class="shrink-0 mt-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg p-1 transition-colors"
                @click="copyRecordLink(openedRecord)"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              </button>
              <button
                type="button"
                :aria-label="watchedIds.has(openedRecord.id) ? 'Stop watching' : 'Watch record'"
                :title="watchedIds.has(openedRecord.id) ? 'Stop watching this record' : 'Watch this record for changes'"
                class="shrink-0 mt-0.5 rounded-lg p-1 transition-colors"
                :class="watchedIds.has(openedRecord.id)
                  ? 'text-sky-500 hover:text-sky-400 dark:text-sky-400 dark:hover:text-sky-300'
                  : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'"
                @click="toggleWatch(openedRecord.id)"
              >
                <svg
                  class="h-4 w-4"
                  :fill="watchedIds.has(openedRecord.id) ? 'currentColor' : 'none'"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  stroke-width="2"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
              </button>
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

            <!-- stage pipeline indicator -->
            <div
              v-if="kanbanField && !editingRecord && openedRecord.field_values[kanbanField.key] != null"
              class="flex items-center gap-px px-5 py-2.5 border-b border-slate-100 dark:border-slate-800/80 overflow-x-auto no-scrollbar"
            >
              <template v-for="(stage, idx) in (kanbanField.select_options ?? [])" :key="stage">
                <button
                  type="button"
                  class="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-all"
                  :class="openedRecord.field_values[kanbanField.key] === stage
                    ? 'bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300 ring-1 ring-sky-300 dark:ring-sky-700'
                    : (kanbanField.select_options ?? []).indexOf(String(openedRecord.field_values[kanbanField.key])) > idx
                      ? 'text-slate-400 dark:text-slate-500 line-through opacity-60'
                      : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'"
                  :title="`Move to ${stage}`"
                  @click="openedRecord.field_values[kanbanField.key] = stage; showToast(`Stage: ${stage}`)"
                >
                  {{ stage }}
                </button>
                <svg
                  v-if="idx < (kanbanField.select_options ?? []).length - 1"
                  class="h-3 w-3 shrink-0 text-slate-200 dark:text-slate-700"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  stroke-width="2"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </template>
            </div>

            <!-- record completeness bar -->
            <div
              v-if="!editingRecord && recordCompleteness.total > 0"
              class="flex items-center gap-2.5 px-5 py-2 border-b border-slate-100 dark:border-slate-800/80"
              :title="`${recordCompleteness.filled} of ${recordCompleteness.total} fields filled${recordCompleteness.missing.length ? '\nMissing: ' + recordCompleteness.missing.join(', ') : ''}`"
            >
              <div class="flex-1 h-1 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                  class="h-full rounded-full transition-all duration-300"
                  :class="completenessPercent >= 80 ? 'bg-emerald-400 dark:bg-emerald-500' : completenessPercent >= 50 ? 'bg-amber-400 dark:bg-amber-500' : 'bg-rose-400 dark:bg-rose-500'"
                  :style="{ width: `${completenessPercent}%` }"
                />
              </div>
              <span class="shrink-0 tabular-nums text-xs text-slate-400 dark:text-slate-500">
                {{ completenessPercent }}%
              </span>
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
                  class="space-y-1 group/field"
                >
                  <div class="flex items-center gap-1">
                    <label class="flex-1 flex items-center gap-1 text-xs font-medium text-slate-400 dark:text-slate-500">
                      <svg class="h-3 w-3 shrink-0 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.75">
                        <path stroke-linecap="round" stroke-linejoin="round" :d="DATA_TYPE_ICONS[field.data_type] ?? DATA_TYPE_ICONS['text']" />
                      </svg>
                      {{ field.label }}
                      <span v-if="field.is_required" class="text-red-400">*</span>
                    </label>
                    <template v-if="!editingRecord">
                      <!-- copy field value -->
                      <button
                        v-if="openedRecord.field_values[field.key] != null && String(openedRecord.field_values[field.key]).trim()"
                        type="button"
                        class="invisible group-hover/field:visible rounded p-0.5 transition-colors text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400"
                        title="Copy value"
                        aria-label="Copy field value"
                        @click.stop="copyFieldValue(openedRecord.field_values[field.key])"
                      >
                        <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke-linecap="round" stroke-linejoin="round" />
                          <path stroke-linecap="round" stroke-linejoin="round" d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                        </svg>
                      </button>
                      <!-- annotate field -->
                      <button
                        type="button"
                        class="invisible group-hover/field:visible rounded p-0.5 transition-colors"
                        :class="fieldAnnotations[`${openedRecord.id}|${field.key}`]
                          ? 'text-sky-400 hover:text-sky-500 !visible'
                          : 'text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400'"
                        :title="fieldAnnotations[`${openedRecord.id}|${field.key}`] ? 'Edit note' : 'Add note'"
                        :aria-label="fieldAnnotations[`${openedRecord.id}|${field.key}`] ? 'Edit note' : 'Add note'"
                        @click.stop="startAnnotate(field.key, openedRecord.id)"
                      >
                        <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                      </button>
                    </template>
                  </div>
                  <!-- clickable cycle badge for select fields in view mode -->
                  <template v-if="!editingRecord && field.data_type === 'select'">
                    <button
                      v-if="openedRecord.field_values[field.key]"
                      type="button"
                      class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80 cursor-pointer"
                      :class="selectBadgeClass(String(openedRecord.field_values[field.key]))"
                      :title="`Click to cycle ${field.label} (${field.select_options?.join(' → ')})`"
                      @click="cycleSelectField(openedRecord, field)"
                    >
                      {{ openedRecord.field_values[field.key] }}
                      <svg class="h-2.5 w-2.5 opacity-60 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
                      </svg>
                    </button>
                    <button
                      v-else
                      type="button"
                      class="text-xs text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400 transition-colors italic"
                      :title="`Click to set ${field.label}`"
                      @click="cycleSelectField(openedRecord, field)"
                    >
                      — set value
                    </button>
                  </template>
                  <CrmFieldInput
                    v-else
                    :data-type="field.data_type"
                    :value="openedRecord.field_values[field.key]"
                    :read-only="!editingRecord"
                    :select-options="field.select_options ?? []"
                    :format="field.format"
                    @update:value="openedRecord.field_values[field.key] = $event"
                  />
                  <!-- field annotation display -->
                  <p
                    v-if="fieldAnnotations[`${openedRecord.id}|${field.key}`] && annotatingField !== field.key"
                    class="text-xs text-slate-400 dark:text-slate-500 italic leading-snug"
                  >{{ fieldAnnotations[`${openedRecord.id}|${field.key}`] }}</p>
                  <!-- field annotation input -->
                  <div v-if="annotatingField === field.key" class="mt-0.5 space-y-1">
                    <input
                      ref="annotationInputEl"
                      v-model="annotationDraft"
                      type="text"
                      placeholder="Note about this field… (empty to clear)"
                      class="w-full rounded px-2 py-1 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                      @keydown.enter.prevent="commitAnnotation(openedRecord.id, field.key)"
                      @keydown.esc.stop="cancelAnnotation"
                      @blur="commitAnnotation(openedRecord.id, field.key)"
                    />
                    <p class="text-xs text-slate-400 dark:text-slate-500">Enter to save · Esc to discard · empty to clear</p>
                  </div>
                </div>
              </template>

              <!-- Activity tab -->
              <template v-else-if="detailTab === 'activity'">
                <div class="flex items-center justify-between">
                  <p class="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">Activity</p>
                  <button
                    v-if="loggingNote"
                    type="button"
                    class="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                    @click="loggingNote = false; noteText = ''"
                  >Cancel</button>
                </div>
                <!-- quick log action buttons -->
                <div v-if="!loggingNote" class="flex items-center gap-1.5">
                  <button
                    v-for="qt in ([['note', 'M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z', 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'], ['call', 'M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z', 'text-emerald-600 hover:text-emerald-500 dark:text-emerald-500 dark:hover:text-emerald-400'], ['email', 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z', 'text-sky-500 hover:text-sky-400 dark:text-sky-400 dark:hover:text-sky-300'], ['meeting', 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z', 'text-violet-500 hover:text-violet-400 dark:text-violet-400 dark:hover:text-violet-300']] as [string, string, string][])"
                    :key="qt[0]"
                    type="button"
                    class="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors capitalize"
                    :class="qt[2]"
                    :title="`Log ${qt[0]}`"
                    @click="noteType = (qt[0] as 'note' | 'email' | 'call' | 'meeting'); loggingNote = true; noteText = ''"
                  >
                    <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.75">
                      <path stroke-linecap="round" stroke-linejoin="round" :d="qt[1]" />
                    </svg>
                    {{ qt[0] }}
                  </button>
                </div>
                <!-- compose area -->
                <div v-if="loggingNote" class="space-y-2">
                  <div class="flex items-center gap-2">
                    <span
                      class="h-5 w-5 rounded-full flex items-center justify-center shrink-0"
                      :class="ACTIVITY_ICON_BG[noteType]"
                    >
                      <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.75">
                        <path stroke-linecap="round" stroke-linejoin="round" :d="ACTIVITY_ICONS[noteType]" />
                      </svg>
                    </span>
                    <span class="text-xs font-medium text-slate-500 dark:text-slate-400 capitalize">{{ noteType }}</span>
                  </div>
                  <textarea
                    ref="activityTextareaEl"
                    v-model="noteText"
                    rows="3"
                    :placeholder="`Add ${noteType === 'note' ? 'a' : 'an'} ${noteType}…`"
                    class="w-full rounded-lg px-3 py-2 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-none focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                    @keydown.meta.enter.prevent="logNote(openedRecord)"
                    @keydown.ctrl.enter.prevent="logNote(openedRecord)"
                  />
                  <div class="flex items-center justify-between">
                    <span class="text-xs text-slate-400 dark:text-slate-500">⌘ Enter to save</span>
                    <button
                      type="button"
                      class="rounded-lg px-3 py-1.5 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 transition-colors disabled:opacity-40"
                      :disabled="!noteText.trim()"
                      @click="logNote(openedRecord)"
                    >
                      Save {{ noteType }}
                    </button>
                  </div>
                </div>
                <!-- activity search — shown when 4+ activities exist -->
                <div v-if="recordActivities.length >= 4" class="relative">
                  <svg class="pointer-events-none absolute top-1/2 left-2.5 h-3 w-3 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                  </svg>
                  <input
                    v-model="activitySearchQuery"
                    type="text"
                    placeholder="Search activity…"
                    :class="['h-7 w-full rounded-lg pl-7 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-400/40', activitySearchQuery ? 'pr-6' : 'pr-2']"
                  />
                  <button
                    v-if="activitySearchQuery"
                    type="button"
                    class="absolute top-1/2 right-1.5 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded transition-colors"
                    @click="activitySearchQuery = ''"
                  >
                    <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                <!-- activity type filter chips -->
                <div v-if="recordActivities.length > 1" class="flex items-center gap-1 flex-wrap">
                  <button
                    v-for="t in ['all', 'note', 'email', 'call', 'meeting', 'change'] as const"
                    :key="t"
                    type="button"
                    class="rounded-full px-2 py-0.5 text-xs font-medium transition-colors capitalize"
                    :class="activityTypeFilter === t
                      ? 'bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300 ring-1 ring-sky-300 dark:ring-sky-700'
                      : 'text-slate-400 dark:text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-300'"
                    @click="activityTypeFilter = t"
                  >{{ t }}</button>
                </div>

                <div v-if="visibleActivities.length" class="space-y-1">
                  <template v-for="row in groupedActivities" :key="row.kind === 'label' ? row.key : row.act.id">
                    <!-- date label -->
                    <div
                      v-if="row.kind === 'label'"
                      class="flex items-center gap-2 pt-2 pb-0.5 first:pt-0"
                    >
                      <span class="text-xs font-semibold text-slate-400 dark:text-slate-500 shrink-0">{{ row.label }}</span>
                      <div class="flex-1 h-px bg-slate-100 dark:bg-slate-800" />
                    </div>
                    <!-- activity item -->
                    <div v-else class="flex gap-2.5 py-1">
                      <span
                        class="mt-0.5 h-6 w-6 rounded-full flex items-center justify-center shrink-0"
                        :class="ACTIVITY_ICON_BG[row.act.type]"
                      >
                        <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.75">
                          <path stroke-linecap="round" stroke-linejoin="round" :d="ACTIVITY_ICONS[row.act.type]" />
                        </svg>
                      </span>
                      <div class="flex-1 min-w-0">
                        <p
                          class="text-xs leading-relaxed"
                          :class="row.act.type === 'change'
                            ? 'text-slate-400 dark:text-slate-500 font-mono'
                            : 'text-slate-600 dark:text-slate-300'"
                        >{{ row.act.content }}</p>
                        <p class="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                          <span
                            class="capitalize font-medium"
                            :class="row.act.type === 'change' ? 'text-amber-500 dark:text-amber-400' : ''"
                          >{{ row.act.type === 'change' ? 'System' : row.act.author }}</span>
                          · {{ formatRelativeTime(row.act.created_at) }}
                        </p>
                      </div>
                    </div>
                  </template>
                </div>
                <p v-else-if="activitySearchQuery" class="text-xs text-slate-400 dark:text-slate-500 italic">No activity matches your search.</p>
                <p v-else-if="activityTypeFilter !== 'all'" class="text-xs text-slate-400 dark:text-slate-500 italic">No {{ activityTypeFilter }} activity logged yet.</p>
                <p v-else class="text-xs text-slate-400 dark:text-slate-500 italic">No activity logged yet.</p>
              </template>

              <!-- Related tab -->
              <template v-else-if="detailTab === 'related'">
                <p class="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">Related records</p>

                <!-- quick link search -->
                <div class="relative">
                  <div class="relative">
                    <svg class="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                    </svg>
                    <input
                      v-model="linkQuery"
                      type="text"
                      placeholder="Link a record…"
                      class="h-8 w-full rounded-lg pl-8 pr-3 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                      @focus="linkDropdownOpen = true"
                      @blur="linkDropdownOpen = false"
                    />
                  </div>
                  <div
                    v-if="linkDropdownOpen && linkResults.length"
                    class="absolute top-full left-0 right-0 mt-1 rounded-lg border shadow-lg overflow-hidden z-20 bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700"
                  >
                    <button
                      v-for="r in linkResults"
                      :key="r.id"
                      type="button"
                      class="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                      @mousedown.prevent="addLink(openedRecord, r)"
                    >
                      <span
                        class="h-5 w-5 rounded flex items-center justify-center shrink-0"
                        :style="{ background: (schema.find(rt => rt.key === r.record_type_key)?.color ?? '#64748b') + '22', color: schema.find(rt => rt.key === r.record_type_key)?.color ?? '#64748b' }"
                      >
                        <component :is="ICON_COMPONENTS[schema.find(rt => rt.key === r.record_type_key)?.icon ?? 'user']" class="h-3 w-3" />
                      </span>
                      <div class="flex-1 min-w-0">
                        <p class="text-xs font-medium text-slate-700 dark:text-slate-200 truncate">{{ r.title }}</p>
                        <p class="text-xs text-slate-400 dark:text-slate-500 capitalize">{{ schema.find(rt => rt.key === r.record_type_key)?.label }}</p>
                      </div>
                    </button>
                  </div>
                </div>

                <div v-if="openedRecord.links?.length" class="space-y-1">
                  <div
                    v-for="link in openedRecord.links"
                    :key="link.target_id"
                    class="group/link flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
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
                    <button
                      type="button"
                      class="invisible group-hover/link:visible rounded p-0.5 text-slate-300 dark:text-slate-600 hover:text-rose-400 dark:hover:text-rose-400 transition-colors"
                      aria-label="Remove link"
                      title="Remove link"
                      @click="removeLink(openedRecord, link.target_id)"
                    >
                      <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="shrink-0 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400 rounded p-0.5 transition-colors"
                      aria-label="Open linked record"
                      @click="openLinkedRecord(link)"
                    >
                      <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                </div>
                <p v-else class="text-xs text-slate-400 dark:text-slate-500 italic">No related records yet — use the search above to link some.</p>
              </template>
            </div>

            <!-- panel footer — view mode -->
            <div v-if="!editingRecord" class="px-5 py-4 border-t border-slate-200 dark:border-slate-700 space-y-2">
              <p class="text-xs text-slate-400 dark:text-slate-500">
                Created {{ formatDate(openedRecord.created_at) }}
                <template v-if="openedRecord.updated_at">
                  <span class="mx-1 opacity-50">·</span>
                  Updated {{ formatAge(openedRecord.updated_at) }}
                </template>
                <template v-if="filteredRecords.length > 1 && openedRecordIndex >= 0">
                  <span class="mx-1 opacity-50">·</span>{{ openedRecordIndex + 1 }} of {{ filteredRecords.length }}
                </template>
              </p>
              <div class="flex gap-2">
                <button
                  type="button"
                  class="flex-1 rounded-lg py-2 text-sm font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                  @click="startEditing(openedRecord)"
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
                <button
                  type="button"
                  aria-label="Delete record"
                  title="Delete record"
                  class="rounded-lg py-2 px-3 text-sm font-medium transition-colors text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                  @click="deleteRecord(openedRecord)"
                >
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
                  @click="saveEditing(openedRecord)"
                >
                  Save changes
                </button>
                <button
                  type="button"
                  class="rounded-lg py-2 px-3 text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                  @click="editingRecord = false; preEditSnapshot = {}"
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
                { keys: ['⌘', 'K'], desc: 'Command palette' },
                { keys: ['N'], desc: 'New record' },
                { keys: ['D'], desc: 'Duplicate open record' },
                { keys: ['P'], desc: 'Toggle pinned-only view' },
                { keys: ['/'], desc: 'Focus search' },
                { keys: ['R'], desc: 'Reset filters, search & sort' },
                { keys: ['F'], desc: 'Open filter picker' },
                { keys: ['G'], desc: 'Toggle row density (table view)' },
                { keys: ['['], desc: 'Toggle sidebar' },
                { keys: ['1-4'], desc: 'Switch record type (no panel open)' },
                { keys: ['T'], desc: 'Table view' },
                { keys: ['B'], desc: 'Board / Kanban view' },
                { keys: ['⌘', 'A'], desc: 'Select all records (table view)' },
                { keys: ['↑', '↓'], desc: 'Prev / next record' },
                { keys: ['Esc'], desc: 'Close panel' },
                { keys: ['?'], desc: 'Toggle this overlay' },
              ]},
              { heading: 'Detail Panel', items: [
                { keys: ['E'], desc: 'Edit record' },
                { keys: ['W'], desc: 'Watch / unwatch record' },
                { keys: ['C'], desc: 'Copy record link' },
                { keys: ['A'], desc: 'Open activity compose' },
                { keys: ['Del'], desc: 'Delete record (with undo toast)' },
                { keys: ['1'], desc: 'Details tab' },
                { keys: ['2'], desc: 'Activity tab' },
                { keys: ['3'], desc: 'Related tab' },
              ]},
              { heading: 'Table', items: [
                { keys: ['Dbl-click'], desc: 'Edit cell inline' },
                { keys: ['Enter'], desc: 'Commit cell edit' },
                { keys: ['Esc'], desc: 'Cancel cell edit' },
                { keys: ['Right-click'], desc: 'Row context menu' },
                { keys: ['S'], desc: 'Bulk move to stage (when rows selected)' },
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

    <!-- command palette — ⌘K -->
    <transition
      enter-active-class="transition-all duration-150"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition-all duration-100"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="showPalette"
        class="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/50"
        @click.self="showPalette = false"
      >
        <div class="w-full max-w-lg rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">
          <!-- search input -->
          <div class="flex items-center gap-3 px-4 py-3 border-b border-slate-100 dark:border-slate-800">
            <svg class="h-4 w-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input
              ref="paletteInputEl"
              v-model="paletteQuery"
              type="text"
              placeholder="Search all records…"
              class="flex-1 text-sm bg-transparent text-slate-900 dark:text-white placeholder-slate-400 outline-none"
              @keydown.arrow-down.prevent="paletteIdx = Math.min(paletteIdx + 1, paletteResults.length - 1)"
              @keydown.arrow-up.prevent="paletteIdx = Math.max(paletteIdx - 1, 0)"
              @keydown.enter.prevent="paletteResults[paletteIdx] && openFromPalette(paletteResults[paletteIdx])"
              @keydown.esc.stop="showPalette = false"
            />
            <kbd class="text-xs text-slate-400 border border-slate-200 dark:border-slate-700 rounded px-1.5 py-0.5 font-mono">esc</kbd>
          </div>
          <!-- quick-create chips — shown when no query -->
          <div v-if="!paletteQuery.trim()" class="px-4 pt-3 pb-3 border-b border-slate-100 dark:border-slate-800">
            <p class="text-xs font-medium text-slate-400 dark:text-slate-500 uppercase tracking-wide mb-2">Create</p>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="rt in schema"
                :key="rt.key"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition-colors"
                :style="{ borderColor: rt.color + '55', color: rt.color, background: rt.color + '11' }"
                @click="showPalette = false; selectedTypeKey = rt.key; openNewRecord()"
              >
                <component :is="ICON_COMPONENTS[rt.icon]" class="h-3 w-3" />
                New {{ rt.label }}
              </button>
            </div>
          </div>

          <!-- results -->
          <div class="max-h-72 overflow-y-auto">
            <p
              v-if="!paletteQuery.trim()"
              class="px-4 pt-3 pb-1 text-xs font-medium text-slate-400 dark:text-slate-500 uppercase tracking-wide"
            >Recent</p>
            <button
              v-for="(record, idx) in paletteResults"
              :key="record.id"
              type="button"
              class="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
              :class="idx === paletteIdx ? 'bg-sky-50 dark:bg-sky-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'"
              @mouseenter="paletteIdx = idx"
              @click="openFromPalette(record)"
            >
              <div
                class="shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold"
                :style="{ background: (schema.find(t => t.key === record.record_type_key)?.color ?? '#3b82f6') + '22', color: schema.find(t => t.key === record.record_type_key)?.color ?? '#3b82f6' }"
              >
                {{ recordInitials(record.title) }}
              </div>
              <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-slate-900 dark:text-white truncate">
                  <template v-if="paletteQuery.trim()">
                    <template v-for="(part, pi) in highlightText(record.title, paletteQuery.trim())" :key="pi">
                      <mark v-if="part.match" class="bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-100 rounded-sm not-italic">{{ part.text }}</mark>
                      <span v-else>{{ part.text }}</span>
                    </template>
                  </template>
                  <template v-else>{{ record.title }}</template>
                </p>
                <p class="text-xs text-slate-400 dark:text-slate-500 truncate">{{ schema.find(t => t.key === record.record_type_key)?.label }}</p>
              </div>
              <span v-if="pinnedIds.has(record.id)" class="text-amber-400 shrink-0" title="Pinned">
                <svg class="h-3 w-3" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>
              </span>
              <span v-if="watchedIds.has(record.id)" class="text-sky-400 shrink-0" title="Watching">
                <svg class="h-3 w-3" fill="currentColor" viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" /></svg>
              </span>
              <svg v-if="idx === paletteIdx" class="h-3.5 w-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <p v-if="!paletteResults.length" class="px-4 py-8 text-center text-sm text-slate-400 dark:text-slate-500">No records found</p>
          </div>
          <div class="px-4 py-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center gap-3 text-xs text-slate-400 dark:text-slate-500">
            <span><kbd class="font-mono">↑↓</kbd> navigate</span>
            <span><kbd class="font-mono">↵</kbd> open</span>
            <span><kbd class="font-mono">esc</kbd> close</span>
            <span class="ml-auto"><kbd class="font-mono">⌘K</kbd> toggle</span>
          </div>
        </div>
      </div>
    </transition>

    <!-- row hover preview card -->
    <transition
      enter-active-class="transition-all duration-150"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition-all duration-100"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="previewRecord && !openedRecord"
        class="fixed z-40 pointer-events-none rounded-xl border shadow-xl p-3 w-52 bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700"
        :style="{ top: `${previewPos.y}px`, left: `${previewPos.x}px` }"
      >
        <p class="text-xs font-semibold text-slate-900 dark:text-white truncate mb-2">{{ previewRecord.title }}</p>
        <div class="space-y-1.5">
          <div
            v-for="f in previewFields"
            :key="f.key"
            class="flex items-center gap-2"
          >
            <span class="shrink-0 text-xs text-slate-400 dark:text-slate-500 w-16 truncate">{{ f.label }}</span>
            <span
              v-if="f.data_type === 'select' && previewRecord.field_values[f.key]"
              class="inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium truncate"
              :class="selectBadgeClass(String(previewRecord.field_values[f.key]))"
            >{{ previewRecord.field_values[f.key] }}</span>
            <span v-else class="text-xs text-slate-600 dark:text-slate-300 truncate flex-1">
              {{ formatCardValue(previewRecord.field_values[f.key] as string | number | boolean | null, f.data_type, f.format) || '—' }}
            </span>
          </div>
        </div>
      </div>
    </transition>

    <!-- kanban card overflow menu -->
    <transition
      enter-active-class="transition-all duration-100"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition-all duration-75"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="kanbanCardMenu"
        class="fixed z-50 w-44 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl overflow-hidden py-1"
        :style="{ top: `${Math.min(kanbanCardMenu.y, window.innerHeight - 200)}px`, left: `${Math.min(kanbanCardMenu.x, window.innerWidth - 180)}px` }"
        @click.stop
      >
        <template v-if="mockRecords.find(r => r.id === kanbanCardMenu?.recordId) as CrmRecord | undefined">
          <button type="button" class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors" @click="openRecord(mockRecords.find(r => r.id === kanbanCardMenu!.recordId)!); kanbanCardMenu = null">
            <svg class="h-3.5 w-3.5 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
            Open
          </button>
          <button type="button" class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors" @click="duplicateRecord(mockRecords.find(r => r.id === kanbanCardMenu!.recordId)!); kanbanCardMenu = null">
            <svg class="h-3.5 w-3.5 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            Duplicate
          </button>
          <button type="button" class="w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors"
            :class="pinnedIds.has(kanbanCardMenu.recordId) ? 'text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/20' : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'"
            @click="togglePin(kanbanCardMenu!.recordId); kanbanCardMenu = null">
            <svg class="h-3.5 w-3.5 shrink-0" :fill="pinnedIds.has(kanbanCardMenu.recordId) ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>
            {{ pinnedIds.has(kanbanCardMenu.recordId) ? 'Unpin' : 'Pin' }}
          </button>
          <button type="button" class="w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors"
            :class="watchedIds.has(kanbanCardMenu.recordId) ? 'text-sky-600 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/20' : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'"
            @click="toggleWatch(kanbanCardMenu!.recordId); kanbanCardMenu = null">
            <svg class="h-3.5 w-3.5 shrink-0" :fill="watchedIds.has(kanbanCardMenu.recordId) ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
            {{ watchedIds.has(kanbanCardMenu.recordId) ? 'Unwatch' : 'Watch' }}
          </button>
          <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
          <button type="button" class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 dark:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 hover:text-red-600 dark:hover:text-red-400 transition-colors"
            @click="deleteRecord(mockRecords.find(r => r.id === kanbanCardMenu!.recordId)!); kanbanCardMenu = null">
            <svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            Delete
          </button>
        </template>
      </div>
    </transition>

    <!-- table row context menu -->
    <transition
      enter-active-class="transition-all duration-100"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition-all duration-75"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="contextMenuRecord"
        class="fixed z-50 w-48 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl py-1"
        :style="{ top: `${contextMenuPos.y}px`, left: `${contextMenuPos.x}px` }"
        @click.stop
      >
        <button
          type="button"
          class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          @click="openRecord(contextMenuRecord); closeContextMenu()"
        >
          <svg class="h-3.5 w-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
          Open
        </button>
        <button
          type="button"
          class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          @click="duplicateRecord(contextMenuRecord); closeContextMenu()"
        >
          <svg class="h-3.5 w-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          Duplicate
        </button>
        <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
        <button
          type="button"
          class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          @click="togglePin(contextMenuRecord.id); closeContextMenu()"
        >
          <svg class="h-3.5 w-3.5 shrink-0" :class="pinnedIds.has(contextMenuRecord.id) ? 'text-amber-500' : 'text-slate-400'" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
          {{ pinnedIds.has(contextMenuRecord.id) ? 'Unpin' : 'Pin' }}
        </button>
        <button
          type="button"
          class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          @click="toggleWatch(contextMenuRecord.id); closeContextMenu()"
        >
          <svg class="h-3.5 w-3.5 shrink-0" :class="watchedIds.has(contextMenuRecord.id) ? 'text-sky-500' : 'text-slate-400'" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
          {{ watchedIds.has(contextMenuRecord.id) ? 'Unwatch' : 'Watch' }}
        </button>
        <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
        <button
          type="button"
          class="w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors text-red-400 dark:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 hover:text-red-600 dark:hover:text-red-400"
          @click="deleteRecord(contextMenuRecord)"
        >
          <svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          Delete
        </button>
      </div>
    </transition>

    <!-- column header context menu -->
    <transition
      enter-active-class="transition-all duration-100"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition-all duration-75"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="colHeaderMenu"
        class="fixed z-50 w-44 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl py-1"
        :style="{ top: `${colHeaderMenu.y}px`, left: `${colHeaderMenu.x}px` }"
        @click.stop
      >
        <p class="px-3 pt-2 pb-1 text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider truncate">
          {{ allColumns.find(c => c.key === colHeaderMenu?.fieldKey)?.label ?? colHeaderMenu.fieldKey }}
        </p>
        <button type="button" class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          @click="sortField = colHeaderMenu!.fieldKey; sortDir = 'asc'; colHeaderMenu = null">
          <svg class="h-3.5 w-3.5 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
          </svg>
          Sort A → Z
        </button>
        <button type="button" class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          @click="sortField = colHeaderMenu!.fieldKey; sortDir = 'desc'; colHeaderMenu = null">
          <svg class="h-3.5 w-3.5 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
          Sort Z → A
        </button>
        <template v-if="allColumns.find(c => c.key === colHeaderMenu?.fieldKey)?.data_type === 'select'">
          <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
          <button type="button" class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            @click="filterPickerField = colHeaderMenu!.fieldKey; showFilterDropdown = true; colHeaderMenu = null">
            <svg class="h-3.5 w-3.5 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 4h18M7 9h10M11 14h2" />
            </svg>
            Filter by this field
          </button>
        </template>
        <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
        <button type="button" class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          @click="hiddenColumnKeys = new Set([...hiddenColumnKeys, colHeaderMenu!.fieldKey]); colHeaderMenu = null">
          <svg class="h-3.5 w-3.5 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
          </svg>
          Hide column
        </button>
      </div>
    </transition>

    <!-- bulk note modal -->
    <transition
      enter-active-class="transition-all duration-150"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-all duration-100"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="showBulkNoteModal"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        @click.self="showBulkNoteModal = false"
      >
        <div class="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-2xl p-5 space-y-3">
          <div class="flex items-center justify-between">
            <p class="text-sm font-semibold text-slate-900 dark:text-white">
              Log note for {{ selectedIds.size }} record{{ selectedIds.size === 1 ? '' : 's' }}
            </p>
            <button
              type="button"
              class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
              @click="showBulkNoteModal = false"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <textarea
            ref="bulkNoteInputEl"
            v-model="bulkNoteText"
            rows="4"
            placeholder="Write a note that will be logged for all selected records…"
            class="w-full rounded-lg px-3 py-2 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-none focus:outline-none focus:ring-2 focus:ring-sky-400/40"
            @keydown.meta.enter.prevent="submitBulkNote"
            @keydown.ctrl.enter.prevent="submitBulkNote"
            @keydown.esc.stop="showBulkNoteModal = false"
          />
          <div class="flex items-center justify-between">
            <span class="text-xs text-slate-400 dark:text-slate-500">⌘ Enter to save</span>
            <div class="flex gap-2">
              <button
                type="button"
                class="h-8 px-3 rounded-lg text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                @click="showBulkNoteModal = false"
              >
                Cancel
              </button>
              <button
                type="button"
                class="h-8 px-4 rounded-lg text-sm font-medium text-white bg-sky-600 hover:bg-sky-500 transition-colors disabled:opacity-40"
                :disabled="!bulkNoteText.trim()"
                @click="submitBulkNote"
              >
                Log note
              </button>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- toast notifications -->
    <div class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none">
      <transition-group
        enter-active-class="transition-all duration-200"
        enter-from-class="opacity-0 translate-y-2 scale-95"
        enter-to-class="opacity-100 translate-y-0 scale-100"
        leave-active-class="transition-all duration-150"
        leave-from-class="opacity-100 translate-y-0 scale-100"
        leave-to-class="opacity-0 translate-y-1 scale-95"
      >
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shadow-lg bg-slate-900 dark:bg-slate-800 text-white border border-slate-700 dark:border-slate-600"
          :class="toast.action ? 'pointer-events-auto' : ''"
        >
          <svg class="h-3.5 w-3.5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          {{ toast.message }}
          <button
            v-if="toast.action"
            class="ml-1 text-sky-400 hover:text-sky-300 font-semibold text-xs uppercase tracking-wide transition-colors"
            @click.stop="toast.action.fn(); toasts = toasts.filter(t => t.id !== toast.id)"
          >{{ toast.action.label }}</button>
        </div>
      </transition-group>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick, defineComponent, h, onMounted } from 'vue';
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
  updated_at?: string;
  links?: CrmLink[];
}

interface CrmActivity {
  id: string;
  record_id: string;
  type: 'note' | 'email' | 'call' | 'meeting' | 'change';
  content: string;
  author: string;
  created_at: string;
}

interface SavedView {
  id: string;
  name: string;
  typeKey: string;
  filters: Array<{ fieldKey: string; value: string }>;
  sortField: string | null;
  sortDir: 'asc' | 'desc';
  viewMode: 'table' | 'kanban';
  hiddenCols: string[];
  showPinnedOnly: boolean;
  showWatchedOnly: boolean;
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
  change:  'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
};

const ACTIVITY_ICON_BG: Record<CrmActivity['type'], string> = {
  note:    'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
  email:   'bg-sky-50 dark:bg-sky-950/40 text-sky-500 dark:text-sky-400',
  call:    'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400',
  meeting: 'bg-violet-50 dark:bg-violet-950/40 text-violet-500 dark:text-violet-400',
  change:  'bg-amber-50 dark:bg-amber-950/30 text-amber-500 dark:text-amber-400',
};

const DATA_TYPE_ICONS: Record<DataType, string> = {
  text:    'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  number:  'M7 20l4-16m2 16l4-16M6 9h14M4 15h14',
  email:   'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  phone:   'M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z',
  url:     'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
  boolean: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  date:    'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  select:  'M4 6h16M4 10h16M4 14h16M4 18h16',
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

const mockRecords = reactive<CrmRecord[]>([
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
]);

// ── Mock activity feed ─────────────────────────────────────────────────────

const mockActivities = reactive<CrmActivity[]>([
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
]);

// ── Kanban stage ordering per record type ─────────────────────────────────

const STAGE_ORDER: Record<string, string[]> = {
  deal:    ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'],
  contact: ['Lead', 'Prospect', 'Active', 'Churned'],
  lead:    ['Webinar', 'LinkedIn', 'Referral', 'Paid Social', 'Organic', 'Direct'],
  company: ['Education', 'Marketing', 'Consulting', 'Technology', 'Finance', 'Healthcare', 'Other'],
};

// Tailwind bg color for stage distribution bar segments
function stageSegmentBg(val: string): string {
  const v = val.toLowerCase();
  if (['won', 'active', 'converted', 'done'].some((k) => v.includes(k))) return 'bg-emerald-400 dark:bg-emerald-500';
  if (['lost', 'churn', 'inactive'].some((k) => v.includes(k))) return 'bg-rose-400 dark:bg-rose-500';
  if (['negotiat', 'qualif', 'proposal'].some((k) => v.includes(k))) return 'bg-violet-400 dark:bg-violet-500';
  if (['lead', 'webinar', 'linkedin', 'referral', 'paid', 'organic', 'direct'].some((k) => v.includes(k))) return 'bg-amber-400 dark:bg-amber-500';
  return 'bg-sky-400 dark:bg-sky-500';
}

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
const searchInputEl = ref<HTMLInputElement | null>(null);
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
const sidebarCollapsed = ref(false);
const pendingDeleteId = ref<string | null>(null);
let pendingDeleteTimer: ReturnType<typeof setTimeout> | null = null;
const deletedSnapshot = ref<{
  record: CrmRecord;
  idx: number;
  wasPinned: boolean;
  wasWatched: boolean;
} | null>(null);
let deletedSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
const bulkDeletedSnapshot = ref<Array<{
  record: CrmRecord;
  idx: number;
  wasPinned: boolean;
  wasWatched: boolean;
}> | null>(null);
let bulkDeletedSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
const detailTab = ref<'details' | 'activity' | 'related'>('details');
const contextMenuRecord = ref<CrmRecord | null>(null);
const contextMenuPos = ref({ x: 0, y: 0 });
const bulkStageDropdown = ref(false);
const collapsedColumns = ref<Set<string>>(new Set());
const showFilterDropdown = ref(false);
const filterPickerField = ref<string | null>(null);
const kanbanCardMenu = ref<{ recordId: string; x: number; y: number } | null>(null);
const colHeaderMenu = ref<{ fieldKey: string; x: number; y: number } | null>(null);
const showBulkNoteModal = ref(false);
const bulkNoteText = ref('');
const bulkNoteInputEl = ref<HTMLTextAreaElement | null>(null);
watch(showBulkNoteModal, (val) => { if (val) { bulkNoteText.value = ''; nextTick(() => bulkNoteInputEl.value?.focus()); } });
const editingCell = ref<{ recordId: string; fieldKey: string } | null>(null);
const lastSelectedIdx = ref(-1);
const savedViews = ref<SavedView[]>([]);
const showSaveViewPopover = ref(false);
const saveViewName = ref('');
const saveViewInputEl = ref<HTMLInputElement | null>(null);
watch(showSaveViewPopover, (val) => {
  if (val) { saveViewName.value = ''; nextTick(() => saveViewInputEl.value?.focus()); }
});
const loggingNote = ref(false);
const activityTextareaEl = ref<HTMLTextAreaElement | null>(null);
watch(loggingNote, (val) => { if (val) nextTick(() => activityTextareaEl.value?.focus()); });
const noteText = ref('');
const noteType = ref<'note' | 'email' | 'call' | 'meeting'>('note');
const editingTitle = ref(false);
const titleDraft = ref('');
const titleInputEl = ref<HTMLInputElement | null>(null);
watch(editingTitle, (val) => { if (val) nextTick(() => titleInputEl.value?.select()); });
watch(showPalette, (val) => {
  if (val) { paletteQuery.value = ''; paletteIdx.value = 0; nextTick(() => paletteInputEl.value?.focus()); }
});
const cellDraftValue = ref<string | number | boolean | null>(null);
const showShortcuts = ref(false);
const toasts = ref<Array<{ id: string; message: string; action?: { label: string; fn: () => void } }>>([]);
const showPalette = ref(false);
const paletteQuery = ref('');
const paletteIdx = ref(0);
const paletteInputEl = ref<HTMLInputElement | null>(null);
const activeFilters = ref<Array<{ fieldKey: string; value: string }>>([]);
const pinnedIds = ref<Set<string>>(new Set());
const showPinnedOnly = ref(false);
const showWatchedOnly = ref(false);
const showIncompleteOnly = ref(false);
const fieldAnnotations = ref<Record<string, string>>({});
const annotatingField = ref<string | null>(null);
const preEditSnapshot = ref<Record<string, unknown>>({});
const recentRecords = ref<CrmRecord[]>([]); // last 5 opened, newest first
const linkQuery = ref('');
const linkDropdownOpen = ref(false);
const watchedIds = ref<Set<string>>(new Set());
const previewRecord = ref<CrmRecord | null>(null);
const previewPos = ref({ x: 0, y: 0 });
let previewTimer: ReturnType<typeof setTimeout> | null = null;
const annotationDraft = ref('');
const annotationInputEl = ref<HTMLInputElement | null>(null);
watch(annotatingField, (val) => { if (val) nextTick(() => annotationInputEl.value?.focus()); });

const newRecordTitleInputEl = ref<HTMLInputElement | null>(null);
watch(creatingRecord, (val) => { if (val) nextTick(() => newRecordTitleInputEl.value?.focus()); });

// ── localStorage persistence ────────────────────────────────────────────────
const LS_KEY_VIEW_MODE = 'crm:viewMode';
const LS_KEY_HIDDEN_COLS = 'crm:hiddenCols';
const LS_KEY_ROW_DENSITY = 'crm:rowDensity';
const LS_KEY_SAVED_VIEWS = 'crm:savedViews';

onMounted(() => {
  try {
    const savedView = localStorage.getItem(LS_KEY_VIEW_MODE) as 'table' | 'kanban' | null;
    if (savedView === 'table' || savedView === 'kanban') viewMode.value = savedView;
    const savedHidden = localStorage.getItem(LS_KEY_HIDDEN_COLS);
    if (savedHidden) hiddenColumnKeys.value = new Set(JSON.parse(savedHidden) as string[]);
    const savedDensity = localStorage.getItem(LS_KEY_ROW_DENSITY) as 'comfortable' | 'compact' | null;
    if (savedDensity === 'comfortable' || savedDensity === 'compact') rowDensity.value = savedDensity;
    const sv = localStorage.getItem(LS_KEY_SAVED_VIEWS);
    if (sv) savedViews.value = JSON.parse(sv) as SavedView[];
  } catch { /* storage not available */ }
});

watch(viewMode, (val) => { try { localStorage.setItem(LS_KEY_VIEW_MODE, val); } catch { /* ignore */ } });
watch(hiddenColumnKeys, (val) => { try { localStorage.setItem(LS_KEY_HIDDEN_COLS, JSON.stringify([...val])); } catch { /* ignore */ } });
watch(rowDensity, (val) => { try { localStorage.setItem(LS_KEY_ROW_DENSITY, val); } catch { /* ignore */ } });
watch(savedViews, (val) => { try { localStorage.setItem(LS_KEY_SAVED_VIEWS, JSON.stringify(val)); } catch { /* ignore */ } }, { deep: true });

// ── Computed ───────────────────────────────────────────────────────────────

const selectedType = computed(() =>
  schema.find((rt) => rt.key === selectedTypeKey.value) ?? null,
);

const watchedRecords = computed(() =>
  mockRecords.filter((r) => watchedIds.value.has(r.id)),
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

const stageDistribution = computed((): Array<{ label: string; count: number; pct: number }> => {
  if (!kanbanField.value) return [];
  const fieldKey = kanbanField.value.key;
  const recs = mockRecords.filter((r) => r.record_type_key === selectedTypeKey.value);
  const counts: Record<string, number> = {};
  for (const r of recs) {
    const val = String(r.field_values[fieldKey] ?? '');
    if (val) counts[val] = (counts[val] ?? 0) + 1;
  }
  const order = STAGE_ORDER[selectedTypeKey.value] ?? Object.keys(counts);
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  if (!total) return [];
  return order
    .filter((s) => counts[s] != null)
    .map((s) => ({ label: s, count: counts[s], pct: Math.round((counts[s] / total) * 100) }));
});

const completenessRateByType = computed((): Record<string, number> => {
  const rates: Record<string, number> = {};
  for (const rt of schema) {
    const recs = mockRecords.filter((r) => r.record_type_key === rt.key);
    if (!recs.length || !rt.fields.length) { rates[rt.key] = 100; continue; }
    let fullyComplete = 0;
    for (const r of recs) {
      const allFilled = rt.fields.every((f) => {
        const v = r.field_values[f.key];
        return v != null && (typeof v !== 'string' || v.trim() !== '');
      });
      if (allFilled) fullyComplete++;
    }
    rates[rt.key] = Math.round((fullyComplete / recs.length) * 100);
  }
  return rates;
});

const allColumns = computed(() =>
  (selectedType.value?.fields ?? [])
    .slice()
    .sort((a, b) => a.position - b.position),
);

const visibleColumns = computed(() =>
  allColumns.value.filter((c) => !hiddenColumnKeys.value.has(c.key)),
);

const activeSortLabel = computed(() => {
  if (!sortField.value) return null;
  if (sortField.value === '__created_at__') return 'Added';
  if (sortField.value === '__updated_at__') return 'Updated';
  return allColumns.value.find((c) => c.key === sortField.value)?.label ?? sortField.value;
});

const pinnedCountForType = computed(() =>
  mockRecords.filter((r) => r.record_type_key === selectedTypeKey.value && pinnedIds.value.has(r.id)).length,
);
const watchedCountForType = computed(() =>
  mockRecords.filter((r) => r.record_type_key === selectedTypeKey.value && watchedIds.value.has(r.id)).length,
);
const incompleteCountForType = computed(() => {
  const fields = selectedType.value?.fields ?? [];
  if (!fields.length) return 0;
  return mockRecords.filter((r) => {
    if (r.record_type_key !== selectedTypeKey.value) return false;
    return fields.some((f) => {
      const v = r.field_values[f.key];
      return v == null || (typeof v === 'string' && v.trim() === '');
    });
  }).length;
});

const filteredRecords = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const recs = mockRecords.filter((r) => r.record_type_key === selectedTypeKey.value);
  let result: CrmRecord[] = q
    ? recs.filter((r) =>
        r.title.toLowerCase().includes(q) ||
        Object.values(r.field_values).some((v) => v != null && String(v).toLowerCase().includes(q))
      )
    : recs;

  if (activeFilters.value.length) {
    result = result.filter((r) =>
      activeFilters.value.every((f) => String(r.field_values[f.fieldKey] ?? '') === f.value),
    );
  }

  if (sortField.value) {
    const key = sortField.value;
    const dir = sortDir.value === 'asc' ? 1 : -1;

    if (key === '__created_at__') {
      result = [...result].sort((a, b) =>
        (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * dir,
      );
    } else if (key === '__updated_at__') {
      result = [...result].sort((a, b) => {
        const at = a.updated_at ? new Date(a.updated_at).getTime() : new Date(a.created_at).getTime();
        const bt = b.updated_at ? new Date(b.updated_at).getTime() : new Date(b.created_at).getTime();
        return (at - bt) * dir;
      });
    } else {
      const col = selectedType.value?.fields.find((f) => f.key === key);
      result = [...result].sort((a, b) => {
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
    }
  }

  if (showWatchedOnly.value && watchedIds.value.size) {
    result = result.filter((r) => watchedIds.value.has(r.id));
  }

  if (pinnedIds.value.size) {
    if (showPinnedOnly.value) {
      result = result.filter((r) => pinnedIds.value.has(r.id));
    } else {
      const pinned = result.filter((r) => pinnedIds.value.has(r.id));
      const rest = result.filter((r) => !pinnedIds.value.has(r.id));
      result = [...pinned, ...rest];
    }
  }

  if (showIncompleteOnly.value) {
    const fields = selectedType.value?.fields ?? [];
    result = result.filter((r) =>
      fields.some((f) => {
        const v = r.field_values[f.key];
        return v == null || (typeof v === 'string' && v.trim() === '');
      }),
    );
  }

  return result;
});

// The first select field drives the kanban grouping dimension
const kanbanField = computed(() =>
  selectedType.value?.fields.find((f) => f.data_type === 'select') ?? null,
);

const canKanban = computed(() => kanbanField.value != null);

const KANBAN_UNASSIGNED = '__unassigned__';

const kanbanColumns = computed((): string[] => {
  if (!kanbanField.value) return [];
  const fieldKey = kanbanField.value.key;
  const order = STAGE_ORDER[selectedTypeKey.value] ?? [];
  // collect extra values present in records not already in the predefined order
  const extra = [...new Set(
    filteredRecords.value
      .map((r) => r.field_values[fieldKey] as string)
      .filter((v): v is string => Boolean(v) && !order.includes(v)),
  )];
  // append unassigned column only when any record has no stage value
  const hasUnassigned = filteredRecords.value.some((r) => !r.field_values[fieldKey]);
  return [...order, ...extra, ...(hasUnassigned ? [KANBAN_UNASSIGNED] : [])];
});

const kanbanGroups = computed((): Record<string, CrmRecord[]> => {
  if (!kanbanField.value) return {};
  const fieldKey = kanbanField.value.key;
  const groups: Record<string, CrmRecord[]> = {};
  for (const col of kanbanColumns.value) groups[col] = [];
  for (const r of filteredRecords.value) {
    const val = (r.field_values[fieldKey] as string) ?? '';
    if (val && Object.prototype.hasOwnProperty.call(groups, val)) {
      groups[val].push(r);
    } else if (!val && Object.prototype.hasOwnProperty.call(groups, KANBAN_UNASSIGNED)) {
      groups[KANBAN_UNASSIGNED].push(r);
    }
  }
  return groups;
});

const kanbanGroupsTotal = computed((): Record<string, number> => {
  if (!kanbanField.value) return {};
  const fieldKey = kanbanField.value.key;
  const totals: Record<string, number> = {};
  for (const col of kanbanColumns.value) totals[col] = 0;
  const typeRecs = mockRecords.filter((r) => r.record_type_key === selectedTypeKey.value);
  for (const r of typeRecs) {
    const val = (r.field_values[fieldKey] as string) ?? '';
    if (val && Object.prototype.hasOwnProperty.call(totals, val)) {
      totals[val]++;
    } else if (!val && Object.prototype.hasOwnProperty.call(totals, KANBAN_UNASSIGNED)) {
      totals[KANBAN_UNASSIGNED]++;
    }
  }
  return totals;
});

const pinnedInView = computed(() =>
  filteredRecords.value.filter((r) => pinnedIds.value.has(r.id)).length,
);
const watchedInView = computed(() =>
  filteredRecords.value.filter((r) => watchedIds.value.has(r.id)).length,
);

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

const tableColumnTotals = computed((): Record<string, number | null> => {
  const totals: Record<string, number | null> = {};
  for (const col of visibleColumns.value) {
    if (col.data_type !== 'number') { totals[col.key] = null; continue; }
    totals[col.key] = filteredRecords.value.reduce((s, r) => {
      const v = r.field_values[col.key];
      return s + (v != null ? Number(v) : 0);
    }, 0);
  }
  return totals;
});

const hasTableTotals = computed(() =>
  Object.values(tableColumnTotals.value).some((v) => v !== null),
);

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

const activityTypeFilter = ref<CrmActivity['type'] | 'all'>('all');
const activitySearchQuery = ref('');

const visibleActivities = computed(() => {
  let result = activityTypeFilter.value === 'all'
    ? recordActivities.value
    : recordActivities.value.filter((a) => a.type === activityTypeFilter.value);
  const q = activitySearchQuery.value.trim().toLowerCase();
  if (q) result = result.filter((a) => a.content.toLowerCase().includes(q) || a.author.toLowerCase().includes(q));
  return result;
});

type ActivityRow =
  | { kind: 'label'; label: string; key: string }
  | { kind: 'activity'; act: CrmActivity };

const groupedActivities = computed((): ActivityRow[] => {
  const rows: ActivityRow[] = [];
  let lastLabel = '';
  for (const act of visibleActivities.value) {
    const d = new Date(act.created_at);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const isSameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    let label: string;
    if (isSameDay(d, today)) label = 'Today';
    else if (isSameDay(d, yesterday)) label = 'Yesterday';
    else label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
    if (label !== lastLabel) {
      lastLabel = label;
      rows.push({ kind: 'label', label, key: 'lbl-' + label });
    }
    rows.push({ kind: 'activity', act });
  }
  return rows;
});

const recordCompleteness = computed((): { filled: number; total: number; missing: string[] } => {
  if (!openedRecord.value || !selectedType.value) return { filled: 0, total: 0, missing: [] };
  const fields = selectedType.value.fields;
  const missing: string[] = [];
  let filled = 0;
  for (const f of fields) {
    const v = openedRecord.value.field_values[f.key];
    if (v != null && (typeof v !== 'string' || v.trim() !== '')) {
      filled++;
    } else {
      missing.push(f.label);
    }
  }
  return { filled, total: fields.length, missing };
});

const completenessPercent = computed(() =>
  recordCompleteness.value.total === 0
    ? 0
    : Math.round((recordCompleteness.value.filled / recordCompleteness.value.total) * 100),
);

const previewFields = computed(() =>
  (selectedType.value?.fields ?? [])
    .filter((f) => !f.is_title)
    .slice()
    .sort((a, b) => a.position - b.position)
    .slice(0, 3),
);

const linkResults = computed(() => {
  const q = linkQuery.value.trim().toLowerCase();
  if (!q) return [];
  const linked = new Set(openedRecord.value?.links?.map((l) => l.target_id) ?? []);
  return mockRecords
    .filter((r) =>
      r.id !== openedRecord.value?.id &&
      !linked.has(r.id) &&
      (r.title.toLowerCase().includes(q) ||
        Object.values(r.field_values).some((v) => v != null && String(v).toLowerCase().includes(q)))
    )
    .slice(0, 6);
});

const paletteResults = computed(() => {
  const q = paletteQuery.value.trim().toLowerCase();
  if (!q) return mockRecords.slice(0, 8);
  return mockRecords
    .filter((r) =>
      r.title.toLowerCase().includes(q) ||
      Object.values(r.field_values).some((v) => v != null && String(v).toLowerCase().includes(q)),
    )
    .slice(0, 8);
});

const allSelected = computed(
  () =>
    filteredRecords.value.length > 0 &&
    filteredRecords.value.every((r) => selectedIds.value.has(r.id)),
);

// ── Actions ────────────────────────────────────────────────────────────────

function openContextMenu(record: CrmRecord, e: MouseEvent) {
  contextMenuRecord.value = record;
  const menuW = 192;
  const menuH = 200;
  contextMenuPos.value = {
    x: Math.min(e.clientX, window.innerWidth - menuW - 8),
    y: Math.min(e.clientY, window.innerHeight - menuH - 8),
  };
}

function closeContextMenu() {
  contextMenuRecord.value = null;
}

function openColHeaderMenu(fieldKey: string, e: MouseEvent) {
  const menuW = 180;
  const menuH = 160;
  colHeaderMenu.value = {
    fieldKey,
    x: Math.min(e.clientX, window.innerWidth - menuW - 8),
    y: Math.min(e.clientY, window.innerHeight - menuH - 8),
  };
}

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function onCheckboxClick(record: CrmRecord, idx: number, e: MouseEvent) {
  e.stopPropagation();
  if (e.shiftKey && lastSelectedIdx.value >= 0) {
    const lo = Math.min(lastSelectedIdx.value, idx);
    const hi = Math.max(lastSelectedIdx.value, idx);
    const adding = !selectedIds.value.has(record.id);
    const next = new Set(selectedIds.value);
    for (let i = lo; i <= hi; i++) {
      const r = filteredRecords.value[i];
      if (r) { if (adding) next.add(r.id); else next.delete(r.id); }
    }
    selectedIds.value = next;
  } else {
    toggleSelect(record.id);
  }
  lastSelectedIdx.value = idx;
}

function toggleAll() {
  if (allSelected.value) {
    selectedIds.value = new Set();
    lastSelectedIdx.value = -1;
  } else {
    selectedIds.value = new Set(filteredRecords.value.map((r) => r.id));
    lastSelectedIdx.value = filteredRecords.value.length - 1;
  }
}

function clearSelection() {
  selectedIds.value = new Set();
  lastSelectedIdx.value = -1;
}

function togglePin(id: string) {
  const next = new Set(pinnedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  pinnedIds.value = next;
}

function showPreview(e: MouseEvent, record: CrmRecord) {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewRecord.value = record;
    previewPos.value = { x: e.clientX + 14, y: e.clientY - 8 };
  }, 350);
}
function updatePreviewPos(e: MouseEvent) {
  previewPos.value = { x: e.clientX + 14, y: e.clientY - 8 };
}
function hidePreview() {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
  previewRecord.value = null;
}

function bulkPinToggle() {
  const ids = [...selectedIds.value];
  const allPinned = ids.every((id) => pinnedIds.value.has(id));
  const next = new Set(pinnedIds.value);
  for (const id of ids) {
    if (allPinned) next.delete(id);
    else next.add(id);
  }
  pinnedIds.value = next;
  showToast(allPinned ? `Unpinned ${ids.length} record${ids.length === 1 ? '' : 's'}` : `Pinned ${ids.length} record${ids.length === 1 ? '' : 's'}`);
}

function bulkWatchToggle() {
  const ids = [...selectedIds.value];
  const allWatched = ids.every((id) => watchedIds.value.has(id));
  const next = new Set(watchedIds.value);
  for (const id of ids) {
    if (allWatched) next.delete(id);
    else next.add(id);
  }
  watchedIds.value = next;
  showToast(allWatched ? `Unwatching ${ids.length} record${ids.length === 1 ? '' : 's'}` : `Watching ${ids.length} record${ids.length === 1 ? '' : 's'}`);
}

function toggleColumnCollapse(col: string) {
  const next = new Set(collapsedColumns.value);
  if (next.has(col)) next.delete(col); else next.add(col);
  collapsedColumns.value = next;
}

function bulkMoveToStage(stage: string) {
  const fieldKey = kanbanField.value?.key;
  if (!fieldKey) return;
  const ids = [...selectedIds.value];
  for (const r of mockRecords) {
    if (ids.includes(r.id)) r.field_values[fieldKey] = stage;
  }
  bulkStageDropdown.value = false;
  showToast(`Moved ${ids.length} record${ids.length === 1 ? '' : 's'} to ${stage}`);
}

function bulkDelete() {
  const ids = [...selectedIds.value];
  if (!ids.length) return;
  const snapshots = ids.map((id) => {
    const record = mockRecords.find((r) => r.id === id);
    if (!record) return null;
    return {
      record,
      idx: mockRecords.indexOf(record),
      wasPinned: pinnedIds.value.has(id),
      wasWatched: watchedIds.value.has(id),
    };
  }).filter((s): s is NonNullable<typeof s> => s !== null);
  if (bulkDeletedSnapshotTimer) clearTimeout(bulkDeletedSnapshotTimer);
  bulkDeletedSnapshot.value = snapshots;
  bulkDeletedSnapshotTimer = setTimeout(() => { bulkDeletedSnapshot.value = null; }, 5000);
  // Remove all selected records (in reverse index order to keep splicing stable)
  const sortedByIdx = snapshots.slice().sort((a, b) => b.idx - a.idx);
  for (const s of sortedByIdx) {
    const cur = mockRecords.indexOf(s.record);
    if (cur >= 0) mockRecords.splice(cur, 1);
  }
  if (openedRecord.value && ids.includes(openedRecord.value.id)) closePanel();
  const nextPinned = new Set(pinnedIds.value);
  const nextWatched = new Set(watchedIds.value);
  for (const id of ids) { nextPinned.delete(id); nextWatched.delete(id); }
  pinnedIds.value = nextPinned;
  watchedIds.value = nextWatched;
  recentRecords.value = recentRecords.value.filter((r) => !ids.includes(r.id));
  selectedIds.value = new Set();
  showToast(`${ids.length} record${ids.length === 1 ? '' : 's'} deleted`, { label: 'Undo', fn: restoreBulkDeleted });
}

function restoreBulkDeleted() {
  const snaps = bulkDeletedSnapshot.value;
  if (!snaps || !snaps.length) return;
  if (bulkDeletedSnapshotTimer) clearTimeout(bulkDeletedSnapshotTimer);
  bulkDeletedSnapshot.value = null;
  // Re-insert in original index order (ascending)
  const sorted = snaps.slice().sort((a, b) => a.idx - b.idx);
  for (const s of sorted) {
    const insertIdx = Math.min(s.idx, mockRecords.length);
    mockRecords.splice(insertIdx, 0, s.record);
    if (s.wasPinned) { const next = new Set(pinnedIds.value); next.add(s.record.id); pinnedIds.value = next; }
    if (s.wasWatched) { const next = new Set(watchedIds.value); next.add(s.record.id); watchedIds.value = next; }
  }
  showToast('Delete undone');
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
  showPinnedOnly.value = false;
  showWatchedOnly.value = false;
  showIncompleteOnly.value = false;
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

function startTitleEdit(record: CrmRecord) {
  if (editingRecord.value) return;
  titleDraft.value = record.title;
  editingTitle.value = true;
}

function commitTitleEdit(record: CrmRecord) {
  const trimmed = titleDraft.value.trim();
  if (trimmed && trimmed !== record.title) {
    const prev = record.title;
    record.title = trimmed;
    record.updated_at = new Date().toISOString();
    mockActivities.unshift({
      id: 'act-chg-title-' + String(mockActivities.length),
      record_id: record.id,
      type: 'change',
      content: `Name: ${prev} → ${trimmed}`,
      author: 'You',
      created_at: new Date().toISOString(),
    });
  }
  editingTitle.value = false;
}

function cancelTitleEdit() {
  editingTitle.value = false;
}

function closePanel() {
  openedRecord.value = null;
  editingRecord.value = false;
  creatingRecord.value = false;
  navigationStack.value = [];
  createFormErrors.value = new Set();
  loggingNote.value = false;
  noteText.value = '';
  activitySearchQuery.value = '';
  editingTitle.value = false;
  annotatingField.value = null;
  annotationDraft.value = '';
}

function openRecord(record: CrmRecord) {
  navigationStack.value = [];
  openedRecord.value = record;
  editingRecord.value = false;
  creatingRecord.value = false;
  detailTab.value = 'details';
  // track in recent list (dedupe + cap at 5)
  recentRecords.value = [record, ...recentRecords.value.filter((r) => r.id !== record.id)].slice(0, 5);
}

function openNewRecord(stageValue?: string) {
  openedRecord.value = null;
  const fieldKey = kanbanField.value?.key;
  draftValues.value = fieldKey && stageValue ? { [fieldKey]: stageValue } : {};
  createFormErrors.value = new Set();
  creatingRecord.value = true;
}

function saveNewRecord() {
  const type = selectedType.value;
  const required = (type?.fields ?? []).filter((f) => f.is_required);
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
  // Build the record from draftValues
  const titleField = type?.fields.find((f) => f.is_title);
  const title = titleField ? String(draftValues.value[titleField.key] ?? '').trim() || `New ${type?.label ?? 'Record'}` : `New ${type?.label ?? 'Record'}`;
  const newRecord: CrmRecord = {
    id: 'new-' + selectedTypeKey.value + '-' + String(mockRecords.length),
    record_type_key: selectedTypeKey.value,
    title,
    created_at: new Date().toISOString(),
    field_values: { ...draftValues.value },
    links: [],
  };
  mockRecords.push(newRecord);
  mockActivities.unshift({
    id: 'act-create-' + newRecord.id,
    record_id: newRecord.id,
    type: 'change',
    content: 'Record created',
    author: 'You',
    created_at: newRecord.created_at,
  });
  creatingRecord.value = false;
  draftValues.value = {};
  openRecord(newRecord);
  showToast(`${type?.label ?? 'Record'} created`);
}

function openFromPalette(record: CrmRecord) {
  showPalette.value = false;
  if (record.record_type_key !== selectedTypeKey.value) {
    selectedTypeKey.value = record.record_type_key;
    searchQuery.value = '';
    sortField.value = null;
    sortDir.value = 'asc';
    viewMode.value = 'table';
  }
  nextTick(() => openRecord(record));
}

function logNote(record: CrmRecord) {
  const text = noteText.value.trim();
  if (!text) return;
  mockActivities.unshift({
    id: 'act-' + String(mockActivities.length),
    record_id: record.id,
    type: noteType.value,
    content: text,
    author: 'You',
    created_at: new Date().toISOString(),
  });
  noteText.value = '';
  loggingNote.value = false;
  showToast(`${noteType.value.charAt(0).toUpperCase() + noteType.value.slice(1)} logged`);
}

function highlightText(text: string, query: string): Array<{ text: string; match: boolean }> {
  if (!query) return [{ text, match: false }];
  const q = query.toLowerCase();
  const idx = text.toLowerCase().indexOf(q);
  if (idx === -1) return [{ text, match: false }];
  return [
    text.slice(0, idx) ? { text: text.slice(0, idx), match: false } : null,
    { text: text.slice(idx, idx + q.length), match: true },
    text.slice(idx + q.length) ? { text: text.slice(idx + q.length), match: false } : null,
  ].filter((p): p is { text: string; match: boolean } => p !== null);
}

function toggleWatch(id: string) {
  const next = new Set(watchedIds.value);
  if (next.has(id)) {
    next.delete(id);
    showToast('Stopped watching record');
  } else {
    next.add(id);
    showToast('Watching record');
  }
  watchedIds.value = next;
}

function moveCardStage(record: CrmRecord, dir: 1 | -1) {
  const fieldKey = kanbanField.value?.key;
  if (!fieldKey) return;
  const cols = kanbanColumns.value.filter((c) => c !== KANBAN_UNASSIGNED);
  const currentVal = String(record.field_values[fieldKey] ?? '');
  const idx = cols.indexOf(currentVal);
  const nextIdx = idx + dir;
  if (nextIdx < 0 || nextIdx >= cols.length) return;
  record.field_values[fieldKey] = cols[nextIdx];
  showToast(`Stage: ${cols[nextIdx]}`);
}

function addLink(record: CrmRecord, target: CrmRecord) {
  if (!record.links) record.links = [];
  if (record.links.some((l) => l.target_id === target.id)) return;
  record.links.push({
    target_id: target.id,
    target_title: target.title,
    target_type: target.record_type_key,
  });
  linkQuery.value = '';
  linkDropdownOpen.value = false;
  showToast(`Linked to ${target.title}`);
}

function removeLink(record: CrmRecord, targetId: string) {
  if (!record.links) return;
  record.links = record.links.filter((l) => l.target_id !== targetId);
  showToast('Link removed');
}

function startAnnotate(fieldKey: string, recordId: string) {
  annotatingField.value = fieldKey;
  annotationDraft.value = fieldAnnotations.value[`${recordId}|${fieldKey}`] ?? '';
}

function commitAnnotation(recordId: string, fieldKey: string) {
  const text = annotationDraft.value.trim();
  const key = `${recordId}|${fieldKey}`;
  if (text) {
    fieldAnnotations.value = { ...fieldAnnotations.value, [key]: text };
  } else {
    const copy = { ...fieldAnnotations.value };
    delete copy[key];
    fieldAnnotations.value = copy;
  }
  annotatingField.value = null;
  annotationDraft.value = '';
}

function cancelAnnotation() {
  annotatingField.value = null;
  annotationDraft.value = '';
}

async function copyFieldValue(value: unknown) {
  const text = value == null ? '' : String(value).trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied');
  } catch {
    // clipboard unavailable in non-secure context — silent fail
  }
}

async function copyRecordLink(record: CrmRecord) {
  try {
    await navigator.clipboard.writeText(`crm://record/${record.id}`);
    showToast('Link copied');
  } catch {
    // silent fail in non-secure context
  }
}

function cycleSelectField(record: CrmRecord, field: CrmField) {
  const opts = field.select_options ?? [];
  if (!opts.length) return;
  const cur = String(record.field_values[field.key] ?? '');
  const idx = opts.indexOf(cur);
  record.field_values[field.key] = opts[(idx + 1) % opts.length];
}

function deleteRecord(record: CrmRecord) {
  if (pendingDeleteTimer) clearTimeout(pendingDeleteTimer);
  pendingDeleteId.value = null;
  const idx = mockRecords.indexOf(record);
  const wasPinned = pinnedIds.value.has(record.id);
  const wasWatched = watchedIds.value.has(record.id);
  // Snapshot for undo
  if (deletedSnapshotTimer) clearTimeout(deletedSnapshotTimer);
  deletedSnapshot.value = { record, idx: Math.max(0, idx), wasPinned, wasWatched };
  deletedSnapshotTimer = setTimeout(() => { deletedSnapshot.value = null; }, 5000);
  if (idx >= 0) mockRecords.splice(idx, 1);
  if (openedRecord.value?.id === record.id) closePanel();
  const nextPinned = new Set(pinnedIds.value); nextPinned.delete(record.id); pinnedIds.value = nextPinned;
  const nextWatched = new Set(watchedIds.value); nextWatched.delete(record.id); watchedIds.value = nextWatched;
  const nextSelected = new Set(selectedIds.value); nextSelected.delete(record.id); selectedIds.value = nextSelected;
  recentRecords.value = recentRecords.value.filter((r) => r.id !== record.id);
  closeContextMenu();
  showToast('Record deleted', { label: 'Undo', fn: restoreDeletedRecord });
}

function restoreDeletedRecord() {
  const snap = deletedSnapshot.value;
  if (!snap) return;
  if (deletedSnapshotTimer) clearTimeout(deletedSnapshotTimer);
  deletedSnapshot.value = null;
  const insertIdx = Math.min(snap.idx, mockRecords.length);
  mockRecords.splice(insertIdx, 0, snap.record);
  if (snap.wasPinned) { const next = new Set(pinnedIds.value); next.add(snap.record.id); pinnedIds.value = next; }
  if (snap.wasWatched) { const next = new Set(watchedIds.value); next.add(snap.record.id); watchedIds.value = next; }
  showToast('Delete undone');
}

function submitBulkNote() {
  const text = bulkNoteText.value.trim();
  if (!text) return;
  const ids = [...selectedIds.value];
  const now = new Date().toISOString();
  for (const id of ids) {
    mockActivities.unshift({
      id: 'act-bulk-' + id + '-' + String(mockActivities.length),
      record_id: id,
      type: 'note',
      content: text,
      author: 'You',
      created_at: now,
    });
  }
  showBulkNoteModal.value = false;
  showToast(`Note logged for ${ids.length} record${ids.length === 1 ? '' : 's'}`);
}

function saveCurrentView() {
  const name = saveViewName.value.trim();
  if (!name) return;
  const view: SavedView = {
    id: 'sv-' + String(Date.now()) + '-' + String(savedViews.value.length),
    name,
    typeKey: selectedTypeKey.value,
    filters: activeFilters.value.slice(),
    sortField: sortField.value,
    sortDir: sortDir.value,
    viewMode: viewMode.value,
    hiddenCols: [...hiddenColumnKeys.value],
    showPinnedOnly: showPinnedOnly.value,
    showWatchedOnly: showWatchedOnly.value,
  };
  savedViews.value = [...savedViews.value, view];
  showSaveViewPopover.value = false;
  showToast('View saved');
}

function applySavedView(view: SavedView) {
  selectedTypeKey.value = view.typeKey;
  activeFilters.value = view.filters.slice();
  sortField.value = view.sortField;
  sortDir.value = view.sortDir;
  viewMode.value = view.viewMode;
  hiddenColumnKeys.value = new Set(view.hiddenCols);
  showPinnedOnly.value = view.showPinnedOnly;
  showWatchedOnly.value = view.showWatchedOnly;
  searchQuery.value = '';
  closePanel();
}

function deleteSavedView(id: string) {
  savedViews.value = savedViews.value.filter((v) => v.id !== id);
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
  showToast('Record duplicated');
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
  if (searchInputEl.value && document.activeElement === searchInputEl.value && searchQuery.value) {
    searchQuery.value = '';
    return;
  }
  closePanel();
}

function onGlobalKeydown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  const inField = ['INPUT', 'SELECT', 'TEXTAREA'].includes(tag);
  if (e.key === '?' && !inField) {
    showShortcuts.value = !showShortcuts.value;
    return;
  }
  if (e.key === '/' && !inField) {
    e.preventDefault();
    searchInputEl.value?.focus();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    showPalette.value = !showPalette.value;
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'a' && !inField && viewMode.value === 'table' && !openedRecord.value && !editingRecord.value && !creatingRecord.value) {
    e.preventDefault();
    toggleAll();
    return;
  }
  if (!inField && openedRecord.value && !editingRecord.value) {
    if (e.key === '1') { detailTab.value = 'details'; e.preventDefault(); return; }
    if (e.key === '2') { detailTab.value = 'activity'; e.preventDefault(); return; }
    if (e.key === '3') { detailTab.value = 'related'; e.preventDefault(); return; }
    if (e.key === 'c' && !e.metaKey && !e.ctrlKey) { copyRecordLink(openedRecord.value); e.preventDefault(); return; }
    if (e.key === 'a' && !e.metaKey && !e.ctrlKey) {
      detailTab.value = 'activity';
      loggingNote.value = true;
      e.preventDefault();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey) {
      deleteRecord(openedRecord.value);
      e.preventDefault();
      return;
    }
  }
  if (!inField && !openedRecord.value && !editingRecord.value && !creatingRecord.value) {
    const idx = parseInt(e.key, 10) - 1;
    if (idx >= 0 && idx < schema.length) {
      selectType(schema[idx].key);
      e.preventDefault();
    }
  }
}

function onKeyN(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  openNewRecord();
}

function onKeyD(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (openedRecord.value && !editingRecord.value && !creatingRecord.value) {
    duplicateRecord(openedRecord.value);
  }
}

function onKeyR(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (editingRecord.value || creatingRecord.value) return;
  const hadState = searchQuery.value || activeFilters.value.length || sortField.value || showPinnedOnly.value || showWatchedOnly.value || showIncompleteOnly.value;
  searchQuery.value = '';
  activeFilters.value = [];
  sortField.value = null;
  showPinnedOnly.value = false;
  showWatchedOnly.value = false;
  showIncompleteOnly.value = false;
  if (hadState) showToast('View reset');
}

function onKeyT(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (editingRecord.value || creatingRecord.value) return;
  viewMode.value = 'table';
}

function onKeyB(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (editingRecord.value || creatingRecord.value) return;
  if (canKanban.value) viewMode.value = 'kanban';
}

function onKeyS(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (editingRecord.value || creatingRecord.value || openedRecord.value) return;
  if (selectedIds.value.size > 0 && kanbanField.value) {
    bulkStageDropdown.value = !bulkStageDropdown.value;
    e.preventDefault();
  }
}

function onKeyF(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (editingRecord.value || creatingRecord.value) return;
  showFilterDropdown.value = !showFilterDropdown.value;
  filterPickerField.value = null;
  e.preventDefault();
}

function onKeyG(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (editingRecord.value || creatingRecord.value) return;
  if (viewMode.value === 'table') {
    rowDensity.value = rowDensity.value === 'comfortable' ? 'compact' : 'comfortable';
    e.preventDefault();
  }
}

function onKeyBracketLeft(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  sidebarCollapsed.value = !sidebarCollapsed.value;
  e.preventDefault();
}

function startEditing(record: CrmRecord) {
  preEditSnapshot.value = { ...record.field_values };
  editingRecord.value = true;
}

function saveEditing(record: CrmRecord) {
  const fields = selectedType.value?.fields ?? [];
  for (const f of fields) {
    const before = preEditSnapshot.value[f.key];
    const after = record.field_values[f.key];
    const beforeStr = before == null ? '' : String(before);
    const afterStr = after == null ? '' : String(after);
    if (beforeStr !== afterStr) {
      mockActivities.unshift({
        id: 'act-chg-' + String(mockActivities.length),
        record_id: record.id,
        type: 'change',
        content: `${f.label}: ${beforeStr || '—'} → ${afterStr || '—'}`,
        author: 'You',
        created_at: new Date().toISOString(),
      });
    }
  }
  preEditSnapshot.value = {};
  editingRecord.value = false;
  record.updated_at = new Date().toISOString();
}

function onKeyE(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (openedRecord.value && !editingRecord.value && !creatingRecord.value) {
    startEditing(openedRecord.value);
  }
}

function onKeyP(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (pinnedCountForType.value > 0) {
    showPinnedOnly.value = !showPinnedOnly.value;
  }
}

function onKeyW(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (openedRecord.value && !editingRecord.value && !creatingRecord.value) {
    toggleWatch(openedRecord.value.id);
  }
}

function onKeySave() {
  if (creatingRecord.value) { saveNewRecord(); return; }
  if (editingRecord.value && openedRecord.value) { saveEditing(openedRecord.value); }
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

function showToast(message: string, action?: { label: string; fn: () => void }) {
  const id = 'toast-' + String(toasts.value.length) + '-' + String(Math.floor(Math.random() * 99999));
  toasts.value.push({ id, message, action });
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, action ? 5000 : 2500);
}

function exportCsv(records?: CrmRecord[]) {
  const recs = records ?? filteredRecords.value;
  const cols = allColumns.value;
  const headers = [...cols.map((c) => c.label), 'Created'];
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = recs.map((r) => [
    ...cols.map((c) => escape(r.field_values[c.key])),
    escape(formatDate(r.created_at)),
  ]);
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${selectedType.value?.label_plural ?? 'records'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${recs.length} record${recs.length === 1 ? '' : 's'}`);
}

function recordInitials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
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
        const now = new Date();
        const diffMs = d.getTime() - now.getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        // Strip time component for comparison (treat as date-only)
        const isOverdue = diffDays < -0.5;
        const isDueSoon = !isOverdue && diffDays <= 7;
        const fmt = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
        const colorClass = isOverdue
          ? 'text-red-500 dark:text-red-400'
          : isDueSoon
            ? 'text-amber-500 dark:text-amber-400'
            : '';
        const titleStr = isOverdue
          ? `Overdue — ${Math.round(-diffDays)} day${Math.round(-diffDays) === 1 ? '' : 's'} ago`
          : isDueSoon
            ? diffDays < 1 ? 'Due today' : `Due in ${Math.round(diffDays)} day${Math.round(diffDays) === 1 ? '' : 's'}`
            : fmt;
        return h('span', { class: 'tabular-nums ' + colorClass, title: titleStr }, fmt);
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
  emits: ['update:value'],
  setup(props, { emit }) {
    return () => {
      const baseClass = 'w-full rounded-lg px-3 py-2 text-sm border bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100';
      const val = props.value;
      if (props.dataType === 'boolean') {
        return h('div', {
          class: 'flex items-center gap-2 py-1' + (props.readOnly ? '' : ' cursor-pointer select-none'),
          onClick: props.readOnly ? undefined : () => emit('update:value', !val),
        }, [
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
          onChange: (e: Event) => emit('update:value', (e.target as HTMLSelectElement).value || null),
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
        onInput: props.readOnly ? undefined : (e: Event) => {
          const raw = (e.target as HTMLInputElement).value;
          emit('update:value', props.dataType === 'number' ? (raw === '' ? null : Number(raw)) : raw);
        },
      });
    };
  },
});
</script>
