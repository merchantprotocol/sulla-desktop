<template>
  <div class="library">
    <!-- Left rail: kind selector -->
    <aside class="rail">
      <div class="rail-head">
        Library
      </div>
      <nav class="rail-nav">
        <button
          v-for="k in KINDS"
          :key="k.kind"
          type="button"
          class="rail-item"
          :class="[
            { on: lib.activeKind.value === k.kind },
            `kind-${ k.kind }`
          ]"
          @click="onSelect(k.kind)"
        >
          <span class="dot" />
          <span class="label">{{ k.label }}</span>
          <span class="count">{{ lib.kindCounts.value[k.kind] }}</span>
        </button>
      </nav>
      <div class="rail-footer">
        <p>{{ footerHint }}</p>
      </div>
    </aside>

    <!-- Main column -->
    <section class="content">
      <div class="content-head">
        <h3>{{ currentLabel }}</h3>
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
            v-model="lib.search.value"
            type="text"
            :placeholder="`Search ${ currentLabel.toLowerCase() }…`"
          >
          <span
            v-if="lib.activeState.value.items.length > 0"
            class="count"
          >
            {{ lib.filteredItems.value.length }} of {{ lib.activeState.value.items.length }}
          </span>
        </div>
      </div>

      <div
        v-if="lib.activeState.value.error"
        class="banner err"
      >
        <strong>Couldn't load your {{ currentLabel.toLowerCase() }}</strong>
        <p>{{ lib.activeState.value.error }}</p>
        <button
          type="button"
          class="btn ghost"
          @click="reload"
        >
          Try again
        </button>
      </div>

      <div
        v-else-if="lib.activeState.value.isLoading && lib.activeState.value.items.length === 0"
        class="status"
      >
        Scanning your {{ currentLabel.toLowerCase() }}…
      </div>

      <div
        v-else-if="lib.activeState.value.items.length === 0"
        class="status"
      >
        <p><strong>Nothing here yet.</strong></p>
        <p>{{ emptyHint }}</p>
      </div>

      <div
        v-else-if="lib.filteredItems.value.length === 0"
        class="status"
      >
        No matches for "{{ lib.search.value }}".
      </div>

      <template v-else>
        <LibraryItemStrip
          v-for="item in lib.filteredItems.value"
          :key="`${ lib.activeKind.value }:${ item.slug }`"
          :kind="lib.activeKind.value"
          :item="item"
          :primary-label="primaryLabel"
          @primary="onPrimary(item.slug)"
          @view="onView(item.slug)"
          @reveal="onReveal(item.slug)"
        />
      </template>
    </section>

    <!-- Local detail drawer — reuses the marketplace component in `local` mode. -->
    <MarketplaceDetail
      v-if="detailPayload"
      :row="detailPayload.row"
      :manifest="detailPayload.manifest"
      source="local"
      :forking="forking"
      :fork-error="forkError"
      @close="onCloseDetail"
      @fork="onFork(detailPayload.row)"
    />
    <div
      v-else-if="detailLoading"
      class="drawer-loading"
    >
      Loading…
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import LibraryItemStrip from '@pkg/components/routines/LibraryItemStrip.vue';
import MarketplaceDetail from '@pkg/components/routines/MarketplaceDetail.vue';
import type { LibraryKind } from '@pkg/composables/useLibrary';
import { useLibrary } from '@pkg/composables/useLibrary';
import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const emit = defineEmits<{
  (e: 'use-template', slug: string): void;
  (e: 'open-draft', id: string, kind: 'skill' | 'function' | 'recipe'): void;
}>();

// Detail drawer state — reuses MarketplaceDetail in local mode.
interface LocalDetail {
  row:      MarketplaceBrowseRow;
  manifest: Record<string, unknown>;
}
const detailPayload = ref<LocalDetail | null>(null);
const detailLoading = ref(false);
const forking       = ref(false);
const forkError     = ref<string | null>(null);

const KINDS: { kind: LibraryKind; label: string }[] = [
  { kind: 'routines',  label: 'Routines' },
  { kind: 'skills',    label: 'Skills' },
  { kind: 'functions', label: 'Functions' },
  { kind: 'recipes',   label: 'Recipes' },
];

const lib = useLibrary();

onMounted(() => {
  void lib.loadAll();
});

const currentLabel = computed(() => KINDS.find(k => k.kind === lib.activeKind.value)?.label ?? 'Library');

const footerHint = computed(() => {
  switch (lib.activeKind.value) {
  case 'routines':
    return 'Routine templates in ~/sulla/routines/. Use one to drop a fresh copy onto your canvas.';
  case 'skills':
    return 'Skills in ~/sulla/skills/. Instructions your agents load on demand.';
  case 'functions':
    return 'Functions in ~/sulla/functions/. Callable code your routines invoke.';
  case 'recipes':
    return 'Recipes in ~/sulla/recipes/. Docker extension configs; launch them from Extensions.';
  }

  return '';
});

