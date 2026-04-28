<template>
  <div class="routines-home">
    <!-- Inline action feedback. Fixed to viewport so it's visible from
         any scroll position. Success/info auto-fade after 3.2s; errors
         stick until dismissed or replaced by the next action. -->
    <Transition name="feedback">
      <div
        v-if="feedback"
        :key="feedback.id"
        class="feedback-toast"
        :class="`feedback-${feedback.kind}`"
        role="status"
      >
        <span class="feedback-dot" />
        <span class="feedback-msg">{{ feedback.message }}</span>
        <button
          v-if="feedback.kind === 'error'"
          type="button"
          class="feedback-close"
          aria-label="Dismiss"
          @click="dismissFeedback"
        >
          ×
        </button>
      </div>
    </Transition>

    <!-- Scrollable canvas — atmosphere and ribbon live INSIDE this
         container so they scroll with the page. Blue glow sits at the
         top of the document, violet at the bottom; brackets frame the
         document's corners. Nothing here is viewport-fixed. -->
    <div class="scroll-area">
      <div class="canvas">
        <div class="glow blue" />
        <div class="glow violet" />
        <div class="stars" />
        <div class="bracket tl" />
        <div class="bracket tr" />
        <div class="bracket bl" />
        <div class="bracket br" />

        <div class="shell">
      <!-- top: brand + two tabs -->
      <div class="topline">
        <div class="brand">
          <div class="brand-mark">
            S
          </div>
          <div>
            <div class="brand-name">
              Sulla Studio
            </div>
            <div class="brand-sub">
              Agent assets + marketplace
            </div>
          </div>
        </div>
        <nav class="tabs">
          <button
            type="button"
            class="tab"
            :class="{ on: activeTab === 'mywork' }"
            @click="activeTab = 'mywork'"
          >
            My Work
            <span class="tab-num">{{ routinesController.routines.value.length }}</span>
          </button>
          <button
            type="button"
            class="tab"
            :class="{ on: activeTab === 'library' }"
            @click="activeTab = 'library'"
          >
            Library
            <span class="tab-num">{{ totalLibraryCount }}</span>
          </button>
          <button
            type="button"
            class="tab"
            :class="{ on: activeTab === 'marketplace' }"
            @click="activeTab = 'marketplace'"
          >
            Marketplace
          </button>
          <button
            type="button"
            class="tab import-btn"
            :title="'Import a .routine.zip or a routine folder'"
            @click="onImport"
          >
            + Import
          </button>
        </nav>
      </div>

      <!-- hero -->
      <div class="hero">
        <div class="kicker">
          <span class="d" />{{ heroKicker }}
        </div>
        <h1>{{ heroTitle }}</h1>
        <div class="dek">
          {{ heroDek }}
        </div>
        <div
          v-if="activeTab === 'mywork' && myWorkView === 'active' && routinesController.routines.value.length > 0"
          class="rollup-row"
        >
          <div>
            <b>{{ routinesController.stats.value.runs }}</b>runs this week
          </div>
          <div>
            <b>{{ routinesController.stats.value.artifacts }}</b>artifacts
          </div>
          <div>
            <b>{{ routinesController.stats.value.reclaimed }}</b>reclaimed
          </div>
          <div>
            <b>{{ routinesController.stats.value.spend }}</b>compute
          </div>
        </div>
      </div>

      <!-- ═══════ MY WORK TAB ═══════ -->
      <template v-if="activeTab === 'mywork'">
        <!-- sub-view toggle: Active routines vs. Archive -->
        <div class="subtabs">
          <button
            type="button"
            class="subtab"
            :class="{ on: myWorkView === 'active' }"
            @click="myWorkView = 'active'"
          >
            Active
            <span class="subtab-num">{{ routinesController.routines.value.length }}</span>
          </button>
          <button
            type="button"
            class="subtab"
            :class="{ on: myWorkView === 'archive' }"
            @click="myWorkView = 'archive'"
          >
            Archive
            <span class="subtab-num">{{ routinesController.archived.value.length }}</span>
          </button>
        </div>
      </template>

      <!-- ═══════ MY WORK → ACTIVE ═══════ -->
      <template v-if="activeTab === 'mywork' && myWorkView === 'active'">
        <!-- Booting state — the app shell repaints tabs from localStorage
             before the Electron backend is up. Show a benign "warming up"
             message instead of blowing up with a DB connection error. -->
        <EmptyState
          v-if="routinesController.isEmpty.value"
          kicker="No routines yet"
          title="Your stage is empty."
          message="You haven't built a routine yet. Start from a template — some are waiting in your Library — or compose one from scratch on the canvas."
        >
          <button
            type="button"
            class="btn primary"
            @click="activeTab = 'library'"
          >
            Browse your library →
          </button>
          <button
            type="button"
            class="btn"
            @click="onNewBlank"
          >
            ＋ Start blank
          </button>
        </EmptyState>

        <!-- populated: grouped acts -->
        <template v-else>
          <ActSection
            v-if="routinesController.running.value.length"
            act-num="Act I"
            title="Running now"
            :count-label="runningCountLabel"
          >
            <RoutineStrip
              v-for="r in routinesController.running.value"
              :key="r.id"
              :routine="r"
              primary-label="Open"
              secondary-label="Watch"
              @primary="onOpenRoutine(r.id)"
              @open="onOpenRoutine(r.id)"
              @publish="onPublishRoutine(r)"
              @duplicate="onDuplicate(r.id)"
              @archive="onToggleArchive(r.id)"
              @export="onExport(r.id)"
              @delete="onDelete(r)"
            />
          </ActSection>

          <ActSection
            v-if="routinesController.scheduled.value.length"
            act-num="Act II"
            title="On the schedule"
            :count-label="scheduledCountLabel"
          >
            <RoutineStrip
              v-for="r in routinesController.scheduled.value"
              :key="r.id"
              :routine="r"
              primary-label="Open"
              secondary-label="Skip next"
              @primary="onOpenRoutine(r.id)"
              @open="onOpenRoutine(r.id)"
              @publish="onPublishRoutine(r)"
              @duplicate="onDuplicate(r.id)"
              @archive="onToggleArchive(r.id)"
              @export="onExport(r.id)"
              @delete="onDelete(r)"
            />
          </ActSection>

          <ActSection
            v-if="routinesController.idle.value.length"
            act-num="Act III"
            title="In the wings"
            count-label="Idle, drafts, archived"
          >
            <RoutineStrip
              v-for="r in routinesController.idle.value"
              :key="r.id"
              :routine="r"
              :primary-label="r.status === 'draft' ? 'Publish' : 'Run'"
              secondary-label="Edit"
              @primary="r.status === 'draft' ? onPublishAndRun(r.id) : onOpenRoutine(r.id)"
              @secondary="onEditRoutine(r.id)"
              @open="onOpenRoutine(r.id)"
              @publish="onPublishRoutine(r)"
              @duplicate="onDuplicate(r.id)"
              @archive="onToggleArchive(r.id)"
              @export="onExport(r.id)"
              @delete="onDelete(r)"
            />
          </ActSection>

          <div class="closer">
            <button
              type="button"
              class="btn accent large"
              @click="onNewBlank"
            >
              ＋ Write a new routine
            </button>
            <div class="closer-sub">
              Start blank · or borrow from {{ templatesController.templates.value.length }} template{{ templatesController.templates.value.length === 1 ? '' : 's' }}
            </div>
          </div>
        </template>
      </template>

      <!-- ═══════ MY WORK → ARCHIVE ═══════ -->
      <template v-else-if="activeTab === 'mywork' && myWorkView === 'archive'">
        <EmptyState
          v-if="routinesController.archived.value.length === 0"
          kicker="The vault is empty"
          title="Nothing archived."
          message="No archived routines. When you archive one from Active, it lands here."
        >
          <button
            type="button"
            class="btn primary"
            @click="myWorkView = 'active'"
          >
            ← Back to Active
          </button>
        </EmptyState>

        <template v-else>
          <ActSection
            act-num="Vault"
            title="Archived routines"
            :count-label="archivedCountLabel"
          >
            <RoutineStrip
              v-for="r in routinesController.archived.value"
              :key="r.id"
              :routine="r"
              primary-label="Restore"
              secondary-label="Open"
              @primary="onRestoreRoutine(r.id)"
              @secondary="onEditRoutine(r.id)"
              @open="onEditRoutine(r.id)"
              @publish="onPublishRoutine(r)"
              @duplicate="onDuplicate(r.id)"
              @archive="onToggleArchive(r.id)"
              @export="onExport(r.id)"
              @delete="onDelete(r)"
            />
          </ActSection>

          <div class="closer">
            <div class="closer-sub">
              Archived routines stay in the database — restore any of them and they return to Active.
            </div>
          </div>
        </template>
      </template>

      <!-- ═══════ LIBRARY TAB ═══════ -->
      <template v-else-if="activeTab === 'library'">
        <LibraryTab
          @use-template="onUseTemplate"
        />
      </template>

      <!-- ═══════ MARKETPLACE TAB ═══════ -->
      <template v-else-if="activeTab === 'marketplace'">
        <MarketplaceTab
          @installed="onMarketplaceInstalled"
        />
      </template>
        </div>

        <!-- ribbon footer — sits in normal flow at the end of the canvas
             so it reads as "end of document" rather than a sticky bar. -->
        <div class="ribbon">
          <div class="l">
            <span>Studio</span>
            <span class="tc">{{ ribbonStatusLabel }}</span>
          </div>
          <div class="c">
            <div class="mark">
              A Sulla Original
            </div>
            <div class="sig">
              Made entirely by <b>agents</b>.
            </div>
          </div>
          <div class="r">
            Opus 4.7 · compiled {{ todayStr }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import ActSection from '@pkg/components/routines/ActSection.vue';
import EmptyState from '@pkg/components/routines/EmptyState.vue';
import LibraryTab from '@pkg/components/routines/LibraryTab.vue';
import MarketplaceTab from '@pkg/components/routines/MarketplaceTab.vue';
import RoutineStrip from '@pkg/components/routines/RoutineStrip.vue';
import { useLibrary } from '@pkg/composables/useLibrary';
import { useRoutines } from '@pkg/composables/useRoutines';
import { useTemplates } from '@pkg/composables/useTemplates';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import { useStartupProgress } from './agent/useStartupProgress';

type Tab = 'mywork' | 'library' | 'marketplace';
type MyWorkView = 'active' | 'archive';

const props = withDefaults(defineProps<{
  initialTab?: Tab;
}>(), { initialTab: 'mywork' });

const emit = defineEmits<{
  (e: 'open-workflow', id: string, mode?: 'edit' | 'run'): void
  (e: 'use-template', slug: string): void
  (e: 'new-blank'): void
  (e: 'restore-routine', id: string): void
}>();

const activeTab = ref<Tab>(props.initialTab);
const myWorkView = ref<MyWorkView>('active');

// Watch for external navigation (e.g., clicking Library in ModeRail)
watch(() => props.initialTab, (newTab) => {
  if (newTab && newTab !== activeTab.value) {
    activeTab.value = newTab;
  }
});

// Composables = the controller layer. The view only reads their reactive
// state and forwards user intents back to them or up to the parent.
const routinesController = useRoutines();
const templatesController = useTemplates();

// Total count across all four library kinds — shown on the Library tab button.
// `useLibrary()` is a module-scoped singleton; calling it here mounts the
// same store the Library tab uses, and `loadAll()` hydrates all four kinds
// so the badge reflects reality even before the user ever clicks in. The
// call is idempotent — if the Library tab already loaded, this is a no-op.
const libraryStore = useLibrary();
const totalLibraryCount = computed(() => libraryStore.totalCount.value);

// The playbill can't query Postgres until the backend has booted — the
// tab is restored from localStorage on first paint, which regularly
// beats the Electron main-process bring-up. Gate the initial load on
// `systemReady` and reload automatically the moment it flips true, so
// the first real render gets real data instead of an ECONNREFUSED.
const { systemReady } = useStartupProgress();

async function loadAll() {
  await Promise.all([
    routinesController.load(),
    templatesController.load(),
    // Hydrate every library kind so the Studio tab badge shows the true
    // total across routines/skills/functions/recipes without waiting for
    // the user to open the Library tab first. Singleton store — second
    // caller (LibraryTab) gets the same cached counts.
    libraryStore.loadAll(),
  ]);
}

onMounted(() => {
  if (systemReady.value) {
    void loadAll();
  }
});

// Re-fire when readiness toggles true. Handles both the first-boot race
// and any later reboot of the backend (settings reset, VM restart, etc).
watch(systemReady, (ready, prev) => {
  if (ready && !prev) void loadAll();
});

// Display-layer string derivations. Kept as computeds so the template
// never has to embed template-literal logic inline — keeps the view
// terse and lets the eslint style rules stay strict.

// Hero kicker shifts with the active tab. Playbill-adjacent phrasing,
// but contextual so the three tabs feel like different places.
const heroKicker = computed(() => {
  switch (activeTab.value) {
  case 'mywork':
    return myWorkView.value === 'archive' ? 'The Vault' : 'The Cast';
  case 'library':     return 'The Library';
  case 'marketplace': return 'The Commons';
  default:            return 'The Studio';
  }
});

const heroTitle = computed(() => {
  switch (activeTab.value) {
  case 'mywork':      return myWorkView.value === 'archive' ? 'Archive.' : 'My Work.';
  case 'library':     return 'Library.';
  case 'marketplace': return 'Marketplace.';
  default:            return 'Studio.';
  }
});

const heroDek = computed(() => {
  const count = routinesController.routines.value.length;
  if (activeTab.value === 'mywork') {
    if (myWorkView.value === 'archive') {
      return 'Archived routines preserved from the active set. Restore them any time.';
    }
    if (count === 0) {
      return 'Nothing running, nothing scheduled, nothing idle. Start from a template in your Library, or compose something new from the canvas.';
    }
    const plural = count === 1 ? '' : 's';
    const reclaimed = routinesController.stats.value.reclaimed;

    return `${ count } routine${ plural }. ${ reclaimed } of human-equivalent work reclaimed this week. Each one a small constellation of agents, rehearsed until they run without you.`;
  }
  if (activeTab.value === 'library') {
    return 'Your collected routines, skills, functions, and recipes. Everything installed from the marketplace or added by hand lives here.';
  }
  if (activeTab.value === 'marketplace') {
    return 'Routines, skills, functions, and recipes the community has published. Install one and it drops straight into your Library — reviewed before it lands here.';
  }

  return 'Four kinds, one home.';
});

const runningCountLabel = computed(() => {
  const n = routinesController.running.value.length;

  return `${ n } routine${ n === 1 ? '' : 's' } live`;
});

const scheduledCountLabel = computed(() => `${ routinesController.scheduled.value.length } upcoming`);

const archivedCountLabel = computed(() => {
  const n = routinesController.archived.value.length;

  return `${ n } routine${ n === 1 ? '' : 's' } archived`;
});

const ribbonStatusLabel = computed(() => {
  switch (activeTab.value) {
  case 'marketplace':
    return 'Browsing Sulla Cloud';
  case 'library':
    return `${ templatesController.templates.value.length } templates on disk`;
  case 'mywork':
    return myWorkView.value === 'archive'
      ? `${ routinesController.archived.value.length } archived`
      : `${ routinesController.routines.value.length } in database`;
  default:
    return '';
  }
});

const todayStr = new Date().toISOString().slice(0, 10);

// ── Inline feedback toast ───────────────────────────────────────────
// Replaces native alerts for action outcomes. Success/info fade after
// ~3s; errors stick until dismissed or replaced so the user actually
// reads them. One toast at a time — a new one overwrites the previous.
type FeedbackKind = 'success' | 'error' | 'info';
const feedback = ref<{ kind: FeedbackKind; message: string; id: number } | null>(null);
let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
let feedbackIdSeq = 0;

function showFeedback(kind: FeedbackKind, message: string) {
  if (feedbackTimer) {
    clearTimeout(feedbackTimer);
    feedbackTimer = null;
  }
  feedback.value = { kind, message, id: ++feedbackIdSeq };
  if (kind !== 'error') {
    feedbackTimer = setTimeout(() => {
      feedback.value = null;
      feedbackTimer = null;
    }, 3200);
  }
}

function dismissFeedback() {
  if (feedbackTimer) {
    clearTimeout(feedbackTimer);
    feedbackTimer = null;
  }
  feedback.value = null;
}

function onOpenRoutine(id: string) {
  emit('open-workflow', id, 'run');
}
function onEditRoutine(id: string) {
  emit('open-workflow', id, 'edit');
}
async function onPublishAndRun(id: string) {
  try {
    await ipcRenderer.invoke('workflow-move', id, 'production');
    await routinesController.load();
  } catch (err) {
    console.error('[RoutinesHome] publish failed:', err);
  }
  emit('open-workflow', id, 'run');
}
function onUseTemplate(slug: string) {
  emit('use-template', slug);
}
function onNewBlank() {
  emit('new-blank');
}
async function onDuplicate(id: string) {
  await routinesController.duplicate(id);
}

async function onToggleArchive(id: string) {
  await routinesController.toggleArchive(id);
}

async function onDelete(routine: { id: string; name: string }) {
  // Destructive and permanent — confirm explicitly. Native confirm is
  // ugly but bounded and won't surprise anyone; a prettier modal is a
  // later polish pass.
  const ok = window.confirm(
    `Delete "${ routine.name }" permanently? This can't be undone.`,
  );
  if (!ok) return;
  const removed = await routinesController.remove(routine.id);
  if (removed) {
    showFeedback('success', `Deleted "${ routine.name }".`);
  } else {
    const err = routinesController.error.value;
    showFeedback('error', `Couldn't delete "${ routine.name }"${ err ? `: ${ err }` : '.' }`);
  }
}

// Publish a routine to the marketplace. The main process checks the user's
// Sulla Cloud session; if they aren't signed in, we surface a prompt so
// they can authenticate instead of silently failing. Native confirm/alert
// keeps the flow bounded — a custom modal can come later.
async function onPublishRoutine(routine: { id: string; name: string }) {
  const ok = window.confirm(
    `Publish "${ routine.name }" to the Sulla Marketplace? It'll land in review as a pending submission.`,
  );
  if (!ok) return;
  try {
    const result = await ipcRenderer.invoke('routines-publish-to-marketplace' as any, routine.id);
    if (result?.needs_auth) {
      showFeedback('error', 'Sign in to Sulla Cloud first (My Account → Sign in), then try again.');
      return;
    }
    if (result?.error) {
      showFeedback('error', `Publish failed: ${ result.error }`);
      return;
    }
    showFeedback(
      'success',
      `"${ routine.name }" submitted for review (status: ${ result.status ?? 'pending' }).`,
    );
  } catch (err) {
    console.error('[RoutinesHome] publish failed:', err);
    showFeedback('error', `Publish failed: ${ err instanceof Error ? err.message : String(err) }`);
  }
}

// Archive tab uses its own "Restore" affordance. Restoring just flips
// archive → draft via the existing toggleArchive action.
async function onRestoreRoutine(id: string) {
  await routinesController.toggleArchive(id);
  emit('restore-routine', id);
}

// When the marketplace tab installs something, refresh the relevant
// local view so the user sees it land. Routines become templates; skills
// + functions don't have tabs here today so the refresh is a no-op for
// them (the filesystem scan runs next time the consuming surface opens).
async function onMarketplaceInstalled(info: { kind: string; slug: string; path: string; name: string }) {
  if (info.kind === 'routine') {
    await templatesController.load();
  }
}

async function onExport(id: string) {
  // Fires the native save dialog in the main process; surfaces any
  // failure through the inline toast so the view stays consistent with
  // other IPC failure paths.
  try {
    await ipcRenderer.invoke('routines-export', id);
    showFeedback('success', 'Export saved.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Routines] Export failed:', err);
    showFeedback('error', `Export failed: ${ msg }`);
  }
}

async function onImport() {
  try {
    const result = await ipcRenderer.invoke('routines-import') as any;
    if (result?.canceled) return;
    if (result?.error) {
      window.alert(`Import failed: ${ result.error }`);

      return;
    }
    // Refresh the templates view so the newly-landed folder shows up.
    await templatesController.load();
    // Switch to the library tab so the user sees the new card.
    activeTab.value = 'library';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Routines] Import failed:', err);
    window.alert(`Import failed: ${ msg }`);
  }
}
</script>

