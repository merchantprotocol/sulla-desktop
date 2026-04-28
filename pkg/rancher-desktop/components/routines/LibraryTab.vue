<template>
  <div
    class="library"
    :class="{ 'is-detail': showingDetail }"
  >
    <!-- Recipe Docker management panel — replaces the read-only detail for recipes. -->
    <RecipeDockerPanel
      v-if="recipeDetail"
      :slug="recipeDetail.slug"
      :name="recipeDetail.name"
      :description="recipeDetail.description"
      @close="recipeDetail = null"
    />

    <!-- Full-page read-only detail takes over the whole tab. -->
    <MarketplaceDetail
      v-else-if="detailPayload"
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
      class="full-loading"
    >
      Loading…
    </div>

    <!-- Full-page draft editor takes over when active. -->
    <LibraryDraftDetail
      v-else-if="drafts.active.value"
      :draft="drafts.active.value"
      :drafts="drafts"
      @close="drafts.closeDetail"
      @deleted="drafts.closeDetail"
    />

    <!-- Normal library view: left rail + list. -->
    <template v-else>
      <!-- Left rail: kind selector + drafts shortcut -->
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
              { on: activeView === 'kind' && lib.activeKind.value === k.kind },
              `kind-${k.kind}`,
            ]"
            @click="onSelectKind(k.kind)"
          >
            <span class="dot" />
            <span class="label">{{ k.label }}</span>
            <span class="count">{{ countFor(k.kind) }}</span>
          </button>
        </nav>
        <div class="rail-divider" />
        <nav class="rail-nav">
          <button
            type="button"
            class="rail-item kind-drafts"
            :class="{ on: activeView === 'drafts' }"
            @click="onShowDrafts"
          >
            <span class="dot" />
            <span class="label">Drafts</span>
            <span class="count">{{ drafts.drafts.value.length }}</span>
          </button>
        </nav>
        <div class="rail-footer">
          <p>{{ footerHint }}</p>
        </div>
      </aside>

      <!-- Main column -->
      <section
        v-if="activeView === 'kind'"
        class="content"
      >
        <div class="content-head">
          <h3>{{ currentKindLabel }}</h3>
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
              :placeholder="`Search ${currentKindLabel.toLowerCase()}…`"
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
          <strong>Couldn't load your {{ currentKindLabel.toLowerCase() }}</strong>
          <p>{{ lib.activeState.value.error }}</p>
          <button
            type="button"
            class="btn ghost"
            @click="reload"
          >
            Try again
          </button>
        </div>

        <!-- Stats tiles — shown only on the All view. Quick at-a-glance
           breakdown across the four artifact kinds; clicking a tile
           drills into that kind's filter. -->
        <div
          v-if="lib.activeKind.value === 'all' && !lib.activeState.value.error && lib.activeState.value.items.length > 0"
          class="stats"
        >
          <button
            v-for="tile in STAT_TILES"
            :key="tile.kind"
            type="button"
            class="stat-tile"
            :class="`kind-${tile.kind}`"
            @click="onSelectKind(tile.kind)"
          >
            <span class="stat-value">{{ lib.kindCounts.value[tile.kind] }}</span>
            <span class="stat-label">{{ tile.label }}</span>
          </button>
        </div>

        <div
          v-else-if="lib.activeState.value.isLoading && lib.activeState.value.items.length === 0"
          class="status"
        >
          Scanning your {{ currentKindLabel.toLowerCase() }}…
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
            :key="`${resolveItemKind(item)}:${item.slug}`"
            :kind="resolveItemKind(item)"
            :item="item"
            :primary-label="resolveItemKind(item) === 'routines' ? 'Use Template' : primaryLabel"
            @primary="onPrimary(item)"
            @view="onView(item)"
            @reveal="onReveal(item)"
            @publish="onPublish(item)"
          />
        </template>
      </section>

      <!-- Drafts list -->
      <section
        v-else-if="activeView === 'drafts'"
        class="content"
      >
        <div class="content-head">
          <h3>Drafts</h3>
          <div
            v-if="drafts.drafts.value.length > 0"
            class="count-pill"
          >
            {{ drafts.drafts.value.length }} in progress
          </div>
        </div>

        <div
          v-if="drafts.loadError.value"
          class="banner err"
        >
          <strong>Couldn't load drafts</strong>
          <p>{{ drafts.loadError.value }}</p>
        </div>

        <div
          v-else-if="drafts.isLoading.value && drafts.drafts.value.length === 0"
          class="status"
        >
          Loading drafts…
        </div>

        <div
          v-else-if="drafts.drafts.value.length === 0"
          class="status"
        >
          <p><strong>No drafts yet.</strong></p>
          <p>Open any skill, function, or recipe and click "Fork" to start editing it here.</p>
        </div>

        <div
          v-for="d in drafts.drafts.value"
          v-else
          :key="d.id"
          class="draft-row"
          @click="onOpenDraft(d.id)"
        >
          <div
            class="icon"
            :class="`kind-${d.kind}`"
          >
            {{ initials(d.name, d.slug) }}
          </div>
          <div class="body">
            <div class="top">
              <span
                class="kind-badge"
                :class="`kind-${d.kind}`"
              >{{ d.kind }}</span>
              <span
                v-if="d.base_slug"
                class="chip"
              >forked from {{ d.base_slug }}</span>
              <span class="chip">{{ d.slug }}</span>
            </div>
            <div class="title">
              {{ d.name || d.slug }}
            </div>
            <div class="meta">
              Updated {{ formatRelative(d.updated_at) }}
            </div>
          </div>
          <div class="cta">
            <button
              type="button"
              class="btn primary"
              @click.stop="onOpenDraft(d.id)"
            >
              Edit
            </button>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import LibraryDraftDetail from '@pkg/components/routines/LibraryDraftDetail.vue';
