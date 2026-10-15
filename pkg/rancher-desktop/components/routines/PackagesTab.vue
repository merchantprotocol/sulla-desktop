<template>
  <div
    class="packages"
    :class="{ 'is-detail': showingDetail }"
  >
    <!-- Getting a use case downloads it from Sulla Cloud, which needs a
         session. Browsing doesn't, so the gate only appears on Get. -->
    <div
      v-if="signInFor"
      class="signin-gate"
    >
      <SullaCloudCard
        :rationale="`Sign in to Sulla Cloud to get ${signInFor.name}. Browsing use cases doesn't need an account.`"
        @signed-in="onSignedIn"
      />
      <button
        type="button"
        class="link-btn"
        @click="signInFor = null"
      >
        ← Back to use cases
      </button>
    </div>

    <template v-else-if="pk.detail.value">
      <PackageDetail
        v-if="pk.detail.value.templateKind === 'package' || !pk.detail.value.templateKind"
        :detail="pk.detail.value"
        :installed="pk.installedSlugs.value.has(pk.detail.value.row.slug)"
        :busy="pk.busySlug.value === pk.detail.value.row.slug"
        @close="pk.clearDetail()"
        @get="onGet(pk.detail.value.row)"
        @uninstall="onUninstall(pk.detail.value.row.slug, pk.detail.value.row.name)"
      />
      <!-- Old sulla://marketplace links can still point at a single
           workflow/agent/skill listing; show those in the item page. -->
      <MarketplaceDetail
        v-else
        :row="pk.detail.value.raw as any"
        :manifest="pk.detail.value.manifest"
        :installing="mp.installing.value === pk.detail.value.row.id"
        :install-error="mp.installError.value"
        :installed-info="mp.lastInstalled.value"
        @close="pk.clearDetail()"
        @install="onLegacyInstall(pk.detail.value.row.id, false)"
        @install-all="onLegacyInstall(pk.detail.value.row.id, true)"
      />
    </template>

    <div
      v-else-if="pk.detailLoading.value"
      class="note"
    >
      Loading use case…
    </div>

    <div
      v-else-if="pk.detailError.value"
      class="note error"
    >
      <p>Couldn't open that use case: {{ pk.detailError.value }}</p>
      <button
        type="button"
        class="link-btn"
        @click="pk.clearDetail()"
      >
        ← Back to use cases
      </button>
    </div>

    <template v-else>
      <div
        class="seg"
        role="tablist"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="view === 'browse'"
          @click="view = 'browse'"
        >
          Browse
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="view === 'installed'"
          @click="view = 'installed'"
        >
          Installed ({{ pk.installed.value.length }})
        </button>
      </div>

      <!-- ═══════ BROWSE ═══════ -->
      <div v-if="view === 'browse'">
        <div
          v-if="pk.isLoading.value && pk.packages.value.length === 0"
          class="note"
        >
          Loading use cases…
        </div>

        <div
          v-else-if="pk.error.value"
          class="note error"
        >
          <p>Couldn't load use cases: {{ pk.error.value }}</p>
          <button
            type="button"
            class="link-btn"
            @click="pk.load()"
          >
            Try again
          </button>
        </div>

        <div
          v-else-if="pk.packages.value.length === 0"
          class="empty-state"
        >
          <h2>No use cases yet</h2>
          <p>Use cases are ready-made jobs for Sulla, each one a single download with everything it needs. When the first ones are published they'll show up here.</p>
        </div>

        <template v-else>
          <div class="sugg">
            <label class="search">
              <span
                class="ico"
                aria-hidden="true"
              >⌕</span>
              <input
                ref="searchInput"
                v-model="query"
                type="search"
                placeholder="What do you want Sulla to do?"
                autocomplete="off"
                aria-label="Search use cases"
                @focus="searchFocused = true"
                @blur="onSearchBlur"
              >
            </label>
            <ul
              v-if="showSuggestions"
              class="sugg-list"
            >
              <li
                v-for="p in suggestions"
                :key="p.id"
              >
                <button
                  type="button"
                  @mousedown.prevent="openPackage(p)"
                >
                  <span>{{ p.icon }}</span>{{ p.title }}<small>{{ packageTopicLabel(p.topic) }}</small>
                </button>
              </li>
            </ul>
          </div>

          <p
            v-if="tries.length"
            class="tries"
          >
            People search for:
            <button
              v-for="t in tries"
              :key="t"
              type="button"
              @click="trySearch(t)"
            >
              {{ t }}
            </button>
          </p>

          <select
            class="jump"
            aria-label="Jump to a topic"
            :value="''"
            @change="onJump"
          >
            <option value="">
              Jump to a topic…
            </option>
            <option
              v-for="g in groups"
              :key="g.key"
              :value="g.key"
            >
              {{ g.label }} ({{ g.items.length }})
            </option>
          </select>

          <div class="uc">
            <nav
              class="side"
              aria-label="Topics"
            >
              <div class="sec">
                Topics
              </div>
              <button
                v-for="g in groups"
                :key="g.key"
                type="button"
                :class="{ on: activeTopic === g.key }"
                @click="goToTopic(g.key)"
              >
                {{ g.label }}<span>{{ g.items.length }}</span>
              </button>
            </nav>

            <div>
              <p class="count">
                {{ countLabel }}
              </p>

              <div
                v-if="searching"
                class="pkgs"
              >
                <PackageCard
                  v-for="p in hits"
                  :key="p.id"
                  :pkg="p"
                  :installed="pk.installedSlugs.value.has(p.slug)"
                  :busy="pk.busySlug.value === p.slug"
                  @open="openPackage(p)"
                  @get="onGet(p)"
                />
                <div
                  v-if="hits.length === 0"
                  class="empty"
                >
                  Nothing yet for that. Try different words, or ask Sulla in chat to do it for you.
                </div>
              </div>

              <template v-else>
                <section
                  v-for="g in groups"
                  :key="g.key"
                  :ref="el => registerGroup(g.key, el as HTMLElement | null)"
                  class="group"
                  :data-topic="g.key"
                >
                  <h2>{{ g.label }}</h2>
                  <p>{{ g.blurb }}</p>
                  <div class="pkgs">
                    <PackageCard
                      v-for="p in g.items"
                      :key="p.id"
                      :pkg="p"
                      :installed="pk.installedSlugs.value.has(p.slug)"
                      :busy="pk.busySlug.value === p.slug"
                      @open="openPackage(p)"
                      @get="onGet(p)"
                    />
                  </div>
                </section>
              </template>
            </div>
          </div>
        </template>
      </div>

      <!-- ═══════ INSTALLED ═══════ -->
      <div
        v-else
        class="pkgs installed-list"
      >
        <div
          v-if="pk.installed.value.length === 0"
          class="empty-state"
        >
          <h2>Nothing installed yet</h2>
          <p>Use cases you get show up here, with everything they added.</p>
        </div>
        <div
          v-for="p in pk.installed.value"
          :key="p.slug"
          class="inst"
        >
          <div class="pkg-ic">
            {{ p.icon || '📦' }}
          </div>
          <div class="inst-body">
            <h3>{{ p.name }}</h3>
            <p>{{ installedLine(p) }}</p>
          </div>
          <div class="inst-act">
            <button
              v-if="browseRowFor(p.slug)"
              type="button"
              class="ghost-btn"
              @click="openPackage(browseRowFor(p.slug)!)"
            >
              Details
            </button>
            <button
              type="button"
              class="ghost-btn"
              :disabled="pk.busySlug.value === p.slug"
              @click="onUninstall(p.slug, p.name)"
            >
              {{ pk.busySlug.value === p.slug ? 'Removing…' : 'Remove' }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

import SullaCloudCard from '@pkg/components/account/SullaCloudCard.vue';
import MarketplaceDetail from '@pkg/components/routines/MarketplaceDetail.vue';
import PackageCard from '@pkg/components/routines/PackageCard.vue';
import PackageDetail from '@pkg/components/routines/PackageDetail.vue';
import { PACKAGE_TOPICS, packageTopicLabel } from '@pkg/composables/packageTopics';
import { useMarketplace } from '@pkg/composables/useMarketplace';
import { packageMatches, usePackages, type InstalledPackage, type PackageRow } from '@pkg/composables/usePackages';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type FeedbackKind = 'success' | 'error' | 'info';

const emit = defineEmits<{
  (e: 'installed'): void;
  (e: 'feedback', kind: FeedbackKind, message: string): void;
}>();

const pk = usePackages();
const mp = useMarketplace(); // only for old single-item deep links

const view = ref<'browse' | 'installed'>('browse');
const query = ref('');
const searchFocused = ref(false);
const activeTopic = ref<string>('');
const signInFor = ref<PackageRow | null>(null);

const showingDetail = computed(() => !!pk.detail.value || pk.detailLoading.value || !!pk.detailError.value || !!signInFor.value);

// ── Sections ─────────────────────────────────────────────────────────

const groups = computed(() => {
  const known = PACKAGE_TOPICS.map(t => ({
    key:   t.key as string,
    label: t.label as string,
    blurb: t.blurb as string,
    items: pk.packages.value.filter(p => p.topic === t.key),
  }));
  const other = pk.packages.value.filter(p => !PACKAGE_TOPICS.some(t => t.key === p.topic));
  if (other.length) known.push({ key: 'other', label: 'More', blurb: 'Everything else.', items: other });

  return known.filter(g => g.items.length > 0);
});

const searching = computed(() => query.value.trim().length > 0);
const hits = computed(() => pk.packages.value.filter(p => packageMatches(p, query.value)));
const suggestions = computed(() => hits.value.slice(0, 5));
const showSuggestions = computed(() => searching.value && searchFocused.value && suggestions.value.length > 0);

const countLabel = computed(() => {
  if (!searching.value) {
    const n = pk.packages.value.length;

    return `${ n } thing${ n === 1 ? '' : 's' } Sulla can do for you`;
  }
  const n = hits.value.length;

  return `${ n } match${ n === 1 ? '' : 'es' } for “${ query.value.trim() }”`;
});

// Example searches come from real packages' keywords, so every link
// finds something.
const tries = computed(() => {
  const out: string[] = [];
  for (const p of pk.packages.value) {
    const k = p.keywords[0];
    if (k && !out.includes(k)) out.push(k);
    if (out.length === 4) break;
  }

  return out;
});

function trySearch(term: string) {
  query.value = term;
  searchInput.value?.focus();
}

const searchInput = ref<HTMLInputElement | null>(null);

function onSearchBlur() {
  setTimeout(() => { searchFocused.value = false }, 150);
}

// ── Topic scroll + highlight ─────────────────────────────────────────

const groupEls = new Map<string, HTMLElement>();
let observer: IntersectionObserver | null = null;
// A clicked topic stays highlighted while the smooth scroll settles, even
// when the last sections can't reach the top of the page.
let pinnedUntil = 0;

function registerGroup(key: string, el: HTMLElement | null) {
  if (el) groupEls.set(key, el);
  else groupEls.delete(key);
}

function goToTopic(key: string) {
  activeTopic.value = key;
  pinnedUntil = Date.now() + 1200;
  groupEls.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onJump(ev: Event) {
  const select = ev.target as HTMLSelectElement;
  if (select.value) goToTopic(select.value);
  select.value = '';
}

function observeGroups() {
  observer?.disconnect();
  observer = null;
  if (searching.value || groupEls.size === 0) return;
  observer = new IntersectionObserver((entries) => {
    if (Date.now() < pinnedUntil) return;
    for (const entry of entries) {
      if (entry.isIntersecting) activeTopic.value = (entry.target as HTMLElement).dataset.topic ?? '';
    }
  }, { rootMargin: '-60px 0px -70% 0px' });
  groupEls.forEach(el => observer!.observe(el));
  if (!activeTopic.value) activeTopic.value = groups.value[0]?.key ?? '';
}

watch([groups, searching, view, () => pk.detail.value], () => {
  nextTick(observeGroups);
});

// ── Detail ───────────────────────────────────────────────────────────

function openPackage(row: PackageRow) {
  searchFocused.value = false;
  pk.loadDetail(row.id).catch(() => undefined);
}

function browseRowFor(slug: string): PackageRow | undefined {
  return pk.packages.value.find(p => p.slug === slug);
}

function installedLine(p: InstalledPackage): string {
  const parts = [p.title];
  const when = Date.parse(p.installedAt);
  if (!Number.isNaN(when)) parts.push(`installed ${ new Date(when).toLocaleDateString() }`);
  const n = p.items?.length ?? 0;
  parts.push(`${ n } item${ n === 1 ? '' : 's' }`);

  return parts.filter(Boolean).join(' · ');
}

// ── Get / Remove ─────────────────────────────────────────────────────

async function isSignedIn(): Promise<boolean> {
  try {
    const status = await ipcRenderer.invoke('sulla-cloud:get-status');

    return !!status?.signedIn;
  } catch {
    return true; // let the installer report the real problem
  }
}

async function onGet(row: PackageRow) {
  if (pk.busySlug.value) return;
  if (!(await isSignedIn())) {
    signInFor.value = row;

    return;
  }
  const res = await pk.install(row);
  if (res.ok) {
    const n = res.installed?.length ?? 0;
    emit('feedback', 'success', `${ row.name } is ready.${ n ? ` Added ${ n } item${ n === 1 ? '' : 's' }.` : '' }`);
    emit('installed');
  } else {
    emit('feedback', 'error', `Couldn't get ${ row.name }: ${ res.error || 'unknown error' }`);
  }
}

async function onSignedIn() {
  const row = signInFor.value;
  signInFor.value = null;
  if (row) await onGet(row);
}

async function onUninstall(slug: string, name: string) {
  if (!window.confirm(`Remove ${ name }?\n\nSulla takes out what this use case added. Anything you've changed since stays.`)) return;
  const res = await pk.uninstall(slug);
  if (res.ok) {
    emit('feedback', 'success', `${ name } removed.`);
    emit('installed');
  } else {
    emit('feedback', 'error', `Couldn't remove ${ name }: ${ res.error || 'unknown error' }`);
  }
}

async function onLegacyInstall(id: string, includeDependencies: boolean) {
  const res = includeDependencies ? await mp.installAll(id) : await mp.install(id);
  if (res) {
    emit('feedback', 'success', `${ res.name } installed.`);
    emit('installed');
  } else {
    emit('feedback', 'error', `Install failed: ${ mp.installError.value || 'unknown error' }`);
  }
}

// Deep link: sulla://marketplace/install?id=… (or sulla://packages/…).
function onOpenDetailEvent(ev: Event) {
  const id = (ev as CustomEvent<{ id?: string }>).detail?.id;
  if (id) pk.loadDetail(id).catch(() => undefined);
}

onMounted(() => {
  window.addEventListener('sulla:marketplace-open-detail', onOpenDetailEvent);
  pk.load().catch(() => undefined);
  pk.loadInstalled().catch(() => undefined);
});

onUnmounted(() => {
  window.removeEventListener('sulla:marketplace-open-detail', onOpenDetailEvent);
  observer?.disconnect();
});
</script>

<style scoped>
.packages {
  container: packages / inline-size;
  color: var(--nx-read-1, var(--text-primary));
  font-family: var(--font-body, system-ui, sans-serif);
}

.seg {
  display: inline-flex;
  border: 1px solid var(--nx-hair-strong, var(--border-default));
  border-radius: 10px;
  overflow: hidden;
}
.seg button {
  font: inherit;
  font-size: 14px;
  padding: 8px 16px;
  border: 0;
  background: transparent;
  color: var(--nx-read-3, var(--text-muted));
  cursor: pointer;
}
.seg button[aria-selected="true"] {
  background: var(--nx-read-1, var(--text-primary));
  color: var(--nx-paper, var(--bg-page));
  font-weight: 600;
}

/* search + suggestions */
.sugg { position: relative; margin-top: 20px; }
.search {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--nx-surface, var(--bg-surface));
  border: 1.5px solid var(--nx-hair-strong, var(--border-default));
  border-radius: 14px;
  padding: 12px 16px;
}
.search:focus-within { border-color: var(--nx-accent, var(--accent-primary)); }
.search .ico { color: var(--nx-read-3, var(--text-muted)); font-size: 18px; }
.search input {
  flex: 1;
  min-width: 0;
  font: inherit;
  font-size: 16px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--nx-read-1, var(--text-primary));
}
.search input::placeholder { color: var(--nx-read-4, var(--text-dim)); }
.sugg-list {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 6px);
  z-index: 4;
  list-style: none;
  margin: 0;
  padding: 6px;
  background: var(--nx-surface, var(--bg-surface));
  border: 1px solid var(--nx-hair-strong, var(--border-default));
  border-radius: 14px;
  box-shadow: var(--nx-shadow-lg, 0 12px 40px rgba(0, 0, 0, 0.3));
}
.sugg-list button {
  display: flex;
  width: 100%;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  font: inherit;
  font-size: 14px;
  text-align: left;
  color: var(--nx-read-1, var(--text-primary));
  cursor: pointer;
}
.sugg-list button:hover { background: var(--nx-paper, var(--bg-hover)); }
.sugg-list small { margin-left: auto; font-size: 12px; color: var(--nx-read-3, var(--text-muted)); }

