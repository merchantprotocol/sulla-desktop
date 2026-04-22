<template>
  <div
    class="marketplace"
    :class="{ 'is-detail': showingDetail }"
  >
    <!-- Full-page detail takes over when open; list is hidden. -->
    <MarketplaceDetail
      v-if="mp.detail.value"
      :row="mp.detail.value.row"
      :manifest="mp.detail.value.manifest"
      :installing="mp.installing.value === mp.detail.value.row.id"
      :install-error="mp.installError.value"
      :installed-info="installedForOpenDrawer"
      @close="onCloseDetail"
      @install="onInstall(mp.detail.value.row.id)"
    />
    <div
      v-else-if="mp.detailLoading.value"
      class="full-loading"
    >
      Loading template details…
    </div>

    <template v-else>
    <!-- Left filter rail -->
    <aside class="rail">
      <div class="rail-head">
        Marketplace
      </div>

      <div class="rail-section">
        <div class="rail-label">
          Kind
        </div>
        <nav class="rail-nav">
          <button
            v-for="k in KIND_OPTIONS"
            :key="k.value"
            type="button"
            class="rail-item"
            :class="[
              { on: mp.kind.value === k.value },
              `kind-${ k.value }`
            ]"
            @click="onKind(k.value)"
          >
            <span class="dot" />
            <span class="label">{{ k.label }}</span>
          </button>
        </nav>
      </div>

      <div class="rail-section">
        <div class="rail-label">
          Sort
        </div>
        <nav class="rail-nav">
          <button
            v-for="s in SORT_OPTIONS"
            :key="s.value"
            type="button"
            class="rail-item plain"
            :class="{ on: mp.sort.value === s.value }"
            @click="onSort(s.value)"
          >
            <span class="label">{{ s.label }}</span>
          </button>
        </nav>
      </div>

      <div class="rail-footer">
        <p>Signed-in browse — installs land in your Library.</p>
      </div>
    </aside>

    <!-- Main content -->
    <section class="content">
      <div class="content-head">
        <h3>{{ headingLabel }}</h3>

        <div class="search-box">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
          >
            <circle
              cx="11"
              cy="11"
              r="8"
            />
            <line
              x1="21"
              y1="21"
              x2="16.65"
              y2="16.65"
            />
          </svg>
          <input
            v-model="searchDraft"
            type="text"
            placeholder="Search the marketplace…"
            @keydown.enter="submitSearch"
          >
          <span
            v-if="mp.total.value > 0"
            class="count"
          >
            {{ mp.total.value }} result{{ mp.total.value === 1 ? '' : 's' }}
          </span>
        </div>
      </div>

      <div
        v-if="mp.error.value"
        class="banner err"
      >
        <strong>Marketplace unavailable</strong>
        <p>{{ mp.error.value }}</p>
        <button
          type="button"
          class="btn ghost"
          @click="mp.load"
        >
          Retry
        </button>
      </div>

      <div
        v-else-if="mp.isLoading.value && mp.templates.value.length === 0"
        class="status"
      >
        Loading the marketplace…
      </div>

      <div
        v-else-if="mp.isEmpty.value"
        class="status"
      >
        Nothing here yet. Try clearing the filter or checking back once the community starts publishing.
      </div>

      <template v-else>
        <MarketplaceStrip
          v-for="t in mp.templates.value"
          :key="t.id"
          :row="t"
          :installing="mp.installing.value === t.id"
          @open="onOpen(t.id)"
          @install="onInstall(t.id)"
        />

        <div
          v-if="mp.totalPages.value > 1"
          class="pagination"
        >
          <button
            type="button"
            class="btn ghost"
            :disabled="mp.page.value <= 1"
            @click="mp.setPage(mp.page.value - 1)"
          >
            ← Prev
          </button>
          <span class="page-label">Page {{ mp.page.value }} of {{ mp.totalPages.value }}</span>
          <button
            type="button"
            class="btn ghost"
            :disabled="mp.page.value >= mp.totalPages.value"
            @click="mp.setPage(mp.page.value + 1)"
          >
            Next →
          </button>
        </div>
      </template>
    </section>

    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import MarketplaceDetail from '@pkg/components/routines/MarketplaceDetail.vue';
import MarketplaceStrip from '@pkg/components/routines/MarketplaceStrip.vue';
import type { KindFilter, MarketplaceSort } from '@pkg/composables/useMarketplace';
import { useMarketplace } from '@pkg/composables/useMarketplace';

type SortValue = MarketplaceSort;

const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'all',      label: 'All' },
  { value: 'routine',  label: 'Routines' },
  { value: 'skill',    label: 'Skills' },
  { value: 'function', label: 'Functions' },
  { value: 'recipe',   label: 'Recipes' },
];

const SORT_OPTIONS: { value: SortValue; label: string }[] = [
  { value: 'popular',  label: 'Popular' },
  { value: 'newest',   label: 'Newest' },
  { value: 'featured', label: 'Featured' },
];

const mp = useMarketplace();
const searchDraft = ref('');

const emit = defineEmits<{
  (e: 'installed', info: { kind: string; slug: string; path: string; name: string }): void;
}>();

