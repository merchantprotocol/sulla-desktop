<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="results-view">
    <button
      v-if="mobile"
      ref="filterTrigger"
      class="mobile-filter"
      type="button"
      @click="filtersOpen = true"
    >
      Search &amp; filters
    </button>
    <div
      v-if="filtersOpen && mobile"
      ref="filterDialog"
      class="mobile-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Search and filter use cases"
      tabindex="-1"
      @click.self="filtersOpen = false"
      @keydown.esc.stop.prevent="filtersOpen = false"
      @keydown="trapFilterFocus"
    >
      <MarketplaceFilterRail
        :facets="facets"
        :state="state"
        @update:state="updateState"
      /><button
        ref="filterCloseButton"
        class="close-filters"
        type="button"
        @click="filtersOpen = false"
      >
        Done
      </button>
    </div>
    <MarketplaceFilterRail
      v-else
      class="desktop-rail"
      :facets="facets"
      :state="state"
      @update:state="updateState"
    />
    <main class="main">
      <header class="heading">
        <div class="title-block"><button class="back" type="button" @click="emit('close')">Back to marketplace</button><h1>{{ title }}</h1><p>{{ rows.length }} use cases · {{ videoCount }} with video</p></div>
        <div class="tools">
          <label class="sort">Sort <select
            :value="state.sort"
            aria-label="Sort results"
            @change="setSort"
          ><option value="relevance">Best match</option><option value="popular">Most downloaded</option><option value="newest">Newest</option><option value="name">Name A–Z</option></select></label><div
            class="view-toggle"
            :class="{ grid: viewMode === 'grid' }"
          >
            <span class="thumb" /><button
              type="button"
              aria-label="List view"
              :aria-pressed="viewMode === 'list'"
              @click="viewMode = 'list'"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg>
            </button><button
              type="button"
              aria-label="Grid view"
              :aria-pressed="viewMode === 'grid'"
              @click="viewMode = 'grid'"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg>
            </button>
          </div>
        </div>
      </header>
      <div class="pills">
        <span
          v-if="state.q"
          class="pill"
        >{{ state.q }}<button
          aria-label="Remove search"
          @click="updateState({ ...state, q: '' })"
        >×</button></span>
        <span
          v-for="pill in selectedPills"
          :key="pill.key + pill.value"
          class="pill"
        >{{ pill.label }}<button
          :aria-label="`Remove ${pill.label}`"
          @click="removePill(pill.key, pill.value)"
        >×</button></span>
      </div>
      <div
        v-if="loading"
        class="skeletons"
        aria-label="Loading results"
      >
        <div
          v-for="n in 4"
          :key="n"
          class="skeleton"
        >
          <i /><div><b /><b /><b /></div>
        </div>
      </div>
      <div
        v-else-if="rows.length === 0"
        class="empty"
      >
        <h2>No use cases found</h2><p>Try changing your search or filters.</p><button
          type="button"
          @click="clearAll"
        >
          Remove filters
        </button>
      </div>
      <div
        v-else
        class="results-list"
        :class="viewMode"
      >
        <component
          :is="viewMode === 'list' ? MarketplaceResultRow : MarketplaceResultCard"
          v-for="row in rows"
          :key="row.id"
          :row="row"
          :install-status="statusFor(row)"
          @open="quickView = row"
          @detail="emit('open-detail', $event); quickView = null"
          @install="emit('install', $event)"
        />
      </div>
    </main>
    <MarketplaceQuickView
      :row="quickView"
      :install-status="quickView ? statusFor(quickView) : undefined"
      @close="quickView = null"
      @install="emit('install', $event)"
      @detail="emit('open-detail', $event); quickView = null"
    />
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import MarketplaceFilterRail from './MarketplaceFilterRail.vue';
import MarketplaceQuickView from './MarketplaceQuickView.vue';
import MarketplaceResultCard from './MarketplaceResultCard.vue';
import MarketplaceResultRow from './MarketplaceResultRow.vue';

