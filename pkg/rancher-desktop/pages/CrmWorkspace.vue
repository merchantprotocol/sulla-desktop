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
    @keydown.l.exact="onKeyL"
    @keydown.v.exact="onKeyV"
    @keydown.s.exact="onKeyS"
    @keydown.f.exact="onKeyF"
    @keydown.g.exact="onKeyG"
    @keydown.x.exact="onKeyX"
    @keydown.bracket-left.exact="onKeyBracketLeft"
    @keydown.up.exact.prevent="onKeyArrow(-1)"
    @keydown.down.exact.prevent="onKeyArrow(1)"
    @keydown.left.exact="onKeyArrowLR(-1, $event)"
    @keydown.right.exact="onKeyArrowLR(1, $event)"
    @keydown.home.exact.prevent="onKeyHome"
    @keydown.end.exact.prevent="onKeyEnd"
    @keydown.meta.enter.exact.prevent="onKeySave"
    @keydown.ctrl.enter.exact.prevent="onKeySave"
    @keydown="onGlobalKeydown"
    @click="showColumnsMenu = false; cancelCellEdit(); closeContextMenu(); bulkStageDropdown = false; showFilterDropdown = false; kanbanCardMenu = null; showSaveViewPopover = false; colHeaderMenu = null; showStaleDropdown = false; groupMenu = null; kanbanColMenu = null; showTemplatePanel = false; showBulkTagDropdown = false; showFilterPresetsPanel = false; cancelKanbanInlineAdd(); showDetailColorPicker = false; showGalleryFieldsPopover = false; showTypeIconColorPicker = false"
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
                draggable="true"
                class="group/type flex items-center rounded-lg transition-colors"
                :class="[
                  selectedTypeKey === rt.key
                    ? 'bg-slate-100 dark:bg-slate-800'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
                  sidebarTypeDragOver === rt.key && sidebarTypeDragSrc !== rt.key ? 'ring-1 ring-sky-400 ring-inset' : '',
                  sidebarTypeDragSrc === rt.key ? 'opacity-40' : '',
                ]"
                @dragstart="(e) => { sidebarTypeDragSrc = rt.key; e.dataTransfer && (e.dataTransfer.effectAllowed = 'move'); }"
                @dragover.prevent="sidebarTypeDragOver = rt.key"
                @dragleave="sidebarTypeDragOver = null"
                @drop.prevent="dropSidebarTypeReorder(rt.key)"
                @dragend="() => { sidebarTypeDragSrc = null; sidebarTypeDragOver = null; }"
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
                  class="shrink-0 h-5 w-5 rounded flex items-center justify-center opacity-0 group-hover/type:opacity-100 transition-all text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700"
                  @click.stop="selectType(rt.key); openNewRecord()"
                >
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                </button>
                <!-- edit fields gear button, appears on hover -->
                <button
                  type="button"
                  :title="`Edit ${rt.label} fields`"
                  class="shrink-0 mr-2 h-5 w-5 rounded flex items-center justify-center opacity-0 group-hover/type:opacity-100 transition-all text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-slate-200 dark:hover:bg-slate-700"
                  @click.stop="selectType(rt.key); openSchemaEditor('fields')"
                >
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
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
              class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-violet-600 dark:hover:text-violet-400 transition-colors text-sm"
              title="Create a new record type"
              @click="openSchemaEditor('new-type')"
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

        <!-- ── Quick filter panel ── -->
        <transition
          enter-active-class="transition-all duration-200"
          enter-from-class="-translate-x-full opacity-0"
          enter-to-class="translate-x-0 opacity-100"
          leave-active-class="transition-all duration-150"
          leave-from-class="translate-x-0 opacity-100"
          leave-to-class="-translate-x-full opacity-0"
        >
          <aside
            v-if="showQuickFilterPanel && quickFilterFieldStats.length"
            class="shrink-0 w-52 flex flex-col border-r border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-y-auto"
            @click.stop
          >
            <!-- header -->
            <div class="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700 shrink-0">
              <span class="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">Filters</span>
              <button
                v-if="activeFilters.length"
                type="button"
                class="text-xs text-rose-500 dark:text-rose-400 hover:text-rose-600 dark:hover:text-rose-300 transition-colors"
                @click="clearFilters()"
              >Clear all</button>
            </div>
            <!-- per-field sections -->
            <div class="flex-1 overflow-y-auto">
              <div
                v-for="field in quickFilterFieldStats"
                :key="field.key"
                class="border-b border-slate-100 dark:border-slate-800 last:border-b-0"
              >
                <p class="px-4 pt-3 pb-2 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">{{ field.label }}</p>
                <div class="px-2 pb-2 space-y-0.5">
                  <button
                    v-for="opt in field.options"
                    :key="opt.value"
                    type="button"
                    class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors"
                    :class="opt.active
                      ? 'bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-300'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'"
                    @click="toggleFilter(field.key, opt.value)"
                  >
                    <!-- checkbox indicator -->
                    <span
                      class="shrink-0 h-3.5 w-3.5 rounded flex items-center justify-center border transition-colors"
                      :class="opt.active
                        ? 'bg-sky-500 border-sky-500'
                        : 'border-slate-300 dark:border-slate-600'"
                    >
                      <svg v-if="opt.active" class="h-2.5 w-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </span>
                    <!-- stage dot for select fields -->
                    <span
                      v-if="field.dataType === 'select'"
                      class="shrink-0 h-1.5 w-1.5 rounded-full"
                      :class="stageDot(opt.value)"
                    />
                    <span class="flex-1 truncate text-left">{{ opt.value }}</span>
                    <span class="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">{{ opt.count }}</span>
                  </button>
                </div>
              </div>
            </div>
          </aside>
        </transition>

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
              class="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800 transition-colors"
              :title="`Set a field for ${selectedIds.size} record${selectedIds.size === 1 ? '' : 's'}`"
              @click="showBulkFieldModal = true"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
              Set field
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

            <!-- bulk color label -->
            <div class="relative flex items-center gap-1 h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-slate-900/60" title="Set color label for selected records">
              <button
                v-for="c in COLOR_LABEL_PALETTE"
                :key="c"
                type="button"
                class="h-3.5 w-3.5 rounded-full transition-transform hover:scale-125 focus:outline-none flex-shrink-0"
                :style="{ background: c }"
                @click="[...selectedIds].forEach(id => setColorLabel(id, c))"
              />
              <button
                type="button"
                class="h-3.5 w-3.5 rounded-full flex items-center justify-center text-slate-400 border border-slate-300 dark:border-slate-600 hover:text-slate-600 transition-colors"
                title="Clear color labels"
                @click="[...selectedIds].forEach(id => setColorLabel(id, ''))"
              >
                <svg class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <!-- bulk tag -->
            <div class="relative" @click.stop>
              <button
                type="button"
                class="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm border transition-colors"
                :class="showBulkTagDropdown
                  ? 'border-violet-300 dark:border-violet-700 bg-violet-50 dark:bg-violet-950/30 text-violet-600 dark:text-violet-400'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800'"
                :title="`Add tag to ${selectedIds.size} selected record${selectedIds.size === 1 ? '' : 's'}`"
                @click="showBulkTagDropdown = !showBulkTagDropdown; bulkTagInput = ''"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
                Tag
              </button>
              <div
                v-if="showBulkTagDropdown"
                class="absolute top-full mt-1 left-0 z-40 w-56 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-lg py-2"
              >
                <div class="px-3 mb-2">
                  <input
                    v-model="bulkTagInput"
                    type="text"
                    placeholder="Type a tag and press Enter"
                    class="w-full h-7 rounded-lg px-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-400/40"
                    @keydown.enter.prevent="addBulkTag(bulkTagInput); showBulkTagDropdown = false"
                    @keydown.esc.stop="showBulkTagDropdown = false"
                  />
                </div>
                <template v-if="allTags.length">
                  <p class="px-3 pb-1 text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide">Existing tags</p>
                  <button
                    v-for="tag in allTags.slice(0, 10)"
                    :key="tag"
                    type="button"
                    class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    @click="addBulkTag(tag); showBulkTagDropdown = false"
                  >
                    <svg class="h-3 w-3 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" /></svg>
                    {{ tag }}
                  </button>
                </template>
              </div>
            </div>
            <!-- bulk duplicate -->
            <button
              type="button"
              class="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800 transition-colors"
              :title="`Duplicate ${selectedIds.size} selected record${selectedIds.size === 1 ? '' : 's'}`"
              @click="bulkDuplicate()"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Duplicate
            </button>
            <button
              type="button"
              class="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800 transition-colors"
              :title="`Archive ${selectedIds.size} selected record${selectedIds.size === 1 ? '' : 's'}`"
              @click="archiveSelected()"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8l1 12a2 2 0 002 2h8a2 2 0 002-2L19 8" />
              </svg>
              Archive
            </button>
            <!-- bulk watch / unwatch -->
            <button
              type="button"
              class="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm border transition-colors"
              :class="[...selectedIds].every(id => watchedIds.has(id))
                ? 'border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/30 text-sky-600 dark:text-sky-400 hover:bg-sky-100 dark:hover:bg-sky-900/30'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800'"
              :title="[...selectedIds].every(id => watchedIds.has(id))
                ? `Unwatch ${selectedIds.size} record${selectedIds.size === 1 ? '' : 's'}`
                : `Watch ${selectedIds.size} record${selectedIds.size === 1 ? '' : 's'}`"
              @click="[...selectedIds].every(id => watchedIds.has(id)) ? bulkWatch(false) : bulkWatch(true)"
            >
              <svg
                class="h-4 w-4"
                :fill="[...selectedIds].every(id => watchedIds.has(id)) ? 'currentColor' : 'none'"
                stroke="currentColor"
                viewBox="0 0 24 24"
                stroke-width="2"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
              Watch
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

            <!-- quick filter panel toggle -->
            <button
              v-if="quickFilterFieldStats.length"
              type="button"
              class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border transition-colors"
              :class="showQuickFilterPanel
                ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200'"
              title="Toggle filter panel"
              @click.stop="showQuickFilterPanel = !showQuickFilterPanel"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h8m-8 6h16" />
              </svg>
              Filters
            </button>
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
                      v-for="col in allColumns.filter(c => (c.data_type === 'select' || c.data_type === 'multi_select') && (c.select_options?.length ?? 0) > 0)"
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
                      @click="toggleFilter(filterPickerField, opt)"
                    >
                      <svg
                        v-if="activeFilters.some(f => f.fieldKey === filterPickerField && f.value === opt)"
                        class="h-3 w-3 text-sky-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"
                      ><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
                      <span v-else class="h-2 w-2 rounded-full shrink-0 mt-0.5" :class="stageDot(opt)" />
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

            <!-- archived filter chip -->
            <div
              v-if="archivedCountForType > 0"
              class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium cursor-pointer select-none transition-colors"
              :class="showArchived
                ? 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 border border-slate-400 dark:border-slate-500'
                : 'bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 hover:text-slate-600 dark:hover:text-slate-300'"
              :title="showArchived ? 'Back to active records' : `Show ${archivedCountForType} archived record${archivedCountForType === 1 ? '' : 's'}`"
              @click="showArchived = !showArchived"
            >
              <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8l1 12a2 2 0 002 2h8a2 2 0 002-2L19 8" />
              </svg>
              <span>{{ showArchived ? 'Archived' : `${archivedCountForType} archived` }}</span>
              <button
                v-if="showArchived"
                type="button"
                class="ml-0.5 rounded-full hover:bg-slate-300 dark:hover:bg-slate-600 p-0.5 transition-colors"
                aria-label="Back to active records"
                title="Back to active records"
                @click.stop="showArchived = false"
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

            <!-- expand/collapse all groups — only shown when grouping is active in table view -->
            <button
              v-if="groupByField && viewMode === 'table'"
              type="button"
              class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border border-violet-300 dark:border-violet-700 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-colors"
              :title="collapsedGroups.size ? 'Expand all groups' : 'Collapse all groups'"
              @click="collapsedGroups = collapsedGroups.size ? new Set() : new Set((groupedTableRows ?? []).filter(r => r.kind === 'header').map(r => r.key))"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path v-if="collapsedGroups.size" stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                <path v-else stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7M5 9l7-7 7 7" />
              </svg>
              {{ collapsedGroups.size ? 'Expand all' : 'Collapse all' }}
            </button>

            <!-- color label filter — only visible when any record in this type has a color label -->
            <div
              v-if="usedColorLabels.length"
              class="flex items-center gap-1 h-9 px-2.5 rounded-lg border transition-colors"
              :class="colorLabelFilter ? 'border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-800' : 'border-slate-200 dark:border-slate-700'"
              :title="colorLabelFilter ? 'Filtering by color label — click to clear' : 'Filter by color label'"
            >
              <button
                v-for="c in usedColorLabels"
                :key="c"
                type="button"
                class="h-4 w-4 rounded-full transition-transform hover:scale-125 focus:outline-none flex-shrink-0"
                :style="{ background: c, boxShadow: colorLabelFilter === c ? `0 0 0 2px white, 0 0 0 3.5px ${c}` : 'none' }"
                @click="colorLabelFilter = colorLabelFilter === c ? null : c"
              />
              <button
                v-if="colorLabelFilter"
                type="button"
                class="ml-0.5 h-3.5 w-3.5 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                title="Clear color filter"
                @click="colorLabelFilter = null"
              >
                <svg class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <!-- created date preset filter -->
            <div class="flex items-center rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden h-9">
              <button
                v-for="(label, preset) in ({ today: 'Today', week: 'Week', month: 'Month' } as const)"
                :key="preset"
                type="button"
                class="h-full px-2.5 text-xs font-medium transition-colors border-r border-slate-200 dark:border-slate-700 last:border-0"
                :class="createdPreset === preset
                  ? 'bg-violet-500 text-white'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'"
                :title="`Filter: created ${label.toLowerCase()}`"
                @click="createdPreset = createdPreset === preset ? null : preset"
              >{{ label }}</button>
            </div>

            <!-- overdue / due-soon filters — only when a date field exists -->
            <template v-if="dueDateField">
              <button
                type="button"
                class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border transition-colors"
                :class="showOverdueOnly
                  ? 'border-rose-300 dark:border-rose-700 bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'"
                :title="showOverdueOnly ? 'Clear overdue filter' : `Show overdue records (${overdueIds.size} total)`"
                @click="showOverdueOnly = !showOverdueOnly; showDueSoonOnly = false"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                Overdue<span v-if="overdueIds.size" class="ml-1 text-xs tabular-nums opacity-70">({{ overdueIds.size }})</span>
              </button>
              <button
                type="button"
                class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border transition-colors"
                :class="showDueSoonOnly
                  ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'"
                :title="showDueSoonOnly ? 'Clear due-soon filter' : `Show records due within 7 days (${dueSoonIds.size} total)`"
                @click="showDueSoonOnly = !showDueSoonOnly; showOverdueOnly = false"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Due soon<span v-if="dueSoonIds.size" class="ml-1 text-xs tabular-nums opacity-70">({{ dueSoonIds.size }})</span>
              </button>
            </template>
            <!-- stale records filter -->
            <div class="relative">
              <button
                type="button"
                class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border transition-colors"
                :class="staleDaysFilter
                  ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200'"
                :title="staleDaysFilter ? `Showing records with no activity in ${staleDaysFilter}+ days` : 'Show stale records'"
                @click.stop="showStaleDropdown = !showStaleDropdown"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {{ staleDaysFilter ? `Stale ${staleDaysFilter}d` : 'Stale' }}
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
                  v-if="showStaleDropdown"
                  class="absolute top-full right-0 mt-1 z-40 w-40 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-lg py-1"
                  @click.stop
                >
                  <p class="px-3 pt-1.5 pb-1 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">No activity in</p>
                  <button
                    v-for="days in [7, 14, 30, 60]"
                    :key="days"
                    type="button"
                    class="w-full flex items-center justify-between px-3 py-2 text-sm transition-colors"
                    :class="staleDaysFilter === days
                      ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'"
                    @click="staleDaysFilter = staleDaysFilter === days ? null : days; showStaleDropdown = false"
                  >
                    {{ days }}+ days
                    <svg v-if="staleDaysFilter === days" class="h-3.5 w-3.5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
                  </button>
                  <div v-if="staleDaysFilter" class="border-t border-slate-100 dark:border-slate-800 mt-1 pt-1">
                    <button
                      type="button"
                      class="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                      @click="staleDaysFilter = null; showStaleDropdown = false"
                    >
                      <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      Clear
                    </button>
                  </div>
                </div>
              </transition>
            </div>

            <!-- tag filter — only when tags exist -->
            <div v-if="allTags.length" class="relative">
              <button
                type="button"
                class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border transition-colors"
                :class="tagFilter
                  ? 'border-teal-300 dark:border-teal-700 bg-teal-50 dark:bg-teal-950/30 text-teal-600 dark:text-teal-400 hover:bg-teal-100 dark:hover:bg-teal-900/30'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200'"
                :title="tagFilter ? `Filtered by tag: ${tagFilter}` : 'Filter by tag'"
                @click.stop="$event.currentTarget.nextElementSibling?.classList.toggle('hidden')"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.75">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-5 5a2 2 0 01-2.828 0l-7-7A2 2 0 013 10V5a2 2 0 012-2z" />
                </svg>
                {{ tagFilter ?? 'Tags' }}
                <svg v-if="tagFilter" class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" @click.stop="tagFilter = null">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <div class="hidden absolute top-full left-0 mt-1 z-50 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg py-1 min-w-[140px]">
                <button
                  v-for="t in allTags"
                  :key="t"
                  type="button"
                  class="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  :class="tagFilter === t ? 'text-teal-600 dark:text-teal-400 font-medium' : 'text-slate-700 dark:text-slate-300'"
                  @click="tagFilter = tagFilter === t ? null : t; $event.currentTarget.closest('.relative')?.querySelector('.hidden')?.classList.add('hidden')"
                >
                  <svg v-if="tagFilter === t" class="h-3.5 w-3.5 text-teal-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
                  <span v-else class="h-3.5 w-3.5" />
                  {{ t }}
                </button>
              </div>
            </div>

            <!-- filter presets -->
            <div class="relative" @click.stop>
              <button
                type="button"
                class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border transition-colors"
                :class="typeFilterPresets.length
                  ? 'border-indigo-200 dark:border-indigo-700 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/30'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200'"
                :title="typeFilterPresets.length ? `${typeFilterPresets.length} saved filter preset${typeFilterPresets.length === 1 ? '' : 's'}` : 'Save or apply filter presets'"
                @click="showFilterPresetsPanel = !showFilterPresetsPanel; filterPresetNameInput = ''"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.75">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
                Presets<span v-if="typeFilterPresets.length" class="ml-1 text-xs tabular-nums opacity-70">({{ typeFilterPresets.length }})</span>
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
                  v-if="showFilterPresetsPanel"
                  class="absolute top-full right-0 mt-1 z-50 w-64 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl overflow-hidden"
                  @click.stop
                >
                  <!-- save current as preset — only shown when filters are active -->
                  <div v-if="hasAnyFilter" class="p-3 border-b border-slate-100 dark:border-slate-800">
                    <p class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Save current filters</p>
                    <div class="flex gap-2">
                      <input
                        v-model="filterPresetNameInput"
                        type="text"
                        placeholder="Preset name…"
                        class="flex-1 min-w-0 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-2.5 py-1.5 outline-none focus:border-indigo-400 dark:focus:border-indigo-500 focus:ring-1 focus:ring-indigo-200 dark:focus:ring-indigo-800"
                        @keydown.enter.prevent="saveFilterPreset"
                        @keydown.esc.stop="showFilterPresetsPanel = false"
                      />
                      <button
                        type="button"
                        :disabled="!filterPresetNameInput.trim()"
                        class="shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                        :class="filterPresetNameInput.trim()
                          ? 'bg-indigo-500 hover:bg-indigo-600 text-white'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed'"
                        @click="saveFilterPreset"
                      >Save</button>
                    </div>
                  </div>
                  <!-- no active filters — prompt to set some first -->
                  <div v-else-if="!typeFilterPresets.length" class="p-4 text-center">
                    <p class="text-sm text-slate-400 dark:text-slate-500">Apply some filters first, then save them here as a named preset.</p>
                  </div>
                  <!-- saved presets list -->
                  <div v-if="typeFilterPresets.length" class="max-h-64 overflow-y-auto">
                    <p class="px-3 pt-3 pb-1.5 text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Saved presets</p>
                    <div
                      v-for="preset in typeFilterPresets"
                      :key="preset.id"
                      class="group/fp flex items-center gap-2 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      <button
                        type="button"
                        class="flex-1 min-w-0 text-left text-sm text-slate-700 dark:text-slate-300 truncate"
                        :title="`Apply preset: ${preset.name}`"
                        @click="applyFilterPreset(preset)"
                      >{{ preset.name }}</button>
                      <button
                        type="button"
                        class="shrink-0 opacity-0 group-hover/fp:opacity-100 text-slate-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 transition-all"
                        :title="`Delete preset: ${preset.name}`"
                        @click="deleteFilterPreset(preset.id)"
                      >
                        <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <!-- no presets yet but filters active -->
                  <div v-else class="pb-3 px-3">
                    <p class="text-xs text-slate-400 dark:text-slate-500">No saved presets yet for this record type.</p>
                  </div>
                </div>
              </transition>
            </div>

            <!-- conditional formatting button — table view only -->
            <button
              v-if="viewMode === 'table'"
              type="button"
              class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border transition-colors"
              :class="conditionalRules.length
                ? 'border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-950/30 text-purple-600 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/30'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200'"
              :title="conditionalRules.length ? `${conditionalRules.length} formatting rule${conditionalRules.length === 1 ? '' : 's'} active` : 'Conditional row formatting'"
              @click="showFormatPanel = true"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
              </svg>
              Format{{ conditionalRules.length ? ` (${conditionalRules.length})` : '' }}
            </button>

            <!-- import button -->
            <button
              type="button"
              class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
              title="Import records from CSV"
              @click="openImportModal"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l4-4m0 0l4 4m-4-4v12" />
              </svg>
              Import
            </button>

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

            <!-- view toggle — table always available; board when type has select field; calendar when type has date field -->
            <div
              v-if="canKanban || canCalendar"
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
              <!-- kanban compact toggle -->
              <button
                v-if="viewMode === 'kanban'"
                type="button"
                class="flex items-center gap-1 px-2 h-9 text-xs border-l border-slate-200 dark:border-slate-700 transition-colors"
                :class="kanbanCompact
                  ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'
                  : 'text-slate-400 dark:text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/60'"
                title="Toggle compact kanban cards"
                @click="kanbanCompact = !kanbanCompact"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <!-- calendar view button — only when type has a date field -->
              <button
                v-if="canCalendar"
                type="button"
                class="flex items-center gap-1.5 px-3 h-9 text-sm border-l border-slate-200 dark:border-slate-700 transition-colors"
                :class="viewMode === 'calendar'
                  ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white font-medium'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60'"
                title="Calendar view (L)"
                @click="viewMode = 'calendar'"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
                </svg>
                Calendar
              </button>
              <!-- gallery view button -->
              <button
                type="button"
                class="flex items-center gap-1.5 px-3 h-9 text-sm border-l border-slate-200 dark:border-slate-700 transition-colors"
                :class="viewMode === 'gallery'
                  ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white font-medium'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60'"
                title="Gallery view"
                @click="viewMode = 'gallery'"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
                Gallery
              </button>
              <!-- gallery column-count picker — shown only in gallery mode -->
              <template v-if="viewMode === 'gallery'">
                <button
                  v-for="n in ([2, 3, 4] as const)"
                  :key="n"
                  type="button"
                  class="flex items-center justify-center w-7 h-9 text-xs border-l border-slate-200 dark:border-slate-700 transition-colors"
                  :class="galleryColCount === n
                    ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-semibold'
                    : 'text-slate-400 dark:text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/60'"
                  :title="`${n} columns`"
                  @click="galleryColCount = n"
                >{{ n }}</button>
              </template>
              <!-- gallery fields picker -->
              <div v-if="viewMode === 'gallery'" class="relative border-l border-slate-200 dark:border-slate-700" @click.stop>
                <button
                  type="button"
                  class="flex items-center gap-1 h-9 px-3 text-xs transition-colors"
                  :class="galleryPreviewFieldKeys[selectedTypeKey]?.length
                    ? 'text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/30'
                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'"
                  :title="galleryPreviewFieldKeys[selectedTypeKey]?.length ? `Card fields: ${(galleryPreviewFieldKeys[selectedTypeKey] ?? []).length} selected` : 'Choose which fields appear on cards'"
                  @click="showGalleryFieldsPopover = !showGalleryFieldsPopover"
                >
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 10h16M4 14h8" />
                  </svg>
                  Fields
                </button>
                <div
                  v-if="showGalleryFieldsPopover"
                  class="absolute top-full right-0 mt-1 z-40 w-52 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-lg py-2"
                >
                  <p class="px-3 pt-0.5 pb-2 text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide">Card preview fields</p>
                  <div class="space-y-0.5 px-1 max-h-60 overflow-y-auto">
                    <label
                      v-for="field in (selectedType?.fields ?? []).filter(f => !f.is_title).sort((a, b) => a.position - b.position)"
                      :key="field.key"
                      class="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        class="h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-600 text-sky-600"
                        :checked="(galleryPreviewFieldKeys[selectedTypeKey] ?? []).includes(field.key)"
                        @change="(() => {
                          const cur = galleryPreviewFieldKeys[selectedTypeKey] ?? [];
                          const checked = (($event as Event).target as HTMLInputElement).checked;
                          const next = checked ? [...cur, field.key] : cur.filter(k => k !== field.key);
                          galleryPreviewFieldKeys = { ...galleryPreviewFieldKeys, [selectedTypeKey]: next };
                        })()"
                      />
                      <span class="text-sm text-slate-700 dark:text-slate-300 truncate">{{ field.label }}</span>
                    </label>
                  </div>
                  <div class="px-3 pt-2 mt-1 border-t border-slate-100 dark:border-slate-800">
                    <button
                      type="button"
                      class="text-xs text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 transition-colors"
                      @click="galleryPreviewFieldKeys = { ...galleryPreviewFieldKeys, [selectedTypeKey]: [] }; showGalleryFieldsPopover = false"
                    >Reset to default (auto)</button>
                  </div>
                </div>
              </div>
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
                    Saves: type, filters{{ activeFilters.length ? ` (${activeFilters.length})` : '' }}{{ showPinnedOnly ? ', pinned-only' : '' }}{{ showWatchedOnly ? ', watching-only' : '' }}{{ showIncompleteOnly ? ', incomplete-only' : '' }}{{ groupByField ? `, grouped by ${allColumns.find(c => c.key === groupByField)?.label}` : '' }}{{ sortField ? `, sort: ${activeSortLabel}` : '' }}, view mode
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

            <!-- templates button + dropdown -->
            <div v-if="recordTemplates.filter(t => t.typeKey === selectedTypeKey).length" class="relative">
              <button
                type="button"
                class="flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm border border-violet-200 dark:border-violet-700 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-colors"
                title="Create from template"
                @click.stop="showTemplatePanel = !showTemplatePanel"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Templates
              </button>
              <div
                v-if="showTemplatePanel"
                class="absolute top-full right-0 mt-1 z-50 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg py-1.5 min-w-[200px]"
                @click.stop
              >
                <p class="px-3 pt-0.5 pb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">Templates</p>
                <button
                  v-for="tmpl in recordTemplates.filter(t => t.typeKey === selectedTypeKey)"
                  :key="tmpl.id"
                  type="button"
                  class="flex items-center justify-between w-full px-3 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  @click="applyTemplate(tmpl)"
                >
                  <span class="truncate">{{ tmpl.name }}</span>
                  <button
                    type="button"
                    class="ml-2 shrink-0 text-slate-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 rounded transition-colors"
                    :aria-label="`Delete template ${tmpl.name}`"
                    @click.stop="deleteTemplate(tmpl.id)"
                  >
                    <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </button>
              </div>
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
            v-if="activeFilters.length || groupByField || showOverdueOnly || showDueSoonOnly || Object.values(fieldTextFilters).some(v => v.trim()) || Object.values(numberMinFilters).some(v => v != null) || Object.values(numberMaxFilters).some(v => v != null) || Object.values(dateAfterFilters).some(v => v) || Object.values(dateBeforeFilters).some(v => v)"
            class="flex items-center gap-2 px-6 py-2.5 border-b border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-950/50 flex-wrap"
          >
            <!-- group-by chip -->
            <div
              v-if="groupByField"
              class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300"
            >
              <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h8m-8 6h16" />
              </svg>
              <span>Grouped by: <b>{{ allColumns.find(c => c.key === groupByField)?.label }}</b></span>
              <button
                type="button"
                class="ml-0.5 text-violet-400 hover:text-violet-600 dark:hover:text-violet-200 transition-colors leading-none"
                aria-label="Clear grouping"
                @click="groupByField = null"
              >
                <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <span v-if="activeFilters.length || Object.values(fieldTextFilters).some(v => v.trim()) || Object.values(numberMinFilters).some(v => v != null) || Object.values(numberMaxFilters).some(v => v != null) || Object.values(dateAfterFilters).some(v => v) || Object.values(dateBeforeFilters).some(v => v)" class="text-xs font-medium text-slate-500 dark:text-slate-400 shrink-0">Filtered by:</span>
            <!-- select-field filter chips -->
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
            <!-- text-field filter chips -->
            <template v-for="(val, fkey) in fieldTextFilters" :key="'tf:' + fkey">
              <div
                v-if="val.trim()"
                class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300"
              >
                <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803" />
                </svg>
                <span>{{ allColumns.find(c => c.key === fkey)?.label }} contains: <b>{{ val }}</b></span>
                <button
                  type="button"
                  class="ml-0.5 text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-200 transition-colors leading-none"
                  :aria-label="`Remove ${fkey} text filter`"
                  @click="fieldTextFilters = { ...fieldTextFilters, [fkey]: '' }"
                >
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </template>
            <!-- number range filter chips -->
            <template v-for="(minVal, fkey) in numberMinFilters" :key="'nmin:' + fkey">
              <div
                v-if="minVal != null"
                class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800 text-orange-700 dark:text-orange-300"
              >
                <span>{{ allColumns.find(c => c.key === fkey)?.label }} <b>≥ {{ minVal }}</b></span>
                <button
                  type="button"
                  class="ml-0.5 text-orange-400 hover:text-orange-600 dark:hover:text-orange-200 transition-colors leading-none"
                  :aria-label="`Remove ${fkey} min filter`"
                  @click="numberMinFilters = { ...numberMinFilters, [fkey]: null }"
                >
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </template>
            <template v-for="(maxVal, fkey) in numberMaxFilters" :key="'nmax:' + fkey">
              <div
                v-if="maxVal != null"
                class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800 text-orange-700 dark:text-orange-300"
              >
                <span>{{ allColumns.find(c => c.key === fkey)?.label }} <b>≤ {{ maxVal }}</b></span>
                <button
                  type="button"
                  class="ml-0.5 text-orange-400 hover:text-orange-600 dark:hover:text-orange-200 transition-colors leading-none"
                  :aria-label="`Remove ${fkey} max filter`"
                  @click="numberMaxFilters = { ...numberMaxFilters, [fkey]: null }"
                >
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </template>
            <!-- date range filter chips -->
            <template v-for="(val, fkey) in dateAfterFilters" :key="'dafter:' + fkey">
              <div
                v-if="val"
                class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-800 text-teal-700 dark:text-teal-300"
              >
                <span>{{ allColumns.find(c => c.key === fkey)?.label }} <b>after {{ val }}</b></span>
                <button type="button" class="ml-0.5 text-teal-400 hover:text-teal-600 dark:hover:text-teal-200 transition-colors leading-none" @click="dateAfterFilters = { ...dateAfterFilters, [fkey]: null }">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </template>
            <template v-for="(val, fkey) in dateBeforeFilters" :key="'dbefore:' + fkey">
              <div
                v-if="val"
                class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-800 text-teal-700 dark:text-teal-300"
              >
                <span>{{ allColumns.find(c => c.key === fkey)?.label }} <b>before {{ val }}</b></span>
                <button type="button" class="ml-0.5 text-teal-400 hover:text-teal-600 dark:hover:text-teal-200 transition-colors leading-none" @click="dateBeforeFilters = { ...dateBeforeFilters, [fkey]: null }">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </template>
            <!-- overdue filter chip -->
            <div
              v-if="showOverdueOnly"
              class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300"
            >
              <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>Overdue</span>
              <button
                type="button"
                class="ml-0.5 text-rose-400 hover:text-rose-600 dark:hover:text-rose-200 transition-colors leading-none"
                aria-label="Clear overdue filter"
                @click="showOverdueOnly = false"
              >
                <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <!-- due-soon filter chip -->
            <div
              v-if="showDueSoonOnly"
              class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300"
            >
              <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <circle cx="12" cy="12" r="9" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 7v5l3 3" />
              </svg>
              <span>Due soon</span>
              <button
                type="button"
                class="ml-0.5 text-amber-400 hover:text-amber-600 dark:hover:text-amber-200 transition-colors leading-none"
                aria-label="Clear due-soon filter"
                @click="showDueSoonOnly = false"
              >
                <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
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

          <!-- ── Record count status bar ── -->
          <div
            v-if="selectedType"
            class="flex items-center gap-4 px-6 py-1.5 border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-950 text-xs text-slate-400 dark:text-slate-500 select-none"
          >
            <span class="tabular-nums">
              {{ filteredRecords.length === 1 ? '1 record' : `${filteredRecords.length} records` }}
              <template v-if="filteredRecords.length !== mockRecords.filter(r => r.record_type_key === selectedTypeKey).length">
                <span class="opacity-60"> of {{ mockRecords.filter(r => r.record_type_key === selectedTypeKey).length }}</span>
              </template>
            </span>
            <span v-if="selectedIds.size" class="text-sky-500 dark:text-sky-400 font-medium tabular-nums">{{ selectedIds.size }} selected</span>
            <span
              v-if="filteredOverdueCount > 0 && !showOverdueOnly"
              class="text-rose-400 dark:text-rose-500 tabular-nums cursor-pointer hover:text-rose-600 dark:hover:text-rose-300 transition-colors"
              title="Show overdue only"
              @click="showOverdueOnly = true; showDueSoonOnly = false"
            >
              {{ filteredOverdueCount }} overdue
            </span>
            <span
              v-if="filteredDueSoonCount > 0 && !showDueSoonOnly"
              class="text-amber-400 dark:text-amber-500 tabular-nums cursor-pointer hover:text-amber-600 dark:hover:text-amber-300 transition-colors"
              title="Show due-soon only"
              @click="showDueSoonOnly = true; showOverdueOnly = false"
            >
              {{ filteredDueSoonCount }} due soon
            </span>
          </div>

          <!-- ── Table view ── -->
          <div
            v-if="viewMode === 'table'"
            ref="tableScrollEl"
            class="flex-1 overflow-auto"
            @scroll.passive="scrollPositions[selectedTypeKey] = ($event.target as HTMLElement).scrollTop"
          >
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
                    draggable="true"
                    class="relative px-4 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 whitespace-nowrap transition-colors"
                    :class="[
                      pinnedColumnKeys.has(col.key) ? 'sticky z-10 shadow-[2px_0_4px_rgba(0,0,0,0.06)]' : '',
                      colDragOver === col.key && colDragSrc !== col.key ? 'border-l-2 border-l-sky-500' : '',
                      colDragSrc === col.key ? 'opacity-40' : '',
                    ]"
                    :style="columnWidths[col.key] ? { width: `${columnWidths[col.key]}px`, minWidth: `${columnWidths[col.key]}px` } : undefined"
                    @contextmenu.prevent="openColHeaderMenu(col.key, $event)"
                    @dragstart.stop="(e) => { colDragSrc = col.key; e.dataTransfer && (e.dataTransfer.effectAllowed = 'move'); }"
                    @dragover.prevent="colDragOver = col.key"
                    @dragleave="colDragOver = null"
                    @drop.prevent="dropColReorder(col.key)"
                    @dragend="() => { colDragSrc = null; colDragOver = null; }"
                  >
                    <input
                      v-if="editingColKey === col.key"
                      data-col-rename-input
                      v-model="editingColLabel"
                      class="w-full min-w-0 text-xs font-semibold uppercase tracking-wide bg-white dark:bg-slate-900 border border-sky-400 dark:border-sky-500 rounded px-1 py-0.5 outline-none text-sky-600 dark:text-sky-400"
                      @keydown.enter.stop="commitColRename()"
                      @keydown.esc.stop="editingColKey = null"
                      @blur="commitColRename()"
                    />
                    <button
                      v-else
                      type="button"
                      class="flex items-center gap-1 text-left text-xs font-semibold uppercase tracking-wide transition-colors select-none"
                      :class="sortField === col.key || sortField2 === col.key
                        ? 'text-sky-600 dark:text-sky-400'
                        : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'"
                      :title="sortField2 && sortField !== col.key && sortField2 !== col.key ? 'Shift+click to add as secondary sort' : 'Double-click to rename'"
                      @click="toggleSort(col.key, $event.shiftKey)"
                      @dblclick.stop="startColRename(col)"
                    >
                      {{ col.label }}
                      <!-- secondary sort badge -->
                      <span
                        v-if="sortField2 === col.key"
                        class="inline-flex items-center rounded px-0.5 text-[9px] font-bold leading-none bg-sky-100 dark:bg-sky-900/40 text-sky-500 dark:text-sky-400"
                      >2</span>
                      <!-- sort indicator -->
                      <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                        <path
                          v-if="(sortField === col.key && sortDir === 'asc') || (sortField2 === col.key && sortDir2 === 'asc')"
                          stroke-linecap="round" stroke-linejoin="round"
                          d="M5 15l7-7 7 7"
                        />
                        <path
                          v-else-if="(sortField === col.key && sortDir === 'desc') || (sortField2 === col.key && sortDir2 === 'desc')"
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
                    <!-- column resize handle -->
                    <div
                      draggable="false"
                      class="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-sky-400/40 dark:hover:bg-sky-500/40 transition-colors"
                      title="Drag to resize column"
                      @mousedown.stop="onColResizeMouseDown($event, col.key, columnWidths[col.key] ?? (($event.currentTarget as HTMLElement).closest('th') as HTMLElement)?.offsetWidth ?? 160)"
                    />
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
                  <th class="w-20 px-3 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-right">
                    <button
                      type="button"
                      class="text-xs font-semibold uppercase tracking-wide transition-colors select-none"
                      :class="sortField === '__activity_count__'
                        ? 'text-sky-600 dark:text-sky-400'
                        : 'text-slate-300 dark:text-slate-700 hover:text-slate-500 dark:hover:text-slate-400'"
                      title="Sort by activity count"
                      @click="toggleSort('__activity_count__')"
                    >
                      <svg class="h-3 w-3 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                      </svg>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                <!-- group header rows when grouping is active -->
                <template v-if="groupedTableRows">
                  <template v-for="row in groupedTableRows" :key="row.kind === 'header' ? 'grp-' + row.key : row.record.id">
                    <!-- group header -->
                    <tr
                      v-if="row.kind === 'header'"
                      class="bg-slate-50 dark:bg-slate-950 cursor-pointer select-none"
                      @click="toggleGroupCollapse(row.key)"
                      @contextmenu.prevent="groupMenu = { key: row.key, label: row.label, count: row.count, x: $event.clientX, y: $event.clientY }"
                    >
                      <td :colspan="visibleColumns.length + 3" class="px-5 py-1.5">
                        <div class="flex items-center gap-2">
                          <svg
                            class="h-3.5 w-3.5 text-slate-400 transition-transform"
                            :class="collapsedGroups.has(row.key) ? '-rotate-90' : ''"
                            fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"
                          >
                            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                          </svg>
                          <span
                            class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                            :class="row.key === '__ungrouped__'
                              ? 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 italic'
                              : selectBadgeClass(row.label)"
                          >{{ row.label }}</span>
                          <span class="text-xs tabular-nums text-slate-400 dark:text-slate-500">{{ row.count }}</span>
                          <template v-for="col in visibleColumns.filter(c => c.data_type === 'number' && groupedStats[row.key]?.[c.key]?.count)" :key="col.key">
                            <span class="text-xs tabular-nums text-slate-400 dark:text-slate-500">·</span>
                            <span
                              class="text-xs tabular-nums font-medium text-slate-500 dark:text-slate-400"
                              :title="`${col.label}: Σ ${groupedStats[row.key][col.key].sum.toLocaleString()} · avg ${(groupedStats[row.key][col.key].sum / groupedStats[row.key][col.key].count).toLocaleString(undefined, { maximumFractionDigits: 1 })}`"
                            >
                              {{ col.format === 'currency' ? '$' : '' }}{{ groupedStats[row.key][col.key].sum >= 1000 ? (groupedStats[row.key][col.key].sum / 1000).toFixed(1) + 'k' : groupedStats[row.key][col.key].sum }}
                            </span>
                          </template>
                        </div>
                      </td>
                    </tr>
                    <!-- group record row (computed already excludes collapsed groups) -->
                    <template v-else>
                      <tr
                        class="group cursor-pointer transition-colors"
                        :class="openedRecord?.id === row.record.id
                          ? 'bg-sky-50 dark:bg-sky-950/20'
                          : 'hover:bg-white dark:hover:bg-slate-900'"
                        :style="(() => { const cl = colorLabels[row.record.id]; const cr = evaluateConditionalRules(row.record); return { ...(cl ? { boxShadow: `inset 3px 0 0 ${cl}` } : {}), ...(cr ? { background: cr + '18' } : {}) }; })()"
                        :data-record-id="row.record.id"
                        @click="openRecord(row.record)"
                        @contextmenu.prevent="openContextMenu(row.record, $event)"
                      >
                        <td class="pl-6 pr-2" :class="rowDensity === 'compact' ? 'py-1.5' : 'py-3'" @click.stop>
                          <input
                            type="checkbox"
                            :checked="selectedIds.has(row.record.id)"
                            class="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-sky-600 cursor-pointer"
                            @click="onCheckboxClick(row.record, row.idxInFiltered, $event)"
                          >
                        </td>
                        <td v-for="col in visibleColumns" :key="col.key" class="px-4" :class="[rowDensity === 'compact' ? 'py-1.5' : 'py-3']">
                          <CrmCellValue :value="row.record.field_values[col.key]" :data-type="col.data_type" :format="col.format" />
                        </td>
                        <td class="px-4" :class="rowDensity === 'compact' ? 'py-1.5' : 'py-3'">
                          <div class="flex items-center gap-1.5">
                            <span
                              v-if="activityCountByRecord[row.record.id]"
                              class="inline-flex items-center rounded-full px-1.5 py-0.5 text-xs tabular-nums font-medium bg-sky-50 dark:bg-sky-950/30 text-sky-600 dark:text-sky-400"
                              :title="`${activityCountByRecord[row.record.id]} activities`"
                            >{{ activityCountByRecord[row.record.id] }}</span>
                            <svg
                              v-if="staleDaysFilter && staleIds.has(row.record.id)"
                              class="h-3.5 w-3.5 text-amber-400 shrink-0"
                              fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"
                              :title="`No activity in ${staleDaysFilter}+ days`"
                            >
                              <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          </div>
                        </td>
                        <td class="w-10 px-4 opacity-0 group-hover:opacity-100 transition-opacity" :class="rowDensity === 'compact' ? 'py-1.5' : 'py-3'">
                          <button type="button" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded transition-colors" title="Open record" @click.stop="openRecord(row.record)">
                            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
                          </button>
                        </td>
                      </tr>
                    </template>
                  </template>
                </template>

                <!-- normal (non-grouped) rows -->
                <template v-else>
                <template v-for="(record, idx) in filteredRecords" :key="record.id">
                <tr
                  class="group cursor-pointer transition-colors"
                  :class="[openedRecord?.id === record.id
                    ? 'bg-sky-50 dark:bg-sky-950/20'
                    : 'hover:bg-white dark:hover:bg-slate-900',
                    dragOverId === record.id && dragSrcId !== record.id ? 'ring-inset ring-2 ring-sky-400' : '']"
                  :style="(() => { const cl = colorLabels[record.id]; const cr = evaluateConditionalRules(record); return { ...(cl ? { boxShadow: `inset 3px 0 0 ${cl}` } : {}), ...(cr ? { background: cr + '18' } : {}), opacity: dragSrcId === record.id ? '0.4' : undefined }; })()"
                  :data-record-id="record.id"
                  draggable="true"
                  @click="openRecord(record)"
                  @contextmenu.prevent="openContextMenu(record, $event)"
                  @dragstart="onRowDragStart($event, record.id)"
                  @dragover="onRowDragOver($event, record.id)"
                  @drop="onRowDrop($event, record.id)"
                  @dragend="onRowDragEnd"
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
                      pinnedColumnKeys.has(col.key) ? 'sticky z-[1] bg-inherit shadow-[2px_0_4px_rgba(0,0,0,0.04)]' : '',
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
                        <template v-else-if="col.data_type === 'text' && String(record.field_values[col.key] ?? '').length > 80">
                          <span :class="expandedRowIds.has(record.id) ? 'whitespace-pre-wrap break-words' : 'truncate block max-w-[220px]'">{{ record.field_values[col.key] }}</span>
                          <button
                            type="button"
                            class="ml-1 text-xs text-sky-500 dark:text-sky-400 hover:underline"
                            @click.stop="toggleRowExpand(record.id)"
                          >{{ expandedRowIds.has(record.id) ? 'less' : 'more' }}</button>
                        </template>
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
                      (() => {
                        const lastActive = lastActivityByRecord[record.id]
                          ?? (record.updated_at ? new Date(record.updated_at).getTime() : null)
                          ?? new Date(record.created_at).getTime();
                        const daysSince = (Date.now() - lastActive) / (1000 * 60 * 60 * 24);
                        return daysSince > 60
                          ? 'text-rose-400 dark:text-rose-600'
                          : daysSince > 30
                            ? 'text-amber-400 dark:text-amber-600'
                            : 'text-slate-400 dark:text-slate-500';
                      })(),
                    ]"
                    :title="(() => {
                      const lastTs = lastActivityByRecord[record.id];
                      const base = record.updated_at ? `Added ${formatDate(record.created_at)} · Updated ${formatDate(record.updated_at)}` : formatDate(record.created_at);
                      return lastTs ? `${base} · Last activity ${formatAge(new Date(lastTs).toISOString())}` : base;
                    })()"
                  >
                    <div>{{ formatAge(record.updated_at ?? record.created_at) }}</div>
                    <div v-if="record.updated_at" class="text-[10px] text-slate-300 dark:text-slate-700 leading-none mt-0.5">upd</div>
                  </td>
                  <td class="w-20 px-3" :class="rowDensity === 'compact' ? 'py-1.5' : 'py-3'">
                    <div class="flex items-center justify-end gap-1">
                      <button
                        v-if="activityCountByRecord[record.id]"
                        type="button"
                        class="shrink-0 h-4 min-w-[1rem] rounded-full px-1 text-[10px] tabular-nums font-medium bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 hover:bg-sky-100 dark:hover:bg-sky-900/30 hover:text-sky-500 dark:hover:text-sky-400 transition-colors"
                        :title="`${activityCountByRecord[record.id]} activit${activityCountByRecord[record.id] === 1 ? 'y' : 'ies'}`"
                        @click.stop="openRecord(record); nextTick(() => { detailTab = 'activity'; })"
                      >{{ activityCountByRecord[record.id] }}</button>
                      <svg
                        v-if="staleDaysFilter && staleIds.has(record.id)"
                        class="h-3.5 w-3.5 text-amber-400 shrink-0"
                        fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"
                        :title="`No activity in ${staleDaysFilter}+ days`"
                      >
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <!-- due-date urgency badges -->
                      <svg
                        v-if="overdueIds.has(record.id)"
                        class="h-3.5 w-3.5 text-rose-400 shrink-0"
                        fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"
                        :title="`Overdue — ${dueDateField?.label}: ${record.field_values[dueDateField?.key ?? '']}`"
                      >
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <svg
                        v-else-if="dueSoonIds.has(record.id)"
                        class="h-3.5 w-3.5 text-amber-400 shrink-0"
                        fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"
                        :title="`Due soon — ${dueDateField?.label}: ${record.field_values[dueDateField?.key ?? '']}`"
                      >
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
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
                </template><!-- end non-grouped -->

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
                <tr v-if="!creatingRecord && !showInlineAdd" class="group/addrow">
                  <td :colspan="visibleColumns.length + 3" class="px-6 py-1.5">
                    <button
                      type="button"
                      class="flex items-center gap-1.5 text-xs text-slate-300 dark:text-slate-700 hover:text-sky-500 dark:hover:text-sky-400 transition-colors py-1"
                      @click="showInlineAdd = true"
                    >
                      <svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
                      </svg>
                      Add {{ selectedType?.label ?? 'record' }}
                    </button>
                  </td>
                </tr>
                <!-- inline add input row -->
                <tr v-else-if="showInlineAdd" class="bg-sky-50/50 dark:bg-sky-950/10">
                  <td class="pl-6 pr-2 py-2" />
                  <td :colspan="visibleColumns.length + 1" class="px-3 py-2">
                    <input
                      ref="inlineAddInputEl"
                      v-model="inlineAddTitle"
                      type="text"
                      :placeholder="`New ${selectedType?.label ?? 'record'} title…`"
                      class="w-full rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-slate-900 border border-sky-300 dark:border-sky-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                      @keydown.enter.prevent="commitInlineAdd"
                      @keydown.esc.stop="showInlineAdd = false; inlineAddTitle = ''"
                    >
                  </td>
                  <td class="pr-4 py-2">
                    <div class="flex items-center gap-1.5">
                      <button
                        type="button"
                        class="h-7 px-2.5 rounded-lg text-xs font-medium bg-sky-500 hover:bg-sky-600 text-white transition-colors"
                        @click="commitInlineAdd"
                      >Save</button>
                      <button
                        type="button"
                        class="h-7 px-2 rounded-lg text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                        @click="showInlineAdd = false; inlineAddTitle = ''"
                      >
                        <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
              <!-- column totals footer — only when at least one numeric column exists -->
              <tfoot v-if="hasTableTotals && filteredRecords.length > 1">
                <tr class="bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800">
                  <td class="pl-6 pr-2 py-2">
                    <button
                      type="button"
                      class="text-[10px] font-semibold uppercase tracking-wider transition-colors"
                      :class="Object.keys(colAggOverrides).length
                        ? 'text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300'
                        : 'text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300'"
                      :title="Object.keys(colAggOverrides).length ? 'Click to reset all columns to global mode' : `Global mode: click to cycle (${COL_STAT_MODES.join(' → ')})`"
                      @click="Object.keys(colAggOverrides).length ? colAggOverrides = {} : colStatMode = COL_STAT_MODES[(COL_STAT_MODES.indexOf(colStatMode) + 1) % COL_STAT_MODES.length]"
                    >{{ colStatMode }}</button>
                  </td>
                  <td
                    v-for="col in visibleColumns"
                    :key="col.key"
                    class="px-4 py-2 text-xs"
                    :class="tableColumnStats[col.key] !== null ? 'text-slate-700 dark:text-slate-300' : ''"
                  >
                    <button
                      v-if="tableColumnStats[col.key] !== null"
                      type="button"
                      class="group/agg flex flex-col items-start gap-0.5 w-full text-left tabular-nums font-medium hover:text-sky-600 dark:hover:text-sky-400 transition-colors"
                      :title="`${colAggOverrides[col.key] ?? colStatMode}: click to cycle per-column · Sum: ${tableColumnStats[col.key]!.sum.toLocaleString()} · Avg: ${tableColumnStats[col.key]!.avg.toLocaleString(undefined, { maximumFractionDigits: 1 })} · Min: ${tableColumnStats[col.key]!.min.toLocaleString()} · Max: ${tableColumnStats[col.key]!.max.toLocaleString()} · Count: ${tableColumnStats[col.key]!.count}`"
                      @click="(() => { const cur = colAggOverrides[col.key] ?? colStatMode; const next = COL_STAT_MODES[(COL_STAT_MODES.indexOf(cur) + 1) % COL_STAT_MODES.length]; colAggOverrides = { ...colAggOverrides, [col.key]: next }; })()"
                    >
                      <span>{{ (colAggOverrides[col.key] ?? colStatMode) === 'count' ? tableColumnStats[col.key]!.count : formatCardValue(tableColumnTotals[col.key], 'number', col.format) }}</span>
                      <span
                        class="text-[10px] font-semibold uppercase tracking-wider opacity-0 group-hover/agg:opacity-100 transition-opacity"
                        :class="colAggOverrides[col.key] ? 'text-sky-500 dark:text-sky-400' : 'text-slate-400 dark:text-slate-500'"
                      >{{ colAggOverrides[col.key] ?? colStatMode }}</span>
                    </button>
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
                    wipLimits[col] && (kanbanGroups[col] ?? []).length > wipLimits[col] ? 'bg-red-50/60 dark:bg-red-950/10 ring-1 ring-red-200 dark:ring-red-900/40' : '',
                    openedRecord && kanbanField && String(openedRecord.field_values[kanbanField.key] ?? (col === KANBAN_UNASSIGNED ? col : '')) === col
                      ? 'bg-sky-50 dark:bg-sky-950/20 ring-1 ring-sky-200 dark:ring-sky-800/60'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
                  ]"
                  :title="collapsedColumns.has(col) ? `Expand ${col === KANBAN_UNASSIGNED ? 'Unassigned' : col}` : `Collapse ${col === KANBAN_UNASSIGNED ? 'Unassigned' : col}`"
                  @click="toggleColumnCollapse(col)"
                  @contextmenu.prevent="kanbanColMenu = { col, x: $event.clientX, y: $event.clientY }"
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
                    class="ml-auto text-xs tabular-nums font-medium shrink-0 flex items-center gap-1"
                    :class="wipLimits[col] && (kanbanGroups[col] ?? []).length > wipLimits[col] ? 'text-red-500 dark:text-red-400' : 'text-slate-400 dark:text-slate-500'"
                  >
                    <template v-if="(searchQuery || activeFilters.length) && (kanbanGroups[col] ?? []).length !== (kanbanGroupsTotal[col] ?? 0)">
                      <span class="text-sky-500 dark:text-sky-400">{{ (kanbanGroups[col] ?? []).length }}</span> of {{ kanbanGroupsTotal[col] ?? 0 }}
                    </template>
                    <template v-else>{{ (kanbanGroups[col] ?? []).length }}</template>
                    <template v-if="wipLimits[col]">
                      <span class="opacity-50">/</span>{{ wipLimits[col] }}
                      <svg v-if="(kanbanGroups[col] ?? []).length > wipLimits[col]" class="h-3 w-3 text-red-400" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" /></svg>
                    </template>
                    <template v-if="kanbanColumnTotals[col]"> · {{ kanbanColumnTotals[col] }}</template>
                  </span>
                  <span
                    v-else
                    class="text-xs tabular-nums font-semibold text-slate-500 dark:text-slate-400"
                  >{{ (kanbanGroups[col] ?? []).length }}</span>
                </div>

                <!-- column completion bar -->
                <div
                  v-if="!collapsedColumns.has(col) && (kanbanGroups[col] ?? []).length > 0"
                  class="h-1 rounded-full bg-slate-100 dark:bg-slate-800 mb-2.5 overflow-hidden"
                  :title="`${kanbanColCompletionPct[col] ?? 0}% of records fully filled`"
                >
                  <div
                    class="h-full rounded-full transition-all duration-300"
                    :class="(kanbanColCompletionPct[col] ?? 0) === 100
                      ? 'bg-emerald-400 dark:bg-emerald-500'
                      : (kanbanColCompletionPct[col] ?? 0) >= 50
                        ? 'bg-sky-400 dark:bg-sky-500'
                        : 'bg-slate-300 dark:bg-slate-600'"
                    :style="{ width: `${kanbanColCompletionPct[col] ?? 0}%` }"
                  />
                </div>

                <!-- cards -->
                <div v-if="!collapsedColumns.has(col)" class="flex-1 space-y-2 overflow-y-auto pb-2 pr-0.5">
                  <button
                    v-for="record in (kanbanGroups[col] ?? [])"
                    :key="record.id"
                    type="button"
                    class="group/card w-full text-left rounded-xl border shadow-sm transition-all"
                    :class="[openedRecord?.id === record.id
                      ? 'bg-sky-50 dark:bg-sky-950/30 border-sky-200 dark:border-sky-800 shadow-md'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700',
                      kanbanCompact ? 'p-2' : 'p-3.5']"
                    :style="colorLabels[record.id] ? { borderTopColor: colorLabels[record.id], borderTopWidth: '3px' } : undefined"
                    @click="openRecord(record)"
                  >
                    <p class="text-sm font-medium text-slate-900 dark:text-white leading-snug line-clamp-2 flex items-start gap-1.5" :class="kanbanCompact ? 'mb-0' : 'mb-2'">
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
                    <!-- urgency chip for kanban cards -->
                    <span
                      v-if="!kanbanCompact && (overdueIds.has(record.id) || dueSoonIds.has(record.id))"
                      class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium mb-1.5"
                      :class="overdueIds.has(record.id)
                        ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-500 dark:text-rose-400'
                        : 'bg-amber-50 dark:bg-amber-950/40 text-amber-500 dark:text-amber-400'"
                    >
                      <svg class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                        <path v-if="overdueIds.has(record.id)" stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        <path v-else stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {{ overdueIds.has(record.id) ? 'Overdue' : 'Due soon' }}
                    </span>
                    <div v-if="!kanbanCompact" class="space-y-1">
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
                    <div v-if="!kanbanCompact" class="flex items-center justify-between mt-2 opacity-0 group-hover/card:opacity-100 transition-opacity">
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

                <!-- add card placeholder — inline if active, button otherwise -->
                <div v-if="kanbanInlineAdd?.col === col" class="rounded-xl border border-sky-200 dark:border-sky-700 bg-white dark:bg-slate-900 p-3 space-y-2" @click.stop>
                  <input
                    ref="kanbanInlineInputEl"
                    v-model="kanbanInlineTitle"
                    type="text"
                    placeholder="Record title…"
                    class="w-full text-sm rounded-lg px-2.5 py-1.5 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-400 dark:focus:ring-sky-500"
                    @keydown.enter.prevent="commitKanbanInlineAdd"
                    @keydown.esc.stop="cancelKanbanInlineAdd"
                  />
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="flex-1 text-xs font-medium bg-sky-500 hover:bg-sky-600 text-white rounded-lg px-2 py-1.5 transition-colors"
                      :disabled="!kanbanInlineTitle.trim()"
                      @click="commitKanbanInlineAdd"
                    >Add</button>
                    <button
                      type="button"
                      class="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                      @click="cancelKanbanInlineAdd"
                    >Cancel</button>
                  </div>
                </div>
                <button
                  v-else
                  type="button"
                  class="w-full text-left rounded-xl border border-dashed border-slate-200 dark:border-slate-800 p-3 text-xs text-slate-400 dark:text-slate-600 hover:border-slate-300 dark:hover:border-slate-700 hover:text-slate-500 dark:hover:text-slate-500 transition-colors"
                  @click="startKanbanInlineAdd(col)"
                >
                  + Add record
                </button>
                </div>
              </div>

              <!-- add column -->
              <div class="flex flex-col w-48 shrink-0">
                <div v-if="showAddStageInput" class="space-y-1.5 px-1">
                  <input
                    ref="addStageInputEl"
                    v-model="newStageName"
                    type="text"
                    placeholder="Stage name"
                    class="h-8 w-full rounded-lg px-3 text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                    @keydown.enter.prevent="commitAddStage"
                    @keydown.esc.stop="showAddStageInput = false"
                  />
                  <div class="flex gap-1">
                    <button type="button" class="flex-1 h-7 rounded-lg text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 transition-colors" @click="commitAddStage">Add</button>
                    <button type="button" class="h-7 px-2 rounded-lg text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" @click="showAddStageInput = false">Cancel</button>
                  </div>
                </div>
                <button
                  v-else
                  type="button"
                  class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors opacity-60 hover:opacity-100"
                  title="Add a new stage column"
                  @click="showAddStageInput = true"
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

        <!-- ── Calendar view ── -->
        <div v-if="viewMode === 'calendar' && canCalendar" class="flex-1 flex flex-col overflow-hidden">
          <!-- calendar nav bar -->
          <div class="flex items-center gap-3 px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 shrink-0">
            <button
              type="button"
              class="h-7 px-2 rounded-md text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              @click="calendarViewMode === 'week' ? calPrevWeek() : calPrevMonth()"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>
            </button>
            <span class="font-semibold text-sm text-slate-800 dark:text-slate-200 min-w-[180px] text-center">
              {{ calendarViewMode === 'week' ? calWeekLabel : `${MONTH_NAMES[calendarMonth]} ${calendarYear}` }}
            </span>
            <button
              type="button"
              class="h-7 px-2 rounded-md text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              @click="calendarViewMode === 'week' ? calNextWeek() : calNextMonth()"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
            </button>
            <button
              type="button"
              class="h-7 px-3 rounded-md text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors"
              @click="calendarViewMode === 'week' ? calGoTodayWeek() : calGoToday()"
            >Today</button>
            <!-- month / week toggle -->
            <div class="flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden ml-2">
              <button
                type="button"
                class="h-7 px-2.5 text-xs transition-colors"
                :class="calendarViewMode === 'month'
                  ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-semibold'
                  : 'text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60'"
                @click="calendarViewMode = 'month'"
              >Month</button>
              <button
                type="button"
                class="h-7 px-2.5 text-xs border-l border-slate-200 dark:border-slate-700 transition-colors"
                :class="calendarViewMode === 'week'
                  ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-semibold'
                  : 'text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60'"
                @click="calendarViewMode = 'week'"
              >Week</button>
            </div>
            <span class="ml-auto text-xs text-slate-400 dark:text-slate-500">Grouped by: <b class="text-slate-600 dark:text-slate-300">{{ calendarDateField?.label }}</b></span>
          </div>
          <!-- day-of-week headers (shared by both modes) -->
          <div class="grid grid-cols-7 border-b border-slate-200 dark:border-slate-700 shrink-0">
            <div
              v-for="d in ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']"
              :key="d"
              class="px-2 py-1.5 text-center text-xs font-medium text-slate-400 dark:text-slate-500 border-r border-slate-200 dark:border-slate-700 last:border-r-0"
            >{{ d }}</div>
          </div>
          <!-- MONTH grid -->
          <div v-if="calendarViewMode === 'month'" class="flex-1 overflow-y-auto">
            <div v-for="(week, wi) in calendarGrid" :key="wi" class="grid grid-cols-7 border-b border-slate-200 dark:border-slate-700 last:border-b-0 min-h-[100px]">
              <div
                v-for="cell in week"
                :key="cell.date"
                class="group relative flex flex-col border-r border-slate-200 dark:border-slate-700 last:border-r-0 p-1.5 min-h-[100px]"
                :class="cell.inMonth ? 'bg-white dark:bg-slate-900' : 'bg-slate-50 dark:bg-slate-950'"
              >
                <div class="flex items-start justify-between mb-1">
                  <button
                    v-if="cell.inMonth"
                    type="button"
                    class="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-slate-400 hover:text-sky-500 hover:bg-sky-50 dark:hover:bg-sky-950/50 transition-all"
                    title="Add record on this day"
                    @click.stop="calendarDateField && openNewRecord(undefined, { [calendarDateField.key]: cell.date })"
                  >
                    <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" /></svg>
                  </button>
                  <span v-else class="w-5 h-5" />
                  <span
                    class="text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full"
                    :class="cell.date === DUE_TODAY_STR
                      ? 'bg-sky-500 text-white'
                      : cell.inMonth
                        ? 'text-slate-700 dark:text-slate-300'
                        : 'text-slate-300 dark:text-slate-600'"
                  >{{ cell.dayNum }}</span>
                </div>
                <div class="flex-1 space-y-0.5 overflow-hidden">
                  <button
                    v-for="record in cell.records.slice(0, 4)"
                    :key="record.id"
                    type="button"
                    class="w-full text-left text-xs px-1.5 py-0.5 rounded-md truncate transition-colors"
                    :class="openedRecord?.id === record.id
                      ? 'text-white'
                      : colorLabels[record.id]
                        ? 'text-white hover:opacity-90'
                        : 'bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900/60'"
                    :style="openedRecord?.id === record.id
                      ? { background: colorLabels[record.id] ?? '#0ea5e9' }
                      : colorLabels[record.id]
                        ? { background: colorLabels[record.id] }
                        : undefined"
                    :title="record.title"
                    @click="openRecord(record)"
                  >{{ record.title }}</button>
                  <button
                    v-if="cell.records.length > 4"
                    type="button"
                    class="block text-xs text-slate-400 dark:text-slate-500 px-1 hover:text-sky-500 dark:hover:text-sky-400 transition-colors"
                    @click.stop="calOverflowDate = cell.date; calOverflowPos = { x: $event.clientX, y: $event.clientY }"
                  >+{{ cell.records.length - 4 }} more</button>
                </div>
              </div>
            </div>
          </div>
          <!-- WEEK grid -->
          <div v-else class="flex-1 overflow-y-auto">
            <div class="grid grid-cols-7 h-full min-h-[420px]">
              <div
                v-for="cell in calWeekDays"
                :key="cell.date"
                class="group flex flex-col border-r border-slate-200 dark:border-slate-700 last:border-r-0 bg-white dark:bg-slate-900"
                :class="cell.date === DUE_TODAY_STR ? 'bg-sky-50/40 dark:bg-sky-950/10' : ''"
              >
                <!-- day header -->
                <div class="flex items-center justify-between px-3 py-2 border-b border-slate-100 dark:border-slate-800 shrink-0">
                  <span
                    class="text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full"
                    :class="cell.date === DUE_TODAY_STR
                      ? 'bg-sky-500 text-white'
                      : 'text-slate-700 dark:text-slate-300'"
                  >{{ cell.dayNum }}</span>
                  <button
                    type="button"
                    class="opacity-0 group-hover:opacity-100 h-5 w-5 flex items-center justify-center rounded text-slate-400 hover:text-sky-500 hover:bg-sky-50 dark:hover:bg-sky-950/50 transition-all"
                    title="Add record on this day"
                    @click.stop="calendarDateField && openNewRecord(undefined, { [calendarDateField.key]: cell.date })"
                  >
                    <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" /></svg>
                  </button>
                </div>
                <!-- events -->
                <div class="flex-1 overflow-y-auto px-2 py-2 space-y-1">
                  <button
                    v-for="record in cell.records"
                    :key="record.id"
                    type="button"
                    class="w-full text-left text-xs px-2 py-1.5 rounded-lg truncate transition-colors font-medium"
                    :class="openedRecord?.id === record.id
                      ? 'text-white'
                      : colorLabels[record.id]
                        ? 'text-white hover:opacity-90'
                        : 'bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900/60'"
                    :style="openedRecord?.id === record.id
                      ? { background: colorLabels[record.id] ?? '#0ea5e9' }
                      : colorLabels[record.id]
                        ? { background: colorLabels[record.id] }
                        : undefined"
                    :title="record.title"
                    @click="openRecord(record)"
                  >{{ record.title }}</button>
                  <div v-if="!cell.records.length" class="text-xs text-slate-200 dark:text-slate-700 text-center py-6 select-none">—</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Gallery view ── -->
        <div v-if="viewMode === 'gallery'" class="flex-1 overflow-y-auto p-5">
          <!-- empty state -->
          <div v-if="!filteredRecords.length" class="flex flex-col items-center justify-center py-24 text-center">
            <div class="h-14 w-14 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-4">
              <svg class="h-6 w-6 text-slate-300 dark:text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </div>
            <p class="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">No records match your filters</p>
            <button
              type="button"
              class="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium bg-sky-600 hover:bg-sky-500 text-white transition-colors"
              @click="openNewRecord()"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" /></svg>
              New {{ selectedType?.label ?? 'Record' }}
            </button>
          </div>
          <!-- card grid — grouped sections -->
          <div v-else-if="groupedGalleryGroups" class="space-y-8">
            <section v-for="group in groupedGalleryGroups" :key="group.key">
              <!-- group header -->
              <div class="flex items-center gap-2.5 mb-4">
                <span
                  class="h-2 w-2 rounded-full shrink-0"
                  :class="group.key !== '__ungrouped__' ? stageDot(group.key) : 'bg-slate-300 dark:bg-slate-600'"
                />
                <span class="text-sm font-semibold text-slate-700 dark:text-slate-300">
                  {{ group.label }}
                </span>
                <span class="text-xs tabular-nums text-slate-400 dark:text-slate-500">{{ group.records.length }}</span>
                <div class="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
              </div>
              <!-- cards in group -->
              <div
                class="grid gap-4"
                :style="{ gridTemplateColumns: `repeat(${galleryColCount}, minmax(0, 1fr))` }"
              >
                <div
                  v-for="record in group.records"
                  :key="record.id"
                  role="button"
                  tabindex="0"
                  class="group/gc text-left rounded-xl border shadow-sm transition-all overflow-hidden flex flex-col cursor-pointer"
                  :class="[
                    selectedIds.has(record.id)
                      ? 'ring-2 ring-sky-400 dark:ring-sky-500 border-sky-300 dark:border-sky-700'
                      : openedRecord?.id === record.id
                        ? 'border-sky-200 dark:border-sky-800 shadow-md ring-1 ring-sky-200 dark:ring-sky-800'
                        : 'border-slate-200 dark:border-slate-800 hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700',
                    selectedIds.has(record.id) || openedRecord?.id === record.id
                      ? 'bg-sky-50 dark:bg-sky-950/30'
                      : 'bg-white dark:bg-slate-900',
                  ]"
                  @click="openRecord(record)"
                  @keydown.enter="openRecord(record)"
                  @contextmenu.prevent="openContextMenu(record, $event)"
                >
                  <div v-if="colorLabels[record.id] || evaluateConditionalRules(record)" class="h-1.5 w-full shrink-0" :style="{ background: colorLabels[record.id] || evaluateConditionalRules(record) }" />
                  <div class="flex-1 flex flex-col p-4">
                    <div class="flex items-start gap-2 mb-3">
                      <input
                        type="checkbox"
                        class="mt-1 h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-600 text-sky-600 cursor-pointer shrink-0 transition-opacity"
                        :class="selectedIds.has(record.id) ? 'opacity-100' : 'opacity-0 group-hover/gc:opacity-100'"
                        :checked="selectedIds.has(record.id)"
                        :aria-label="`Select ${record.title}`"
                        @click.stop="toggleSelect(record.id)"
                      />
                      <div class="h-9 w-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 select-none" :style="{ background: (selectedType?.color ?? '#3b82f6') + '22', color: selectedType?.color ?? '#3b82f6' }">{{ recordInitials(record.title) }}</div>
                      <div class="flex-1" />
                      <button type="button" class="shrink-0 mt-1 rounded transition-colors" :class="pinnedIds.has(record.id) ? 'text-amber-400' : 'text-slate-200 dark:text-slate-700 hover:text-amber-400 dark:hover:text-amber-400 opacity-0 group-hover/gc:opacity-100'" :title="pinnedIds.has(record.id) ? 'Unpin' : 'Pin'" :aria-label="pinnedIds.has(record.id) ? 'Unpin record' : 'Pin record'" @click.stop="togglePin(record.id)">
                        <svg v-if="pinnedIds.has(record.id)" class="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>
                        <svg v-else class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>
                      </button>
                    </div>
                    <p class="text-sm font-semibold text-slate-900 dark:text-white leading-snug line-clamp-2 mb-3">
                      <template v-if="searchQuery.trim()">
                        <template v-for="(part, pi) in highlightText(record.title, searchQuery.trim())" :key="pi">
                          <mark v-if="part.match" class="bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-100 rounded-sm not-italic">{{ part.text }}</mark>
                          <span v-else>{{ part.text }}</span>
                        </template>
                      </template>
                      <template v-else>{{ record.title }}</template>
                    </p>
                    <div v-if="galleryPreviewFields.length" class="space-y-1.5 mb-3">
                      <div v-for="field in galleryPreviewFields" :key="field.key" class="flex items-start gap-2">
                        <span class="text-xs text-slate-400 dark:text-slate-500 w-20 shrink-0 truncate pt-px">{{ field.label }}</span>
                        <CrmCellValue :value="record.field_values[field.key]" :data-type="field.data_type" :format="field.format" class="text-xs truncate" />
                      </div>
                    </div>
                    <div v-if="(recordTags[record.id] ?? []).length" class="flex flex-wrap gap-1 mb-3">
                      <span v-for="tag in (recordTags[record.id] ?? [])" :key="tag" class="inline-flex items-center rounded-full px-2 py-0.5 text-xs bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">{{ tag }}</span>
                    </div>
                    <div class="mt-auto pt-2">
                      <div class="h-1 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                        <div class="h-full rounded-full transition-all" :class="recordCompleteness(record) === 100 ? 'bg-emerald-400' : 'bg-sky-400'" :style="{ width: `${recordCompleteness(record)}%` }" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
            <!-- ghost add card below all groups -->
            <button type="button" class="w-full rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-800 flex items-center justify-center h-16 text-slate-300 dark:text-slate-700 hover:border-sky-300 dark:hover:border-sky-700 hover:text-sky-400 dark:hover:text-sky-500 transition-all" title="Add new record" @click="openNewRecord()">
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" /></svg>
            </button>
          </div>
          <!-- card grid — flat (no grouping) -->
          <div
            v-else
            class="grid gap-4"
            :style="{ gridTemplateColumns: `repeat(${galleryColCount}, minmax(0, 1fr))` }"
          >
            <div
              v-for="(record, idx) in filteredRecords"
              :key="record.id"
              role="button"
              tabindex="0"
              :data-gallery-idx="idx"
              class="group/gc text-left rounded-xl border shadow-sm transition-all overflow-hidden flex flex-col cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-1"
              :class="[
                selectedIds.has(record.id)
                  ? 'ring-2 ring-sky-400 dark:ring-sky-500 border-sky-300 dark:border-sky-700'
                  : openedRecord?.id === record.id
                    ? 'border-sky-200 dark:border-sky-800 shadow-md ring-1 ring-sky-200 dark:ring-sky-800'
                    : 'border-slate-200 dark:border-slate-800 hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700',
                selectedIds.has(record.id) || openedRecord?.id === record.id
                  ? 'bg-sky-50 dark:bg-sky-950/30'
                  : 'bg-white dark:bg-slate-900',
              ]"
              @click="openRecord(record)"
              @keydown.enter.prevent="openRecord(record)"
              @keydown.space.prevent="toggleSelect(record.id)"
              @focus="galleryFocusIdx = idx"
              @contextmenu.prevent="openContextMenu(record, $event)"
            >
              <!-- color stripe at top -->
              <div
                v-if="colorLabels[record.id] || evaluateConditionalRules(record)"
                class="h-1.5 w-full shrink-0"
                :style="{ background: colorLabels[record.id] || evaluateConditionalRules(record) }"
              />
              <div class="flex-1 flex flex-col p-4">
                <!-- checkbox + avatar + pin row -->
                <div class="flex items-start gap-2 mb-3">
                  <input
                    type="checkbox"
                    class="mt-1 h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-600 text-sky-600 cursor-pointer shrink-0 transition-opacity"
                    :class="selectedIds.has(record.id) ? 'opacity-100' : 'opacity-0 group-hover/gc:opacity-100'"
                    :checked="selectedIds.has(record.id)"
                    :aria-label="`Select ${record.title}`"
                    @click.stop="onCheckboxClick(record, idx, $event)"
                  />
                  <div
                    class="h-9 w-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 select-none"
                    :style="{ background: (selectedType?.color ?? '#3b82f6') + '22', color: selectedType?.color ?? '#3b82f6' }"
                  >{{ recordInitials(record.title) }}</div>
                  <div class="flex-1" />
                  <button
                    type="button"
                    class="shrink-0 mt-1 rounded transition-colors"
                    :class="pinnedIds.has(record.id)
                      ? 'text-amber-400'
                      : 'text-slate-200 dark:text-slate-700 hover:text-amber-400 dark:hover:text-amber-400 opacity-0 group-hover/gc:opacity-100'"
                    :title="pinnedIds.has(record.id) ? 'Unpin' : 'Pin'"
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
                </div>
                <!-- title -->
                <p class="text-sm font-semibold text-slate-900 dark:text-white leading-snug line-clamp-2 mb-1.5">
                  <template v-if="searchQuery.trim()">
                    <template v-for="(part, pi) in highlightText(record.title, searchQuery.trim())" :key="pi">
                      <mark v-if="part.match" class="bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-100 rounded-sm not-italic">{{ part.text }}</mark>
                      <span v-else>{{ part.text }}</span>
                    </template>
                  </template>
                  <template v-else>{{ record.title }}</template>
                </p>
                <!-- urgency chip -->
                <div v-if="overdueIds.has(record.id) || dueSoonIds.has(record.id)" class="mb-2.5">
                  <span
                    class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                    :class="overdueIds.has(record.id)
                      ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400'
                      : 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400'"
                  >
                    <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                      <path v-if="overdueIds.has(record.id)" stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      <path v-else stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {{ overdueIds.has(record.id) ? 'Overdue' : 'Due soon' }}
                  </span>
                </div>
                <!-- preview fields -->
                <div v-if="galleryPreviewFields.length" class="space-y-1.5 mb-3">
                  <div
                    v-for="field in galleryPreviewFields"
                    :key="field.key"
                    class="flex items-start gap-2"
                  >
                    <span class="text-xs text-slate-400 dark:text-slate-500 w-20 shrink-0 truncate pt-px">{{ field.label }}</span>
                    <CrmCellValue
                      :value="record.field_values[field.key]"
                      :data-type="field.data_type"
                      :format="field.format"
                      class="text-xs truncate"
                    />
                  </div>
                </div>
                <!-- tags -->
                <div v-if="(recordTags[record.id] ?? []).length" class="flex flex-wrap gap-1 mb-3">
                  <span
                    v-for="tag in (recordTags[record.id] ?? [])"
                    :key="tag"
                    class="inline-flex items-center rounded-full px-2 py-0.5 text-xs bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
                  >{{ tag }}</span>
                </div>
                <!-- completeness bar -->
                <div class="mt-auto pt-2">
                  <div class="h-1 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div
                      class="h-full rounded-full transition-all"
                      :class="recordCompleteness(record) === 100 ? 'bg-emerald-400' : 'bg-sky-400'"
                      :style="{ width: `${recordCompleteness(record)}%` }"
                    />
                  </div>
                </div>
              </div>
            </div>
            <!-- ghost add-record card -->
            <button
              type="button"
              class="rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-800 flex items-center justify-center min-h-[160px] text-slate-300 dark:text-slate-700 hover:border-sky-300 dark:hover:border-sky-700 hover:text-sky-400 dark:hover:text-sky-500 transition-all"
              title="Add new record"
              @click="openNewRecord()"
            >
              <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>
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
            class="shrink-0 flex flex-col border-l border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden transition-all duration-200"
            :class="detailPanelExpanded === 'full' ? 'w-full' : detailPanelExpanded === 'wide' ? 'w-[560px]' : 'w-80'"
          >
            <!-- panel header -->
            <div class="flex items-start gap-3 px-5 py-4 border-b border-slate-200 dark:border-slate-700">
              <!-- record avatar — click to set color label -->
              <div class="relative shrink-0 mt-0.5" @click.stop>
                <button
                  type="button"
                  class="h-9 w-9 rounded-full flex items-center justify-center text-xs font-bold select-none transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                  :style="{
                    background: colorLabels[openedRecord.id] ? colorLabels[openedRecord.id] + '33' : (selectedType?.color ?? '#3b82f6') + '22',
                    color: colorLabels[openedRecord.id] ?? (selectedType?.color ?? '#3b82f6'),
                    boxShadow: colorLabels[openedRecord.id] ? `0 0 0 2px ${colorLabels[openedRecord.id]}` : undefined,
                  }"
                  :title="colorLabels[openedRecord.id] ? 'Change color label (click)' : 'Set color label (click)'"
                  @click="showDetailColorPicker = !showDetailColorPicker"
                >{{ recordInitials(openedRecord.title) }}</button>
                <!-- color picker popover -->
                <transition
                  enter-active-class="transition-all duration-150"
                  enter-from-class="opacity-0 scale-90 -translate-y-1"
                  enter-to-class="opacity-100 scale-100 translate-y-0"
                  leave-active-class="transition-all duration-100"
                  leave-from-class="opacity-100 scale-100 translate-y-0"
                  leave-to-class="opacity-0 scale-90 -translate-y-1"
                >
                  <div
                    v-if="showDetailColorPicker"
                    class="absolute top-full left-0 mt-1.5 z-50 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-2.5"
                  >
                    <div class="flex items-center gap-1.5 mb-2">
                      <button
                        v-for="c in COLOR_LABEL_PALETTE"
                        :key="c"
                        type="button"
                        class="h-5 w-5 rounded-full transition-transform hover:scale-125 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-sky-400"
                        :style="{ background: c, boxShadow: colorLabels[openedRecord.id] === c ? `0 0 0 2px white, 0 0 0 3.5px ${c}` : undefined }"
                        :aria-label="`Set color label: ${c}`"
                        @click="setColorLabel(openedRecord.id, colorLabels[openedRecord.id] === c ? '' : c); showDetailColorPicker = false"
                      />
                    </div>
                    <button
                      v-if="colorLabels[openedRecord.id]"
                      type="button"
                      class="w-full text-xs text-center text-slate-400 dark:text-slate-500 hover:text-rose-500 dark:hover:text-rose-400 transition-colors py-0.5"
                      @click="setColorLabel(openedRecord.id, ''); showDetailColorPicker = false"
                    >Remove label</button>
                  </div>
                </transition>
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
              <!-- completeness indicator -->
              <span
                v-if="!editingRecord"
                class="shrink-0 mt-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                :class="recordCompleteness(openedRecord) === 100
                  ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400'
                  : recordCompleteness(openedRecord) >= 50
                    ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400'
                    : 'bg-red-50 dark:bg-red-950/30 text-red-500 dark:text-red-400'"
                :title="`${recordCompleteness(openedRecord)}% of fields filled`"
              >{{ recordCompleteness(openedRecord) }}%</span>
              <!-- save as template -->
              <button
                type="button"
                aria-label="Save as template"
                title="Save this record as a template"
                class="shrink-0 mt-0.5 text-slate-400 hover:text-violet-500 dark:hover:text-violet-400 rounded-lg p-1 transition-colors"
                @click="templateDraftName = openedRecord.title; saveAsTemplate(openedRecord)"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </button>
              <!-- copy as text -->
              <button
                type="button"
                aria-label="Copy as text"
                title="Copy record as plain text"
                class="shrink-0 mt-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg p-1 transition-colors"
                @click="copyRecordAsText(openedRecord)"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              </button>
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
              <!-- expand / compress panel button -->
              <button
                type="button"
                class="shrink-0 mt-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg p-1 transition-colors"
                :title="detailPanelExpanded === 'full' ? 'Compress panel' : detailPanelExpanded === 'wide' ? 'Full width' : 'Expand panel'"
                @click="detailPanelExpanded = detailPanelExpanded === false ? 'wide' : detailPanelExpanded === 'wide' ? 'full' : false"
              >
                <svg v-if="!detailPanelExpanded" class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0 0l-5-5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
                <svg v-else-if="detailPanelExpanded === 'wide'" class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0 0l-5-5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
                <svg v-else class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 9L4 4m0 0v4m0-4h4m11 0h-4m4 0v4m0-4l-5 5M9 15l-5 5m0 0v-4m0 4h4m11 0h-4m4 0v-4m0 4l-5-5" />
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

            <!-- tags row -->
            <div class="flex flex-wrap items-center gap-1.5 px-5 py-2 border-b border-slate-100 dark:border-slate-800/80 min-h-[36px]">
              <span
                v-for="tag in (recordTags[openedRecord.id] ?? [])"
                :key="tag"
                class="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
              >
                {{ tag }}
                <button
                  type="button"
                  class="ml-0.5 rounded-full hover:text-rose-500 dark:hover:text-rose-400 transition-colors leading-none"
                  :aria-label="`Remove tag ${tag}`"
                  @click="removeTag(openedRecord.id, tag)"
                >
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
              <template v-if="showTagInput">
                <input
                  ref="tagInputEl"
                  v-model="tagInput"
                  type="text"
                  class="h-6 px-2 rounded-full text-xs border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 outline-none focus:border-sky-400 dark:focus:border-sky-500 w-24"
                  placeholder="Add tag..."
                  @keydown.enter.prevent="addTag(openedRecord.id, tagInput); tagInput = ''; showTagInput = false"
                  @keydown.escape="showTagInput = false; tagInput = ''"
                  @blur="if(tagInput.trim()) { addTag(openedRecord.id, tagInput); tagInput = ''; } showTagInput = false"
                />
              </template>
              <button
                v-else
                type="button"
                class="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                title="Add tag"
                @click="showTagInput = true; $nextTick(() => { (tagInputEl as HTMLInputElement | null)?.focus(); })"
              >
                <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                Tag
              </button>
            </div>

            <!-- tab bar — hidden while editing -->
            <div v-if="!editingRecord" class="flex border-b border-slate-200 dark:border-slate-700 px-5">
              <button
                v-for="tab in ([
                  { key: 'details', label: 'Details' },
                  { key: 'activity', label: 'Activity', count: recordActivities.length },
                  { key: 'related', label: 'Related', count: (openedRecord.links?.length ?? 0) + inverseLinks.length },
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
                    :class="editingRecord && editFormErrors.has(field.key) ? 'ring-2 ring-red-400/50 rounded-lg' : ''"
                    @update:value="openedRecord.field_values[field.key] = $event; if (editFormErrors.has(field.key)) { const e = new Set(editFormErrors); e.delete(field.key); editFormErrors = e; }"
                  />
                  <p v-if="editingRecord && editFormErrors.has(field.key)" class="text-xs text-red-500 dark:text-red-400">This field is required.</p>
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
                    <div v-else class="group/act flex gap-2.5 py-1">
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
                      <button
                        v-if="row.act.type !== 'change'"
                        type="button"
                        class="shrink-0 self-start mt-0.5 p-0.5 rounded opacity-0 group-hover/act:opacity-100 text-slate-300 dark:text-slate-700 hover:text-rose-400 dark:hover:text-rose-400 transition-all"
                        aria-label="Delete activity"
                        title="Delete this activity"
                        @click="deleteActivity(row.act.id)"
                      >
                        <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
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

                <!-- inverse/backlinks — records that link TO this one -->
                <template v-if="inverseLinks.length">
                  <p class="text-xs font-semibold uppercase tracking-widest text-slate-300 dark:text-slate-600 mt-4 mb-1">Linked from</p>
                  <div class="space-y-1">
                    <div
                      v-for="r in inverseLinks"
                      :key="r.id"
                      class="group/backlink flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
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
                      <button
                        type="button"
                        class="shrink-0 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400 rounded p-0.5 transition-colors"
                        aria-label="Open linked record"
                        @click="openRecord(r)"
                      >
                        <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </template>
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
              <!-- prev / next navigation row -->
              <div v-if="filteredRecords.length > 1 && openedRecordIndex >= 0" class="flex items-center gap-1">
                <button
                  type="button"
                  class="flex-1 flex items-center justify-center gap-1 h-7 rounded-lg text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                  title="Previous record  [  "
                  :disabled="openedRecordIndex <= 0"
                  @click="openRecord(filteredRecords[openedRecordIndex - 1])"
                >
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>
                  Prev
                </button>
                <button
                  type="button"
                  class="flex-1 flex items-center justify-center gap-1 h-7 rounded-lg text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                  title="Next record  ]  "
                  :disabled="openedRecordIndex >= filteredRecords.length - 1"
                  @click="openRecord(filteredRecords[openedRecordIndex + 1])"
                >
                  Next
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
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
                  @click="editingRecord = false; preEditSnapshot = {}; editFormErrors = new Set()"
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
                { keys: ['N'], desc: 'New record (or bulk note if rows selected)' },
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
                { keys: ['L'], desc: 'Calendar view' },
                { keys: ['V'], desc: 'Gallery view' },
                { keys: ['⌘', 'A'], desc: 'Select all records (table view)' },
                { keys: ['↑', '↓'], desc: 'Prev / next record' },
                { keys: ['Home', 'End'], desc: 'First / last record' },
                { keys: ['Esc'], desc: 'Close panel' },
                { keys: ['?'], desc: 'Toggle this overlay' },
              ]},
              { heading: 'Detail Panel', items: [
                { keys: ['E'], desc: 'Edit record' },
                { keys: ['W'], desc: 'Watch / unwatch record' },
                { keys: ['C'], desc: 'Copy record link' },
                { keys: ['A'], desc: 'Open activity compose' },
                { keys: ['X'], desc: 'Expand / compress detail panel' },
                { keys: ['Del'], desc: 'Delete record (with undo toast)' },
                { keys: ['1'], desc: 'Details tab' },
                { keys: ['2'], desc: 'Activity tab' },
                { keys: ['3'], desc: 'Related tab' },
                { keys: ['['], desc: 'Previous record in list' },
                { keys: [']'], desc: 'Next record in list' },
              ]},
              { heading: 'Gallery', items: [
                { keys: ['Click'], desc: 'Open record detail' },
                { keys: ['Right-click'], desc: 'Context menu' },
                { keys: ['2 / 3 / 4'], desc: 'Set column count (toolbar picker)' },
                { keys: ['←', '→'], desc: 'Move focus between cards (flat view)' },
                { keys: ['↑', '↓'], desc: 'Move focus up / down a row (flat view)' },
                { keys: ['Enter'], desc: 'Open focused card' },
                { keys: ['Space'], desc: 'Select / deselect focused card' },
              ]},
              { heading: 'Table', items: [
                { keys: ['Dbl-click'], desc: 'Edit cell inline' },
                { keys: ['Enter'], desc: 'Commit cell edit' },
                { keys: ['Esc'], desc: 'Cancel cell edit' },
                { keys: ['Right-click'], desc: 'Row context menu (filter by value)' },
                { keys: ['Right-click', 'col'], desc: 'Column menu (sort / group / hide)' },
                { keys: ['⇧', 'click col'], desc: 'Add secondary sort column' },
                { keys: ['Dbl-click', 'col'], desc: 'Rename column in-place' },
                { keys: ['Drag', 'col'], desc: 'Reorder columns' },
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

    <!-- group header context menu -->
    <transition
      enter-active-class="transition-all duration-100"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition-all duration-75"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="groupMenu"
        class="fixed z-50 w-52 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl py-1"
        :style="{ top: `${Math.min(groupMenu.y, window.innerHeight - 220)}px`, left: `${Math.min(groupMenu.x, window.innerWidth - 220)}px` }"
        @click.stop
      >
        <p class="px-3 pt-1.5 pb-0.5 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 truncate">
          {{ groupMenu.label === '__ungrouped__' ? 'No value' : groupMenu.label }}
          <span class="font-normal text-slate-300 dark:text-slate-600">({{ groupMenu.count }})</span>
        </p>
        <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
        <button
          type="button"
          class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          @click="selectGroupRecords(groupMenu.key); groupMenu = null"
        >
          <svg class="h-3.5 w-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
          Select all in group
        </button>
        <button
          type="button"
          class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          @click="toggleGroupCollapse(groupMenu.key); groupMenu = null"
        >
          <svg class="h-3.5 w-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path v-if="collapsedGroups.has(groupMenu.key)" stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
            <path v-else stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {{ collapsedGroups.has(groupMenu.key) ? 'Expand group' : 'Collapse group' }}
        </button>
        <template v-if="kanbanField && groupMenu.key !== '__ungrouped__'">
          <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
          <p class="px-3 pt-1.5 pb-0.5 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">Move all to</p>
          <button
            v-for="stage in (kanbanField?.select_options ?? []).filter(s => s !== groupMenu!.key)"
            :key="stage"
            type="button"
            class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            @click="moveGroupToStage(groupMenu!.key, stage); groupMenu = null"
          >
            <span class="h-2 w-2 rounded-full shrink-0" :style="{ background: stageColorHex(stage) }" />
            {{ stage }}
          </button>
        </template>
        <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
        <button
          type="button"
          class="w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors text-red-400 dark:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 hover:text-red-600 dark:hover:text-red-400"
          @click="deleteGroupRecords(groupMenu.key); groupMenu = null"
        >
          <svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          Delete all in group
        </button>
      </div>
    </transition>

    <!-- kanban column context menu -->
    <transition
      enter-active-class="transition-all duration-100"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition-all duration-75"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="kanbanColMenu"
        class="fixed z-50 w-52 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl py-1"
        :style="{ top: `${Math.min(kanbanColMenu.y, window.innerHeight - 200)}px`, left: `${Math.min(kanbanColMenu.x, window.innerWidth - 220)}px` }"
        @click.stop
      >
        <p class="px-3 pt-1.5 pb-0.5 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">{{ kanbanColMenu.col === KANBAN_UNASSIGNED ? 'Unassigned' : kanbanColMenu.col }}</p>
        <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
        <!-- WIP limit input -->
        <div class="px-3 py-2">
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-1.5">WIP limit</p>
          <div class="flex items-center gap-2">
            <input
              v-if="wipLimitEditing === kanbanColMenu.col"
              ref="wipLimitInputEl"
              v-model="wipLimitDraft"
              type="number"
              min="1"
              placeholder="Max cards"
              class="w-full h-7 rounded-lg px-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-600 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
              @keydown.enter.prevent="commitWipLimit(kanbanColMenu!.col)"
              @keydown.esc.stop="wipLimitEditing = null"
            >
            <template v-else>
              <span class="text-sm font-medium tabular-nums" :class="wipLimits[kanbanColMenu.col] ? 'text-slate-700 dark:text-slate-300' : 'text-slate-400 dark:text-slate-500 italic'">
                {{ wipLimits[kanbanColMenu.col] ?? 'None' }}
              </span>
            </template>
            <button
              v-if="wipLimitEditing !== kanbanColMenu.col"
              type="button"
              class="h-6 px-2 rounded text-xs font-medium text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/30 hover:bg-sky-100 dark:hover:bg-sky-900/30 transition-colors shrink-0"
              @click="wipLimitEditing = kanbanColMenu!.col; wipLimitDraft = String(wipLimits[kanbanColMenu!.col] ?? '')"
            >Set</button>
            <button
              v-else
              type="button"
              class="h-6 px-2 rounded text-xs font-medium text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/30 hover:bg-sky-100 dark:hover:bg-sky-900/30 transition-colors shrink-0"
              @click="commitWipLimit(kanbanColMenu!.col)"
            >Save</button>
            <button
              v-if="wipLimits[kanbanColMenu.col] && wipLimitEditing !== kanbanColMenu.col"
              type="button"
              class="h-6 w-6 rounded flex items-center justify-center text-slate-400 hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors shrink-0"
              title="Clear WIP limit"
              @click="delete wipLimits[kanbanColMenu!.col]; kanbanColMenu = null"
            >
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
        <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
        <button
          type="button"
          class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          @click="openNewRecord(kanbanColMenu!.col === KANBAN_UNASSIGNED ? undefined : kanbanColMenu!.col); kanbanColMenu = null"
        >
          <svg class="h-3.5 w-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" /></svg>
          New card in column
        </button>
        <button
          type="button"
          class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          @click="toggleColumnCollapse(kanbanColMenu!.col); kanbanColMenu = null"
        >
          <svg class="h-3.5 w-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path v-if="collapsedColumns.has(kanbanColMenu!.col)" stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
            <path v-else stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {{ collapsedColumns.has(kanbanColMenu!.col) ? 'Expand column' : 'Collapse column' }}
        </button>
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
        <button
          v-if="openedRecord && openedRecord.id !== contextMenuRecord.id"
          type="button"
          class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          @click="openMergeModal(openedRecord!.id, contextMenuRecord.id); closeContextMenu()"
        >
          <svg class="h-3.5 w-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Merge into open record
        </button>
        <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
        <button
          type="button"
          class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          @click="archivedIds.has(contextMenuRecord.id) ? unarchiveRecord(contextMenuRecord.id) : archiveRecord(contextMenuRecord.id); closeContextMenu()"
        >
          <svg class="h-3.5 w-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8l1 12a2 2 0 002 2h8a2 2 0 002-2L19 8" />
          </svg>
          {{ archivedIds.has(contextMenuRecord.id) ? 'Unarchive' : 'Archive' }}
        </button>
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
        <template v-if="contextMenuSelectFilters.length">
          <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
          <p class="px-3 pt-1.5 pb-0.5 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">Filter by</p>
          <button
            v-for="opt in contextMenuSelectFilters"
            :key="opt.fieldKey + ':' + opt.value"
            type="button"
            class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            @click="toggleFilter(opt.fieldKey, opt.value); closeContextMenu()"
          >
            <svg
              v-if="activeFilters.some(f => f.fieldKey === opt.fieldKey && f.value === opt.value)"
              class="h-3.5 w-3.5 text-sky-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <svg v-else class="h-3.5 w-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 4h18M7 9h10M11 14h2" />
            </svg>
            <span class="truncate"><span class="text-slate-400 dark:text-slate-500">{{ opt.label }}:</span> {{ opt.value }}</span>
          </button>
        </template>
        <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
        <div class="px-3 pt-1.5 pb-2">
          <p class="pb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">Color label</p>
          <div class="flex items-center gap-1.5">
            <button
              v-for="c in COLOR_LABEL_PALETTE"
              :key="c"
              type="button"
              class="h-4 w-4 rounded-full transition-transform hover:scale-125 focus:outline-none"
              :style="{ background: c, boxShadow: colorLabels[contextMenuRecord.id] === c ? `0 0 0 2px white, 0 0 0 3.5px ${c}` : 'none' }"
              @click="setColorLabel(contextMenuRecord.id, colorLabels[contextMenuRecord.id] === c ? '' : c)"
            />
            <button
              v-if="colorLabels[contextMenuRecord.id]"
              type="button"
              class="ml-1 h-4 w-4 rounded-full flex items-center justify-center text-slate-400 border border-slate-300 dark:border-slate-600 hover:text-slate-600 transition-colors"
              title="Clear label"
              @click="setColorLabel(contextMenuRecord.id, '')"
            >
              <svg class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
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

    <!-- conditional formatting panel -->
    <transition enter-active-class="transition-all duration-150" enter-from-class="opacity-0" enter-to-class="opacity-100" leave-active-class="transition-all duration-100" leave-from-class="opacity-100" leave-to-class="opacity-0">
      <div v-if="showFormatPanel" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" @click.self="showFormatPanel = false">
        <div class="w-full max-w-xl rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col max-h-[80vh]">
          <div class="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800">
            <div>
              <h3 class="text-base font-semibold text-slate-900 dark:text-white">Conditional row formatting</h3>
              <p class="text-xs text-slate-400 dark:text-slate-500 mt-0.5">Highlight rows automatically based on field values</p>
            </div>
            <button type="button" class="rounded-lg p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" @click="showFormatPanel = false">
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <div class="flex-1 overflow-auto p-6 space-y-3">
            <div
              v-for="(rule, ri) in conditionalRules"
              :key="rule.id"
              class="flex items-center gap-2 p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50"
            >
              <span class="h-3.5 w-3.5 rounded-full shrink-0 border border-white/40 shadow-sm" :style="{ background: rule.color }" />
              <select v-model="rule.fieldKey" class="flex-1 h-7 rounded-lg px-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-400">
                <option v-for="f in selectedType?.fields ?? []" :key="f.key" :value="f.key">{{ f.label }}</option>
              </select>
              <select v-model="rule.operator" class="w-32 h-7 rounded-lg px-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-400">
                <option value="equals">equals</option>
                <option value="not_equals">not equals</option>
                <option value="contains">contains</option>
                <option value="gt">greater than</option>
                <option value="lt">less than</option>
                <option value="is_empty">is empty</option>
                <option value="is_not_empty">is not empty</option>
              </select>
              <input
                v-if="!['is_empty', 'is_not_empty'].includes(rule.operator)"
                v-model="rule.value"
                type="text"
                placeholder="value"
                class="w-24 h-7 rounded-lg px-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-purple-400"
              >
              <span v-else class="w-24" />
              <div class="flex items-center gap-0.5">
                <button
                  v-for="c in COLOR_LABEL_PALETTE"
                  :key="c"
                  type="button"
                  class="h-4 w-4 rounded-full transition-transform hover:scale-125"
                  :style="{ background: c, boxShadow: rule.color === c ? `0 0 0 1.5px white, 0 0 0 3px ${c}` : 'none' }"
                  @click="rule.color = c"
                />
              </div>
              <button type="button" class="h-6 w-6 rounded text-slate-400 hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors flex items-center justify-center shrink-0" @click="conditionalRules.splice(ri, 1)">
                <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div v-if="!conditionalRules.length" class="text-center py-6 text-sm text-slate-400 dark:text-slate-500">
              No formatting rules yet. Add one below.
            </div>
          </div>
          <div class="px-6 py-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <button
              type="button"
              class="flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm font-medium text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/30 hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-colors"
              @click="conditionalRules.push({ id: String(Date.now()), fieldKey: selectedType?.fields[0]?.key ?? '', operator: 'equals', value: '', color: COLOR_LABEL_PALETTE[0] })"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" /></svg>
              Add rule
            </button>
            <button type="button" class="h-8 px-4 rounded-xl text-sm font-medium text-white bg-purple-500 hover:bg-purple-600 transition-colors" @click="showFormatPanel = false">Done</button>
          </div>
        </div>
      </div>
    </transition>

    <!-- CSV import modal -->
    <transition enter-active-class="transition-all duration-150" enter-from-class="opacity-0" enter-to-class="opacity-100" leave-active-class="transition-all duration-100" leave-from-class="opacity-100" leave-to-class="opacity-0">
      <div v-if="showImportModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" @click.self="showImportModal = false">
        <div class="w-full max-w-2xl rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col max-h-[85vh]">
          <!-- header -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800">
            <div>
              <h3 class="text-base font-semibold text-slate-900 dark:text-white">Import {{ selectedType?.label ?? 'records' }}</h3>
              <p class="text-xs text-slate-400 dark:text-slate-500 mt-0.5">Step {{ importStep === 'paste' ? '1' : importStep === 'map' ? '2' : '3' }} of 3 — {{ importStep === 'paste' ? 'Paste CSV data' : importStep === 'map' ? 'Map columns to fields' : 'Preview & confirm' }}</p>
            </div>
            <button type="button" class="rounded-lg p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" @click="showImportModal = false">
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <!-- step 1: paste CSV -->
          <div v-if="importStep === 'paste'" class="flex-1 overflow-auto p-6 space-y-4">
            <div class="flex items-center gap-3">
              <label class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 cursor-pointer select-none">
                <input v-model="importHeaderRow" type="checkbox" class="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-sky-600 cursor-pointer">
                First row is a header
              </label>
            </div>
            <textarea
              v-model="importCsvText"
              class="w-full h-64 rounded-xl px-4 py-3 text-sm font-mono bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-none focus:outline-none focus:ring-2 focus:ring-sky-400/40"
              placeholder="Paste CSV data here&#10;e.g.:&#10;Name,Email,Company&#10;John Smith,john@acme.com,Acme Corp&#10;Jane Doe,jane@startup.io,Startup Inc"
            />
          </div>

          <!-- step 2: column mapping -->
          <div v-else-if="importStep === 'map'" class="flex-1 overflow-auto p-6">
            <p class="text-sm text-slate-500 dark:text-slate-400 mb-4">Map each CSV column to a record field, or leave as "Skip" to ignore.</p>
            <div class="space-y-2">
              <div v-for="(header, i) in (importHeaderRow ? importParsed[0] : importParsed[0]?.map((_, j) => `Column ${j + 1}`))" :key="i" class="flex items-center gap-3">
                <span class="w-40 text-sm font-medium text-slate-700 dark:text-slate-300 truncate shrink-0">{{ importHeaderRow ? importParsed[0][i] : `Column ${i + 1}` }}</span>
                <span class="text-slate-300 dark:text-slate-600">→</span>
                <select
                  v-model="importMapping[i]"
                  class="flex-1 h-8 rounded-lg px-2 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                >
                  <option value="">Skip</option>
                  <option v-for="f in selectedType?.fields ?? []" :key="f.key" :value="f.key">{{ f.label }}</option>
                  <option value="__title__">Title (record name)</option>
                </select>
              </div>
            </div>
          </div>

          <!-- step 3: preview -->
          <div v-else class="flex-1 overflow-auto p-6">
            <p class="text-sm text-slate-500 dark:text-slate-400 mb-4">
              Ready to import <strong class="text-slate-700 dark:text-slate-300">{{ importPreviewRows.length }}</strong> record{{ importPreviewRows.length === 1 ? '' : 's' }}. Here is a preview of the first {{ Math.min(5, importPreviewRows.length) }}:
            </p>
            <div class="space-y-2">
              <div
                v-for="(row, ri) in importPreviewRows.slice(0, 5)"
                :key="ri"
                class="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2.5 bg-slate-50 dark:bg-slate-800/50"
              >
                <p class="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{{ row.__title__ ?? `Record ${ri + 1}` }}</p>
                <div class="flex flex-wrap gap-2 mt-1">
                  <span v-for="(val, key) in row" :key="key" class="text-xs text-slate-500 dark:text-slate-400">
                    <span class="font-medium text-slate-600 dark:text-slate-300">{{ selectedType?.fields.find(f => f.key === key)?.label ?? key }}:</span> {{ val }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- footer actions -->
          <div class="px-6 py-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
            <button v-if="importStep !== 'paste'" type="button" class="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors" @click="importStep = importStep === 'preview' ? 'map' : 'paste'">
              Back
            </button>
            <span v-else />
            <div class="flex items-center gap-2">
              <button type="button" class="h-9 px-4 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" @click="showImportModal = false">Cancel</button>
              <button
                v-if="importStep === 'paste'"
                type="button"
                class="h-9 px-4 rounded-xl text-sm font-semibold bg-sky-500 hover:bg-sky-600 text-white transition-colors disabled:opacity-40 disabled:pointer-events-none"
                :disabled="!importCsvText.trim()"
                @click="parseImportCsv"
              >Next: Map fields</button>
              <button
                v-else-if="importStep === 'map'"
                type="button"
                class="h-9 px-4 rounded-xl text-sm font-semibold bg-sky-500 hover:bg-sky-600 text-white transition-colors"
                @click="importStep = 'preview'"
              >Next: Preview</button>
              <button
                v-else
                type="button"
                class="h-9 px-4 rounded-xl text-sm font-semibold bg-sky-500 hover:bg-sky-600 text-white transition-colors"
                @click="commitImport"
              >Import {{ importPreviewRows.length }} record{{ importPreviewRows.length === 1 ? '' : 's' }}</button>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- bulk field fill modal -->
    <transition
      enter-active-class="transition-all duration-150"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-all duration-100"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="showBulkFieldModal"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        @click.self="showBulkFieldModal = false"
      >
        <div class="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-2xl p-5 space-y-3">
          <div class="flex items-center justify-between">
            <p class="text-sm font-semibold text-slate-900 dark:text-white">
              Set field for {{ selectedIds.size }} record{{ selectedIds.size === 1 ? '' : 's' }}
            </p>
            <button type="button" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors" @click="showBulkFieldModal = false">
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <!-- step 1: field picker -->
          <template v-if="!bulkFieldKey">
            <p class="text-xs text-slate-400 dark:text-slate-500">Pick a field to update:</p>
            <div class="space-y-1 max-h-52 overflow-y-auto">
              <button
                v-for="col in allColumns.filter(c => !c.is_title)"
                :key="col.key"
                type="button"
                class="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors"
                @click="bulkFieldKey = col.key; bulkFieldValue = null"
              >
                <svg class="h-3.5 w-3.5 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.75">
                  <path stroke-linecap="round" stroke-linejoin="round" :d="DATA_TYPE_ICONS[col.data_type] ?? DATA_TYPE_ICONS['text']" />
                </svg>
                {{ col.label }}
              </button>
            </div>
          </template>
          <!-- step 2: value editor -->
          <template v-else>
            <div class="flex items-center gap-2">
              <button type="button" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors" @click="bulkFieldKey = null; bulkFieldValue = null">
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>
              </button>
              <p class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                {{ allColumns.find(c => c.key === bulkFieldKey)?.label }}
              </p>
            </div>
            <CrmFieldInput
              :data-type="allColumns.find(c => c.key === bulkFieldKey)?.data_type ?? 'text'"
              :value="bulkFieldValue"
              :read-only="false"
              :select-options="allColumns.find(c => c.key === bulkFieldKey)?.select_options ?? []"
              :format="allColumns.find(c => c.key === bulkFieldKey)?.format"
              @update:value="bulkFieldValue = $event"
            />
            <div class="flex gap-2 justify-end">
              <button type="button" class="h-8 px-3 rounded-lg text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" @click="showBulkFieldModal = false">
                Cancel
              </button>
              <button type="button" class="h-8 px-4 rounded-lg text-sm font-medium text-white bg-sky-600 hover:bg-sky-500 transition-colors" @click="submitBulkFieldFill">
                Apply to {{ selectedIds.size }} record{{ selectedIds.size === 1 ? '' : 's' }}
              </button>
            </div>
          </template>
        </div>
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
          @click="sortField = colHeaderMenu!.fieldKey; sortDir = 'asc'; sortField2 = null; sortDir2 = 'asc'; colHeaderMenu = null">
          <svg class="h-3.5 w-3.5 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
          </svg>
          Sort A → Z
        </button>
        <button type="button" class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          @click="sortField = colHeaderMenu!.fieldKey; sortDir = 'desc'; sortField2 = null; sortDir2 = 'asc'; colHeaderMenu = null">
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
          <button type="button" class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            @click="togglePinColumn(colHeaderMenu!.fieldKey); colHeaderMenu = null"
          >
            <svg class="h-3.5 w-3.5 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
            {{ pinnedColumnKeys.has(colHeaderMenu?.fieldKey ?? '') ? 'Unpin column' : 'Pin column to left' }}
          </button>
          <button type="button" class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            @click="groupByField = groupByField === colHeaderMenu!.fieldKey ? null : colHeaderMenu!.fieldKey; colHeaderMenu = null">
            <svg class="h-3.5 w-3.5 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h8m-8 6h16" />
            </svg>
            {{ groupByField === colHeaderMenu?.fieldKey ? 'Clear grouping' : 'Group by this field' }}
          </button>
        </template>
        <template v-if="['text', 'email', 'phone', 'url'].includes(allColumns.find(c => c.key === colHeaderMenu?.fieldKey)?.data_type ?? '')">
          <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
          <div class="px-3 py-2 space-y-1">
            <p class="text-xs text-slate-400 dark:text-slate-500 font-medium">Contains text:</p>
            <div class="relative">
              <input
                type="text"
                :value="fieldTextFilters[colHeaderMenu?.fieldKey ?? ''] ?? ''"
                placeholder="Filter…"
                class="h-7 w-full rounded-lg px-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                @input="fieldTextFilters = { ...fieldTextFilters, [colHeaderMenu!.fieldKey]: ($event.target as HTMLInputElement).value }"
                @keydown.enter.stop="colHeaderMenu = null"
                @keydown.esc.stop="fieldTextFilters = { ...fieldTextFilters, [colHeaderMenu!.fieldKey]: '' }; colHeaderMenu = null"
                @click.stop
              />
            </div>
          </div>
        </template>
        <template v-if="allColumns.find(c => c.key === colHeaderMenu?.fieldKey)?.data_type === 'number'">
          <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
          <div class="px-3 py-2 space-y-1.5">
            <p class="text-xs text-slate-400 dark:text-slate-500 font-medium">Number range:</p>
            <div class="flex items-center gap-1.5">
              <input
                type="number"
                placeholder="Min"
                :value="numberMinFilters[colHeaderMenu?.fieldKey ?? ''] ?? ''"
                class="h-7 w-full rounded-lg px-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                @input="numberMinFilters = { ...numberMinFilters, [colHeaderMenu!.fieldKey]: ($event.target as HTMLInputElement).value ? Number(($event.target as HTMLInputElement).value) : null }"
                @keydown.enter.stop="colHeaderMenu = null"
                @click.stop
              />
              <span class="text-xs text-slate-400 shrink-0">–</span>
              <input
                type="number"
                placeholder="Max"
                :value="numberMaxFilters[colHeaderMenu?.fieldKey ?? ''] ?? ''"
                class="h-7 w-full rounded-lg px-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                @input="numberMaxFilters = { ...numberMaxFilters, [colHeaderMenu!.fieldKey]: ($event.target as HTMLInputElement).value ? Number(($event.target as HTMLInputElement).value) : null }"
                @keydown.enter.stop="colHeaderMenu = null"
                @click.stop
              />
            </div>
          </div>
        </template>
        <template v-if="allColumns.find(c => c.key === colHeaderMenu?.fieldKey)?.data_type === 'date'">
          <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
          <div class="px-3 py-2 space-y-1.5">
            <p class="text-xs text-slate-400 dark:text-slate-500 font-medium">Date range:</p>
            <div class="space-y-1">
              <div class="flex items-center gap-1.5">
                <span class="text-xs text-slate-400 dark:text-slate-500 w-10 shrink-0">After</span>
                <input
                  type="date"
                  :value="dateAfterFilters[colHeaderMenu?.fieldKey ?? ''] ?? ''"
                  class="h-7 flex-1 rounded-lg px-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                  @input="dateAfterFilters = { ...dateAfterFilters, [colHeaderMenu!.fieldKey]: ($event.target as HTMLInputElement).value || null }"
                  @click.stop
                />
              </div>
              <div class="flex items-center gap-1.5">
                <span class="text-xs text-slate-400 dark:text-slate-500 w-10 shrink-0">Before</span>
                <input
                  type="date"
                  :value="dateBeforeFilters[colHeaderMenu?.fieldKey ?? ''] ?? ''"
                  class="h-7 flex-1 rounded-lg px-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                  @input="dateBeforeFilters = { ...dateBeforeFilters, [colHeaderMenu!.fieldKey]: ($event.target as HTMLInputElement).value || null }"
                  @click.stop
                />
              </div>
            </div>
          </div>
        </template>
        <div class="my-1 border-t border-slate-100 dark:border-slate-800" />
        <button type="button" class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          @click="colStatsFieldKey = colHeaderMenu!.fieldKey; showColStatsModal = true; colHeaderMenu = null">
          <svg class="h-3.5 w-3.5 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 3v18h18M7 16l4-4 4 4 4-4" />
          </svg>
          Column stats
        </button>
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

    <!-- column stats modal -->
    <Teleport to="body">
      <div
        v-if="showColStatsModal && colStats"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
        @click.self="showColStatsModal = false"
      >
        <div class="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[420px] max-h-[80vh] flex flex-col overflow-hidden border border-slate-200 dark:border-slate-700">
          <!-- header -->
          <div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
            <div>
              <h3 class="text-base font-semibold text-slate-900 dark:text-white">{{ colStats.label }}</h3>
              <p class="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{{ colStats.dataType }}</p>
            </div>
            <button type="button" class="rounded-lg p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" @click="showColStatsModal = false">
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <div class="overflow-y-auto flex-1 px-5 py-4 space-y-4">
            <!-- fill rate -->
            <div>
              <div class="flex items-center justify-between text-xs mb-1.5">
                <span class="text-slate-500 dark:text-slate-400">Fill rate</span>
                <span class="font-semibold text-slate-700 dark:text-slate-200">{{ colStats.filled }} / {{ colStats.total }} ({{ colStats.fillRate }}%)</span>
              </div>
              <div class="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div class="h-full rounded-full bg-sky-500 transition-all" :style="`width:${colStats.fillRate}%`" />
              </div>
            </div>
            <!-- number stats -->
            <div v-if="colStats.numMin !== undefined" class="grid grid-cols-3 gap-3">
              <div v-for="stat in [['Min', colStats.numMin], ['Avg', colStats.numAvg], ['Max', colStats.numMax]]" :key="stat[0]" class="rounded-xl bg-slate-50 dark:bg-slate-800 p-3 text-center">
                <div class="text-xs text-slate-400 dark:text-slate-500 mb-1">{{ stat[0] }}</div>
                <div class="text-base font-semibold text-slate-800 dark:text-slate-100 tabular-nums">{{ stat[1] }}</div>
              </div>
            </div>
            <div v-if="colStats.numSum !== undefined" class="flex items-center justify-between rounded-xl bg-slate-50 dark:bg-slate-800 px-4 py-2.5">
              <span class="text-xs text-slate-400 dark:text-slate-500">Sum</span>
              <span class="text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100">{{ colStats.numSum?.toLocaleString() }}</span>
            </div>
            <!-- distribution chart -->
            <div v-if="colStats.distribution && colStats.distribution.length">
              <p class="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">Distribution</p>
              <div class="space-y-1.5">
                <div
                  v-for="item in colStats.distribution"
                  :key="item.label"
                  class="flex items-center gap-2"
                >
                  <span class="text-xs text-slate-600 dark:text-slate-300 w-28 shrink-0 truncate">{{ item.label }}</span>
                  <div class="flex-1 h-5 rounded-md bg-slate-100 dark:bg-slate-800 overflow-hidden relative">
                    <div
                      class="h-full rounded-md bg-sky-400 dark:bg-sky-600 transition-all"
                      :style="`width:${colStats.distribution && colStats.distribution.length ? Math.round((item.count / Math.max(...colStats.distribution.map(x => x.count))) * 100) : 0}%`"
                    />
                    <span class="absolute inset-0 flex items-center justify-end pr-2 text-xs font-medium text-slate-600 dark:text-slate-300">{{ item.count }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- merge records modal -->
    <Teleport to="body">
      <div v-if="showMergeModal && mergeSourceId && mergeTargetId" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" @click.self="showMergeModal = false">
        <div class="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[560px] max-h-[80vh] flex flex-col overflow-hidden border border-slate-200 dark:border-slate-700">
          <div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
            <h3 class="text-base font-semibold text-slate-900 dark:text-white">Merge records</h3>
            <button type="button" class="rounded-lg p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" @click="showMergeModal = false">
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <div class="overflow-y-auto flex-1 px-5 py-4 space-y-1">
            <div class="grid grid-cols-[1fr_auto_1fr] gap-2 text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
              <span class="text-sky-600 dark:text-sky-400">Primary (keep)</span>
              <span />
              <span class="text-right text-rose-500 dark:text-rose-400">Secondary (discard)</span>
            </div>
            <div
              v-for="field in (selectedType?.fields ?? []).slice().sort((a,b) => a.position - b.position)"
              :key="field.key"
              class="grid grid-cols-[1fr_auto_1fr] gap-2 items-center py-1.5 rounded-lg px-1 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              @click="mergeFieldChoices[field.key] = mergeFieldChoices[field.key] === 'primary' ? 'secondary' : 'primary'"
            >
              <div :class="mergeFieldChoices[field.key] === 'primary' ? 'text-slate-800 dark:text-slate-100 font-medium' : 'text-slate-300 dark:text-slate-600 line-through'" class="text-sm truncate">
                {{ mockRecords.find(r => r.id === mergeSourceId)?.field_values[field.key] ?? '' }}
              </div>
              <div class="flex flex-col items-center gap-0.5">
                <span class="text-[10px] text-slate-400 dark:text-slate-500 font-medium">{{ field.label }}</span>
                <svg v-if="mergeFieldChoices[field.key] === 'primary'" class="h-3 w-3 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
                <svg v-else class="h-3 w-3 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
              </div>
              <div :class="mergeFieldChoices[field.key] === 'secondary' ? 'text-slate-800 dark:text-slate-100 font-medium' : 'text-slate-300 dark:text-slate-600 line-through'" class="text-sm truncate text-right">
                {{ mockRecords.find(r => r.id === mergeTargetId)?.field_values[field.key] ?? '' }}
              </div>
            </div>
          </div>
          <div class="flex items-center justify-between px-5 py-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
            <p class="text-xs text-slate-500 dark:text-slate-400">Click a row to toggle which value to keep. Secondary record will be deleted.</p>
            <div class="flex items-center gap-2">
              <button type="button" class="h-9 px-4 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" @click="showMergeModal = false">Cancel</button>
              <button type="button" class="h-9 px-4 rounded-xl text-sm font-semibold bg-rose-500 hover:bg-rose-600 text-white transition-colors" @click="commitMerge">Merge &amp; Delete Secondary</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ============ SCHEMA EDITOR PANEL ============ -->
    <Teleport to="body">
      <transition
        enter-active-class="transition-all duration-200 ease-out"
        enter-from-class="opacity-0"
        enter-to-class="opacity-100"
        leave-active-class="transition-all duration-150 ease-in"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <div v-if="showSchemaEditor" class="fixed inset-0 z-50 flex">
          <!-- backdrop -->
          <div class="absolute inset-0 bg-black/40 backdrop-blur-[1px]" @click="showSchemaEditor = false" />
          <!-- slide-over panel -->
          <transition
            enter-active-class="transition-transform duration-200 ease-out"
            enter-from-class="translate-x-full"
            enter-to-class="translate-x-0"
            leave-active-class="transition-transform duration-150 ease-in"
            leave-from-class="translate-x-0"
            leave-to-class="translate-x-full"
          >
            <div v-if="showSchemaEditor" class="ml-auto relative w-[480px] h-full bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-700 flex flex-col shadow-2xl overflow-hidden">

              <!-- FIELDS MODE -->
              <template v-if="schemaEditorMode === 'fields'">
                <div class="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3">
                  <div class="relative shrink-0">
                    <button
                      type="button"
                      class="flex h-8 w-8 items-center justify-center rounded-lg ring-2 ring-transparent hover:ring-slate-300 dark:hover:ring-slate-600 transition-all"
                      :style="{ background: (selectedType?.color ?? '#6366f1') + '22', color: selectedType?.color ?? '#6366f1' }"
                      title="Change type icon &amp; color"
                      @click.stop="showTypeIconColorPicker = !showTypeIconColorPicker"
                    >
                      <component :is="ICON_COMPONENTS[selectedType?.icon ?? 'folder']" class="h-4 w-4" />
                    </button>
                    <!-- icon + color picker popover -->
                    <div
                      v-if="showTypeIconColorPicker && selectedType"
                      class="absolute top-full left-0 mt-1.5 z-50 w-56 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-3 space-y-3"
                    >
                      <div>
                        <p class="text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1.5">Color</p>
                        <div class="flex flex-wrap gap-1.5">
                          <button
                            v-for="c in SCHEMA_COLOR_PRESETS"
                            :key="c"
                            type="button"
                            class="h-5 w-5 rounded-full transition-transform hover:scale-125 focus:outline-none"
                            :style="{ background: c, boxShadow: selectedType.color === c ? `0 0 0 2px white, 0 0 0 3.5px ${c}` : undefined }"
                            :aria-label="`Set type color: ${c}`"
                            @click.stop="selectedType.color = c"
                          />
                        </div>
                      </div>
                      <div>
                        <p class="text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1.5">Icon</p>
                        <div class="flex flex-wrap gap-1.5">
                          <button
                            v-for="ico in SCHEMA_ICON_OPTIONS"
                            :key="ico"
                            type="button"
                            class="h-7 w-7 rounded-lg flex items-center justify-center transition-colors"
                            :class="selectedType.icon === ico
                              ? 'ring-2 ring-offset-1 ring-violet-400'
                              : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'"
                            :style="selectedType.icon === ico ? { background: (selectedType.color ?? '#6366f1') + '22', color: selectedType.color ?? '#6366f1' } : undefined"
                            :aria-label="`Set icon: ${ico}`"
                            @click.stop="selectedType.icon = ico as IconKey"
                          >
                            <component :is="ICON_COMPONENTS[ico]" class="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      <button type="button" class="w-full text-xs text-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors py-0.5" @click.stop="showTypeIconColorPicker = false">Done</button>
                    </div>
                  </div>
                  <div class="flex-1 min-w-0">
                    <template v-if="schemaTypeLabelDraft !== null">
                      <input
                        ref="schemaTypeLabelInputEl"
                        v-model="schemaTypeLabelDraft"
                        type="text"
                        class="w-full text-sm font-semibold rounded px-1 py-0.5 bg-white dark:bg-slate-800 border border-violet-400 text-slate-900 dark:text-white focus:outline-none"
                        @keydown.enter.prevent="commitSchemaTypeRename"
                        @keydown.esc.stop="schemaTypeLabelDraft = null"
                        @blur="commitSchemaTypeRename"
                        @click.stop
                      />
                    </template>
                    <template v-else>
                      <h3
                        class="text-sm font-semibold text-slate-900 dark:text-white truncate cursor-text hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
                        title="Double-click to rename type"
                        @dblclick.stop="startSchemaTypeRename"
                      >{{ selectedType?.label ?? 'Type' }} — Fields</h3>
                    </template>
                    <p class="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{{ selectedType?.fields.length ?? 0 }} fields · {{ recordCountByType[selectedTypeKey] ?? 0 }} records</p>
                  </div>
                  <button type="button" class="h-7 w-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" @click="showSchemaEditor = false">
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>

                <!-- field list -->
                <div class="flex-1 overflow-y-auto">
                  <div class="divide-y divide-slate-100 dark:divide-slate-800">
                    <div
                      v-for="field in (selectedType?.fields ?? []).slice().sort((a, b) => a.position - b.position)"
                      :key="field.id"
                      draggable="true"
                      class="flex items-center gap-3 px-5 py-3 group/field cursor-grab active:cursor-grabbing transition-colors"
                      :class="[
                        schemaDragOver === field.id && schemaDragSrc !== field.id ? 'border-t-2 border-t-sky-400' : '',
                        schemaDragSrc === field.id ? 'opacity-40' : '',
                      ]"
                      @dragstart.stop="(e) => { schemaDragSrc = field.id; e.dataTransfer && (e.dataTransfer.effectAllowed = 'move'); }"
                      @dragover.prevent="schemaDragOver = field.id"
                      @dragleave="schemaDragOver = null"
                      @drop.prevent="dropSchemaReorder(field.id)"
                      @dragend="() => { schemaDragSrc = null; schemaDragOver = null; }"
                    >
                      <!-- drag handle -->
                      <span class="shrink-0 text-slate-200 dark:text-slate-700 group-hover/field:text-slate-300 dark:group-hover/field:text-slate-600 transition-colors cursor-grab">
                        <svg class="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>
                      </span>
                      <!-- data_type icon -->
                      <span class="shrink-0 h-7 w-7 rounded-md flex items-center justify-center bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                        <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" :d="DATA_TYPE_ICONS[field.data_type]" />
                        </svg>
                      </span>
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-1.5">
                          <span class="text-sm font-medium text-slate-900 dark:text-white truncate">{{ field.label }}</span>
                          <span v-if="field.is_title" class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400 whitespace-nowrap">Title</span>
                          <span v-if="field.is_required" class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 whitespace-nowrap">Required</span>
                        </div>
                        <div class="text-xs text-slate-400 dark:text-slate-500 mt-0.5 font-mono truncate">
                          {{ field.key }} · {{ field.data_type }}
                          <template v-if="field.select_options?.length"> · {{ field.select_options.join(', ') }}</template>
                          <template v-if="field.default_value"> · <span class="text-violet-400 dark:text-violet-500">default: {{ field.default_value }}</span></template>
                        </div>
                      </div>
                      <!-- delete button — hidden for title/required fields -->
                      <button
                        v-if="!field.is_title && !field.is_required"
                        type="button"
                        class="shrink-0 h-7 w-7 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 opacity-0 group-hover/field:opacity-100 transition-all"
                        title="Remove field"
                        @click="removeFieldFromType(selectedTypeKey, field.id)"
                      >
                        <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                      <span v-else class="shrink-0 h-7 w-7" />
                    </div>
                  </div>

                  <!-- add field form -->
                  <div v-if="showAddFieldForm" class="px-5 py-4 border-t border-slate-100 dark:border-slate-800 space-y-3 bg-slate-50 dark:bg-slate-800/40">
                    <p class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">New field</p>
                    <div class="flex gap-2">
                      <div class="flex-1">
                        <label class="text-xs text-slate-500 dark:text-slate-400 mb-1 block">Label</label>
                        <input
                          v-model="newFieldDraft.label"
                          type="text"
                          placeholder="e.g. Close date"
                          class="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-400/50 focus:border-violet-400"
                          @keydown.enter="addFieldToCurrentType"
                        />
                      </div>
                      <div>
                        <label class="text-xs text-slate-500 dark:text-slate-400 mb-1 block">Type</label>
                        <select
                          v-model="newFieldDraft.data_type"
                          class="text-sm px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-violet-400/50"
                        >
                          <option value="text">Text</option>
                          <option value="number">Number</option>
                          <option value="select">Select</option>
                          <option value="multi_select">Multi-select</option>
                          <option value="rating">Rating (1-5 stars)</option>
                          <option value="date">Date</option>
                          <option value="boolean">Boolean</option>
                          <option value="email">Email</option>
                          <option value="phone">Phone</option>
                          <option value="url">URL</option>
                        </select>
                      </div>
                    </div>
                    <div v-if="newFieldDraft.data_type === 'select' || newFieldDraft.data_type === 'multi_select'">
                      <label class="text-xs text-slate-500 dark:text-slate-400 mb-1 block">Options (comma-separated)</label>
                      <input
                        v-model="newFieldDraft.select_options_raw"
                        type="text"
                        placeholder="Option A, Option B, Option C"
                        class="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-400/50 focus:border-violet-400"
                      />
                    </div>
                    <div v-if="newFieldDraft.data_type !== 'boolean'">
                      <label class="text-xs text-slate-500 dark:text-slate-400 mb-1 block">Default value <span class="font-normal opacity-60">(optional)</span></label>
                      <input
                        v-model="newFieldDraft.default_value"
                        type="text"
                        :placeholder="newFieldDraft.data_type === 'number' ? 'e.g. 0' : newFieldDraft.data_type === 'date' ? 'e.g. 2026-01-01' : newFieldDraft.data_type === 'select' || newFieldDraft.data_type === 'multi_select' ? 'e.g. Option A' : newFieldDraft.data_type === 'rating' ? '1–5' : 'e.g. Default text'"
                        class="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-400/50 focus:border-violet-400"
                      />
                    </div>
                    <div class="flex gap-2">
                      <button type="button" class="flex-1 h-8 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" @click="showAddFieldForm = false">Cancel</button>
                      <button type="button" class="flex-1 h-8 rounded-lg text-sm font-semibold bg-violet-500 hover:bg-violet-600 text-white transition-colors" @click="addFieldToCurrentType">Add field</button>
                    </div>
                  </div>

                  <!-- + add field trigger -->
                  <div v-if="!showAddFieldForm" class="px-5 py-3 border-t border-slate-100 dark:border-slate-800">
                    <button type="button" class="w-full flex items-center gap-2 text-sm text-slate-400 hover:text-violet-500 dark:hover:text-violet-400 transition-colors py-1" @click="showAddFieldForm = true">
                      <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" /></svg>
                      Add field
                    </button>
                  </div>
                </div>

                <!-- danger zone footer -->
                <div class="px-5 py-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/20">
                  <div class="flex items-center justify-between">
                    <button
                      type="button"
                      class="flex items-center gap-1.5 text-xs text-slate-400 hover:text-violet-500 dark:hover:text-violet-400 transition-colors"
                      @click="schemaEditorMode = 'new-type'; showAddFieldForm = false"
                    >
                      <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" /></svg>
                      New type
                    </button>
                    <button
                      type="button"
                      class="flex items-center gap-1.5 text-xs transition-colors"
                      :class="(recordCountByType[selectedTypeKey] ?? 0) > 0
                        ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
                        : 'text-red-400 hover:text-red-500'"
                      :title="(recordCountByType[selectedTypeKey] ?? 0) > 0 ? 'Remove all records first' : 'Permanently delete this type'"
                      :disabled="(recordCountByType[selectedTypeKey] ?? 0) > 0"
                      @click="deleteRecordType(selectedTypeKey)"
                    >
                      <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      Delete type
                    </button>
                  </div>
                </div>
              </template>

              <!-- NEW TYPE MODE -->
              <template v-else>
                <div class="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3">
                  <h3 class="flex-1 text-sm font-semibold text-slate-900 dark:text-white">New record type</h3>
                  <button type="button" class="h-7 w-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" @click="showSchemaEditor = false">
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
                <div class="flex-1 overflow-y-auto px-5 py-5 space-y-5">
                  <div>
                    <label class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide block mb-2">Type name</label>
                    <input
                      v-model="newTypeDraft.label"
                      type="text"
                      placeholder="e.g. Project, Event, Invoice"
                      class="w-full text-sm px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-400/50 focus:border-violet-400"
                      @keydown.enter="addNewRecordType"
                    />
                    <p class="text-xs text-slate-400 dark:text-slate-500 mt-1.5">
                      Key: <span class="font-mono text-slate-600 dark:text-slate-300">{{ newTypeDraft.key || (newTypeDraft.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') || '…') }}</span>
                    </p>
                  </div>

                  <div>
                    <label class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide block mb-2">Icon</label>
                    <div class="grid grid-cols-5 gap-2">
                      <button
                        v-for="ico in SCHEMA_ICON_OPTIONS"
                        :key="ico"
                        type="button"
                        class="flex items-center justify-center h-10 rounded-lg border-2 transition-all"
                        :class="newTypeDraft.icon === ico
                          ? 'border-violet-400 bg-violet-50 dark:bg-violet-950/30 text-violet-600 dark:text-violet-400'
                          : 'border-slate-200 dark:border-slate-700 text-slate-400 hover:border-slate-300 dark:hover:border-slate-600 hover:text-slate-700 dark:hover:text-slate-200'"
                        @click="newTypeDraft.icon = ico"
                      >
                        <component :is="ICON_COMPONENTS[ico]" class="h-4.5 w-4.5" />
                      </button>
                    </div>
                  </div>

                  <div>
                    <label class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide block mb-2">Color</label>
                    <div class="flex flex-wrap gap-2">
                      <button
                        v-for="c in SCHEMA_COLOR_PRESETS"
                        :key="c"
                        type="button"
                        class="h-8 w-8 rounded-lg transition-all border-2"
                        :style="{ background: c }"
                        :class="newTypeDraft.color === c ? 'border-white dark:border-slate-300 scale-110 shadow-md' : 'border-transparent hover:scale-105'"
                        :title="c"
                        @click="newTypeDraft.color = c"
                      />
                    </div>
                  </div>

                  <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-4">
                    <p class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-3">Auto-created fields</p>
                    <div class="space-y-1.5">
                      <div class="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                        <span class="h-5 w-5 rounded flex items-center justify-center bg-slate-200 dark:bg-slate-700">
                          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        </span>
                        <span><b>Name</b> — text, title field (required)</span>
                      </div>
                      <div class="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                        <span class="h-5 w-5 rounded flex items-center justify-center bg-slate-200 dark:bg-slate-700">
                          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                        </span>
                        <span><b>Status</b> — select: Active, Inactive (editable after creation)</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="px-5 py-4 border-t border-slate-200 dark:border-slate-700 flex items-center gap-3">
                  <button type="button" class="flex-1 h-10 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" @click="schemaEditorMode = 'fields'">Back to fields</button>
                  <button
                    type="button"
                    class="flex-1 h-10 rounded-xl text-sm font-semibold transition-colors"
                    :class="newTypeDraft.label.trim()
                      ? 'bg-violet-500 hover:bg-violet-600 text-white'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed'"
                    :disabled="!newTypeDraft.label.trim()"
                    @click="addNewRecordType"
                  >Create type</button>
                </div>
              </template>

            </div>
          </transition>
        </div>
      </transition>
    </Teleport>

    <!-- calendar overflow popover -->
    <Teleport to="body">
      <div
        v-if="calOverflowDate"
        class="fixed inset-0 z-50"
        @click="calOverflowDate = null"
      >
        <div
          class="absolute bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl p-2 min-w-[180px] max-w-[240px]"
          :style="{ top: `${Math.min(calOverflowPos.y, window.innerHeight - 240)}px`, left: `${Math.min(calOverflowPos.x + 8, window.innerWidth - 248)}px` }"
          @click.stop
        >
          <p class="text-xs font-semibold text-slate-500 dark:text-slate-400 px-1 pb-1.5">{{ calOverflowDate }}</p>
          <button
            v-for="rec in calOverflowRecords"
            :key="rec.id"
            type="button"
            class="w-full text-left text-xs px-2 py-1 rounded-lg truncate text-slate-700 dark:text-slate-200 hover:bg-sky-50 dark:hover:bg-sky-950/40 hover:text-sky-600 dark:hover:text-sky-400 transition-colors"
            @click="openRecord(rec); calOverflowDate = null"
          >{{ rec.title }}</button>
        </div>
      </div>
    </Teleport>

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

type DataType = 'text' | 'number' | 'email' | 'phone' | 'url' | 'boolean' | 'date' | 'select' | 'multi_select' | 'rating';
type IconKey = 'user' | 'building' | 'chart' | 'target' | 'check' | 'folder' | 'tag' | 'list' | 'layers' | 'star';

type FieldFormat = 'currency' | 'percent' | 'progress' | undefined;

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
  default_value?: string;
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
  field_values: Record<string, string | number | boolean | string[] | null>;
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
  sortField2: string | null;
  sortDir2: 'asc' | 'desc';
  viewMode: 'table' | 'kanban' | 'calendar' | 'gallery';
  hiddenCols: string[];
  showPinnedOnly: boolean;
  showWatchedOnly: boolean;
  showIncompleteOnly: boolean;
  groupByField: string | null;
}

interface FilterPreset {
  id: string;
  name: string;
  typeKey: string;
  filters: Array<{ fieldKey: string; value: string }>;
  fieldTextFilters: Record<string, string>;
  numberMinFilters: Record<string, number | null>;
  numberMaxFilters: Record<string, number | null>;
  dateAfterFilters: Record<string, string | null>;
  dateBeforeFilters: Record<string, string | null>;
  showOverdueOnly: boolean;
  showDueSoonOnly: boolean;
  showPinnedOnly: boolean;
  showWatchedOnly: boolean;
  showIncompleteOnly: boolean;
}

// ── Icon components (memoized — one component per icon key) ───────────────

const ICON_PATHS: Record<IconKey, string> = {
  user:     'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
  building: 'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2zM9 22V12h6v10',
  chart:    'M3 3v18h18M7 16l4-4 4 4 4-4',
  target:   'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 18a6 6 0 100-12 6 6 0 000 12zM12 14a2 2 0 100-4 2 2 0 000 4z',
  check:    'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  folder:   'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  tag:      'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z',
  list:     'M4 6h16M4 10h16M4 14h16M4 18h16',
  layers:   'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  star:     'M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z',
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
  select:       'M4 6h16M4 10h16M4 14h16M4 18h16',
  multi_select: 'M9 12l2 2 4-4M4 6h16M4 10h8M4 14h8M4 18h5',
  rating:       'M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z',
};

// ── Mock schema (mirrors crm_record_types + crm_fields) ───────────────────

const schema = reactive<CrmRecordType[]>([
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
      { id: 'f_co4', key: 'employees',   label: 'Employees',    data_type: 'number',       is_title: false, is_required: false, position: 3 },
      { id: 'f_co5', key: 'annual_rev',  label: 'Annual rev.',  data_type: 'number',       is_title: false, is_required: false, position: 4, format: 'currency' },
      { id: 'f_co6', key: 'products',    label: 'Products',     data_type: 'multi_select', is_title: false, is_required: false, position: 5, select_options: ['CRM', 'Email Marketing', 'Landing Pages', 'Analytics', 'Automation', 'Webinars', 'Coaching Portal'] },
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
      { id: 'f_dl5', key: 'probability', label: 'Win %',      data_type: 'number', is_title: false, is_required: false, position: 4, format: 'progress' },
    ],
  },
  {
    id: 'rt_lead', key: 'lead', label: 'Lead', label_plural: 'Leads',
    icon: 'target', color: '#f59e0b',
    fields: [
      { id: 'f_ld1', key: 'name',      label: 'Name',      data_type: 'text',    is_title: true,  is_required: true,  position: 0 },
      { id: 'f_ld2', key: 'email',     label: 'Email',     data_type: 'email',   is_title: false, is_required: false, position: 1 },
      { id: 'f_ld3', key: 'source',    label: 'Source',    data_type: 'select',  is_title: false, is_required: false, position: 2, select_options: ['Webinar', 'LinkedIn', 'Referral', 'Paid Social', 'Organic', 'Direct'] },
      { id: 'f_ld4', key: 'score',     label: 'Score',     data_type: 'number',  is_title: false, is_required: false, position: 3, format: 'progress' },
      { id: 'f_ld5', key: 'converted', label: 'Converted', data_type: 'boolean', is_title: false, is_required: false, position: 4 },
      { id: 'f_ld6', key: 'quality',   label: 'Quality',   data_type: 'rating',  is_title: false, is_required: false, position: 5 },
    ],
  },
  {
    id: 'rt_work_item', key: 'work_item', label: 'Work Item', label_plural: 'Work Items',
    icon: 'check', color: '#6366f1',
    fields: [
      { id: 'f_wi1', key: 'title',       label: 'Title',      data_type: 'text',   is_title: true,  is_required: true,  position: 0 },
      { id: 'f_wi2', key: 'status',      label: 'Status',     data_type: 'select', is_title: false, is_required: true,  position: 1, select_options: ['Todo', 'In Progress', 'In Review', 'Done', 'Blocked'] },
      { id: 'f_wi3', key: 'priority',    label: 'Priority',   data_type: 'select', is_title: false, is_required: false, position: 2, select_options: ['P0 Critical', 'P1 High', 'P2 Medium', 'P3 Low'] },
      { id: 'f_wi4', key: 'project',     label: 'Project',    data_type: 'select', is_title: false, is_required: false, position: 3, select_options: ['Sulla Desktop', 'TrueQualify', 'DataRipple', 'Sulla Mobile'] },
      { id: 'f_wi5', key: 'assignee',    label: 'Assignee',   data_type: 'text',   is_title: false, is_required: false, position: 4 },
      { id: 'f_wi6', key: 'due_date',    label: 'Due date',   data_type: 'date',   is_title: false, is_required: false, position: 5 },
      { id: 'f_wi7', key: 'description', label: 'Notes',      data_type: 'text',   is_title: false, is_required: false, position: 6 },
    ],
  },
]);

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
    field_values: { name: 'Apex Coaching', domain: 'apexcoaching.com', industry: 'Education', employees: 24, annual_rev: 4200000, products: ['Coaching Portal', 'Email Marketing'] },
    links: [{ target_id: 'r1', target_type: 'contact', target_title: 'Jordan Mitchell' }, { target_id: 'r8', target_type: 'deal', target_title: 'Apex Coaching — Q3 Expansion' }] },
  { id: 'r6', record_type_key: 'company', title: 'ScaleLab', created_at: '2026-04-22T10:15:00Z',
    field_values: { name: 'ScaleLab', domain: 'scalelab.io', industry: 'Marketing', employees: 11, annual_rev: 1800000, products: ['CRM', 'Landing Pages', 'Analytics'] },
    links: [{ target_id: 'r2', target_type: 'contact', target_title: 'Priya Sharma' }, { target_id: 'r9', target_type: 'deal', target_title: 'ScaleLab Renewal' }] },
  { id: 'r7', record_type_key: 'company', title: 'GrowthForge', created_at: '2026-05-05T14:30:00Z',
    field_values: { name: 'GrowthForge', domain: 'growthforge.co', industry: 'Consulting', employees: 7, annual_rev: 920000, products: ['CRM', 'Automation', 'Webinars'] },
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
    field_values: { name: 'FunnelWorks', domain: 'funnelworks.com', industry: 'Marketing', employees: 18, annual_rev: 2400000, products: ['Landing Pages', 'Email Marketing', 'Analytics'] } },
  { id: 'r18', record_type_key: 'company', title: 'MarketMind', created_at: '2026-05-20T11:00:00Z',
    field_values: { name: 'MarketMind', domain: 'marketmind.co', industry: 'Consulting', employees: 5, annual_rev: 680000, products: ['CRM'] } },
  // Contacts (cont.)
  { id: 'r19', record_type_key: 'contact', title: 'Ryan Torres', created_at: '2026-06-14T10:00:00Z',
    field_values: { full_name: 'Ryan Torres', email: 'ryan@funnelworks.com', phone: '+1 555-0412', company: 'FunnelWorks', status: 'Prospect' } },
  { id: 'r20', record_type_key: 'contact', title: 'Aisha Patel', created_at: '2026-06-16T14:20:00Z',
    field_values: { full_name: 'Aisha Patel', email: 'aisha@marketmind.co', phone: null, company: 'MarketMind', status: 'Lead' } },
  // Leads
  { id: 'r10', record_type_key: 'lead', title: 'Alex Rivera', created_at: '2026-06-20T11:20:00Z',
    field_values: { name: 'Alex Rivera', email: 'alex@creativehq.io', source: 'Webinar', score: 82, converted: false, quality: 4 } },
  { id: 'r11', record_type_key: 'lead', title: 'Nina Kowalski', created_at: '2026-06-21T15:10:00Z',
    field_values: { name: 'Nina Kowalski', email: 'nina@marketmind.co', source: 'LinkedIn', score: 91, converted: true, quality: 5 } },
  { id: 'r12', record_type_key: 'lead', title: 'David Chen', created_at: '2026-06-22T08:55:00Z',
    field_values: { name: 'David Chen', email: 'dchen@techsprint.dev', source: 'Referral', score: 74, converted: false, quality: 3 } },
  { id: 'r21', record_type_key: 'lead', title: 'Chris Nakamura', created_at: '2026-06-25T09:30:00Z',
    field_values: { name: 'Chris Nakamura', email: 'chris@organicflow.io', source: 'Organic', score: 68, converted: false, quality: 2 } },
  // Work Items — current project board (2026-06-28)
  { id: 'wi1',  record_type_key: 'work_item', title: 'CRM dynamic architecture — 34-tool surface + Kanban', created_at: '2026-06-20T08:00:00Z',
    field_values: { title: 'CRM dynamic architecture — 34-tool surface + Kanban', status: 'Done', priority: 'P1 High', project: 'Sulla Desktop', assignee: 'Heartbeat', due_date: '2026-06-27', description: 'feat/exechost-tool — 197 commits ahead of main. Full CRM workspace with schema-driven types, Kanban, table, list, gallery views.' }, links: [] },
  { id: 'wi2',  record_type_key: 'work_item', title: 'Push notifications — Tier 2 (call + voicemail alerts)', created_at: '2026-06-21T09:00:00Z',
    field_values: { title: 'Push notifications — Tier 2 (call + voicemail alerts)', status: 'Done', priority: 'P0 Critical', project: 'Sulla Desktop', assignee: 'Heartbeat', due_date: '2026-06-26', description: 'Tiers 0–2 complete. Call screen + voicemail push alerts wired up.' }, links: [] },
  { id: 'wi3',  record_type_key: 'work_item', title: 'BLACK-1 Tier A — JWT + JTI + Clerk super-admin gate', created_at: '2026-06-24T10:00:00Z',
    field_values: { title: 'BLACK-1 Tier A — JWT + JTI + Clerk super-admin gate', status: 'In Review', priority: 'P0 Critical', project: 'DataRipple', assignee: 'Heartbeat', due_date: '2026-06-28', description: 'feat/black-1-tier-a-auth-security — 18 tests passing. Awaits explicit push approval (XHNI).' }, links: [] },
  { id: 'wi4',  record_type_key: 'work_item', title: 'Relay server persistence — scribeRelayTurn() sync', created_at: '2026-06-20T11:00:00Z',
    field_values: { title: 'Relay server persistence — scribeRelayTurn() sync', status: 'In Review', priority: 'P1 High', project: 'Sulla Desktop', assignee: 'Heartbeat', due_date: '2026-06-28', description: 'feat/relay-server-persistence — desktop authoritative scribe via syncMirror.ts. Unpushed, pending review.' }, links: [] },
  { id: 'wi5',  record_type_key: 'work_item', title: 'CRM Kanban compact card mode', created_at: '2026-06-27T08:00:00Z',
    field_values: { title: 'CRM Kanban compact card mode', status: 'Done', priority: 'P2 Medium', project: 'Sulla Desktop', assignee: 'Heartbeat', due_date: '2026-06-27', description: 'Toggle compact/full card density on the Kanban board. Commit afee29fe4.' }, links: [] },
  { id: 'wi6',  record_type_key: 'work_item', title: 'CRM record tags + tag filter bar', created_at: '2026-06-27T08:30:00Z',
    field_values: { title: 'CRM record tags + tag filter bar', status: 'Done', priority: 'P2 Medium', project: 'Sulla Desktop', assignee: 'Heartbeat', due_date: '2026-06-27', description: 'Per-record tag system with inline add/remove, allTags computed, filter in filteredRecords. Commit 49aaa5bd3.' }, links: [] },
  { id: 'wi7',  record_type_key: 'work_item', title: 'CRM table row drag-to-reorder', created_at: '2026-06-27T09:00:00Z',
    field_values: { title: 'CRM table row drag-to-reorder', status: 'Done', priority: 'P2 Medium', project: 'Sulla Desktop', assignee: 'Heartbeat', due_date: '2026-06-27', description: 'HTML5 drag API on table rows with visual drop indicator + customOrder ref. Commit 5f4b09c49.' }, links: [] },
  { id: 'wi8',  record_type_key: 'work_item', title: 'CRM column resize drag handles', created_at: '2026-06-27T09:30:00Z',
    field_values: { title: 'CRM column resize drag handles', status: 'Done', priority: 'P2 Medium', project: 'Sulla Desktop', assignee: 'Heartbeat', due_date: '2026-06-27', description: 'Resize handle on each column header th; columnWidths ref; mousemove listener on window. Commit cbc311fff.' }, links: [] },
  { id: 'wi9',  record_type_key: 'work_item', title: 'CRM column pinning / sticky freeze', created_at: '2026-06-27T10:00:00Z',
    field_values: { title: 'CRM column pinning / sticky freeze', status: 'Done', priority: 'P2 Medium', project: 'Sulla Desktop', assignee: 'Heartbeat', due_date: '2026-06-27', description: 'Pin columns to left with CSS sticky + z-index. pinnedColumnKeys ref; visibleColumns sorts pinned first. Commit 7a3b78e8e.' }, links: [] },
  { id: 'wi10', record_type_key: 'work_item', title: 'CRM record merge dialog (Teleport)', created_at: '2026-06-27T10:30:00Z',
    field_values: { title: 'CRM record merge dialog (Teleport)', status: 'Done', priority: 'P2 Medium', project: 'Sulla Desktop', assignee: 'Heartbeat', due_date: '2026-06-27', description: 'Field-by-field merge chooser via <Teleport to="body">. Auto-picks non-empty source. Commit f91c3cba4.' }, links: [] },
  { id: 'wi11', record_type_key: 'work_item', title: 'CRM record templates — save & apply', created_at: '2026-06-27T11:00:00Z',
    field_values: { title: 'CRM record templates — save & apply', status: 'Done', priority: 'P2 Medium', project: 'Sulla Desktop', assignee: 'Heartbeat', due_date: '2026-06-27', description: 'Save current record as named template; apply template to create pre-filled records. Commit 3c7286731.' }, links: [] },
  { id: 'wi12', record_type_key: 'work_item', title: 'CRM inline row expand for long text', created_at: '2026-06-27T11:30:00Z',
    field_values: { title: 'CRM inline row expand for long text', status: 'Done', priority: 'P3 Low', project: 'Sulla Desktop', assignee: 'Heartbeat', due_date: '2026-06-27', description: 'Text >80 chars gets "more/less" toggle in table cells. expandedRowIds Set ref. Commit 85fdaa0da.' }, links: [] },
  { id: 'wi13', record_type_key: 'work_item', title: 'CRM scroll position memory per type', created_at: '2026-06-27T12:00:00Z',
    field_values: { title: 'CRM scroll position memory per type', status: 'Done', priority: 'P3 Low', project: 'Sulla Desktop', assignee: 'Heartbeat', due_date: '2026-06-27', description: 'scrollPositions ref keyed by typeKey; @scroll.passive writes position; selectType() restores via nextTick. Commit 61ca3cd28.' }, links: [] },
  { id: 'wi14', record_type_key: 'work_item', title: 'TrueQualify website copy — 9 mismatch fixes', created_at: '2026-06-28T00:00:00Z',
    field_values: { title: 'TrueQualify website copy — 9 mismatch fixes', status: 'Done', priority: 'P1 High', project: 'TrueQualify', assignee: 'Heartbeat', due_date: '2026-06-28', description: 'home.tsx, pricing.tsx: CAC channel copy, trust logos, testimonial, plan model, FAQ endpoint names. Commit cda0043.' }, links: [] },
  { id: 'wi15', record_type_key: 'work_item', title: 'TrueQualify team members tab reformat', created_at: '2026-06-28T01:00:00Z',
    field_values: { title: 'TrueQualify team members tab reformat', status: 'Done', priority: 'P2 Medium', project: 'TrueQualify', assignee: 'Heartbeat', due_date: '2026-06-28', description: 'Avatar color variety, "you" badge, joinedAt date in meta, Owner lock-badge replaces disabled dropdown. Commit be2569a.' }, links: [] },
  { id: 'wi16', record_type_key: 'work_item', title: 'CRM work_item record type + project board seed', created_at: '2026-06-28T01:27:00Z',
    field_values: { title: 'CRM work_item record type + project board seed', status: 'In Progress', priority: 'P2 Medium', project: 'Sulla Desktop', assignee: 'Heartbeat', due_date: '2026-06-28', description: 'Adding work_item type to CRM schema with status/priority/project fields + seeding 18 work items reflecting current sprint.' }, links: [] },
  { id: 'wi17', record_type_key: 'work_item', title: 'CRM field_definitions CRUD endpoints (seMX)', created_at: '2026-06-28T02:00:00Z',
    field_values: { title: 'CRM field_definitions CRUD endpoints (seMX)', status: 'Todo', priority: 'P1 High', project: 'Sulla Desktop', assignee: 'Heartbeat', due_date: '2026-07-05', description: 'Runtime field creation/editing via UI — schema-driven type builder for Jonathon\'s AI-driven CRM vision.' }, links: [] },
  { id: 'wi18', record_type_key: 'work_item', title: 'CRM record_types runtime creation (seMX)', created_at: '2026-06-28T02:00:00Z',
    field_values: { title: 'CRM record_types runtime creation (seMX)', status: 'Todo', priority: 'P1 High', project: 'Sulla Desktop', assignee: 'Heartbeat', due_date: '2026-07-05', description: 'Allow users to create new record types at runtime — complete the dynamic CRM architecture end-to-end.' }, links: [] },
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
  deal:      ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'],
  contact:   ['Lead', 'Prospect', 'Active', 'Churned'],
  lead:      ['Webinar', 'LinkedIn', 'Referral', 'Paid Social', 'Organic', 'Direct'],
  company:   ['Education', 'Marketing', 'Consulting', 'Technology', 'Finance', 'Healthcare', 'Other'],
  work_item: ['Todo', 'In Progress', 'In Review', 'Done', 'Blocked'],
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
const viewMode = ref<'table' | 'kanban' | 'calendar' | 'gallery'>('table');
const galleryColCount = ref<2 | 3 | 4>(3);
const galleryFocusIdx = ref(-1);
const rowDensity = ref<'comfortable' | 'compact'>('comfortable');
const creatingRecord = ref(false);
const draftValues = ref<Record<string, string | number | boolean | null>>({});
const createFormErrors = ref<Set<string>>(new Set());
const sortField = ref<string | null>(null);
const sortDir = ref<'asc' | 'desc'>('asc');
const sortField2 = ref<string | null>(null);
const sortDir2 = ref<'asc' | 'desc'>('asc');
const navigationStack = ref<Array<{ record: CrmRecord; typeKey: string }>>([]);
const fieldTextFilters = ref<Record<string, string>>({});
const numberMinFilters = ref<Record<string, number | null>>({});
const numberMaxFilters = ref<Record<string, number | null>>({});
const dateAfterFilters = ref<Record<string, string | null>>({});
const dateBeforeFilters = ref<Record<string, string | null>>({});
const selectedIds = ref<Set<string>>(new Set());
const hiddenColumnKeys = ref<Set<string>>(new Set());
const pinnedColumnKeys = ref<Set<string>>(new Set());
const expandedRowIds = ref<Set<string>>(new Set());
const tableScrollEl = ref<HTMLElement | null>(null);
const scrollPositions = ref<Record<string, number>>({});
const columnWidths = ref<Record<string, number>>({});
let colResizeDragKey: string | null = null;
let colResizeDragStart = 0;
let colResizeDragStartWidth = 0;
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
const showColStatsModal = ref(false);
const colStatsFieldKey = ref<string | null>(null);
const colDragSrc = ref<string | null>(null);
const colDragOver = ref<string | null>(null);
const schemaDragSrc = ref<string | null>(null);
const schemaDragOver = ref<string | null>(null);
const sidebarTypeDragSrc = ref<string | null>(null);
const sidebarTypeDragOver = ref<string | null>(null);
const editingColKey = ref<string | null>(null);
const editingColLabel = ref('');
const groupByField = ref<string | null>(null);
const showAddStageInput = ref(false);
const newStageName = ref('');
const addStageInputEl = ref<HTMLInputElement | null>(null);

const kanbanInlineAdd = ref<{ col: string } | null>(null);
const kanbanInlineTitle = ref('');
const kanbanInlineInputEl = ref<HTMLInputElement | null>(null);
watch(showAddStageInput, (v) => { if (v) { newStageName.value = ''; nextTick(() => addStageInputEl.value?.focus()); } });
const collapsedGroups = ref<Set<string>>(new Set());
watch(groupByField, () => { collapsedGroups.value = new Set(); });
const showBulkNoteModal = ref(false);
const bulkNoteText = ref('');
const bulkNoteInputEl = ref<HTMLTextAreaElement | null>(null);
watch(showBulkNoteModal, (val) => { if (val) { bulkNoteText.value = ''; nextTick(() => bulkNoteInputEl.value?.focus()); } });
const showBulkFieldModal = ref(false);
const bulkFieldKey = ref<string | null>(null);
const bulkFieldValue = ref<string | number | boolean | string[] | null>(null);
watch(showBulkFieldModal, (val) => { if (!val) { bulkFieldKey.value = null; bulkFieldValue.value = null; } });
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
const editFormErrors = ref<Set<string>>(new Set());
const recentRecords = ref<CrmRecord[]>([]); // last 5 opened, newest first
const linkQuery = ref('');
const linkDropdownOpen = ref(false);
const watchedIds = ref<Set<string>>(new Set());
const COLOR_LABEL_PALETTE = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'] as const;
const colorLabels = ref<Record<string, string>>({});
const colorLabelFilter = ref<string | null>(null);
const recordTags = ref<Record<string, string[]>>({});
const tagFilter = ref<string | null>(null);
const tagInput = ref('');
const showTagInput = ref(false);
const showDetailColorPicker = ref(false);
const staleDaysFilter = ref<number | null>(null);
const showStaleDropdown = ref(false);
const createdPreset = ref<'today' | 'week' | 'month' | null>(null);
const detailPanelExpanded = ref<false | 'wide' | 'full'>(false);
const kanbanCompact = ref(false);
const customOrder = ref<string[]>([]);
const dragSrcId = ref<string | null>(null);
const dragOverId = ref<string | null>(null);
interface ConditionalRule { id: string; fieldKey: string; operator: 'equals' | 'not_equals' | 'contains' | 'gt' | 'lt' | 'is_empty' | 'is_not_empty'; value: string; color: string }
const conditionalRules = ref<ConditionalRule[]>([]);
const showFormatPanel = ref(false);
const groupMenu = ref<{ key: string; label: string; count: number; x: number; y: number } | null>(null);
const wipLimits = ref<Record<string, number>>({});
const kanbanColMenu = ref<{ col: string; x: number; y: number } | null>(null);
const wipLimitEditing = ref<string | null>(null);
const wipLimitDraft = ref('');
const wipLimitInputEl = ref<HTMLInputElement | null>(null);
watch(wipLimitEditing, (val) => { if (val) nextTick(() => wipLimitInputEl.value?.focus()); });
const showMergeModal = ref(false);
interface RecordTemplate { id: string; name: string; typeKey: string; fieldValues: Record<string, unknown> }
const recordTemplates = ref<RecordTemplate[]>([]);
const showTemplatePanel = ref(false);
const showQuickFilterPanel = ref(false);
const showBulkTagDropdown = ref(false);
const bulkTagInput = ref('');
const templateDraftName = ref('');
const mergeSourceId = ref<string | null>(null);
const mergeTargetId = ref<string | null>(null);
const mergeFieldChoices = ref<Record<string, 'primary' | 'secondary'>>({});
const showImportModal = ref(false);
const importStep = ref<'paste' | 'map' | 'preview'>('paste');
const importCsvText = ref('');
const importParsed = ref<string[][]>([]);
const importMapping = ref<Record<number, string>>({});
const importHeaderRow = ref(true);
const previewRecord = ref<CrmRecord | null>(null);
const previewPos = ref({ x: 0, y: 0 });
let previewTimer: ReturnType<typeof setTimeout> | null = null;

// ── Schema editor ──────────────────────────────────────────────────────────
const showSchemaEditor = ref(false);
const schemaEditorMode = ref<'fields' | 'new-type'>('fields');
const showAddFieldForm = ref(false);
const schemaTypeLabelDraft = ref<string | null>(null);
const schemaTypeLabelInputEl = ref<HTMLInputElement | null>(null);
const showTypeIconColorPicker = ref(false);
const newFieldDraft = ref<{ label: string; key: string; data_type: DataType; select_options_raw: string; default_value: string }>({ label: '', key: '', data_type: 'text', select_options_raw: '', default_value: '' });
const newTypeDraft = ref<{ label: string; key: string; icon: IconKey; color: string }>({ label: '', key: '', icon: 'folder', color: '#6366f1' });
const SCHEMA_ICON_OPTIONS: IconKey[] = ['user', 'building', 'chart', 'target', 'check', 'folder', 'tag', 'list', 'layers', 'star'];
const SCHEMA_COLOR_PRESETS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#6366f1', '#ec4899', '#ef4444', '#14b8a6', '#f97316', '#64748b'];
const annotationDraft = ref('');
const annotationInputEl = ref<HTMLInputElement | null>(null);
watch(annotatingField, (val) => { if (val) nextTick(() => annotationInputEl.value?.focus()); });

const newRecordTitleInputEl = ref<HTMLInputElement | null>(null);
watch(creatingRecord, (val) => { if (val) nextTick(() => newRecordTitleInputEl.value?.focus()); });
const showInlineAdd = ref(false);
const inlineAddTitle = ref('');
const inlineAddInputEl = ref<HTMLInputElement | null>(null);
watch(showInlineAdd, (val) => { if (val) nextTick(() => inlineAddInputEl.value?.focus()); });
const tagInputEl = ref<HTMLInputElement | null>(null);

// ── localStorage persistence ────────────────────────────────────────────────
const LS_KEY_VIEW_MODE = 'crm:viewMode';
const LS_KEY_HIDDEN_COLS = 'crm:hiddenCols';
const LS_KEY_ROW_DENSITY = 'crm:rowDensity';
const LS_KEY_SAVED_VIEWS = 'crm:savedViews';
const LS_KEY_ARCHIVED = 'crm:archivedIds';
const LS_KEY_FILTER_PRESETS = 'crm:filterPresets';
const LS_KEY_GALLERY_FIELDS = 'crm:galleryFields';

const archivedIds = ref<Set<string>>(new Set());
const showArchived = ref(false);

const filterPresets = ref<FilterPreset[]>([]);
const showFilterPresetsPanel = ref(false);
const filterPresetNameInput = ref('');

const galleryPreviewFieldKeys = ref<Record<string, string[]>>({});
const showGalleryFieldsPopover = ref(false);

onMounted(() => {
  try {
    const savedView = localStorage.getItem(LS_KEY_VIEW_MODE) as 'table' | 'kanban' | 'calendar' | null;
    if (savedView === 'table' || savedView === 'kanban' || savedView === 'calendar') viewMode.value = savedView;
    const savedHidden = localStorage.getItem(LS_KEY_HIDDEN_COLS);
    if (savedHidden) hiddenColumnKeys.value = new Set(JSON.parse(savedHidden) as string[]);
    const savedDensity = localStorage.getItem(LS_KEY_ROW_DENSITY) as 'comfortable' | 'compact' | null;
    if (savedDensity === 'comfortable' || savedDensity === 'compact') rowDensity.value = savedDensity;
    const sv = localStorage.getItem(LS_KEY_SAVED_VIEWS);
    if (sv) savedViews.value = JSON.parse(sv) as SavedView[];
    const sa = localStorage.getItem(LS_KEY_ARCHIVED);
    if (sa) archivedIds.value = new Set(JSON.parse(sa) as string[]);
    const fp = localStorage.getItem(LS_KEY_FILTER_PRESETS);
    if (fp) filterPresets.value = JSON.parse(fp) as FilterPreset[];
    const gf = localStorage.getItem(LS_KEY_GALLERY_FIELDS);
    if (gf) galleryPreviewFieldKeys.value = JSON.parse(gf) as Record<string, string[]>;
  } catch { /* storage not available */ }
});

watch(viewMode, (val) => {
  try { localStorage.setItem(LS_KEY_VIEW_MODE, val); } catch { /* ignore */ }
  if (val !== 'gallery') galleryFocusIdx.value = -1;
});
watch(hiddenColumnKeys, (val) => { try { localStorage.setItem(LS_KEY_HIDDEN_COLS, JSON.stringify([...val])); } catch { /* ignore */ } });
watch(rowDensity, (val) => { try { localStorage.setItem(LS_KEY_ROW_DENSITY, val); } catch { /* ignore */ } });
watch(savedViews, (val) => { try { localStorage.setItem(LS_KEY_SAVED_VIEWS, JSON.stringify(val)); } catch { /* ignore */ } }, { deep: true });
watch(archivedIds, (val) => { try { localStorage.setItem(LS_KEY_ARCHIVED, JSON.stringify([...val])); } catch { /* ignore */ } }, { deep: true });
watch(filterPresets, (val) => { try { localStorage.setItem(LS_KEY_FILTER_PRESETS, JSON.stringify(val)); } catch { /* ignore */ } }, { deep: true });
watch(galleryPreviewFieldKeys, (val) => { try { localStorage.setItem(LS_KEY_GALLERY_FIELDS, JSON.stringify(val)); } catch { /* ignore */ } }, { deep: true });

// ── Computed ───────────────────────────────────────────────────────────────

const selectedType = computed(() =>
  schema.find((rt) => rt.key === selectedTypeKey.value) ?? null,
);

const usedColorLabels = computed(() => {
  const typeRecs = mockRecords.filter((r) => r.record_type_key === selectedTypeKey.value);
  return COLOR_LABEL_PALETTE.filter((c) => typeRecs.some((r) => colorLabels.value[r.id] === c));
});

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

const activityCountByRecord = computed((): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const a of mockActivities) {
    counts[a.record_id] = (counts[a.record_id] ?? 0) + 1;
  }
  return counts;
});