const showingDetail = computed(() => !!mp.detail.value || mp.detailLoading.value);

const headingLabel = computed(() => {
  const kind = KIND_OPTIONS.find(k => k.value === mp.kind.value);

  return kind?.value === 'all' ? 'All kinds' : kind?.label ?? 'Marketplace';
});

const installedForOpenDrawer = computed(() => {
  if (!mp.detail.value || !mp.lastInstalled.value) return null;

  return mp.lastInstalled.value;
});

onMounted(() => { void mp.load(); });

function onKind(k: KindFilter) {
  void mp.setKind(k);
}
function onSort(s: SortValue) {
  void mp.setSort(s);
}
function submitSearch() {
  void mp.setSearch(searchDraft.value);
}
function onOpen(id: string) {
  mp.clearInstallResult();
  void mp.loadDetail(id);
}
function onCloseDetail() {
  mp.clearDetail();
  mp.clearInstallResult();
}

async function onInstall(id: string) {
  const result = await mp.install(id);
  if (result) {
    emit('installed', result);
  }
}
</script>

<style scoped lang="scss">
.marketplace {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 24px;
  margin-top: 8px;
  min-height: 400px;
}
// When the full-page detail is open, drop the grid and let the detail
// page own the whole tab width. Without this the detail sits inside the
// 1fr track with 220px of dead space to its left where the rail used to
// be — which is exactly the "all jacked up" layout.
.marketplace.is-detail {
  display: block;
  grid-template-columns: none;
}

.rail {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: rgba(10, 18, 36, 0.45);
  padding: 16px 12px;
  position: sticky;
  top: 16px;
  align-self: start;
}
.rail-head {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--steel-400);
  margin-bottom: 16px;
  padding: 0 8px;
}
.rail-section + .rail-section { margin-top: 14px; }
.rail-label {
  font-family: var(--mono);
  font-size: 8px;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--steel-400);
  padding: 0 8px 6px;
  border-bottom: 1px dashed rgba(168, 192, 220, 0.15);
  margin-bottom: 6px;
}
.rail-nav { display: flex; flex-direction: column; gap: 2px; }
.rail-item {
  display: grid;
  grid-template-columns: 8px 1fr;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--steel-200);
  font-family: var(--sans);
  font-size: 12.5px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
  text-align: left;
}
.rail-item.plain {
  grid-template-columns: 1fr;
}
.rail-item:hover {
  background: rgba(26, 40, 66, 0.5);
  color: white;
}
.rail-item.on {
  background: rgba(26, 40, 66, 0.82);
  border-color: rgba(140, 172, 201, 0.4);
  color: white;
}

.dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: rgba(168, 192, 220, 0.35);
}
.rail-item.kind-routine  .dot { background: #4a6fa5; }
.rail-item.kind-skill    .dot { background: #f59e0b; }
.rail-item.kind-function .dot { background: #06b6d4; }
.rail-item.kind-recipe   .dot { background: #c026d3; }
.rail-item.kind-all      .dot { background: linear-gradient(135deg, #4a6fa5, #c026d3); }

.rail-footer {
  margin-top: 18px;
  padding: 10px 8px 0;
  border-top: 1px dashed rgba(168, 192, 220, 0.2);
}
.rail-footer p {
  font-family: var(--sans);
  font-size: 11px;
  color: var(--steel-400);
  line-height: 1.5;
  margin: 0;
}

.content { min-width: 0; }
.content-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.content-head h3 {
  font-family: var(--serif);
  font-style: italic;
  font-size: 22px;
  color: white;
  margin: 0;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: rgba(10, 18, 36, 0.55);
  border: 1px solid var(--line);
  border-radius: 4px;
  min-width: 280px;
  flex: 1;
  max-width: 480px;
}
.search-box svg { width: 14px; height: 14px; color: var(--steel-400); }
.search-box input {
  flex: 1;
  background: transparent;
  border: none;
  color: white;
  font-family: var(--sans);
  font-size: 12.5px;
  outline: none;
}
.search-box .count {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--steel-400);
}

.status {
  text-align: center;
  padding: 40px 20px;
  font-family: var(--sans);
  color: var(--steel-300);
  font-size: 13px;
}
.banner {
  padding: 16px 18px;
  border-radius: 4px;
  font-family: var(--sans);
  font-size: 13px;
}
.banner.err {
  border: 1px solid rgba(248, 113, 113, 0.35);
  background: rgba(127, 29, 29, 0.18);
  color: #fca5a5;
}
.banner strong { display: block; margin-bottom: 4px; color: #fecaca; }
.banner p { margin: 0 0 10px; }

.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
  padding: 16px 0;
}
.page-label {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--steel-300);
}
.btn {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 8px 14px;
  border-radius: 4px;
  border: 1px solid transparent;
  cursor: pointer;
  background: transparent;
  color: var(--steel-200);
}
.btn.ghost {
  border-color: rgba(168, 192, 220, 0.3);
}
.btn.ghost:hover:not(:disabled) { border-color: var(--steel-300); color: white; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.full-loading {
  padding: 80px 20px;
  text-align: center;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--steel-300);
}
</style>