import type { MarketplaceFacet, MarketplaceSearchState } from '../../composables/MarketplaceSearchService';
import type { MarketplaceBrowseRow } from '../../typings/electron-ipc';
const props = defineProps<{ rows: MarketplaceBrowseRow[]; facets: MarketplaceFacet[]; state: MarketplaceSearchState; loading: boolean; installState?: (row: MarketplaceBrowseRow) => string; installingId: string | null }>();
const emit = defineEmits<{ 'update:state': [state: MarketplaceSearchState]; 'open-detail': [row: MarketplaceBrowseRow]; install: [row: MarketplaceBrowseRow]; close: [] }>();
const filterDialog = ref<HTMLElement | null>(null); const filterTrigger = ref<HTMLButtonElement | null>(null); const filterCloseButton = ref<HTMLButtonElement | null>(null);
let previousFocus: HTMLElement | null = null; let previousBodyOverflow = ''; let previousHtmlOverflow = '';

const viewMode = ref<'list' | 'grid'>('list'); const quickView = ref<MarketplaceBrowseRow | null>(null); const filtersOpen = ref(false); const mobile = ref(false);
watch(filtersOpen, async open => {
  if (open) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousBodyOverflow = document.body.style.overflow; previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden';
    await nextTick(); filterCloseButton.value?.focus();
  } else {
    document.body.style.overflow = previousBodyOverflow; document.documentElement.style.overflow = previousHtmlOverflow;
    await nextTick(); (previousFocus ?? filterTrigger.value)?.focus(); previousFocus = null;
  }
});
let mediaQuery: MediaQueryList | undefined;
const title = computed(() => props.state.topics.length === 1 ? props.facets.find(f => f.key === 'topics')?.options.find(o => o.value === props.state.topics[0])?.label || props.state.topics[0] : props.state.q.trim() ? `Results for “${ props.state.q.trim() }”` : 'All use cases');
const videoCount = computed(() => props.rows.filter(row => row.hero_media?.type === 'video').length);
const selectedPills = computed(() => props.facets.flatMap(facet => (props.state[facet.key as 'topics' | 'kinds' | 'media'] ?? []).map(value => ({ key: facet.key, value, label: facet.options.find(option => option.value === value)?.label || value }))));
function statusFor(row: MarketplaceBrowseRow) { if (props.installingId === row.id) return 'installing'; return props.installState?.(row) ?? '' }
function updateState(state: MarketplaceSearchState) { emit('update:state', state) }
function setSort(event: Event) { updateState({ ...props.state, sort: (event.target as HTMLSelectElement).value as MarketplaceSearchState['sort'] }) }
function removePill(key: string, value: string) { const field = key as 'topics' | 'kinds' | 'media'; updateState({ ...props.state, [field]: props.state[field].filter(item => item !== value) }) }
function clearAll() { updateState({ ...props.state, q: '', topics: [], kinds: [], media: [] }) }
function updateMobile(event: MediaQueryListEvent | MediaQueryList) { mobile.value = event.matches; if (!event.matches) filtersOpen.value = false; }
function trapFilterFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !filterDialog.value) return;
  const items = [...filterDialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')];
  if (!items.length) {
    event.preventDefault();
    filterDialog.value.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === filterDialog.value)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
onMounted(() => { mediaQuery = window.matchMedia('(max-width: 860px)'); updateMobile(mediaQuery); mediaQuery.addEventListener('change', updateMobile) });
onBeforeUnmount(() => {
  mediaQuery?.removeEventListener('change', updateMobile);
  if (filtersOpen.value) {
    document.body.style.overflow = previousBodyOverflow;
    document.documentElement.style.overflow = previousHtmlOverflow;
  }
});
</script>
<style scoped>
.results-view{display:grid;grid-template-columns:288px minmax(0,1fr);gap:40px;max-width:1440px;margin:0 auto;padding:24px 24px 64px;color:var(--text)}.main{min-width:0}.heading{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding-bottom:16px}.title-block{min-width:0}.back{display:block;padding:0;margin:0 0 10px;border:0;background:none;color:var(--text-muted);font-size:13px;cursor:pointer}.back:hover{color:var(--accent)}.heading h1{font-size:27px;line-height:1.1;margin:0;font-weight:650;letter-spacing:-.03em}.heading p{color:var(--text-muted);margin:6px 0 0}.tools{display:flex;align-items:center;gap:10px;flex:none}.sort{display:flex;align-items:center;gap:7px;color:var(--text-muted);font-size:13px}.sort select{height:36px;border:1px solid var(--border);border-radius:20px;padding:0 30px 0 12px;background:var(--surface-1);color:var(--text);font:inherit}.view-toggle{position:relative;display:flex;padding:3px;border-radius:20px;background:var(--surface-2)}.view-toggle button{position:relative;z-index:1;width:34px;height:30px;border:0;border-radius:20px;background:none;color:var(--text-muted);cursor:pointer}.view-toggle button svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.view-toggle button[aria-pressed=true]{color:var(--text)}.thumb{position:absolute;top:3px;left:3px;width:34px;height:30px;border-radius:20px;background:var(--surface-1);box-shadow:0 1px 3px #0002;transition:transform 220ms ease}.view-toggle.grid .thumb{transform:translateX(34px)}.pills{display:flex;flex-wrap:wrap;gap:8px;border-bottom:1px solid var(--border);padding-bottom:14px;margin-bottom:2px}.pill{display:inline-flex;align-items:center;gap:5px;padding:5px 7px 5px 12px;border-radius:18px;background:var(--surface-2);font-size:13px}.pill button{border:0;border-radius:50%;background:none;width:22px;height:22px;cursor:pointer;color:var(--text-muted);font-size:17px}.pill button:hover{background:var(--border)}.results-list.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(245px,1fr));gap:30px 20px;padding-top:22px}.empty{text-align:center;padding:72px 16px;color:var(--text-muted)}.empty h2{color:var(--text);font-size:20px}.empty button,.mobile-filter{border:0;border-radius:22px;padding:10px 16px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer}.skeleton{display:grid;grid-template-columns:minmax(190px,304px) 1fr 184px;gap:24px;padding:22px 0;border-bottom:1px solid var(--border-muted)}.skeleton i,.skeleton b{display:block;background:var(--surface-2);border-radius:8px;animation:pulse 1.2s ease-in-out infinite alternate}.skeleton i{aspect-ratio:16/9}.skeleton b{height:14px;margin:7px 0;width:80%}.skeleton b:first-child{width:45%}@keyframes pulse{to{opacity:.45}}.mobile-filter,.mobile-scrim{display:none}
@media(max-width:1100px){.results-view{grid-template-columns:250px minmax(0,1fr);gap:24px}.heading{align-items:flex-start;flex-direction:column}.skeleton{grid-template-columns:34% 1fr}}
@media(max-width:860px){.results-view{display:block;padding:12px 18px 48px}.desktop-rail{display:none}.mobile-filter{display:block;margin-bottom:16px}.mobile-scrim{display:block;position:fixed;inset:0;z-index:900;background:#0003}.mobile-scrim :deep(.filter-rail){position:absolute;left:0;right:0;bottom:0;top:auto;max-height:82vh;border-radius:24px 24px 0 0;background:var(--surface-1);padding:22px 24px 70px;box-shadow:0 -10px 35px #0002}.close-filters{position:absolute;bottom:14px;right:20px;border:0;border-radius:20px;padding:9px 18px;background:var(--accent);color:#fff;font-weight:600}.tools{width:100%;justify-content:space-between}.heading h1{font-size:24px}.skeleton{grid-template-columns:34% 1fr;gap:14px}.skeleton div{min-width:0}}
@media(prefers-reduced-motion:reduce){.thumb,.skeleton i,.skeleton b{transition:none;animation:none}}
</style>
