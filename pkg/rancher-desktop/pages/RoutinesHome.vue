<template>
  <div class="routines-home">
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
              Sulla Workbench
            </div>
            <div class="brand-sub">
              Agent Routines
            </div>
          </div>
        </div>
        <nav class="tabs">
          <button
            type="button"
            class="tab"
            :class="{ on: activeTab === 'routines' }"
            @click="activeTab = 'routines'"
          >
            My Routines
            <span class="tab-num">{{ routinesController.routines.value.length }}</span>
          </button>
          <button
            type="button"
            class="tab"
            :class="{ on: activeTab === 'templates' }"
            @click="activeTab = 'templates'"
          >
            My Templates
            <span class="tab-num">{{ templatesController.templates.value.length }}</span>
          </button>
        </nav>
      </div>

      <!-- hero -->
      <div class="hero">
        <div class="kicker">
          <span class="d" />{{ heroKicker }}
        </div>
        <h1>Routines.</h1>
        <div class="dek">
          {{ heroDek }}
        </div>
        <div
          v-if="activeTab === 'routines' && routinesController.routines.value.length > 0"
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

      <!-- ═══════ MY ROUTINES TAB ═══════ -->
      <template v-if="activeTab === 'routines'">
        <EmptyState
          v-if="routinesController.isEmpty.value"
          kicker="No routines yet"
          title="Your stage is empty."
          message="You haven't built a routine yet. Start from a template — five are waiting in the wings — or compose one from scratch on the canvas."
        >
          <button
            type="button"
            class="btn primary"
            @click="activeTab = 'templates'"
          >
            Browse templates →
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
              @export="onExport(r.id)"
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
              @export="onExport(r.id)"
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
              @primary="onOpenRoutine(r.id)"
              @open="onOpenRoutine(r.id)"
              @export="onExport(r.id)"
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

      <!-- ═══════ MY TEMPLATES TAB ═══════ -->
      <template v-else>
        <div class="template-search">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
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
            v-model="templatesController.search.value"
            type="text"
            placeholder="Search templates by name, tag, or category…"
          >
          <span class="template-count">
            {{ templatesController.filtered.value.length }} of {{ templatesController.templates.value.length }}
          </span>
        </div>

        <EmptyState
          v-if="templatesController.hasNoMatches.value"
          class="empty-small"
          kicker="No matches"
          :title="noMatchesTitle"
          message="Try a shorter search or clear the filter."
        />

        <template v-else>
          <ActSection
            act-num="Registry"
            title="Templates on disk"
            :count-label="templatesCountLabel"
          >
            <TemplateStrip
              v-for="t in templatesController.filtered.value"
              :key="t.slug"
              :template="t"
              @use="onUseTemplate(t.slug)"
            />
          </ActSection>

          <div class="closer">
            <div class="closer-sub">
              Templates live in <code>~/sulla/routines/</code> — each is a standalone git repo you can version and share.
            </div>
          </div>
        </template>
      </template>
        </div>

        <!-- ribbon footer — sits in normal flow at the end of the canvas
             so it reads as "end of document" rather than a sticky bar. -->
        <div class="ribbon">
          <div class="l">
            <span>Routines</span>
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
import { computed, onMounted, ref } from 'vue';

import ActSection from '@pkg/components/routines/ActSection.vue';
import EmptyState from '@pkg/components/routines/EmptyState.vue';
import RoutineStrip from '@pkg/components/routines/RoutineStrip.vue';
import TemplateStrip from '@pkg/components/routines/TemplateStrip.vue';
import { useRoutines } from '@pkg/composables/useRoutines';
import { useTemplates } from '@pkg/composables/useTemplates';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type Tab = 'routines' | 'templates';

const emit = defineEmits<{
  (e: 'open-workflow', id: string): void
  (e: 'use-template', slug: string): void
  (e: 'new-blank'): void
}>();

const activeTab = ref<Tab>('routines');

