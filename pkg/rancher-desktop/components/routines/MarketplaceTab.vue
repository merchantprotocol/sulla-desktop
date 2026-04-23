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

        <!-- Top-level view switch. "Browse" keeps the current
           community-feed experience; "My Submissions" swaps the content
           column for the signed-in user's own publishes, with status and
           takedown controls. Kind + Sort only apply to Browse, so those
           sections collapse when Submissions is active. -->
        <div class="rail-section">
          <div class="rail-label">
            View
          </div>
          <nav class="rail-nav">
            <button
              type="button"
              class="rail-item plain"
              :class="{ on: view === 'browse' }"
              @click="setView('browse')"
            >
              <span class="label">Browse</span>
            </button>
            <button
              type="button"
              class="rail-item plain"
              :class="{ on: view === 'submissions' }"
              @click="setView('submissions')"
            >
              <span class="label">My Submissions</span>
              <span
                v-if="view === 'submissions' && submissionsTotal > 0"
                class="rail-count"
              >{{ submissionsTotal }}</span>
            </button>
          </nav>
        </div>

        <template v-if="view === 'browse'">
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
                  `kind-${k.value}`,
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
        </template>

        <div class="rail-footer">
          <p v-if="view === 'browse'">
            Signed-in browse — installs land in your Library.
          </p>
          <p v-else>
            Every routine, skill, function and recipe you've submitted.
            Status updates arrive from the reviewers.
          </p>
        </div>
      </aside>

      <!-- Main content — Browse -->
      <section
        v-if="view === 'browse'"
        class="content"
      >
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

      <!-- Main content — My Submissions -->
      <section
        v-else
        class="content"
      >
        <div class="content-head">
          <h3>My Submissions</h3>
          <button
            type="button"
            class="btn ghost"
            :disabled="submissionsLoading"
            @click="loadSubmissions"
          >
            {{ submissionsLoading ? 'Refreshing…' : 'Refresh' }}
          </button>
        </div>

        <div
          v-if="submissionsError"
          class="banner err"
        >
          <strong>{{ submissionsErrorTitle }}</strong>
          <p>{{ submissionsError }}</p>
          <button
            type="button"
            class="btn ghost"
            @click="loadSubmissions"
          >
            Retry
          </button>
        </div>

        <div
          v-else-if="submissionsLoading && submissions.length === 0"
          class="status"
        >
          Loading your submissions…
        </div>

        <div
          v-else-if="submissions.length === 0"
          class="status"
        >
          You haven't published anything yet. Publish a routine from the
          canvas and it'll show up here with its review status.
        </div>

        <template v-else>
          <article
            v-for="s in submissions"
            :key="s.id"
            class="submission-row"
          >
            <div class="sub-main">
              <div class="sub-title">
                <span
                  class="kind-pill"
                  :class="`kind-${s.kind}`"
                >{{ s.kind }}</span>
                <span class="sub-name">{{ s.name }}</span>
                <span class="sub-version">v{{ s.version }}</span>
              </div>
              <div
                v-if="s.description"
                class="sub-desc"
              >
                {{ s.description }}
              </div>
              <div class="sub-meta">
                <span
                  class="status-pill"
                  :class="`status-${s.status}`"
                >
                  <span class="dot" />
                  {{ STATUS_LABELS[s.status] }}
                </span>
                <span
                  class="status-pill bundle"
                  :class="`bundle-${s.bundle_status}`"
                >Bundle: {{ s.bundle_status }}</span>
                <span
                  v-if="typeof s.download_count === 'number' && s.status === 'approved'"
                  class="meta-item"
                >⬇ {{ s.download_count }}</span>
                <span class="meta-item subtle">Submitted {{ formatRelative(s.created_at) }}</span>
                <span
                  v-if="s.reviewed_at"
                  class="meta-item subtle"
                >Reviewed {{ formatRelative(s.reviewed_at) }}</span>
              </div>
              <div
                v-if="s.admin_notes"
                class="sub-notes"
              >
                <strong>Reviewer notes:</strong> {{ s.admin_notes }}
              </div>
            </div>
            <div class="sub-actions">
              <button
                type="button"
                class="btn ghost"
                @click="onOpen(s.id)"
              >
                View
              </button>
              <button
                type="button"
                class="btn danger"
                :disabled="takingDownId === s.id"
                @click="confirmTakedown(s)"
              >
                {{ takingDownId === s.id ? 'Removing…' : (s.status === 'approved' ? 'Take down' : 'Delete') }}
              </button>
            </div>
          </article>

          <div
            v-if="submissionsTotalPages > 1"
            class="pagination"
          >
            <button
              type="button"
              class="btn ghost"
              :disabled="submissionsPage <= 1 || submissionsLoading"
              @click="setSubmissionsPage(submissionsPage - 1)"
            >
              ← Prev
            </button>
            <span class="page-label">Page {{ submissionsPage }} of {{ submissionsTotalPages }}</span>
            <button
              type="button"
              class="btn ghost"
              :disabled="submissionsPage >= submissionsTotalPages || submissionsLoading"
              @click="setSubmissionsPage(submissionsPage + 1)"
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
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type SortValue = MarketplaceSort;