<style scoped lang="scss">
@import '@pkg/assets/styles/routines-theme.scss';

.routines-home {
  @include routines-theme-vars;

  // Outer frame fills whatever the parent gives us (BrowserTab body).
  // It clips the ambient glows (which extend past the edges) and pins
  // the brackets + ribbon to its own edges. Content scrolls in the
  // inner .scroll-area, not here.
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  color: var(--text);
  background: linear-gradient(135deg, #03060c 0%, #070d1a 60%, #01030a 100%);
  font-family: var(--sans);
  -webkit-font-smoothing: antialiased;
}

.scroll-area {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

// Positioning root for the ambient layer. `min-height: 100%` keeps the
// canvas at least as tall as the viewport so glows/brackets still frame
// a short page; when content is taller, the canvas grows with it and
// the violet glow + bottom brackets land at the end of the document.
.canvas {
  position: relative;
  width: 100%;
  min-height: 100%;
}

.glow {
  position: absolute; pointer-events: none; mix-blend-mode: screen;
  z-index: 1;
  // Bloom is ~900px square — big enough to fade into the corners but
  // independent of content height so long pages don't stretch the glow.
  width: 900px; height: 900px;
}
.glow.blue {
  // Center anchored above the top-left of the document — about a third
  // of the bloom is visible inside the canvas, fading into the first
  // couple of fold heights. Scrolls out of view as the user moves down.
  top: 120px; left: 200px;
  transform: translate(-50%, -50%);
  background: radial-gradient(circle at center,
    rgba(74,111,165,0.55) 0%, rgba(74,111,165,0.34) 12%,
    rgba(74,111,165,0.18) 28%, rgba(74,111,165,0.07) 48%,
    rgba(74,111,165,0.02) 68%, transparent 88%);
}
.glow.violet {
  // Center anchored below the bottom-right of the document — only
  // becomes visible as the user scrolls down toward the ribbon.
  bottom: 120px; right: 200px;
  transform: translate(50%, 50%);
  background: radial-gradient(circle at center,
    rgba(139,92,246,0.36) 0%, rgba(139,92,246,0.22) 12%,
    rgba(139,92,246,0.12) 28%, rgba(139,92,246,0.04) 48%,
    transparent 68%);
}
.stars {
  position: absolute; inset: 0; pointer-events: none; opacity: 0.28; z-index: 1;
  background-image:
    radial-gradient(1px 1px at 12% 22%, white, transparent),
    radial-gradient(1px 1px at 38% 68%, var(--violet-300), transparent),
    radial-gradient(1px 1px at 58% 12%, white, transparent),
    radial-gradient(1px 1px at 74% 58%, white, transparent),
    radial-gradient(1px 1px at 88% 82%, var(--steel-200), transparent),
    radial-gradient(1.5px 1.5px at 7% 62%, white, transparent),
    radial-gradient(1px 1px at 66% 86%, white, transparent),
    radial-gradient(1px 1px at 22% 44%, var(--steel-300), transparent),
    radial-gradient(1px 1px at 48% 32%, white, transparent);
}
.bracket {
  position: absolute; width: 22px; height: 22px; z-index: 4;
  pointer-events: none; border-color: rgba(196,212,230,0.5);
}
.bracket.tl { top: 22px; left: 22px; border-top: 1.5px solid; border-left: 1.5px solid; }
.bracket.tr { top: 22px; right: 22px; border-top: 1.5px solid; border-right: 1.5px solid; }
// Bottom brackets sit below the ribbon footer so the ribbon reads as the
// real bottom chrome and the brackets frame the whole thing (including
// the banner bar). Offset chosen so the bracket's corner lines up with
// the canvas's bottom padding rather than the ribbon's margin.
.bracket.bl { bottom: 6px; left: 22px; border-bottom: 1.5px solid; border-left: 1.5px solid; }
.bracket.br { bottom: 6px; right: 22px; border-bottom: 1.5px solid; border-right: 1.5px solid; }

.shell {
  position: relative; z-index: 3;
  max-width: 1100px; margin: 0 auto;
  padding: 48px 64px 40px;
}

.topline {
  display: flex; justify-content: space-between; align-items: center;
  padding-bottom: 20px; border-bottom: 1px solid var(--line);
  margin-bottom: 32px;
}
.brand { display: flex; align-items: center; gap: 12px; }
.brand-mark {
  width: 34px; height: 34px; border-radius: 8px;
  background: linear-gradient(135deg, var(--steel-400), var(--steel-600));
  display: grid; place-items: center; color: white;
  font-family: var(--serif); font-size: 18px;
  box-shadow: 0 0 18px rgba(74,111,165,0.45);
}
.brand-name { font-family: var(--serif); font-size: 18px; color: white; }
.brand-sub {
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.22em;
  color: var(--steel-400); text-transform: uppercase; margin-top: 2px;
}

.tabs { display: flex; gap: 4px; }
.tab {
  padding: 9px 16px;
  background: transparent; border: 1px solid transparent;
  border-radius: 4px; cursor: pointer;
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--steel-300);
  transition: color 0.15s, background 0.15s, border-color 0.15s;
  display: inline-flex; align-items: center; gap: 8px;
}
.tab:hover { color: white; background: rgba(168,192,220,0.06); }
.tab.on {
  color: white;
  background: linear-gradient(135deg, rgba(74,111,165,0.3), rgba(44,72,113,0.2));
  border-color: rgba(140,172,201,0.5);
  box-shadow: 0 6px 20px rgba(74,111,165,0.25);
}
.tab-num {
  font-size: 9px; padding: 1px 6px; border-radius: 2px;
  background: rgba(168,192,220,0.12); color: var(--steel-300); letter-spacing: 0.06em;
}
.tab.on .tab-num { background: rgba(196,212,230,0.2); color: white; }

// Sub-tabs inside My Work — Active / Archive toggle.
.subtabs {
  display: flex;
  gap: 6px;
  margin-bottom: 20px;
}
.subtab {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  padding: 7px 14px;
  border-radius: 3px;
  border: 1px solid rgba(168, 192, 220, 0.22);
  background: transparent;
  color: var(--steel-300);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.subtab:hover { color: white; border-color: var(--steel-300); }
.subtab.on {
  color: white;
  background: rgba(74, 111, 165, 0.22);
  border-color: rgba(140, 172, 201, 0.5);
}
.subtab-num {
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 2px;
  background: rgba(168, 192, 220, 0.12);
  color: var(--steel-300);
  letter-spacing: 0.06em;
}
.subtab.on .subtab-num { background: rgba(196, 212, 230, 0.2); color: white; }

.hero {
  text-align: center;
  padding: 24px 0 40px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 40px;
}
.kicker {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.3em;
  color: var(--steel-200); text-transform: uppercase;
  display: inline-flex; align-items: center; gap: 8px;
  margin-bottom: 16px;
}
.kicker::before {
  content: ''; display: inline-block; width: 20px; height: 1px;
  background: var(--steel-300);
}
.kicker .d {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--violet-400);
  box-shadow: 0 0 8px var(--violet-400);
  animation: pulse-v 1.6s infinite;
}
@keyframes pulse-v { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

.hero h1 {
  font-family: var(--serif); font-size: 68px;
  color: white; line-height: 1; margin: 0 0 16px;
  letter-spacing: -0.02em; font-weight: 600;
}
.hero .dek {
  font-family: var(--serif); font-size: 17px;
  color: var(--steel-200); max-width: 640px; margin: 0 auto 26px;
  line-height: 1.55;
}
.rollup-row {
  display: flex; justify-content: center; gap: 0;
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.14em;
  color: var(--steel-400); text-transform: uppercase;
}
.rollup-row > div {
  padding: 0 28px; border-right: 1px solid var(--line);
  display: flex; flex-direction: column; align-items: center; gap: 4px;
}
.rollup-row > div:last-child { border-right: none; }
.rollup-row b {
  display: block; font-family: var(--serif);
  font-size: 28px; color: white; line-height: 1;
}

.btn {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; padding: 7px 14px; border-radius: 4px;
  border: 1px solid rgba(168,192,220,0.3); color: var(--steel-100);
  background: rgba(20,30,54,0.55); cursor: pointer;
  transition: background 0.18s, border-color 0.18s, color 0.18s;
  backdrop-filter: blur(6px);
  white-space: nowrap;
}
.btn:hover {
  border-color: rgba(196,212,230,0.6);
  color: white;
  background: rgba(74,111,165,0.16);
}
.btn.primary {
  border-color: rgba(140,172,201,0.6); color: white;
  background: linear-gradient(135deg, rgba(74,111,165,0.72), rgba(44,72,113,0.82));
  box-shadow: 0 8px 22px rgba(74,111,165,0.38), 0 0 14px rgba(74,111,165,0.22);
}
.btn.primary:hover {
  background: linear-gradient(135deg, rgba(90,130,185,0.9), rgba(58,90,140,0.9));
  border-color: rgba(196,212,230,0.75);
}

// Accent variant — violet. Reserved for CTAs that warrant the secondary
// brand color (e.g. "Write a new routine"), not the default action tone.
.btn.accent {
  border-color: rgba(167,139,250,0.55); color: white;
  background: linear-gradient(135deg, rgba(139,92,246,0.75), rgba(124,58,237,0.85));
  box-shadow: 0 8px 22px rgba(139,92,246,0.4), 0 0 14px rgba(139,92,246,0.25);
}
.btn.accent:hover {
  background: linear-gradient(135deg, rgba(167,139,250,0.9), rgba(139,92,246,0.95));
  border-color: rgba(221,214,254,0.75);
}
.btn.large { padding: 12px 26px; font-size: 11px; letter-spacing: 0.16em; }

.template-search {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; margin-bottom: 8px;
  // Transparent — the deep-ocean gradient shows through. Only the border
  // defines the field.
  background: transparent;
  border: 1px solid var(--line); border-radius: 6px;
  transition: border-color 0.15s, background 0.15s;
}
.template-search:focus-within {
  border-color: rgba(140,172,201,0.6);
  background: rgba(74,111,165,0.06);
  box-shadow: 0 0 0 3px rgba(74,111,165,0.14);
}
.template-search svg { color: var(--steel-400); flex-shrink: 0; }
.template-search input {
  flex: 1; border: none; outline: none; background: transparent;
  font-family: var(--sans); font-size: 13.5px; color: var(--text);
}
.template-search input::placeholder {
  color: var(--steel-400);
}
.template-count {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em;
  color: var(--steel-400); text-transform: uppercase;
  white-space: nowrap;
}

.closer {
  text-align: center;
  margin-top: 40px; padding-top: 28px;
  border-top: 1px solid var(--line);
}
.closer-sub {
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.22em;
  color: var(--steel-500); text-transform: uppercase; margin-top: 12px;
}
.closer code {
  font-family: var(--mono); font-size: 12px; padding: 1px 6px;
  background: rgba(168,192,220,0.1); border-radius: 3px;
  color: var(--steel-100); letter-spacing: 0;
}

.ribbon {
  // In-flow footer at the bottom of the canvas. Margin above separates
  // it from the last act; margin below keeps it clear of the bottom
  // brackets that now sit just outside it.
  position: relative;
  z-index: 2;
  margin: 48px 72px 56px;
  padding: 12px 18px;
  background: linear-gradient(90deg,
    rgba(20,30,54,0.25) 0%, rgba(20,30,54,0.8) 30%,
    rgba(20,30,54,0.8) 70%, rgba(20,30,54,0.25) 100%);
  border-top: 1px solid rgba(168,192,220,0.15);
  border-bottom: 1px solid rgba(168,192,220,0.15);
  display: grid; grid-template-columns: auto 1fr auto;
  gap: 20px; align-items: center;
  backdrop-filter: blur(4px);
}
.ribbon .l, .ribbon .r {
  font-family: var(--mono); font-size: 10px; color: var(--steel-300);
  letter-spacing: 0.15em; text-transform: uppercase;
  display: flex; align-items: center; gap: 10px;
}
.ribbon .l .tc, .ribbon .r b {
  color: white; font-weight: 700; letter-spacing: 0.08em;
}
.ribbon .r { justify-content: flex-end; }
.ribbon .c { text-align: center; }
.ribbon .c .mark {
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.3em;
  color: var(--steel-400); text-transform: uppercase;
}
.ribbon .c .sig {
  font-family: var(--serif); font-size: 14px; color: white;
  margin-top: 4px; line-height: 1.2;
}
.ribbon .c .sig b { color: var(--violet-300); font-weight: 700; }

// ── Inline feedback toast ─────────────────────────────────────────
// Fixed to viewport so users see it from any scroll position. Sits
// above the ribbon but below modals. Width scales with content up to
// a readable cap.
.feedback-toast {
  position: fixed;
  bottom: 32px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 280px;
  max-width: 560px;
  padding: 12px 16px;
  border-radius: 6px;
  border: 1px solid rgba(168, 192, 220, 0.25);
  background: rgba(12, 18, 32, 0.92);
  color: white;
  font-family: var(--sans);
  font-size: 13.5px;
  line-height: 1.4;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55),
              0 0 0 1px rgba(0, 0, 0, 0.2) inset;
  backdrop-filter: blur(8px);
}

.feedback-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.feedback-msg {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}

.feedback-close {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.6);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  margin-left: 4px;
}
.feedback-close:hover { color: white; }