// Composables = the controller layer. The view only reads their reactive
// state and forwards user intents back to them or up to the parent.
const routinesController = useRoutines();
const templatesController = useTemplates();

onMounted(async() => {
  await Promise.all([
    routinesController.load(),
    templatesController.load(),
  ]);
});

// Display-layer string derivations. Kept as computeds so the template
// never has to embed template-literal logic inline — keeps the view
// terse and lets the eslint style rules stay strict.

// Hero kicker shifts with the active tab. Playbill-adjacent phrasing,
// but contextual so the two tabs feel like different places.
const heroKicker = computed(() =>
  activeTab.value === 'routines' ? 'The Cast' : 'The Library');

const heroDek = computed(() => {
  const count = routinesController.routines.value.length;
  if (activeTab.value === 'routines') {
    if (count === 0) {
      return 'Nothing running, nothing scheduled, nothing idle. Start from a template to your right, or compose something new from the canvas.';
    }
    const plural = count === 1 ? '' : 's';
    const reclaimed = routinesController.stats.value.reclaimed;

    return `${ count } routine${ plural }. ${ reclaimed } of human-equivalent work reclaimed this week. Each one a small constellation of agents, rehearsed until they run without you.`;
  }
  const tplCount = templatesController.templates.value.length;

  return `${ tplCount } templates on disk. Each is a self-contained git repo in ~/sulla/routines/ — pick one and it lands in your database as a fresh routine, ready to edit on the canvas.`;
});

const runningCountLabel = computed(() => {
  const n = routinesController.running.value.length;

  return `${ n } routine${ n === 1 ? '' : 's' } live`;
});

const scheduledCountLabel = computed(() => `${ routinesController.scheduled.value.length } upcoming`);

const templatesCountLabel = computed(() => `${ templatesController.filtered.value.length } available`);

const noMatchesTitle = computed(() => `Nothing found for "${ templatesController.search.value }"`);

const ribbonStatusLabel = computed(() => {
  return activeTab.value === 'routines'
    ? `${ routinesController.routines.value.length } in database`
    : `${ templatesController.templates.value.length } on disk`;
});

const todayStr = new Date().toISOString().slice(0, 10);

function onOpenRoutine(id: string) {
  emit('open-workflow', id);
}
function onUseTemplate(slug: string) {
  emit('use-template', slug);
}
function onNewBlank() {
  emit('new-blank');
}
async function onExport(id: string) {
  // Fires the native save dialog in the main process; surfaces any
  // failure through the routines controller's existing error channel
  // so the view layer stays consistent with other IPC failure paths.
  try {
    await ipcRenderer.invoke('routines-export', id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    routinesController.error.value = `Export failed: ${ msg }`;
    console.error('[Routines] Export failed:', err);
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
.bracket.bl { bottom: 22px; left: 22px; border-bottom: 1.5px solid; border-left: 1.5px solid; }
.bracket.br { bottom: 22px; right: 22px; border-bottom: 1.5px solid; border-right: 1.5px solid; }

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
  font-family: var(--serif); font-style: italic; font-size: 18px;
  box-shadow: 0 0 18px rgba(74,111,165,0.45);
}
.brand-name { font-family: var(--serif); font-style: italic; font-size: 18px; color: white; }
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
  font-family: var(--serif); font-style: italic; font-size: 68px;
  color: white; line-height: 1; margin: 0 0 16px;
  letter-spacing: -0.02em; font-weight: 600;
}
.hero .dek {
  font-family: var(--serif); font-size: 17px; font-style: italic;
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
  display: block; font-family: var(--serif); font-style: italic;
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
  color: var(--steel-400); font-style: italic;
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
  font-family: var(--serif); font-size: 14px; font-style: italic; color: white;
  margin-top: 4px; line-height: 1.2;
}
.ribbon .c .sig b { color: var(--violet-300); font-weight: 700; }
</style>