const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'routine', label: 'Routines' },
  { value: 'skill', label: 'Skills' },
  { value: 'function', label: 'Functions' },
  { value: 'recipe', label: 'Recipes' },
];

const SORT_OPTIONS: { value: SortValue; label: string }[] = [
  { value: 'popular', label: 'Popular' },
  { value: 'newest', label: 'Newest' },
  { value: 'featured', label: 'Featured' },
];

// User-visible strings for the review statuses the server emits. Keep
// the internal values untouched ("rejected" is what the DB uses, even
// though the UI reads it as "Not accepted" in most cases).
const STATUS_LABELS: Record<'pending' | 'approved' | 'rejected', string> = {
  pending:  'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
};

interface SubmissionRow {
  id:              string;
  kind:            'routine' | 'skill' | 'function' | 'recipe';
  slug:            string;
  name:            string;
  description?:    string | null;
  version:         string;
  status:          'pending' | 'approved' | 'rejected';
  bundle_status:   'pending' | 'uploaded' | 'missing';
  download_count?: number;
  admin_notes?:    string | null;
  reviewed_at?:    string | null;
  created_at:      string;
  updated_at:      string;
}

const mp = useMarketplace();
const searchDraft = ref('');

// ── My Submissions state ──
const view = ref<'browse' | 'submissions'>('browse');
const submissions = ref<SubmissionRow[]>([]);
const submissionsTotal = ref(0);
const submissionsPage = ref(1);
const SUBMISSIONS_LIMIT = 25;
const submissionsLoading = ref(false);
const submissionsError = ref<string | null>(null);
// Banner copy differs depending on which call failed — the error body is
// the same slot, but "Couldn't load your submissions" is wrong when the
// failure came from a takedown (row list loaded fine).
const submissionsErrorTitle = ref('Couldn\'t load your submissions');
const takingDownId = ref<string | null>(null);

const submissionsTotalPages = computed(() => {
  if (submissionsTotal.value === 0) return 1;
  return Math.max(1, Math.ceil(submissionsTotal.value / SUBMISSIONS_LIMIT));
});

const emit = defineEmits<(e: 'installed', info: { kind: string; slug: string; path: string; name: string }) => void>();

const showingDetail = computed(() => !!mp.detail.value || mp.detailLoading.value);

const headingLabel = computed(() => {
  const kind = KIND_OPTIONS.find(k => k.value === mp.kind.value);

  return kind?.value === 'all' ? 'All kinds' : kind?.label ?? 'Marketplace';
});

const installedForOpenDrawer = computed(() => {
  if (!mp.detail.value || !mp.lastInstalled.value) return null;

  return mp.lastInstalled.value;
});

onMounted(() => { void mp.load() });

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

// ── My Submissions ──
// Lazy-loaded the first time the user switches to the Submissions view,
// and again on every explicit refresh / page change. Kept local to this
// component for now — if "My Submissions" grows a detail view or gets
// shared with another page, lift into a composable.
async function loadSubmissions() {
  submissionsLoading.value = true;
  submissionsError.value = null;
  submissionsErrorTitle.value = 'Couldn\'t load your submissions';
  try {
    const res = await ipcRenderer.invoke('marketplace-my-submissions', {
      page:  submissionsPage.value,
      limit: SUBMISSIONS_LIMIT,
    }) as { templates: SubmissionRow[]; total: number; page: number; limit: number } | { error: string };

    if ('error' in res) {
      submissionsError.value = res.error;
      submissions.value = [];
      submissionsTotal.value = 0;
      return;
    }

    submissions.value = res.templates ?? [];
    submissionsTotal.value = res.total ?? 0;
  } catch (err) {
    submissionsError.value = err instanceof Error ? err.message : String(err);
    submissions.value = [];
    submissionsTotal.value = 0;
  } finally {
    submissionsLoading.value = false;
  }
}

function setView(next: 'browse' | 'submissions') {
  if (view.value === next) return;
  view.value = next;
  if (next === 'submissions') {
    // Load on entry — the list is scoped to the caller and small (the
    // marketplace won't surface thousands of personal submissions), so
    // refetching each time keeps status freshness without needing
    // server-side push.
    void loadSubmissions();
  }
}

function setSubmissionsPage(nextPage: number) {
  if (nextPage < 1 || nextPage > submissionsTotalPages.value) return;
  submissionsPage.value = nextPage;
  void loadSubmissions();
}