import LibraryItemStrip from '@pkg/components/routines/LibraryItemStrip.vue';
import MarketplaceDetail from '@pkg/components/routines/MarketplaceDetail.vue';
import RecipeDockerPanel from '@pkg/components/recipes/RecipeDockerPanel.vue';
import type { LibraryArtifactKind, LibraryItem, LibraryKind } from '@pkg/composables/useLibrary';
import { useLibrary } from '@pkg/composables/useLibrary';
import { useLibraryDrafts } from '@pkg/composables/useLibraryDrafts';
import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const emit = defineEmits<(e: 'use-template', slug: string) => void>();

type ActiveView = 'kind' | 'drafts';

const KINDS: { kind: LibraryKind; label: string }[] = [
  { kind: 'all', label: 'All' },
  { kind: 'routines', label: 'Routines' },
  { kind: 'skills', label: 'Skills' },
  { kind: 'functions', label: 'Functions' },
  { kind: 'recipes', label: 'Recipes' },
  { kind: 'integrations', label: 'Integrations' },
];

const STAT_TILES: { kind: LibraryArtifactKind; label: string }[] = [
  { kind: 'routines', label: 'Routines' },
  { kind: 'skills', label: 'Skills' },
  { kind: 'functions', label: 'Functions' },
  { kind: 'recipes', label: 'Recipes' },
  { kind: 'integrations', label: 'Integrations' },
];

/** Per-kind row count for the All-view stats tiles + left-rail counts.
 *  `all` is a derived total; the four artifact kinds pass through. */
function countFor(kind: LibraryKind): number {
  if (kind === 'all') return lib.totalCount.value;
  return lib.kindCounts.value[kind];
}

/** Resolve an item's artifact kind. In kind-specific views the item
 *  matches the active kind; in the All view items carry their own
 *  `kind` tag set by the loaders. Defensive fallback to 'routines'
 *  handles legacy rows that predate the kind-stamping. */
function resolveItemKind(item: LibraryItem): LibraryArtifactKind {
  if (item.kind) return item.kind;
  if (lib.activeKind.value !== 'all') return lib.activeKind.value;
  return 'routines';
}

const lib = useLibrary();
const drafts = useLibraryDrafts();
const activeView = ref<ActiveView>('kind');

// Recipe Docker panel state — shown instead of MarketplaceDetail for recipe items.
interface RecipeDetail { slug: string; name: string; description?: string }
const recipeDetail = ref<RecipeDetail | null>(null);

// Read-only detail drawer state — reuses MarketplaceDetail in local mode.
interface LocalDetail {
  row:      MarketplaceBrowseRow;
  manifest: Record<string, unknown>;
}
const detailPayload = ref<LocalDetail | null>(null);
const detailLoading = ref(false);
const forking = ref(false);
const forkError = ref<string | null>(null);

onMounted(() => {
  void lib.loadAll();
  void drafts.load();
});

const showingDetail = computed(() => !!recipeDetail.value || !!detailPayload.value || detailLoading.value || !!drafts.active.value);

const currentKindLabel = computed(() => KINDS.find(k => k.kind === lib.activeKind.value)?.label ?? 'Library');