const lastActivityByRecord = computed((): Record<string, number> => {
  const stamps: Record<string, number> = {};
  for (const a of mockActivities) {
    const t = new Date(a.created_at).getTime();
    if (!stamps[a.record_id] || t > stamps[a.record_id]) stamps[a.record_id] = t;
  }
  return stamps;
});

// Due-date urgency — first date field in type is used as the due-date proxy
const DUE_TODAY_STR = new Date().toISOString().slice(0, 10);
const DUE_SOON_STR = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
})();

const dueDateField = computed(() =>
  selectedType.value?.fields.find((f) => f.data_type === 'date') ?? null,
);
// These use all type records (not filteredRecords) to avoid circular dependency
const overdueIds = computed((): Set<string> => {
  const df = dueDateField.value;
  if (!df) return new Set();
  return new Set(
    mockRecords
      .filter((r) => r.record_type_key === selectedTypeKey.value && typeof r.field_values[df.key] === 'string' && String(r.field_values[df.key]) < DUE_TODAY_STR)
      .map((r) => r.id),
  );
});
const dueSoonIds = computed((): Set<string> => {
  const df = dueDateField.value;
  if (!df) return new Set();
  return new Set(
    mockRecords
      .filter((r) => {
        if (r.record_type_key !== selectedTypeKey.value) return false;
        const v = r.field_values[df.key];
        return typeof v === 'string' && String(v) >= DUE_TODAY_STR && String(v) <= DUE_SOON_STR;
      })
      .map((r) => r.id),
  );
});