const emptyHint = computed(() => {
  switch (lib.activeKind.value) {
  case 'routines':
    return 'Install a routine from the Marketplace tab, or import one from disk to see it here.';
  case 'skills':
    return 'Install a skill from the Marketplace tab to add it to your collection.';
  case 'functions':
    return 'Install a function from the Marketplace tab or drop one into ~/sulla/functions/.';
  case 'recipes':
    return 'Install a recipe from the Marketplace tab to configure a new extension.';
  }

  return '';
});

const primaryLabel = computed<string | undefined>(() => {
  switch (lib.activeKind.value) {
  case 'routines': return 'Use Template';
  case 'skills':
  case 'functions':
  case 'recipes':
    return undefined; // Reveal-only for now — no primary action defined yet
  }

  return undefined;
});

function onSelect(kind: LibraryKind) {
  void lib.setKind(kind);
}

function reload() {
  void lib.loadKind(lib.activeKind.value);
}

async function onPrimary(slug: string) {
  if (lib.activeKind.value === 'routines') {
    // Matches the existing "Use Template" emit so RoutinesHome's parent
    // can route it to the canvas in edit mode.
    emit('use-template', slug);
  }
}

async function onReveal(slug: string) {
  try {
    const result = await ipcRenderer.invoke('library-reveal', lib.activeKind.value, slug);
    if (!result.revealed && result.error) {
      console.warn(`[Library] reveal failed: ${ result.error }`);
    }
  } catch (err) {
    console.warn('[Library] reveal failed:', err);
  }
}

async function onView(slug: string) {
  detailLoading.value = true;
  forkError.value = null;
  try {
    const res = await ipcRenderer.invoke('library-read-manifest', lib.activeKind.value, slug);
    if ('error' in res) {
      console.warn('[Library] read-manifest failed:', res.error);
      window.alert(`Couldn't load details: ${ res.error }`);

      return;
    }
    const { manifest, ...row } = res.template as any;
    detailPayload.value = {
      row:      row as MarketplaceBrowseRow,
      manifest: (manifest ?? {}) as Record<string, unknown>,
    };
  } catch (err) {
    console.warn('[Library] read-manifest failed:', err);
  } finally {
    detailLoading.value = false;
  }
}

function onCloseDetail() {
  detailPayload.value = null;
  forkError.value = null;
}

async function onFork(row: MarketplaceBrowseRow) {
  if (row.kind === 'routine') {
    // Routines fork to the workflows canvas via the existing template-instantiate flow.
    emit('use-template', row.slug);
    onCloseDetail();

    return;
  }

  forking.value = true;
  forkError.value = null;
  try {
    const result = await ipcRenderer.invoke('library-fork', row.kind, row.slug);
    if ('error' in result) {
      forkError.value = result.error;

      return;
    }
    emit('open-draft', result.id, row.kind);
    onCloseDetail();
  } catch (err) {
    forkError.value = err instanceof Error ? err.message : String(err);
  } finally {
    forking.value = false;
  }
}
</script>

<style scoped lang="scss">
.library {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 24px;
  margin-top: 8px;
  min-height: 400px;
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
  margin-bottom: 12px;
  padding: 0 8px;
}
.rail-nav { display: flex; flex-direction: column; gap: 4px; }
.rail-item {
  display: grid;
  grid-template-columns: 8px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 10px 10px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--steel-200);
  font-family: var(--sans);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
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
}
.rail-item.kind-routines  .dot { background: #4a6fa5; }
.rail-item.kind-skills    .dot { background: #f59e0b; }
.rail-item.kind-functions .dot { background: #06b6d4; }
.rail-item.kind-recipes   .dot { background: #c026d3; }

.label { text-align: left; }
.count {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--steel-400);
  background: rgba(10, 18, 36, 0.6);
  padding: 2px 6px;
  border-radius: 10px;
  min-width: 22px;
  text-align: center;
}
.rail-item.on .count { color: white; background: rgba(14, 22, 40, 0.8); }

.rail-footer {
  margin-top: 16px;
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
  color: var(--steel-400);
  background: transparent;
  padding: 0;
}

.status {
  text-align: center;
  padding: 40px 20px;
  font-family: var(--sans);
  color: var(--steel-300);
  font-size: 13px;
  border: 1px dashed rgba(168, 192, 220, 0.2);
  border-radius: 6px;
  background: rgba(10, 18, 36, 0.3);
}
.status p { margin: 0 0 4px; }
.status p strong { color: white; }

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
.btn.ghost { border-color: rgba(168, 192, 220, 0.3); }
.btn.ghost:hover { border-color: var(--steel-300); color: white; }
</style>