.tries { font-size: 14px; color: var(--nx-read-3, var(--text-muted)); margin: 12px 0 0; }
.tries button {
  font: inherit;
  border: 0;
  background: none;
  padding: 0;
  margin-left: 10px;
  color: var(--nx-accent-2, var(--accent-primary));
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}

/* topic list + sections */
.uc {
  display: grid;
  grid-template-columns: 190px 1fr;
  gap: 26px;
  margin-top: 26px;
  align-items: start;
}
.side {
  position: sticky;
  top: 20px;
  display: grid;
  gap: 2px;
  font-size: 15px;
}
.side .sec {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--nx-read-3, var(--text-muted));
  padding: 0 12px 8px;
}
.side button {
  display: flex;
  justify-content: space-between;
  padding: 9px 12px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  font: inherit;
  text-align: left;
  color: var(--nx-read-2, var(--text-secondary));
  cursor: pointer;
}
.side button:hover { background: var(--nx-surface, var(--bg-hover)); }
.side button.on {
  background: color-mix(in srgb, var(--nx-accent, var(--accent-primary)) 15%, transparent);
  color: var(--nx-accent-2, var(--accent-primary));
  font-weight: 600;
}
.side button span { color: var(--nx-read-3, var(--text-muted)); font-size: 13px; }
.jump {
  display: none;
  width: 100%;
  font: inherit;
  font-size: 16px;
  padding: 12px 14px;
  border: 1.5px solid var(--nx-hair-strong, var(--border-default));
  border-radius: 12px;
  background: var(--nx-surface, var(--bg-surface));
  color: var(--nx-read-1, var(--text-primary));
  margin-top: 18px;
}
.count { margin: 0 0 14px; font-size: 14px; color: var(--nx-read-3, var(--text-muted)); }
.group { margin-bottom: 34px; scroll-margin-top: 20px; }
.group h2 {
  margin: 0 0 4px;
  font-family: var(--font-body, system-ui, sans-serif);
  font-size: 20px;
  font-weight: 700;
  color: var(--nx-read-1, var(--text-primary));
}
.group > p { margin: 0 0 14px; font-size: 14px; color: var(--nx-read-3, var(--text-muted)); }
.pkgs { display: grid; gap: 12px; }