const showOverdueOnly = ref(false);
const showDueSoonOnly = ref(false);

const filteredOverdueCount = computed(() =>
  dueDateField.value
    ? filteredRecords.value.filter((r) => overdueIds.value.has(r.id)).length
    : 0,
);
const filteredDueSoonCount = computed(() =>
  dueDateField.value
    ? filteredRecords.value.filter((r) => dueSoonIds.value.has(r.id)).length
    : 0,
);

const hasAnyFilter = computed(() =>
  activeFilters.value.length > 0 ||
  Object.values(fieldTextFilters.value).some((v) => v.trim()) ||
  Object.values(numberMinFilters.value).some((v) => v != null) ||
  Object.values(numberMaxFilters.value).some((v) => v != null) ||
  Object.values(dateAfterFilters.value).some((v) => v) ||
  Object.values(dateBeforeFilters.value).some((v) => v) ||
  showOverdueOnly.value ||
  showDueSoonOnly.value ||
  showPinnedOnly.value ||
  showWatchedOnly.value ||
  showIncompleteOnly.value,
);

const typeFilterPresets = computed(() =>
  filterPresets.value.filter((p) => p.typeKey === selectedTypeKey.value),
);

const staleIds = computed((): Set<string> => {
  const days = staleDaysFilter.value;
  if (!days) return new Set();
  const cutoff = Date.now() - days * 86_400_000;
  const out = new Set<string>();
  for (const r of mockRecords.filter((r) => r.record_type_key === selectedTypeKey.value)) {
    const last = lastActivityByRecord.value[r.id] ?? new Date(r.created_at).getTime();
    if (last < cutoff) out.add(r.id);
  }
  return out;
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

// Quick-filter panel — per-field value counts across all current type records
const quickFilterFieldStats = computed((): Array<{
  key: string; label: string; dataType: DataType;
  options: Array<{ value: string; count: number; active: boolean }>;
}> => {
  if (!selectedType.value) return [];
  const typeRecs = mockRecords.filter((r) => r.record_type_key === selectedTypeKey.value);
  return [...selectedType.value.fields]
    .filter((f) => f.data_type === 'select' || f.data_type === 'multi_select')
    .sort((a, b) => a.position - b.position)
    .map((f) => {
      const counts: Record<string, number> = {};
      for (const r of typeRecs) {
        const v = r.field_values[f.key];
        if (v == null) continue;
        const vals = Array.isArray(v) ? v : [String(v)];
        for (const val of vals) {
          if (val) counts[val] = (counts[val] ?? 0) + 1;
        }
      }
      const opts = (f.select_options ?? []).length
        ? (f.select_options ?? []).filter((o) => counts[o] != null)
        : Object.keys(counts);
      return {
        key: f.key,
        label: f.label,
        dataType: f.data_type,
        options: opts.map((o) => ({
          value: o,
          count: counts[o] ?? 0,
          active: activeFilters.value.some((af) => af.fieldKey === f.key && af.value === o),
        })),
      };
    })
    .filter((f) => f.options.length > 0);
});

const allColumns = computed(() =>
  (selectedType.value?.fields ?? [])
    .slice()
    .sort((a, b) => a.position - b.position),
);

const visibleColumns = computed(() => {
  const cols = allColumns.value.filter((c) => !hiddenColumnKeys.value.has(c.key));
  const pinned = cols.filter((c) => pinnedColumnKeys.value.has(c.key));
  const rest = cols.filter((c) => !pinnedColumnKeys.value.has(c.key));
  return [...pinned, ...rest];
});

const activeSortLabel = computed(() => {
  if (!sortField.value) return null;
  if (sortField.value === '__created_at__') return 'Added';
  if (sortField.value === '__updated_at__') return 'Updated';
  if (sortField.value === '__activity_count__') return 'Activity';
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
const archivedCountForType = computed(() =>
  mockRecords.filter((r) => r.record_type_key === selectedTypeKey.value && archivedIds.value.has(r.id)).length,
);

const filteredRecords = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const recs = mockRecords.filter((r) => {
    if (r.record_type_key !== selectedTypeKey.value) return false;
    return showArchived.value ? archivedIds.value.has(r.id) : !archivedIds.value.has(r.id);
  });
  let result: CrmRecord[] = q
    ? recs.filter((r) =>
        r.title.toLowerCase().includes(q) ||
        Object.values(r.field_values).some((v) => {
          if (v == null) return false;
          if (Array.isArray(v)) return v.some((s) => s.toLowerCase().includes(q));
          return String(v).toLowerCase().includes(q);
        })
      )
    : recs;

  if (activeFilters.value.length) {
    const byField = new Map<string, string[]>();
    for (const f of activeFilters.value) {
      const existing = byField.get(f.fieldKey) ?? [];
      existing.push(f.value);
      byField.set(f.fieldKey, existing);
    }
    result = result.filter((r) => {
      for (const [fk, vals] of byField) {
        const fv = r.field_values[fk];
        const matches = Array.isArray(fv)
          ? vals.some((v) => fv.includes(v))
          : vals.some((v) => String(fv ?? '') === v);
        if (!matches) return false;
      }
      return true;
    });
  }

  const ftEntries = Object.entries(fieldTextFilters.value).filter(([, v]) => v.trim());
  if (ftEntries.length) {
    result = result.filter((r) =>
      ftEntries.every(([k, q]) =>
        String(r.field_values[k] ?? r.title ?? '').toLowerCase().includes(q.toLowerCase()),
      ),
    );
  }

  const nMinE = Object.entries(numberMinFilters.value).filter(([, v]) => v != null);
  const nMaxE = Object.entries(numberMaxFilters.value).filter(([, v]) => v != null);
  if (nMinE.length || nMaxE.length) {
    result = result.filter((r) => {
      for (const [k, min] of nMinE) {
        if (min != null && Number(r.field_values[k] ?? 0) < min) return false;
      }
      for (const [k, max] of nMaxE) {
        if (max != null && Number(r.field_values[k] ?? 0) > max) return false;
      }
      return true;
    });
  }

  const dAfterE = Object.entries(dateAfterFilters.value).filter(([, v]) => v);
  const dBeforeE = Object.entries(dateBeforeFilters.value).filter(([, v]) => v);
  if (dAfterE.length || dBeforeE.length) {
    result = result.filter((r) => {
      for (const [k, after] of dAfterE) {
        if (!after) continue;
        const rv = r.field_values[k];
        if (!rv || new Date(String(rv)) < new Date(after)) return false;
      }
      for (const [k, before] of dBeforeE) {
        if (!before) continue;
        const rv = r.field_values[k];
        if (!rv || new Date(String(rv)) > new Date(before)) return false;
      }
      return true;
    });
  }

  if (colorLabelFilter.value) {
    const fc = colorLabelFilter.value;
    result = result.filter((r) => colorLabels.value[r.id] === fc);
  }

  if (tagFilter.value) {
    const ft = tagFilter.value;
    result = result.filter((r) => (recordTags.value[r.id] ?? []).includes(ft));
  }

  if (staleDaysFilter.value) {
    const cutoff = Date.now() - staleDaysFilter.value * 86_400_000;
    result = result.filter((r) => {
      const last = lastActivityByRecord.value[r.id] ?? new Date(r.created_at).getTime();
      return last < cutoff;
    });
  }

  if (showOverdueOnly.value && dueDateField.value) {
    const dfKey = dueDateField.value.key;
    result = result.filter((r) => typeof r.field_values[dfKey] === 'string' && String(r.field_values[dfKey]) < DUE_TODAY_STR);
  }

  if (showDueSoonOnly.value && dueDateField.value) {
    const dfKey = dueDateField.value.key;
    result = result.filter((r) => {
      const v = r.field_values[dfKey];
      return typeof v === 'string' && String(v) >= DUE_TODAY_STR && String(v) <= DUE_SOON_STR;
    });
  }

  if (createdPreset.value) {
    const now = new Date();
    let start: Date;
    if (createdPreset.value === 'today') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (createdPreset.value === 'week') {
      const d = new Date(now); d.setDate(d.getDate() - d.getDay()); d.setHours(0, 0, 0, 0); start = d;
    } else {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    result = result.filter((r) => new Date(r.created_at) >= start);
  }

  if (sortField.value) {
    const fields = selectedType.value?.fields;
    const colFor = (key: string) => fields?.find((f) => f.key === key);
    const numVal = (r: CrmRecord, key: string): number => {
      if (key === '__created_at__') return new Date(r.created_at).getTime();
      if (key === '__updated_at__') return r.updated_at ? new Date(r.updated_at).getTime() : new Date(r.created_at).getTime();
      if (key === '__activity_count__') return activityCountByRecord.value[r.id] ?? 0;
      return 0;
    };
    const strVal = (r: CrmRecord, key: string): string | number | boolean | null => r.field_values[key] ?? null;
    const cmpOne = (a: CrmRecord, b: CrmRecord, key: string, dir: number): number => {
      if (['__created_at__', '__updated_at__', '__activity_count__'].includes(key)) {
        return (numVal(a, key) - numVal(b, key)) * dir;
      }
      const col = colFor(key);
      const av = strVal(a, key);
      const bv = strVal(b, key);
      if (av == null && bv == null) return 0;
      if (av == null) return dir;
      if (bv == null) return -dir;
      if (col?.data_type === 'number') return (Number(av) - Number(bv)) * dir;
      if (col?.data_type === 'boolean') return ((av ? 1 : 0) - (bv ? 1 : 0)) * dir;
      if (col?.data_type === 'date') return (new Date(String(av)).getTime() - new Date(String(bv)).getTime()) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    };
    const dir1 = sortDir.value === 'asc' ? 1 : -1;
    const key2 = sortField2.value;
    const dir2 = sortDir2.value === 'asc' ? 1 : -1;
    result = [...result].sort((a, b) => {
      const p = cmpOne(a, b, sortField.value!, dir1);
      if (p !== 0 || !key2) return p;
      return cmpOne(a, b, key2, dir2);
    });
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

  if (!sortField.value && customOrder.value.length) {
    const order = customOrder.value;
    result = [...result].sort((a, b) => {
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }

  return result;
});

// Row grouping for table view — null means no grouping active
type GroupRow = { kind: 'header'; key: string; label: string; count: number } | { kind: 'record'; record: CrmRecord; idxInFiltered: number };
const groupedTableRows = computed((): GroupRow[] | null => {
  if (!groupByField.value || viewMode.value !== 'table') return null;
  const fkey = groupByField.value;
  const field = allColumns.value.find((c) => c.key === fkey);
  const opts = field?.select_options ?? [];
  const ungrouped: CrmRecord[] = [];
  const byVal: Record<string, CrmRecord[]> = {};
  for (const r of filteredRecords.value) {
    const v = r.field_values[fkey];
    if (v == null || String(v) === '') { ungrouped.push(r); continue; }
    const k = String(v);
    if (!byVal[k]) byVal[k] = [];
    byVal[k].push(r);
  }
  const order = opts.length ? opts : Object.keys(byVal);
  const rows: GroupRow[] = [];
  for (const opt of order) {
    const recs = byVal[opt];
    if (!recs?.length) continue;
    rows.push({ kind: 'header', key: opt, label: opt, count: recs.length });
    if (!collapsedGroups.value.has(opt)) {
      for (const r of recs) {
        rows.push({ kind: 'record', record: r, idxInFiltered: filteredRecords.value.indexOf(r) });
      }
    }
  }
  if (ungrouped.length) {
    rows.push({ kind: 'header', key: '__ungrouped__', label: 'No value', count: ungrouped.length });
    if (!collapsedGroups.value.has('__ungrouped__')) {
      for (const r of ungrouped) {
        rows.push({ kind: 'record', record: r, idxInFiltered: filteredRecords.value.indexOf(r) });
      }
    }
  }
  return rows;
});

const groupedStats = computed((): Record<string, Record<string, { sum: number; count: number }>> => {
  if (!groupByField.value) return {};
  const fkey = groupByField.value;
  const numericCols = visibleColumns.value.filter((c) => c.data_type === 'number');
  if (!numericCols.length) return {};
  const stats: Record<string, Record<string, { sum: number; count: number }>> = {};
  for (const r of filteredRecords.value) {
    const gk = r.field_values[fkey] != null && String(r.field_values[fkey]) !== '' ? String(r.field_values[fkey]) : '__ungrouped__';
    if (!stats[gk]) stats[gk] = {};
    for (const col of numericCols) {
      if (!stats[gk][col.key]) stats[gk][col.key] = { sum: 0, count: 0 };
      const v = Number(r.field_values[col.key]);
      if (!isNaN(v) && r.field_values[col.key] != null) { stats[gk][col.key].sum += v; stats[gk][col.key].count++; }
    }
  }
  return stats;
});

function toggleGroupCollapse(key: string) {
  const next = new Set(collapsedGroups.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  collapsedGroups.value = next;
}

function selectGroupRecords(groupKey: string) {
  if (!groupByField.value) return;
  const fkey = groupByField.value;
  const recs = filteredRecords.value.filter((r) => {
    const v = r.field_values[fkey];
    const k = v != null && String(v) !== '' ? String(v) : '__ungrouped__';
    return k === groupKey;
  });
  const next = new Set(selectedIds.value);
  recs.forEach((r) => next.add(r.id));
  selectedIds.value = next;
}

function moveGroupToStage(groupKey: string, targetStage: string) {
  if (!groupByField.value) return;
  const fkey = groupByField.value;
  const recs = filteredRecords.value.filter((r) => {
    const v = r.field_values[fkey];
    const k = v != null && String(v) !== '' ? String(v) : '__ungrouped__';
    return k === groupKey;
  });
  recs.forEach((r) => { r.field_values[fkey] = targetStage; });
  showToast(`Moved ${recs.length} record${recs.length === 1 ? '' : 's'} to ${targetStage}`);
}

function deleteGroupRecords(groupKey: string) {
  if (!groupByField.value) return;
  const fkey = groupByField.value;
  const recs = filteredRecords.value.filter((r) => {
    const v = r.field_values[fkey];
    const k = v != null && String(v) !== '' ? String(v) : '__ungrouped__';
    return k === groupKey;
  });
  const ids = new Set(recs.map((r) => r.id));
  const removed = recs.slice();
  for (let i = mockRecords.length - 1; i >= 0; i--) {
    if (ids.has(mockRecords[i].id)) mockRecords.splice(i, 1);
  }
  if (openedRecord.value && ids.has(openedRecord.value.id)) openedRecord.value = null;
  selectedIds.value = new Set([...selectedIds.value].filter((id) => !ids.has(id)));
  showToast(`Deleted ${removed.length} record${removed.length === 1 ? '' : 's'}`, {
    label: 'Undo',
    fn: () => { removed.forEach((r) => mockRecords.push(r)); },
  });
}

function commitWipLimit(col: string) {
  const n = parseInt(wipLimitDraft.value, 10);
  if (n > 0) { wipLimits.value = { ...wipLimits.value, [col]: n }; }
  wipLimitEditing.value = null;
  wipLimitDraft.value = '';
}

function stageColorHex(stage: string): string {
  const cls = selectBadgeClass(stage);
  if (cls.includes('green')) return '#22c55e';
  if (cls.includes('blue')) return '#3b82f6';
  if (cls.includes('amber') || cls.includes('yellow')) return '#f59e0b';
  if (cls.includes('red') || cls.includes('rose')) return '#ef4444';
  if (cls.includes('purple') || cls.includes('violet')) return '#8b5cf6';
  if (cls.includes('teal') || cls.includes('cyan')) return '#06b6d4';
  return '#94a3b8';
}

function commitAddStage() {
  const name = newStageName.value.trim();
  if (!name || !kanbanField.value) { showAddStageInput.value = false; return; }
  if (!kanbanField.value.select_options) kanbanField.value.select_options = [];
  if (!kanbanField.value.select_options.includes(name)) {
    kanbanField.value.select_options.push(name);
    showToast(`Stage "${name}" added`);
  }
  showAddStageInput.value = false;
}

// The first select field drives the kanban grouping dimension
const kanbanField = computed(() =>
  selectedType.value?.fields.find((f) => f.data_type === 'select') ?? null,
);

const canKanban = computed(() => kanbanField.value != null);

// ── Calendar view ────────────────────────────────────────────────────────────
const calendarYear = ref(2026);
const calendarMonth = ref(5); // 0-indexed: 5 = June
const calOverflowDate = ref<string | null>(null);
const calOverflowPos = ref({ x: 0, y: 0 });
const calOverflowRecords = computed((): CrmRecord[] => {
  const date = calOverflowDate.value;
  if (!date) return [];
  for (const week of calendarGrid.value) {
    const cell = week.find((c) => c.date === date);
    if (cell) return cell.records;
  }
  return [];
});

const calendarDateField = computed(() =>
  selectedType.value?.fields.find((f) => f.data_type === 'date') ?? null,
);
const canCalendar = computed(() => calendarDateField.value != null);

const galleryPreviewFields = computed(() => {
  if (!selectedType.value) return [];
  const chosen = galleryPreviewFieldKeys.value[selectedTypeKey.value];
  const allNonTitle = [...selectedType.value.fields].filter((f) => !f.is_title).sort((a, b) => a.position - b.position);
  if (chosen?.length) {
    return chosen.map((k) => allNonTitle.find((f) => f.key === k)).filter(Boolean) as typeof allNonTitle;
  }
  return allNonTitle.slice(0, 3);
});

type GalleryGroup = { key: string; label: string; records: CrmRecord[] };
const groupedGalleryGroups = computed((): GalleryGroup[] | null => {
  if (!groupByField.value || viewMode.value !== 'gallery') return null;
  const fkey = groupByField.value;
  const field = allColumns.value.find((c) => c.key === fkey);
  const opts = field?.select_options ?? [];
  const ungrouped: CrmRecord[] = [];
  const byVal: Record<string, CrmRecord[]> = {};
  for (const r of filteredRecords.value) {
    const v = r.field_values[fkey];
    if (v == null || String(v) === '') { ungrouped.push(r); continue; }
    const k = String(v);
    if (!byVal[k]) byVal[k] = [];
    byVal[k].push(r);
  }
  const order = opts.length ? opts : Object.keys(byVal);
  const groups: GalleryGroup[] = [];
  for (const opt of order) {
    const recs = byVal[opt];
    if (!recs?.length) continue;
    groups.push({ key: opt, label: opt, records: recs });
  }
  if (ungrouped.length) {
    groups.push({ key: '__ungrouped__', label: 'No value', records: ungrouped });
  }
  return groups.length ? groups : null;
});

interface CalDay {
  date: string;       // ISO yyyy-mm-dd
  dayNum: number;
  inMonth: boolean;
  records: CrmRecord[];
}

const calendarGrid = computed((): CalDay[][] => {
  const fkey = calendarDateField.value?.key;
  const yr = calendarYear.value;
  const mo = calendarMonth.value;
  const firstOfMonth = new Date(yr, mo, 1);
  const startDow = firstOfMonth.getDay(); // 0=Sun
  // Grid starts on the Sunday at or before the 1st
  const gridStart = new Date(yr, mo, 1 - startDow);
  const recs = filteredRecords.value;

  const weeks: CalDay[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: CalDay[] = [];
    for (let d = 0; d < 7; d++) {
      const cellDate = new Date(gridStart);
      cellDate.setDate(gridStart.getDate() + w * 7 + d);
      const iso = cellDate.toISOString().slice(0, 10);
      row.push({
        date: iso,
        dayNum: cellDate.getDate(),
        inMonth: cellDate.getMonth() === mo,
        records: fkey
          ? recs.filter((r) => {
              const v = r.field_values[fkey];
              return typeof v === 'string' && v.slice(0, 10) === iso;
            })
          : [],
      });
    }
    weeks.push(row);
    if (w >= 4 && row.every((c) => !c.inMonth)) break; // trim empty 6th week
  }
  return weeks;
});

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function calPrevMonth() {
  if (calendarMonth.value === 0) { calendarMonth.value = 11; calendarYear.value--; }
  else calendarMonth.value--;
}
function calNextMonth() {
  if (calendarMonth.value === 11) { calendarMonth.value = 0; calendarYear.value++; }
  else calendarMonth.value++;
}
function calGoToday() {
  calendarYear.value = 2026;
  calendarMonth.value = 5; // June 2026 (session date)
}

const calendarViewMode = ref<'month' | 'week'>('month');
const calWeekOffset = ref(0);

const calWeekDays = computed((): CalDay[] => {
  const fkey = calendarDateField.value?.key;
  const today = new Date(DUE_TODAY_STR + 'T00:00:00');
  const sundayBack = today.getDay() === 0 ? 0 : -today.getDay();
  const recs = filteredRecords.value;
  return Array.from({ length: 7 }, (_, d) => {
    const cellDate = new Date(today);
    cellDate.setDate(today.getDate() + sundayBack + calWeekOffset.value * 7 + d);
    const iso = cellDate.toISOString().slice(0, 10);
    return {
      date: iso,
      dayNum: cellDate.getDate(),
      inMonth: true,
      records: fkey ? recs.filter((r) => { const v = r.field_values[fkey]; return typeof v === 'string' && v.slice(0, 10) === iso; }) : [],
    };
  });
});

const calWeekLabel = computed(() => {
  if (!calWeekDays.value.length) return '';
  const first = calWeekDays.value[0];
  const last = calWeekDays.value[6];
  const fd = new Date(first.date + 'T00:00:00');
  const ld = new Date(last.date + 'T00:00:00');
  const fmo = MONTH_NAMES[fd.getMonth()].slice(0, 3);
  const lmo = MONTH_NAMES[ld.getMonth()].slice(0, 3);
  return fd.getMonth() === ld.getMonth()
    ? `${fmo} ${first.dayNum} – ${last.dayNum}, ${fd.getFullYear()}`
    : `${fmo} ${first.dayNum} – ${lmo} ${last.dayNum}, ${ld.getFullYear()}`;
});

function calPrevWeek() { calWeekOffset.value--; }
function calNextWeek() { calWeekOffset.value++; }
function calGoTodayWeek() { calWeekOffset.value = 0; }

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

const kanbanColCompletionPct = computed((): Record<string, number> => {
  const result: Record<string, number> = {};
  for (const [col, records] of Object.entries(kanbanGroups.value)) {
    if (!records.length) { result[col] = 0; continue; }
    const done = records.filter((r) => recordCompleteness(r) === 100).length;
    result[col] = Math.round((done / records.length) * 100);
  }
  return result;
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

type ColStatMode = 'sum' | 'avg' | 'min' | 'max' | 'count';
const colStatMode = ref<ColStatMode>('sum');
const COL_STAT_MODES: ColStatMode[] = ['sum', 'avg', 'min', 'max', 'count'];
const colAggOverrides = ref<Record<string, ColStatMode>>({});

const tableColumnStats = computed((): Record<string, { sum: number; avg: number; min: number; max: number; count: number } | null> => {
  const stats: Record<string, { sum: number; avg: number; min: number; max: number; count: number } | null> = {};
  for (const col of visibleColumns.value) {
    if (col.data_type !== 'number') { stats[col.key] = null; continue; }
    const vals = filteredRecords.value.map((r) => r.field_values[col.key]).filter((v) => v != null).map(Number).filter((v) => !isNaN(v));
    if (!vals.length) { stats[col.key] = null; continue; }
    const sum = vals.reduce((a, b) => a + b, 0);
    stats[col.key] = { sum, avg: sum / vals.length, min: Math.min(...vals), max: Math.max(...vals), count: vals.length };
  }
  return stats;
});

const tableColumnTotals = computed((): Record<string, number | null> => {
  const totals: Record<string, number | null> = {};
  for (const col of visibleColumns.value) {
    const s = tableColumnStats.value[col.key];
    const mode = colAggOverrides.value[col.key] ?? colStatMode.value;
    totals[col.key] = s ? s[mode] : null;
  }
  return totals;
});

const hasTableTotals = computed(() =>
  Object.values(tableColumnStats.value).some((v) => v !== null),
);

interface ColStatsResult {
  label: string;
  dataType: DataType;
  total: number;
  filled: number;
  fillRate: number;
  // per-type extras
  numMin?: number; numMax?: number; numAvg?: number; numSum?: number; numMedian?: number;
  distribution?: Array<{ label: string; count: number }>;
}
const colStats = computed((): ColStatsResult | null => {
  const fkey = colStatsFieldKey.value;
  if (!fkey || !selectedType.value) return null;
  const field = allColumns.value.find((c) => c.key === fkey);
  if (!field) return null;
  const recs = filteredRecords.value;
  const values = recs.map((r) => r.field_values[fkey]);
  const filledVals = values.filter((v) => {
    if (Array.isArray(v)) return v.length > 0;
    return v != null && v !== '' && v !== false;
  });
  const base: ColStatsResult = {
    label: field.label,
    dataType: field.data_type,
    total: recs.length,
    filled: filledVals.length,
    fillRate: recs.length ? Math.round((filledVals.length / recs.length) * 100) : 0,
  };
  if (field.data_type === 'number' || field.data_type === 'rating') {
    const filtered = values.filter((v) => v != null && !isNaN(Number(v))).map(Number);
    if (filtered.length) {
      const sorted = [...filtered].sort((a, b) => a - b);
      base.numMin = sorted[0];
      base.numMax = sorted[sorted.length - 1];
      base.numSum = filtered.reduce((a, b) => a + b, 0);
      base.numAvg = Math.round((base.numSum / filtered.length) * 10) / 10;
      const mid = Math.floor(sorted.length / 2);
      base.numMedian = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    }
    if (field.data_type === 'rating') {
      const dist: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
      for (const v of values) { if (v != null) { const s = String(v); if (dist[s] !== undefined) dist[s]++; } }
      base.distribution = [1,2,3,4,5].map((n) => ({ label: '★'.repeat(n), count: dist[String(n)] }));
    }
  } else if (field.data_type === 'select') {
    const dist: Record<string, number> = {};
    for (const v of values) {
      if (v == null || v === '') continue;
      const s = String(v);
      dist[s] = (dist[s] ?? 0) + 1;
    }
    base.distribution = Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([l, c]) => ({ label: l, count: c }));
  } else if (field.data_type === 'multi_select') {
    const dist: Record<string, number> = {};
    for (const v of values) {
      const arr = Array.isArray(v) ? v : (v ? String(v).split(',').map((s) => s.trim()) : []);
      for (const s of arr) { dist[s] = (dist[s] ?? 0) + 1; }
    }
    base.distribution = Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([l, c]) => ({ label: l, count: c }));
  } else if (field.data_type === 'boolean') {
    const yes = values.filter((v) => v === true || v === 'true').length;
    const no = values.filter((v) => v === false || v === 'false').length;
    base.distribution = [{ label: 'Yes', count: yes }, { label: 'No', count: no }];
  } else if (['text', 'email', 'phone', 'url'].includes(field.data_type)) {
    const unique = new Set(values.filter((v) => v != null && v !== '').map(String)).size;
    base.distribution = [{ label: 'Unique values', count: unique }];
  }
  return base;
});

function evaluateConditionalRules(record: CrmRecord): string | null {
  for (const rule of conditionalRules.value) {
    const rawVal = record.field_values[rule.fieldKey];
    const strVal = rawVal != null ? String(rawVal).toLowerCase() : '';
    const ruleVal = rule.value.toLowerCase();
    let match = false;
    if (rule.operator === 'equals') match = strVal === ruleVal;
    else if (rule.operator === 'not_equals') match = strVal !== ruleVal;
    else if (rule.operator === 'contains') match = strVal.includes(ruleVal);
    else if (rule.operator === 'gt') match = Number(rawVal) > Number(rule.value);
    else if (rule.operator === 'lt') match = Number(rawVal) < Number(rule.value);
    else if (rule.operator === 'is_empty') match = rawVal == null || strVal === '';
    else if (rule.operator === 'is_not_empty') match = rawVal != null && strVal !== '';
    if (match) return rule.color;
  }
  return null;
}

const importPreviewRows = computed((): Array<Record<string, string>> => {
  const rows = importHeaderRow.value ? importParsed.value.slice(1) : importParsed.value;
  return rows.filter((r) => r.some((c) => c.trim())).map((row) => {
    const obj: Record<string, string> = {};
    for (const [colIdx, fieldKey] of Object.entries(importMapping.value)) {
      if (fieldKey) obj[fieldKey] = row[Number(colIdx)] ?? '';
    }
    return obj;
  });
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
    const isFilled = Array.isArray(v) ? v.length > 0 : (v != null && (typeof v !== 'string' || v.trim() !== ''));
    if (isFilled) {
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

const inverseLinks = computed((): CrmRecord[] => {
  const id = openedRecord.value?.id;
  if (!id) return [];
  return mockRecords.filter(
    (r) => r.id !== id && r.links?.some((l) => l.target_id === id),
  );
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

const contextMenuSelectFilters = computed(() => {
  if (!contextMenuRecord.value) return [];
  const record = contextMenuRecord.value;
  const fields = selectedType.value?.fields ?? [];
  const items: Array<{ fieldKey: string; label: string; value: string }> = [];
  for (const f of fields) {
    if (f.data_type === 'select' && record.field_values[f.key] != null) {
      items.push({ fieldKey: f.key, label: f.label, value: String(record.field_values[f.key]) });
    } else if (f.data_type === 'multi_select') {
      const arr = Array.isArray(record.field_values[f.key]) ? record.field_values[f.key] as string[] : [];
      for (const v of arr) items.push({ fieldKey: f.key, label: f.label, value: v });
    }
  }
  return items;
});

function startColRename(col: CrmField) {
  editingColKey.value = col.key;
  editingColLabel.value = col.label;
  nextTick(() => {
    document.querySelector<HTMLInputElement>('[data-col-rename-input]')?.select();
  });
}
function commitColRename() {
  const key = editingColKey.value;
  editingColKey.value = null;
  if (!key || !selectedType.value) return;
  const trimmed = editingColLabel.value.trim();
  if (!trimmed) return;
  const field = selectedType.value.fields.find((f) => f.key === key);
  if (field) field.label = trimmed;
}

function dropColReorder(targetKey: string) {
  const src = colDragSrc.value;
  colDragSrc.value = null;
  colDragOver.value = null;
  if (!src || src === targetKey || !selectedType.value) return;
  const fields = selectedType.value.fields;
  const ordered = [...fields].sort((a, b) => a.position - b.position);
  const srcIdx = ordered.findIndex((f) => f.key === src);
  const tgtIdx = ordered.findIndex((f) => f.key === targetKey);
  if (srcIdx === -1 || tgtIdx === -1) return;
  const [moved] = ordered.splice(srcIdx, 1);
  ordered.splice(tgtIdx, 0, moved);
  ordered.forEach((f, i) => { f.position = i; });
}

function dropSchemaReorder(targetId: string) {
  const src = schemaDragSrc.value;
  schemaDragSrc.value = null;
  schemaDragOver.value = null;
  if (!src || src === targetId || !selectedType.value) return;
  const fields = selectedType.value.fields;
  const ordered = [...fields].sort((a, b) => a.position - b.position);
  const srcIdx = ordered.findIndex((f) => f.id === src);
  const tgtIdx = ordered.findIndex((f) => f.id === targetId);
  if (srcIdx === -1 || tgtIdx === -1) return;
  const [moved] = ordered.splice(srcIdx, 1);
  ordered.splice(tgtIdx, 0, moved);
  ordered.forEach((f, i) => { f.position = i; });
}

function dropSidebarTypeReorder(targetKey: string) {
  const src = sidebarTypeDragSrc.value;
  sidebarTypeDragSrc.value = null;
  sidebarTypeDragOver.value = null;
  if (!src || src === targetKey) return;
  const srcIdx = schema.findIndex((t) => t.key === src);
  const tgtIdx = schema.findIndex((t) => t.key === targetKey);
  if (srcIdx === -1 || tgtIdx === -1) return;
  const [moved] = schema.splice(srcIdx, 1);
  schema.splice(tgtIdx, 0, moved);
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

function bulkDuplicate() {
  const ids = [...selectedIds.value];
  if (!ids.length) return;
  const newIds: string[] = [];
  for (const id of ids) {
    const orig = mockRecords.find((r) => r.id === id);
    if (!orig) continue;
    const dup: CrmRecord = {
      id: 'dup-' + id + '-' + String(mockRecords.length),
      record_type_key: orig.record_type_key,
      title: 'Copy of ' + orig.title,
      created_at: new Date().toISOString(),
      field_values: { ...orig.field_values },
      links: [],
    };
    mockRecords.push(dup);
    mockActivities.unshift({
      id: 'act-dup-' + dup.id,
      record_id: dup.id,
      type: 'change',
      content: 'Record duplicated',
      author: 'You',
      created_at: dup.created_at,
    });
    newIds.push(dup.id);
  }
  selectedIds.value = new Set(newIds);
  showToast(`${newIds.length} record${newIds.length === 1 ? '' : 's'} duplicated`);
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

function archiveSelected() {
  const ids = [...selectedIds.value];
  if (!ids.length) return;
  const next = new Set(archivedIds.value);
  for (const id of ids) next.add(id);
  archivedIds.value = next;
  if (openedRecord.value && ids.includes(openedRecord.value.id)) closePanel();
  selectedIds.value = new Set();
  showToast(`${ids.length} record${ids.length === 1 ? '' : 's'} archived`, {
    label: 'Undo',
    fn: () => {
      const restored = new Set(archivedIds.value);
      for (const id of ids) restored.delete(id);
      archivedIds.value = restored;
    },
  });
}

function archiveRecord(id: string) {
  const next = new Set(archivedIds.value);
  next.add(id);
  archivedIds.value = next;
  if (openedRecord.value?.id === id) closePanel();
  showToast('Record archived', {
    label: 'Undo',
    fn: () => unarchiveRecord(id),
  });
}

function unarchiveRecord(id: string) {
  const next = new Set(archivedIds.value);
  next.delete(id);
  archivedIds.value = next;
  showToast('Record unarchived');
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
  fieldTextFilters.value = {};
  numberMinFilters.value = {};
  numberMaxFilters.value = {};
  dateAfterFilters.value = {};
  dateBeforeFilters.value = {};
  showOverdueOnly.value = false;
  showDueSoonOnly.value = false;
  showPinnedOnly.value = false;
  showWatchedOnly.value = false;
  showIncompleteOnly.value = false;
}

function saveFilterPreset() {
  const name = filterPresetNameInput.value.trim();
  if (!name) return;
  const preset: FilterPreset = {
    id: 'fp-' + String(Date.now()),
    name,
    typeKey: selectedTypeKey.value,
    filters: activeFilters.value.slice(),
    fieldTextFilters: { ...fieldTextFilters.value },
    numberMinFilters: { ...numberMinFilters.value },
    numberMaxFilters: { ...numberMaxFilters.value },
    dateAfterFilters: { ...dateAfterFilters.value },
    dateBeforeFilters: { ...dateBeforeFilters.value },
    showOverdueOnly: showOverdueOnly.value,
    showDueSoonOnly: showDueSoonOnly.value,
    showPinnedOnly: showPinnedOnly.value,
    showWatchedOnly: showWatchedOnly.value,
    showIncompleteOnly: showIncompleteOnly.value,
  };
  filterPresets.value = [...filterPresets.value, preset];
  filterPresetNameInput.value = '';
  showFilterPresetsPanel.value = false;
  showToast(`Preset "${name}" saved`);
}

function applyFilterPreset(preset: FilterPreset) {
  activeFilters.value = preset.filters.slice();
  fieldTextFilters.value = { ...preset.fieldTextFilters };
  numberMinFilters.value = { ...preset.numberMinFilters };
  numberMaxFilters.value = { ...preset.numberMaxFilters };
  dateAfterFilters.value = { ...preset.dateAfterFilters };
  dateBeforeFilters.value = { ...preset.dateBeforeFilters };
  showOverdueOnly.value = preset.showOverdueOnly;
  showDueSoonOnly.value = preset.showDueSoonOnly;
  showPinnedOnly.value = preset.showPinnedOnly;
  showWatchedOnly.value = preset.showWatchedOnly;
  showIncompleteOnly.value = preset.showIncompleteOnly;
  showFilterPresetsPanel.value = false;
  showToast(`Preset "${preset.name}" applied`);
}

function deleteFilterPreset(id: string) {
  filterPresets.value = filterPresets.value.filter((p) => p.id !== id);
}

function startCellEdit(record: CrmRecord, col: CrmField) {
  if (editingRecord.value || col.is_title || col.data_type === 'boolean') return;
  editingCell.value = { recordId: record.id, fieldKey: col.key };
  cellDraftValue.value = record.field_values[col.key] ?? null;
}

function commitCellEdit(newValue: string | number | boolean | string[] | null) {
  const cell = editingCell.value;
  editingCell.value = null;
  cellDraftValue.value = null;
  if (!cell) return;
  const record = mockRecords.find((r) => r.id === cell.recordId);
  if (!record) return;
  const oldValue = record.field_values[cell.fieldKey];
  if (newValue === oldValue) return;
  record.field_values[cell.fieldKey] = newValue;
  record.updated_at = new Date().toISOString();
  // keep title in sync when the title field is edited inline
  const type = schema.find((t) => t.key === record.record_type_key);
  const titleField = type?.fields.find((f) => f.is_title);
  if (titleField?.key === cell.fieldKey && newValue != null) record.title = String(newValue);
  // append a change activity so the audit trail reflects the edit
  const col = type?.fields.find((f) => f.key === cell.fieldKey);
  if (col) {
    mockActivities.push({
      id: 'a_chg_' + String(mockActivities.length) + '_' + String(Date.now()).slice(-6),
      record_id: record.id,
      type: 'change',
      content: `${col.label}: ${oldValue ?? '(empty)'} → ${newValue ?? '(empty)'}`,
      author: 'JB',
      created_at: new Date().toISOString(),
    });
  }
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

function saveAsTemplate(record: CrmRecord) {
  const name = templateDraftName.value.trim() || record.title;
  if (!name) return;
  const tmpl: RecordTemplate = {
    id: 'tmpl-' + String(Date.now()),
    name,
    typeKey: record.record_type_key,
    fieldValues: { ...record.field_values },
  };
  recordTemplates.value = [...recordTemplates.value, tmpl];
  templateDraftName.value = '';
  showToast(`Template "${name}" saved`);
}

function applyTemplate(tmpl: RecordTemplate) {
  const type = schema.find((t) => t.key === tmpl.typeKey);
  const titleField = type?.fields.find((f) => f.is_title);
  const newRecord: CrmRecord = {
    id: 'new-tmpl-' + String(mockRecords.length),
    record_type_key: tmpl.typeKey,
    title: String(tmpl.fieldValues[titleField?.key ?? ''] ?? 'New record'),
    created_at: new Date().toISOString(),
    field_values: { ...tmpl.fieldValues },
    links: [],
  };
  mockRecords.push(newRecord);
  openRecord(newRecord);
  showTemplatePanel.value = false;
  showToast(`Created from template "${tmpl.name}"`);
}

function deleteTemplate(id: string) {
  recordTemplates.value = recordTemplates.value.filter((t) => t.id !== id);
}

function openMergeModal(primaryId: string, secondaryId: string) {
  mergeSourceId.value = primaryId;
  mergeTargetId.value = secondaryId;
  const fields = selectedType.value?.fields ?? [];
  const choices: Record<string, 'primary' | 'secondary'> = {};
  const primary = mockRecords.find((r) => r.id === primaryId);
  const secondary = mockRecords.find((r) => r.id === secondaryId);
  for (const f of fields) {
    const pv = primary?.field_values[f.key];
    const sv = secondary?.field_values[f.key];
    const primaryEmpty = pv == null || String(pv).trim() === '';
    choices[f.key] = primaryEmpty && sv != null && String(sv).trim() !== '' ? 'secondary' : 'primary';
  }
  mergeFieldChoices.value = choices;
  showMergeModal.value = true;
}

function commitMerge() {
  const primary = mockRecords.find((r) => r.id === mergeSourceId.value);
  const secondary = mockRecords.find((r) => r.id === mergeTargetId.value);
  if (!primary || !secondary) return;
  const fields = selectedType.value?.fields ?? [];
  for (const f of fields) {
    if (mergeFieldChoices.value[f.key] === 'secondary') {
      primary.field_values[f.key] = secondary.field_values[f.key];
    }
  }
  const secondaryIdx = mockRecords.findIndex((r) => r.id === secondary.id);
  if (secondaryIdx !== -1) mockRecords.splice(secondaryIdx, 1);
  if (openedRecord.value?.id === secondary.id) openRecord(primary);
  showMergeModal.value = false;
  showToast(`Merged into "${primary.title}"`);
}

function toggleRowExpand(id: string) {
  const next = new Set(expandedRowIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedRowIds.value = next;
}

function togglePinColumn(key: string) {
  const next = new Set(pinnedColumnKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  pinnedColumnKeys.value = next;
}

function onColResizeMouseDown(e: MouseEvent, colKey: string, currentWidth: number) {
  e.preventDefault();
  colResizeDragKey = colKey;
  colResizeDragStart = e.clientX;
  colResizeDragStartWidth = currentWidth;
  function onMove(me: MouseEvent) {
    if (!colResizeDragKey) return;
    const delta = me.clientX - colResizeDragStart;
    const newW = Math.max(60, colResizeDragStartWidth + delta);
    columnWidths.value = { ...columnWidths.value, [colResizeDragKey]: newW };
  }
  function onUp() {
    colResizeDragKey = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function selectType(key: string) {
  const savedScroll = scrollPositions.value[key] ?? 0;
  selectedTypeKey.value = key;
  nextTick(() => { if (tableScrollEl.value) tableScrollEl.value.scrollTop = savedScroll; });
  searchQuery.value = '';
  openedRecord.value = null;
  editingRecord.value = false;
  creatingRecord.value = false;
  showInlineAdd.value = false;
  inlineAddTitle.value = '';
  colorLabelFilter.value = null;
  tagFilter.value = null;
  showTagInput.value = false;
  staleDaysFilter.value = null;
  showOverdueOnly.value = false;
  showDueSoonOnly.value = false;
  createdPreset.value = null;
  galleryFocusIdx.value = -1;
  kanbanInlineAdd.value = null;
  kanbanInlineTitle.value = '';
  customOrder.value = [];
  columnWidths.value = {};
  pinnedColumnKeys.value = new Set();
  draftValues.value = {};
  sortField.value = null;
  sortDir.value = 'asc';
  sortField2.value = null;
  sortDir2.value = 'asc';
  navigationStack.value = [];
  selectedIds.value = new Set();
  hiddenColumnKeys.value = new Set();
  showColumnsMenu.value = false;
  activeFilters.value = [];
  showPinnedOnly.value = false;
  showWatchedOnly.value = false;
  showIncompleteOnly.value = false;
  createFormErrors.value = new Set();
  colAggOverrides.value = {};
  showTypeIconColorPicker.value = false;
  // If the new type has no groupable field, fall back to table view
  const newType = schema.find((rt) => rt.key === key);
  if (!newType?.fields.some((f) => f.data_type === 'select')) {
    viewMode.value = 'table';
  }
}

function toggleSort(fieldKey: string, shift = false) {
  if (shift && sortField.value && sortField.value !== fieldKey) {
    // shift-click: cycle secondary sort
    if (sortField2.value === fieldKey) {
      if (sortDir2.value === 'asc') { sortDir2.value = 'desc'; }
      else { sortField2.value = null; sortDir2.value = 'asc'; }
    } else {
      sortField2.value = fieldKey;
      sortDir2.value = 'asc';
    }
    return;
  }
  // primary sort — also clear secondary if we're switching fields
  if (sortField.value !== fieldKey) {
    sortField2.value = null;
    sortDir2.value = 'asc';
  }
  if (sortField.value === fieldKey) {
    if (sortDir.value === 'asc') { sortDir.value = 'desc'; }
    else { sortField.value = null; sortDir.value = 'asc'; sortField2.value = null; sortDir2.value = 'asc'; }
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
  detailPanelExpanded.value = false;
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

function openNewRecord(stageValue?: string, extraDraft?: Record<string, string | number | boolean | string[] | null>) {
  openedRecord.value = null;
  const fieldKey = kanbanField.value?.key;
  const defaults: Record<string, string | number | boolean | string[] | null> = {};
  for (const f of (selectedType.value?.fields ?? [])) {
    if (f.default_value != null && f.default_value !== '') defaults[f.key] = f.default_value;
  }
  draftValues.value = {
    ...defaults,
    ...(fieldKey && stageValue ? { [fieldKey]: stageValue } : {}),
    ...(extraDraft ?? {}),
  };
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

function startKanbanInlineAdd(col: string) {
  kanbanInlineAdd.value = { col };
  kanbanInlineTitle.value = '';
  nextTick(() => kanbanInlineInputEl.value?.focus());
}

function cancelKanbanInlineAdd() {
  kanbanInlineAdd.value = null;
  kanbanInlineTitle.value = '';
}

function commitKanbanInlineAdd() {
  const ia = kanbanInlineAdd.value;
  const title = kanbanInlineTitle.value.trim();
  if (!ia || !title) { cancelKanbanInlineAdd(); return; }
  const type = selectedType.value;
  const titleField = type?.fields.find((f) => f.is_title);
  const fieldKey = kanbanField.value?.key;
  const fieldValues: Record<string, string | number | boolean | string[] | null> = {};
  if (titleField) fieldValues[titleField.key] = title;
  if (fieldKey && ia.col !== KANBAN_UNASSIGNED) fieldValues[fieldKey] = ia.col;
  const newRecord: CrmRecord = {
    id: 'new-' + selectedTypeKey.value + '-' + String(mockRecords.length),
    record_type_key: selectedTypeKey.value,
    title,
    created_at: new Date().toISOString(),
    field_values: fieldValues,
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
  kanbanInlineTitle.value = '';
  showToast(`${type?.label ?? 'Record'} created`);
  nextTick(() => kanbanInlineInputEl.value?.focus());
}

function commitInlineAdd() {
  const title = inlineAddTitle.value.trim();
  showInlineAdd.value = false;
  inlineAddTitle.value = '';
  if (!title) return;
  const type = selectedType.value;
  const titleField = type?.fields.find((f) => f.is_title);
  const newRecord: CrmRecord = {
    id: 'new-' + selectedTypeKey.value + '-' + String(mockRecords.length),
    record_type_key: selectedTypeKey.value,
    title,
    created_at: new Date().toISOString(),
    field_values: titleField ? { [titleField.key]: title } : {},
    links: [],
  };
  mockRecords.push(newRecord);
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

function deleteActivity(actId: string) {
  const idx = mockActivities.findIndex((a) => a.id === actId);
  if (idx === -1) return;
  const [removed] = mockActivities.splice(idx, 1);
  showToast('Activity deleted', {
    label: 'Undo',
    fn: () => {
      mockActivities.splice(idx, 0, removed);
    },
  });
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

function bulkWatch(watch: boolean) {
  const ids = [...selectedIds.value];
  if (!ids.length) return;
  const next = new Set(watchedIds.value);
  for (const id of ids) { if (watch) next.add(id); else next.delete(id); }
  watchedIds.value = next;
  showToast(watch
    ? `Watching ${ids.length} record${ids.length === 1 ? '' : 's'}`
    : `Stopped watching ${ids.length} record${ids.length === 1 ? '' : 's'}`);
}

function setColorLabel(recordId: string, color: string) {
  if (color) { colorLabels.value = { ...colorLabels.value, [recordId]: color }; }
  else { const next = { ...colorLabels.value }; delete next[recordId]; colorLabels.value = next; }
}

function addTag(recordId: string, tag: string) {
  const t = tag.trim().toLowerCase();
  if (!t) return;
  const existing = recordTags.value[recordId] ?? [];
  if (existing.includes(t)) return;
  recordTags.value = { ...recordTags.value, [recordId]: [...existing, t] };
}

function removeTag(recordId: string, tag: string) {
  const existing = recordTags.value[recordId] ?? [];
  const next = existing.filter((x) => x !== tag);
  recordTags.value = { ...recordTags.value, [recordId]: next };
}

const allTags = computed((): string[] => {
  const set = new Set<string>();
  for (const tags of Object.values(recordTags.value)) {
    for (const t of tags) set.add(t);
  }
  return Array.from(set).sort();
});

function addBulkTag(tag: string) {
  const t = tag.trim();
  if (!t) return;
  for (const id of selectedIds.value) {
    addTag(id, t);
  }
  bulkTagInput.value = '';
  showToast(`Tag "${t}" added to ${selectedIds.value.size} record${selectedIds.value.size === 1 ? '' : 's'}`);
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

function onRowDragStart(e: DragEvent, id: string) {
  dragSrcId.value = id;
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); }
}

function onRowDragOver(e: DragEvent, id: string) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  dragOverId.value = id;
}

function onRowDrop(e: DragEvent, targetId: string) {
  e.preventDefault();
  const srcId = dragSrcId.value;
  dragSrcId.value = null;
  dragOverId.value = null;
  if (!srcId || srcId === targetId) return;
  const ids = filteredRecords.value.map((r) => r.id);
  const order = customOrder.value.length ? [...customOrder.value] : [...ids];
  const srcIdx = order.indexOf(srcId);
  const tgtIdx = order.indexOf(targetId);
  if (srcIdx === -1 || tgtIdx === -1) return;
  order.splice(srcIdx, 1);
  order.splice(tgtIdx, 0, srcId);
  customOrder.value = order;
}

function onRowDragEnd() {
  dragSrcId.value = null;
  dragOverId.value = null;
}

async function copyRecordAsText(record: CrmRecord) {
  const fields = selectedType.value?.fields ?? [];
  const lines: string[] = [record.title, ''];
  for (const f of fields) {
    const v = record.field_values[f.key];
    if (v != null && String(v).trim()) lines.push(`${f.label}: ${String(v)}`);
  }
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    showToast('Copied as text');
  } catch { /* silent fail */ }
}

function recordCompleteness(record: CrmRecord): number {
  const fields = selectedType.value?.fields ?? [];
  if (!fields.length) return 100;
  const filled = fields.filter((f) => {
    const v = record.field_values[f.key];
    if (Array.isArray(v)) return v.length > 0;
    return v != null && String(v).trim() !== '';
  }).length;
  return Math.round((filled / fields.length) * 100);
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

function submitBulkFieldFill() {
  const key = bulkFieldKey.value;
  if (!key) return;
  const ids = [...selectedIds.value];
  const field = allColumns.value.find((c) => c.key === key);
  const now = new Date().toISOString();
  for (const id of ids) {
    const rec = mockRecords.find((r) => r.id === id);
    if (!rec) continue;
    const prev = rec.field_values[key];
    rec.field_values[key] = bulkFieldValue.value;
    rec.updated_at = now;
    if (String(prev ?? '') !== String(bulkFieldValue.value ?? '')) {
      mockActivities.unshift({
        id: 'act-bff-' + id + '-' + String(mockActivities.length),
        record_id: id,
        type: 'change',
        content: `${field?.label ?? key}: ${prev ?? '—'} → ${bulkFieldValue.value ?? '—'}`,
        author: 'You',
        created_at: now,
      });
    }
  }
  showBulkFieldModal.value = false;
  showToast(`${field?.label ?? key} updated for ${ids.length} record${ids.length === 1 ? '' : 's'}`);
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
    sortField2: sortField2.value,
    sortDir2: sortDir2.value,
    viewMode: viewMode.value,
    hiddenCols: [...hiddenColumnKeys.value],
    showPinnedOnly: showPinnedOnly.value,
    showWatchedOnly: showWatchedOnly.value,
    showIncompleteOnly: showIncompleteOnly.value,
    groupByField: groupByField.value,
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
  sortField2.value = view.sortField2 ?? null;
  sortDir2.value = view.sortDir2 ?? 'asc';
  viewMode.value = view.viewMode;
  hiddenColumnKeys.value = new Set(view.hiddenCols);
  showPinnedOnly.value = view.showPinnedOnly;
  showWatchedOnly.value = view.showWatchedOnly;
  showIncompleteOnly.value = view.showIncompleteOnly ?? false;
  groupByField.value = view.groupByField ?? null;
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
    if (e.key === '[' && openedRecordIndex.value > 0) { openRecord(filteredRecords.value[openedRecordIndex.value - 1]); e.preventDefault(); return; }
    if (e.key === ']' && openedRecordIndex.value < filteredRecords.value.length - 1) { openRecord(filteredRecords.value[openedRecordIndex.value + 1]); e.preventDefault(); return; }
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
  if (selectedIds.value.size > 0 && !openedRecord.value && !creatingRecord.value) {
    showBulkNoteModal.value = true;
    return;
  }
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
  const hadState = searchQuery.value || activeFilters.value.length || Object.values(fieldTextFilters.value).some(v => v.trim()) || Object.values(numberMinFilters.value).some(v => v != null) || Object.values(numberMaxFilters.value).some(v => v != null) || Object.values(dateAfterFilters.value).some(v => v) || Object.values(dateBeforeFilters.value).some(v => v) || sortField.value || showPinnedOnly.value || showWatchedOnly.value || showIncompleteOnly.value || groupByField.value;
  searchQuery.value = '';
  activeFilters.value = [];
  fieldTextFilters.value = {};
  numberMinFilters.value = {};
  numberMaxFilters.value = {};
  dateAfterFilters.value = {};
  dateBeforeFilters.value = {};
  sortField.value = null;
  sortDir.value = 'asc';
  sortField2.value = null;
  sortDir2.value = 'asc';
  showPinnedOnly.value = false;
  showWatchedOnly.value = false;
  showIncompleteOnly.value = false;
  groupByField.value = null;
  colorLabelFilter.value = null;
  tagFilter.value = null;
  staleDaysFilter.value = null;
  createdPreset.value = null;
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

function onKeyL(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (editingRecord.value || creatingRecord.value) return;
  if (canCalendar.value) viewMode.value = 'calendar';
}

function onKeyV(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (editingRecord.value || creatingRecord.value) return;
  viewMode.value = 'gallery';
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

function onKeyX(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (!openedRecord.value || editingRecord.value || creatingRecord.value) return;
  detailPanelExpanded.value = detailPanelExpanded.value === false ? 'wide' : detailPanelExpanded.value === 'wide' ? 'full' : false;
  e.preventDefault();
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
  // Validate required fields
  const errors = new Set<string>();
  for (const f of fields) {
    if (f.is_required) {
      const v = record.field_values[f.key];
      if (v == null || (typeof v === 'string' && v.trim() === '')) {
        errors.add(f.key);
      }
    }
  }
  if (errors.size > 0) {
    editFormErrors.value = errors;
    return;
  }
  editFormErrors.value = new Set();
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
  const tag = document.activeElement?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (viewMode.value === 'gallery' && !groupedGalleryGroups.value) {
    const records = filteredRecords.value;
    const step = dir * galleryColCount.value;
    const cur = galleryFocusIdx.value < 0 ? 0 : galleryFocusIdx.value;
    const next = Math.max(0, Math.min(records.length - 1, cur + step));
    galleryFocusIdx.value = next;
    nextTick(() => {
      (document.querySelector(`[data-gallery-idx="${next}"]`) as HTMLElement | null)?.focus();
    });
    return;
  }
  if (!openedRecord.value || viewMode.value !== 'table') return;
  const records = filteredRecords.value;
  const idx = records.findIndex((r) => r.id === openedRecord.value?.id);
  const next = records[idx + dir];
  if (next) {
    openRecord(next);
    nextTick(() => {
      const el = document.querySelector(`[data-record-id="${next.id}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
}

function onKeyArrowLR(dir: 1 | -1, e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (viewMode.value !== 'gallery' || groupedGalleryGroups.value) return;
  e.preventDefault();
  const records = filteredRecords.value;
  const cur = galleryFocusIdx.value < 0 ? 0 : galleryFocusIdx.value;
  const next = Math.max(0, Math.min(records.length - 1, cur + dir));
  galleryFocusIdx.value = next;
  nextTick(() => {
    (document.querySelector(`[data-gallery-idx="${next}"]`) as HTMLElement | null)?.focus();
  });
}

function onKeyHome() {
  if (!openedRecord.value || viewMode.value !== 'table') return;
  const tag = document.activeElement?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  const first = filteredRecords.value[0];
  if (first && first.id !== openedRecord.value?.id) {
    openRecord(first);
    nextTick(() => {
      document.querySelector(`[data-record-id="${first.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
}

function onKeyEnd() {
  if (!openedRecord.value || viewMode.value !== 'table') return;
  const tag = document.activeElement?.tagName ?? '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  const last = filteredRecords.value[filteredRecords.value.length - 1];
  if (last && last.id !== openedRecord.value?.id) {
    openRecord(last);
    nextTick(() => {
      document.querySelector(`[data-record-id="${last.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function showToast(message: string, action?: { label: string; fn: () => void }) {
  const id = 'toast-' + String(toasts.value.length) + '-' + String(Math.floor(Math.random() * 99999));
  toasts.value.push({ id, message, action });
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, action ? 5000 : 2500);
}

// ── Schema editor actions ──────────────────────────────────────────────────

function openSchemaEditor(mode: 'fields' | 'new-type' = 'fields') {
  schemaEditorMode.value = mode;
  showAddFieldForm.value = false;
  newFieldDraft.value = { label: '', key: '', data_type: 'text', select_options_raw: '', default_value: '' };
  newTypeDraft.value = { label: '', key: '', icon: 'folder', color: '#6366f1' };
  showSchemaEditor.value = true;
}

function startSchemaTypeRename() {
  const type = schema.find((t) => t.key === selectedTypeKey.value);
  if (!type) return;
  schemaTypeLabelDraft.value = type.label;
  nextTick(() => { schemaTypeLabelInputEl.value?.select(); });
}

function commitSchemaTypeRename() {
  const draft = schemaTypeLabelDraft.value?.trim();
  schemaTypeLabelDraft.value = null;
  if (!draft) return;
  const type = schema.find((t) => t.key === selectedTypeKey.value);
  if (!type) return;
  const prev = type.label;
  type.label = draft;
  if (!type.label_plural || type.label_plural === prev + 's' || type.label_plural === prev) {
    type.label_plural = draft.endsWith('s') ? draft : draft + 's';
  }
  showToast(`Renamed to "${draft}"`);
}

function addFieldToCurrentType() {
  const draft = newFieldDraft.value;
  const label = draft.label.trim();
  if (!label) return;
  const key = draft.key.trim() || label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const type = schema.find((t) => t.key === selectedTypeKey.value);
  if (!type) return;
  if (type.fields.some((f) => f.key === key)) { showToast('A field with that key already exists'); return; }
  const opts = (draft.data_type === 'select' || draft.data_type === 'multi_select')
    ? draft.select_options_raw.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  type.fields.push({
    id: 'f_custom_' + String(type.fields.length) + '_' + String(Date.now()).slice(-6),
    key,
    label,
    data_type: draft.data_type,
    is_title: false,
    is_required: false,
    position: type.fields.length,
    ...(opts?.length ? { select_options: opts } : {}),
    ...(draft.default_value.trim() ? { default_value: draft.default_value.trim() } : {}),
  });
  newFieldDraft.value = { label: '', key: '', data_type: 'text', select_options_raw: '', default_value: '' };
  showAddFieldForm.value = false;
  showToast(`Field "${label}" added to ${type.label}`);
}

function removeFieldFromType(typeKey: string, fieldId: string) {
  const type = schema.find((t) => t.key === typeKey);
  if (!type) return;
  const field = type.fields.find((f) => f.id === fieldId);
  if (!field || field.is_title || field.is_required) { showToast('Cannot remove required or title fields'); return; }
  const idx = type.fields.findIndex((f) => f.id === fieldId);
  if (idx !== -1) type.fields.splice(idx, 1);
  showToast('Field removed');
}

function addNewRecordType() {
  const draft = newTypeDraft.value;
  const label = draft.label.trim();
  if (!label) return;
  const key = draft.key.trim() || label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (schema.some((t) => t.key === key)) { showToast('A type with that key already exists'); return; }
  const plural = label.endsWith('s') ? label : label + 's';
  schema.push({
    id: 'rt_' + key + '_' + String(Date.now()).slice(-6),
    key,
    label,
    label_plural: plural,
    icon: draft.icon,
    color: draft.color,
    fields: [
      { id: 'f_' + key + '_title', key: 'name', label: 'Name', data_type: 'text', is_title: true, is_required: true, position: 0 },
      { id: 'f_' + key + '_status', key: 'status', label: 'Status', data_type: 'select', is_title: false, is_required: false, position: 1, select_options: ['Active', 'Inactive'] },
    ],
  });
  newTypeDraft.value = { label: '', key: '', icon: 'folder', color: '#6366f1' };
  schemaEditorMode.value = 'fields';
  selectType(key);
  showToast(`Type "${label}" created`);
}

function deleteRecordType(typeKey: string) {
  if (mockRecords.some((r) => r.record_type_key === typeKey)) {
    showToast('Cannot delete a type that has records — remove all records first');
    return;
  }
  const idx = schema.findIndex((t) => t.key === typeKey);
  if (idx === -1) return;
  const label = schema[idx].label;
  schema.splice(idx, 1);
  if (selectedTypeKey.value === typeKey) selectedTypeKey.value = schema[0]?.key ?? '';
  showSchemaEditor.value = false;
  showToast(`Type "${label}" deleted`);
}

function openImportModal() {
  importStep.value = 'paste';
  importCsvText.value = '';
  importParsed.value = [];
  importMapping.value = {};
  importHeaderRow.value = true;
  showImportModal.value = true;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { result.push(current); current = ''; continue; }
    current += ch;
  }
  result.push(current);
  return result;
}

function parseImportCsv() {
  const lines = importCsvText.value.trim().split('\n').filter((l) => l.trim());
  importParsed.value = lines.map(parseCsvLine);
  if (!importParsed.value.length) return;
  importMapping.value = {};
  const headers = importHeaderRow.value ? importParsed.value[0] : [];
  const fields = selectedType.value?.fields ?? [];
  for (let i = 0; i < importParsed.value[0].length; i++) {
    const hdr = (headers[i] ?? '').trim().toLowerCase();
    const matched = fields.find((f) => f.label.toLowerCase() === hdr || f.key === hdr);
    if (matched) { importMapping.value[i] = matched.key; }
    else if (/^name|^title|^full.?name/.test(hdr)) { importMapping.value[i] = '__title__'; }
    else { importMapping.value[i] = ''; }
  }
  importStep.value = 'map';
}

function commitImport() {
  const type = selectedType.value;
  const titleField = type?.fields.find((f) => f.is_title);
  let created = 0;
  for (const row of importPreviewRows.value) {
    const rawTitle = row['__title__'] ?? (titleField ? row[titleField.key] : '') ?? '';
    const title = rawTitle.trim() || `Imported ${type?.label ?? 'record'} ${String(mockRecords.length + 1)}`;
    const fieldVals: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === '__title__') { if (titleField) fieldVals[titleField.key] = v; continue; }
      fieldVals[k] = v;
    }
    mockRecords.push({
      id: 'import-' + selectedTypeKey.value + '-' + String(mockRecords.length),
      record_type_key: selectedTypeKey.value,
      title,
      created_at: new Date().toISOString(),
      field_values: fieldVals,
      links: [],
    });
    created++;
  }
  showImportModal.value = false;
  showToast(`Imported ${created} record${created === 1 ? '' : 's'}`);
}

function exportCsv(records?: CrmRecord[]) {
  const recs = records ?? filteredRecords.value;
  const cols = allColumns.value;
  const headers = [...cols.map((c) => c.label), 'Created'];
  const escape = (v: unknown) => {
    const s = Array.isArray(v) ? v.join('; ') : (v == null ? '' : String(v));
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

function formatCardValue(val: string | number | boolean | string[] | null | undefined, dataType: DataType, format?: FieldFormat): string {
  if (val == null || val === '') return '—';
  if (Array.isArray(val)) return val.length ? val.join(', ') : '—';
  if (dataType === 'number') {
    const n = Number(val);
    if (format === 'currency') {
      if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
      if (n >= 1_000) return '$' + Math.round(n / 1_000) + 'k';
      return '$' + n;
    }
    if (format === 'percent') return n + '%';
    if (format === 'progress') return n + '%';
    return n.toLocaleString();
  }
  if (dataType === 'rating') {
    const n = Number(val);
    if (!n) return '—';
    return '★'.repeat(Math.max(0, Math.min(5, n))) + '☆'.repeat(Math.max(0, 5 - Math.min(5, n)));
  }
  if (dataType === 'date') return new Date(String(val)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return String(val);
}

// ── Inline sub-components ──────────────────────────────────────────────────

const CrmCellValue = defineComponent({
  props: {
    value: { type: [String, Number, Boolean, Array, null] as unknown as () => string | number | boolean | string[] | null, default: null },
    dataType: { type: String as () => DataType, required: true },
    format: { type: String as () => FieldFormat, default: undefined },
  },
  setup(props) {
    return () => {
      if (props.dataType === 'rating') {
        const n = props.value != null ? Number(props.value) : 0;
        if (!n) return h('span', { class: 'text-slate-300 dark:text-slate-600' }, '—');
        return h('span', { class: 'flex items-center gap-0.5 leading-none' },
          [1,2,3,4,5].map((i) => h('span', {
            key: i,
            class: 'text-base ' + (i <= n ? 'text-amber-400' : 'text-slate-200 dark:text-slate-700'),
          }, '★')),
        );
      }
      if (props.dataType === 'multi_select') {
        const arr = Array.isArray(props.value) ? props.value : (props.value ? [String(props.value)] : []);
        if (!arr.length) return h('span', { class: 'text-slate-300 dark:text-slate-600' }, '—');
        return h('span', { class: 'flex flex-wrap gap-0.5' },
          arr.map((tag) => h('span', {
            key: tag,
            class: 'inline-flex items-center rounded-full px-1.5 py-0 text-xs font-medium bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800',
          }, tag)),
        );
      }
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
        if (props.format === 'progress') {
          const pct = Math.max(0, Math.min(100, n));
          const color = pct >= 70 ? '#10b981' : pct >= 40 ? '#f59e0b' : '#ef4444';
          return h('span', { class: 'flex items-center gap-1.5 w-full max-w-[120px]' }, [
            h('span', { class: 'flex-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden' }, [
              h('span', { class: 'h-full rounded-full block', style: `width:${pct}%;background:${color}` }),
            ]),
            h('span', { class: 'tabular-nums text-xs w-8 text-right shrink-0', style: `color:${color}` }, pct + '%'),
          ]);
        }
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
    value: { type: [String, Number, Boolean, Array, null] as unknown as () => string | number | boolean | string[] | null, default: null },
    dataType: { type: String as () => DataType, required: true },
    selectOptions: { type: Array as () => string[], default: () => [] },
  },
  emits: ['commit', 'cancel'],
  setup(props, { emit }) {
    const elRef = ref<HTMLInputElement | HTMLSelectElement | null>(null);
    const hoverStar = ref(0);
    onMounted(() => (elRef.value as HTMLElement | null)?.focus());
    return () => {
      const cellClass = 'w-full rounded px-1.5 py-0.5 text-sm bg-white dark:bg-slate-950 border border-sky-400 dark:border-sky-500 text-slate-900 dark:text-slate-100 outline-none focus:ring-1 focus:ring-sky-400/40';
      const val = props.value;
      function emitCommit() {
        const el = elRef.value;
        if (!el) { emit('commit', null); return; }
        const raw = (el as HTMLInputElement | HTMLSelectElement).value;
        if (props.dataType === 'multi_select') {
          const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
          emit('commit', parts.length ? parts : null);
        } else if (props.dataType === 'number') {
          const n = parseFloat(raw);
          emit('commit', raw === '' ? null : (isNaN(n) ? null : n));
        } else {
          emit('commit', raw === '' ? null : raw);
        }
      }
      const common = {
        ref: elRef,
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') { e.preventDefault(); emitCommit(); }
          if (e.key === 'Escape') { e.stopPropagation(); emit('cancel'); }
        },
        onBlur: emitCommit,
      };
      if (props.dataType === 'select') {
        return h('select', { ...common, class: cellClass + ' cursor-pointer appearance-none' }, [
          h('option', { value: '' }, '— select —'),
          ...props.selectOptions.map((o: string) => h('option', { value: o, selected: String(val) === o }, o)),
        ]);
      }
      if (props.dataType === 'multi_select') {
        const current = Array.isArray(val) ? val : (val ? String(val).split(',').map((s) => s.trim()) : []);
        return h('input', {
          ...common,
          type: 'text',
          value: current.join(', '),
          placeholder: 'Comma-separated values',
          class: cellClass,
          title: 'Enter values separated by commas',
        });
      }
      if (props.dataType === 'rating') {
        const cur = val ? Number(val) : 0;
        const display = hoverStar.value || cur;
        return h('span', {
          class: 'inline-flex items-center gap-0.5 px-1 leading-none outline-none',
          tabIndex: 0,
          onKeydown: (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); emit('cancel'); } },
          onMouseleave: () => { hoverStar.value = 0; },
        }, [1,2,3,4,5].map((i) => h('button', {
          key: i,
          type: 'button',
          class: 'text-xl leading-none transition-colors focus:outline-none ' + (i <= display ? 'text-amber-400' : 'text-slate-200 dark:text-slate-700'),
          onMouseenter: () => { hoverStar.value = i; },
          onMousedown: (e: MouseEvent) => e.preventDefault(),
          onClick: () => emit('commit', i === cur ? null : i),
        }, '★')));
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
    value: { type: [String, Number, Boolean, Array, null] as unknown as () => string | number | boolean | string[] | null, default: null },
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
      if (props.dataType === 'rating') {
        const cur = val ? Number(val) : 0;
        return h('div', { class: 'flex items-center gap-1 py-1' },
          [1,2,3,4,5].map((i) => h('button', {
            key: i,
            type: 'button',
            class: 'text-2xl leading-none transition-colors focus:outline-none ' + (i <= cur ? 'text-amber-400' : 'text-slate-200 dark:text-slate-700')
              + (props.readOnly ? ' cursor-default' : ' hover:text-amber-300 cursor-pointer'),
            disabled: props.readOnly,
            onClick: props.readOnly ? undefined : () => emit('update:value', i === cur ? null : i),
          }, '★')),
        );
      }
      if (props.dataType === 'multi_select') {
        const current: string[] = Array.isArray(val) ? val : (val ? String(val).split(',').map((s) => s.trim()).filter(Boolean) : []);
        if (props.readOnly) {
          if (!current.length) return h('span', { class: 'text-slate-300 dark:text-slate-600 text-sm' }, '—');
          return h('span', { class: 'flex flex-wrap gap-1' },
            current.map((tag) => h('span', {
              key: tag,
              class: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800',
            }, tag)),
          );
        }
        return h('div', { class: 'flex flex-wrap gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2' }, [
          ...props.selectOptions.map((opt) => {
            const checked = current.includes(opt);
            return h('label', {
              key: opt,
              class: 'inline-flex items-center gap-1.5 cursor-pointer select-none',
            }, [
              h('div', {
                class: `h-4 w-4 rounded border-2 flex-shrink-0 flex items-center justify-center ${checked ? 'bg-sky-500 border-sky-500' : 'border-slate-300 dark:border-slate-600'}`,
                onClick: () => {
                  const next = checked ? current.filter((x) => x !== opt) : [...current, opt];
                  emit('update:value', next.length ? next : null);
                },
              }, checked ? h('svg', { class: 'h-2.5 w-2.5 text-white', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24', 'stroke-width': '3' },
                [h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M5 13l4 4L19 7' })]) : null),
              h('span', { class: 'text-sm text-slate-700 dark:text-slate-300' }, opt),
            ]);
          }),
        ]);
      }
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
        if (props.format === 'progress') {
          const pct = val != null ? Math.max(0, Math.min(100, Number(val))) : 0;
          const color = pct >= 70 ? '#10b981' : pct >= 40 ? '#f59e0b' : '#ef4444';
          return h('div', { class: 'space-y-1.5 py-1' }, [
            h('div', { class: 'flex items-center justify-between text-xs' }, [
              h('span', { class: 'text-slate-400 dark:text-slate-500' }, val == null ? '—' : ''),
              h('span', { class: 'font-semibold tabular-nums', style: `color:${color}` }, val != null ? pct + '%' : '—'),
            ]),
            val != null ? h('div', { class: 'h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden' }, [
              h('div', { class: 'h-full rounded-full transition-all', style: `width:${pct}%;background:${color}` }),
            ]) : null,
          ]);
        }
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
      if (!props.readOnly && props.dataType === 'number' && props.format === 'progress') {
        const pct = val != null ? Math.max(0, Math.min(100, Number(val))) : 0;
        const color = pct >= 70 ? '#10b981' : pct >= 40 ? '#f59e0b' : '#ef4444';
        return h('div', { class: 'space-y-2' }, [
          h('div', { class: 'flex items-center gap-3' }, [
            h('input', {
              type: 'range', min: 0, max: 100, step: 1,
              value: pct,
              class: 'flex-1 accent-sky-500 cursor-pointer',
              onInput: (e: Event) => emit('update:value', Number((e.target as HTMLInputElement).value)),
            }),
            h('span', { class: 'text-sm font-semibold tabular-nums w-10 text-right shrink-0', style: `color:${color}` }, pct + '%'),
          ]),
          h('div', { class: 'h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden' }, [
            h('div', { class: 'h-full rounded-full transition-all', style: `width:${pct}%;background:${color}` }),
          ]),
        ]);
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