async function confirmTakedown(s: SubmissionRow) {
  // Hard-delete vs soft-withdraw depends on status — server decides,
  // we just surface that decision in the confirm copy so the user
  // isn't surprised afterwards.
  const isApproved = s.status === 'approved';
  const ok = window.confirm(
    isApproved
      ? `Take "${ s.name }" v${ s.version } off the marketplace?\n\nThe bundle will be removed and the listing won't be downloadable. The row stays in your history so you can see what you've withdrawn.`
      : `Delete "${ s.name }" v${ s.version } submission?\n\nIt's still in review — this will remove it completely.`,
  );
  if (!ok) return;

  takingDownId.value = s.id;
  try {
    const res = await ipcRenderer.invoke('marketplace-takedown', s.id) as
      | { success: true; action: 'deleted' | 'withdrawn' }
      | { error: string };

    if ('error' in res) {
      submissionsErrorTitle.value = 'Couldn\'t take down that submission';
      submissionsError.value = res.error;
      return;
    }

    // Refresh from the server so the row's new state (withdrawn → shows
    // as rejected) is authoritative. If this was the last row on the
    // page, stepping back prevents showing an empty page.
    if (submissions.value.length === 1 && submissionsPage.value > 1) {
      submissionsPage.value -= 1;
    }
    await loadSubmissions();
  } catch (err) {
    submissionsErrorTitle.value = 'Couldn\'t take down that submission';
    submissionsError.value = err instanceof Error ? err.message : String(err);
  } finally {
    takingDownId.value = null;
  }
}

/**
 * Short relative timestamp for the meta row. Formatted here (not in the
 * template) so we can return a graceful "—" for malformed inputs instead
 * of rendering "Invalid Date". Not i18n-aware — matches the rest of the
 * marketplace UI for now.
 */
function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${ mins }m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${ hrs }h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${ days }d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${ months }mo ago`;
  const years = Math.round(days / 365);
  return `${ years }y ago`;
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

// ── My Submissions list ──
.rail-count {
  justify-self: end;
  margin-left: auto;
  padding: 0 6px;
  min-width: 18px;
  text-align: center;
  background: rgba(80, 150, 179, 0.18);
  border: 1px solid rgba(80, 150, 179, 0.55);
  border-radius: 8px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--steel-200);
}

.btn.danger {
  background: rgba(244, 63, 94, 0.12);
  border-color: rgba(244, 63, 94, 0.45);
  color: #fda4af;
}
.btn.danger:hover:not(:disabled) {
  background: rgba(244, 63, 94, 0.22);
  border-color: rgba(244, 63, 94, 0.7);
  color: #fff;
}

.submission-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 14px;
  align-items: center;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: rgba(10, 18, 36, 0.35);
  margin-bottom: 8px;
}
.submission-row + .submission-row { margin-top: 0; }

.sub-main { min-width: 0; }

.sub-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.sub-name {
  font-family: var(--sans);
  font-size: 14.5px;
  font-weight: 600;
  color: white;
}
.sub-version {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--steel-400);
  letter-spacing: 0.06em;
}

.kind-pill {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 3px;
  color: white;
  background: rgba(74, 111, 165, 0.6);
}
.kind-pill.kind-routine  { background: rgba(74, 111, 165, 0.6); }
.kind-pill.kind-skill    { background: rgba(245, 158, 11, 0.55); }
.kind-pill.kind-function { background: rgba(6, 182, 212, 0.55); }
.kind-pill.kind-recipe   { background: rgba(192, 38, 211, 0.55); }

.sub-desc {
  margin-top: 6px;
  font-family: var(--sans);
  font-size: 12.5px;
  color: var(--steel-200);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.sub-meta {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--steel-300);
}
.sub-meta .meta-item.subtle { color: var(--steel-400); }

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.status-pill .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.status-pill.status-pending  { background: rgba(245, 158, 11, 0.12); border-color: rgba(245, 158, 11, 0.4); color: #fbbf24; }
.status-pill.status-pending  .dot { background: #fbbf24; }
.status-pill.status-approved { background: rgba(52, 160, 110, 0.14); border-color: rgba(52, 160, 110, 0.45); color: #86efac; }
.status-pill.status-approved .dot { background: #4ade80; }
.status-pill.status-rejected { background: rgba(244, 63, 94, 0.12); border-color: rgba(244, 63, 94, 0.45); color: #fda4af; }
.status-pill.status-rejected .dot { background: #f87171; }
.status-pill.bundle {
  background: rgba(140, 172, 210, 0.08);
  border-color: rgba(140, 172, 210, 0.25);
  color: var(--steel-300);
}

.sub-notes {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 4px;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.2);
  font-family: var(--sans);
  font-size: 12px;
  color: var(--steel-100);
  line-height: 1.5;
}
.sub-notes strong { color: #fbbf24; font-weight: 600; }

.sub-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-self: start;
}
</style>