/* installed */
.installed-list { margin-top: 20px; }
.inst {
  display: grid;
  grid-template-columns: 52px 1fr auto;
  gap: 16px;
  align-items: center;
  background: var(--nx-surface, var(--bg-surface));
  border: 1px solid var(--nx-hair-strong, var(--border-default));
  border-radius: 16px;
  padding: 18px 20px;
}
.inst .pkg-ic {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: var(--nx-paper, var(--bg-page));
  display: grid;
  place-items: center;
  font-size: 26px;
}
.inst h3 { margin: 0 0 2px; font-size: 17px; font-weight: 600; }
.inst p { margin: 0; font-size: 14px; color: var(--nx-read-3, var(--text-muted)); }
.inst-act { display: flex; gap: 8px; }
.ghost-btn {
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid var(--nx-hair-strong, var(--border-default));
  background: transparent;
  color: var(--nx-read-2, var(--text-secondary));
  cursor: pointer;
}
.ghost-btn:hover:not(:disabled) { border-color: var(--nx-accent, var(--accent-primary)); }
.ghost-btn:disabled { opacity: 0.6; cursor: progress; }

/* states */
.empty-state {
  margin-top: 26px;
  padding: 40px 28px;
  text-align: center;
  border: 1.5px dashed var(--nx-hair-strong, var(--border-default));
  border-radius: 16px;
}
.empty-state h2 { margin: 0 0 8px; font-size: 20px; font-weight: 700; }
.empty-state p { margin: 0 auto; max-width: 520px; font-size: 14px; line-height: 1.6; color: var(--nx-read-3, var(--text-muted)); }
.empty { padding: 18px 0; font-size: 14px; color: var(--nx-read-3, var(--text-muted)); }
.note { margin-top: 26px; font-size: 14px; color: var(--nx-read-3, var(--text-muted)); }
.note.error p { color: var(--nx-danger, var(--text-error)); }
.link-btn {
  font: inherit;
  font-size: 14px;
  border: 0;
  background: none;
  padding: 0;
  margin-top: 12px;
  color: var(--nx-accent-2, var(--accent-primary));
  cursor: pointer;
}
.signin-gate { max-width: 640px; margin: 8px auto 0; }

@container packages (max-width: 760px) {
  .uc { grid-template-columns: 1fr; gap: 0; }
  .side { display: none; }
  .jump { display: block; }
  .inst { grid-template-columns: 44px 1fr; }
  .inst .pkg-ic { width: 44px; height: 44px; font-size: 22px; }
  .inst-act { grid-column: 2; }
}
</style>