const footerHint = computed(() => {
  if (activeView.value === 'drafts') {
    return 'Drafts live in the database. Publish them to disk or submit to the marketplace from the draft detail drawer.';
  }
  switch (lib.activeKind.value) {
  case 'all':
    return 'Every artifact installed on this machine — routines, skills, functions, and recipes.';
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
  case 'all':
    return 'Install anything from the Marketplace tab, or drop a folder into ~/sulla/<kind>/ to see it here.';
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
  // Only routine rows can "Use Template" — in the All view the label
  // would be wrong for non-routine rows, so suppress it there and fall
  // back to "View" + "Reveal" for everyone. Per-kind views still get
  // the primary button on routines.
  return lib.activeKind.value === 'routines' ? 'Use Template' : undefined;
});

function onSelectKind(kind: LibraryKind) {
  activeView.value = 'kind';
  void lib.setKind(kind);
}

function onShowDrafts() {
  activeView.value = 'drafts';
  void drafts.load();
}

function reload() {
  if (lib.activeKind.value === 'all') {
    void lib.loadAll();
    return;
  }
  void lib.loadKind(lib.activeKind.value);
}

async function onPrimary(item: LibraryItem) {
  // Only routines have a "use template" flow — on other kinds the
  // primary button is suppressed, so this path is a no-op for them.
  if (resolveItemKind(item) === 'routines') {
    emit('use-template', item.slug);
  }
}

async function onReveal(item: LibraryItem) {
  const kind = resolveItemKind(item);
  try {
    const result = await ipcRenderer.invoke('library-reveal', kind, item.slug);
    if (!result.revealed && result.error) {
      console.warn(`[Library] reveal failed: ${ result.error }`);
    }
  } catch (err) {
    console.warn('[Library] reveal failed:', err);
  }
}

async function onView(item: LibraryItem) {
  const kind = resolveItemKind(item);

  // Recipes get the Docker management panel instead of the read-only detail drawer.
  if (kind === 'recipes') {
    recipeDetail.value = {
      slug:        item.slug,
      name:        item.name || item.slug,
      description: (item as any).description as string | undefined,
    };
    return;
  }

  detailLoading.value = true;
  forkError.value = null;
  try {
    const res = await ipcRenderer.invoke('library-read-manifest', kind, item.slug);
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
  recipeDetail.value = null;
  forkError.value = null;
}

// Publish a local library item (routine template folder, skill, function,
// recipe) straight to the marketplace via bundles-publish. Native confirm
// keeps the flow bounded; auth failures bubble up from the worker as
// {error: "..."} with 401-ish strings we surface verbatim.
async function onPublish(item: LibraryItem) {
  const pluralToSingular: Record<LibraryArtifactKind, 'routine' | 'skill' | 'function' | 'recipe' | 'integration'> = {
    routines:     'routine',
    skills:       'skill',
    functions:    'function',
    recipes:      'recipe',
    integrations: 'integration',
  };
  const resolvedKind = resolveItemKind(item);
  const kind = pluralToSingular[resolvedKind];
  const label = resolvedKind.slice(0, -1);

  const ok = window.confirm(
    `Publish ${ label } "${ item.name || item.slug }" to the Sulla Marketplace? It'll land in review as a pending submission.`,
  );
  if (!ok) return;

  try {
    const args = kind === 'recipe'
      ? { kind, extensionId: item.slug }
      : { kind, slug: item.slug };
    const result = await ipcRenderer.invoke('bundles-publish', args);
    if ('error' in result) {
      const msg = String(result.error || '');
      if (/401|unauthor|access token|sign.in|signed in/i.test(msg)) {
        window.alert('You need to sign in to Sulla Cloud first. Open My Account → Sign in, then try again.');
      } else {
        window.alert(`Publish failed: ${ msg }`);
      }
      return;
    }
    window.alert(
      `"${ item.name || item.slug }" submitted as ${ result.templateId }. Status: ${ result.status } · bundle ${ result.bundle_status } (${ result.bundle_size } bytes).`,
    );
  } catch (err) {
    console.warn('[Library] publish failed:', err);
    window.alert(`Publish failed: ${ err instanceof Error ? err.message : String(err) }`);
  }
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
    // Close the read-only drawer, refresh drafts, open the draft editor.
    onCloseDetail();
    await drafts.load();
    await drafts.loadDetail(result.id);
    activeView.value = 'drafts';
  } catch (err) {
    forkError.value = err instanceof Error ? err.message : String(err);
  } finally {
    forking.value = false;
  }
}

async function onOpenDraft(id: string) {
  await drafts.loadDetail(id);
}

function initials(name: string, slug: string): string {
  const source = name || slug || '??';
  const words = source.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();

  return (words[0][0] + words[1][0]).toUpperCase();
}

function formatRelative(ts: string): string {
  if (!ts) return '—';
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return ts;
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${ Math.floor(diff / 60) }m ago`;
  if (diff < 86400) return `${ Math.floor(diff / 3600) }h ago`;
  if (diff < 2592000) return `${ Math.floor(diff / 86400) }d ago`;

  return new Date(t).toISOString().slice(0, 10);
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
// Full-width override when the read-only detail or draft editor takes over.
.library.is-detail {
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
  margin-bottom: 12px;
  padding: 0 8px;
}
.rail-nav { display: flex; flex-direction: column; gap: 4px; }
.rail-divider {
  height: 1px;
  background: rgba(168, 192, 220, 0.15);
  margin: 12px 4px;
}
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
  text-align: left;
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
.rail-item.kind-all       .dot { background: linear-gradient(135deg, #4a6fa5, #c026d3); }
.rail-item.kind-routines  .dot { background: #4a6fa5; }
.rail-item.kind-skills    .dot { background: #f59e0b; }
.rail-item.kind-functions .dot { background: #06b6d4; }
.rail-item.kind-recipes   .dot { background: #c026d3; }
.rail-item.kind-drafts    .dot { background: #86efac; }

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
.count-pill {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--steel-300);
  padding: 4px 10px;
  border-radius: 12px;
  background: rgba(10, 18, 36, 0.55);
  border: 1px solid var(--line);
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
.btn.primary {
  background: linear-gradient(135deg, var(--steel-300), var(--steel-500));
  color: white;
  border-color: var(--steel-400);
}

// ─── Draft row ─────────────────────────────────────────────
.draft-row {
  display: grid;
  grid-template-columns: 56px 1fr auto;
  gap: 20px;
  align-items: center;
  padding: 18px 22px;
  background: linear-gradient(90deg, rgba(18, 28, 48, 0.7), rgba(10, 18, 36, 0.4));
  border: 1px solid var(--line);
  border-radius: 6px;
  margin-bottom: 10px;
  cursor: pointer;
  transition: border-color 0.18s, background 0.18s;
}
.draft-row:hover {
  border-color: rgba(140, 172, 201, 0.5);
  background: linear-gradient(90deg, rgba(26, 40, 66, 0.82), rgba(16, 26, 46, 0.55));
}
.draft-row .icon {
  width: 48px; height: 48px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: white;
  font-family: var(--mono);
  font-weight: 700;
  font-size: 13px;
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.draft-row .icon.kind-skill    { background: linear-gradient(135deg, #d97706, #f59e0b); }
.draft-row .icon.kind-function { background: linear-gradient(135deg, #0891b2, #06b6d4); }
.draft-row .icon.kind-recipe   { background: linear-gradient(135deg, #a21caf, #c026d3); }
.draft-row .top { display: flex; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.draft-row .title {
  font-family: var(--serif);
  font-style: italic;
  font-size: 18px;
  color: white;
  line-height: 1.2;
  margin-bottom: 4px;
}
.draft-row .meta {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--steel-400);
}
.kind-badge {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: white;
}
.kind-badge.kind-skill    { background: rgba(245, 158, 11, 0.35); border-color: rgba(245, 158, 11, 0.6); }
.kind-badge.kind-function { background: rgba(6, 182, 212, 0.35);  border-color: rgba(6, 182, 212, 0.6); }
.kind-badge.kind-recipe   { background: rgba(192, 38, 211, 0.35); border-color: rgba(192, 38, 211, 0.6); }
.chip {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid rgba(168, 192, 220, 0.22);
  color: var(--steel-200);
  background: rgba(20, 30, 54, 0.4);
}

.full-loading {
  padding: 80px 20px;
  text-align: center;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--steel-300);
}

// ── Stats tiles (All view) ──
.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.stat-tile {
  padding: 14px 12px;
  border: 1px solid var(--line);
  border-left-width: 3px;
  border-radius: 6px;
  background: rgba(10, 18, 36, 0.5);
  display: grid;
  grid-template-rows: auto auto;
  gap: 4px;
  text-align: left;
  cursor: pointer;
  color: var(--steel-200);
  transition: background 0.15s, border-color 0.15s, transform 0.1s;
}
.stat-tile:hover {
  background: rgba(26, 40, 66, 0.55);
  border-color: rgba(140, 172, 201, 0.55);
  color: white;
  transform: translateY(-1px);
}
.stat-tile .stat-value {
  font-family: var(--display, var(--sans));
  font-size: 28px;
  font-weight: 600;
  color: white;
  letter-spacing: -0.02em;
}
.stat-tile .stat-label {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--steel-400);
}
.stat-tile.kind-routines  { border-left-color: #4a6fa5; }
.stat-tile.kind-skills    { border-left-color: #f59e0b; }
.stat-tile.kind-functions { border-left-color: #06b6d4; }
.stat-tile.kind-recipes   { border-left-color: #c026d3; }
</style>