.feedback-success {
  border-color: rgba(63, 185, 80, 0.55);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5),
              0 0 18px rgba(63, 185, 80, 0.2);
}
.feedback-success .feedback-dot {
  background: #3fb950;
  box-shadow: 0 0 8px rgba(63, 185, 80, 0.6);
}

.feedback-error {
  border-color: rgba(248, 113, 113, 0.6);
  background: rgba(40, 14, 14, 0.92);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55),
              0 0 18px rgba(248, 113, 113, 0.22);
}
.feedback-error .feedback-dot {
  background: #f87171;
  box-shadow: 0 0 8px rgba(248, 113, 113, 0.6);
}

.feedback-info {
  border-color: rgba(140, 172, 201, 0.5);
}
.feedback-info .feedback-dot {
  background: #8cacc9;
  box-shadow: 0 0 8px rgba(140, 172, 201, 0.55);
}

// Slide up + fade on enter; fade out on leave. Paired with the Vue
// Transition wrapper around the toast in the template.
.feedback-enter-active,
.feedback-leave-active {
  transition: opacity 0.24s ease, transform 0.24s ease;
}
.feedback-enter-from {
  opacity: 0;
  transform: translate(-50%, 10px);
}
.feedback-leave-to {
  opacity: 0;
  transform: translate(-50%, -4px);
}
/* Ribbon Footer — Light Mode */
.theme-nord-light .ribbon {
  background: rgba(216, 222, 233, 0.85) !important;
  border-top: 1px solid rgba(94, 129, 172, 0.3) !important;
  backdrop-filter: blur(8px) !important;
}

.theme-nord-light .ribbon .l,
.theme-nord-light .ribbon .r {
  color: #5e81ac !important;
}

.theme-nord-light .ribbon .l .tc,
.theme-nord-light .ribbon .r b {
  color: #2e3440 !important;
  font-weight: 600 !important;
}

.theme-nord-light .ribbon .c .mark {
  color: #81a1c1 !important;
}

.theme-nord-light .ribbon .c .sig {
  color: #3b4252 !important;
}

.theme-nord-light .ribbon .c .sig b {
  color: #5e81ac !important;
}
</style>
