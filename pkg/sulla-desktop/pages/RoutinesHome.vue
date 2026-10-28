<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
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

    <!-- One Studio shell: the Use Cases sidebar owns navigation. Use
         Cases views render inside PackagesTab; every other section is
         supplied here through its `section` slot. -->
    <PackagesTab
      v-model:section="section"
      @installed="onPackagesInstalled"
      @feedback="showFeedback"
    >
      <template #section="{ section: current }">
        <!-- ═══════ WORKFLOWS ═══════ -->
        <div
          v-if="current === 'workflows'"
          class="studio-page"
        >
          <StudioTopbar
            v-model:search="workflowSearch"
            :crumbs="['Workflows']"
            search-placeholder="Search workflows"
          >
            <template #actions>
              <button
                type="button"
                class="btn"
                title="Import a workflow bundle or workflow folder"
                @click="onImport"
              >
                + Import
              </button>
              <button
                type="button"
                class="btn pri"
                @click="onNewBlank"
              >
                ＋ New workflow
              </button>
            </template>
          </StudioTopbar>
          <div class="studio-content">
            <div class="tb">
              <h1>Workflows</h1>
              <span>{{ routinesController.routines.value.length }} in database</span>
            </div>

            <!-- Booting state — the app shell repaints tabs from localStorage
                 before the Electron backend is up. Show a benign "warming up"
                 message instead of blowing up with a DB connection error. -->
            <EmptyState
              v-if="routinesController.routines.value.length === 0 && !routinesController.isLoading.value"
              kicker="No workflows yet"
              title="Your stage is empty."
              message="You haven't built a workflow yet. Get one from Use Cases, or compose one from scratch on the canvas."
            >
              <button
                type="button"
                class="btn pri"
                @click="section = 'browse'"
              >
                Browse Use Cases →
              </button>
              <button
                type="button"
                class="btn"
                @click="onNewBlank"
              >
                ＋ Start blank
              </button>
            </EmptyState>

            <WorkflowTable
              v-else
              :routines="filteredRoutines"
              :summaries="runSummaries.workflows"
              :device-name="runSummaries.deviceName"
              :running="runRequests"
              :now="now"
              @open="onOpenRoutine"
              @open-run="onOpenRun"
              @run="onRunNow"
              @edit="onEditRoutine"
              @restore="onRestoreRoutine"
              @duplicate="onDuplicate"
              @archive="onToggleArchive"
              @export="onExport"
              @publish="onPublishById"
              @delete="onDeleteById"
            />
          </div>
        </div>

        <!-- ═══════ SAVED SKILLS / CUSTOM AGENTS / RECIPES ═══════ -->
        <StudioSkillsPage v-else-if="current === 'skills'" />
        <StudioAgentsPage v-else-if="current === 'agents'" />
        <StudioRecipesPage v-else-if="current === 'recipes'" />

        <!-- ═══════ LIVE AGENTS / TOKEN USAGE ═══════ -->
        <StudioLivePage v-else-if="current === 'live'" />
        <StudioUsagePage v-else-if="current === 'usage'" />
      </template>
    </PackagesTab>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import EmptyState from '@pkg/components/routines/EmptyState.vue';
import PackagesTab from '@pkg/components/routines/PackagesTab.vue';
import type { StudioSection } from '@pkg/components/routines/studioSections';
import WorkflowTable from '@pkg/components/routines/WorkflowTable.vue';
import StudioAgentsPage from '@pkg/components/studio/StudioAgentsPage.vue';
import StudioLivePage from '@pkg/components/studio/StudioLivePage.vue';
import StudioRecipesPage from '@pkg/components/studio/StudioRecipesPage.vue';
import StudioSkillsPage from '@pkg/components/studio/StudioSkillsPage.vue';
import StudioTopbar from '@pkg/components/studio/StudioTopbar.vue';
import StudioUsagePage from '@pkg/components/studio/StudioUsagePage.vue';
import { useRoutines } from '@pkg/composables/useRoutines';
import type { WorkflowRunSummaries } from '@pkg/main/workflowRunSummaries';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import { useStartupProgress } from './agent/useStartupProgress';

const props = withDefaults(defineProps<{
  section?: StudioSection;
}>(), { section: 'workflows' });

const emit = defineEmits<{
  (e: 'open-workflow', id: string, mode?: 'edit' | 'run', runId?: string): void
  (e: 'new-blank'): void
  (e: 'restore-routine', id: string): void
  (e: 'update:section', section: StudioSection): void
}>();

// The sidebar page is owned by the tab, so the mode rail and the Inspect
// menu can open Live Agents or Token Usage directly.
const section = ref<StudioSection>(props.section);

watch(() => props.section, (next) => { if (next !== section.value) section.value = next; });
watch(section, (next) => { if (next !== props.section) emit('update:section', next); });

// Composables = the controller layer. The view only reads their reactive
// state and forwards user intents back to them or up to the parent.
const routinesController = useRoutines();

const workflowSearch = ref('');
const filteredRoutines = computed(() => {
  const q = workflowSearch.value.trim().toLowerCase();
  if (!q) return routinesController.routines.value;

  return routinesController.routines.value.filter(r => `${ r.name } ${ (r as any).description ?? '' }`.toLowerCase().includes(q));
});

// The playbill can't query Postgres until the backend has booted — the
// tab is restored from localStorage on first paint, which regularly
// beats the Electron main-process bring-up. Gate the initial load on
// `systemReady` and reload automatically the moment it flips true, so
// the first real render gets real data instead of an ECONNREFUSED.
const { systemReady } = useStartupProgress();

async function loadAll() {
  await Promise.all([
    routinesController.load(),
    loadRunSummaries(),
  ]);
}

// ── Workflows list run data ─────────────────────────────────────────
// Last 12 runs, trigger, next fire and location per workflow, read from
// workflow_executions + definitions by the main process. Refreshed on a
// slow poll so "Running now" / "Next run" stay honest while the list is
// open; `now` ticks with it so relative labels ("In 18 min") move too.
const runSummaries = ref<WorkflowRunSummaries>({ deviceName: '', workflows: {} });
const runRequests = ref(new Set<string>());
const now = ref(new Date());
let summaryTimer: ReturnType<typeof setInterval> | null = null;

async function loadRunSummaries() {
  try {
    runSummaries.value = await ipcRenderer.invoke('workflow-run-summaries');
  } catch (err) {
    console.warn('[RoutinesHome] run summaries failed:', err);
  }
  now.value = new Date();
}

onMounted(() => {
  summaryTimer = setInterval(() => {
    if (systemReady.value && section.value === 'workflows') void loadRunSummaries();
  }, 15_000);
});
onBeforeUnmount(() => {
  if (summaryTimer) clearInterval(summaryTimer);
});

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
function onOpenRun(id: string, executionId: string) {
  emit('open-workflow', id, 'run', executionId);
}
// Start a run straight from the list. The manager answers as soon as the
// run is launched; the in-process fallback resolves when the run settles,
// so the list refreshes once now and again when the call returns.
async function onRunNow(id: string) {
  const routine = routinesController.routines.value.find(r => r.id === id);
  runRequests.value = new Set([...runRequests.value, id]);
  const settled = ipcRenderer.invoke('routines-execute', id, 'Run from the Studio workflows list')
    .then(() => true)
    .catch((err: unknown) => {
      showFeedback('error', `Couldn't start "${ routine?.name ?? id }": ${ err instanceof Error ? err.message : String(err) }`);

      return false;
    });
  setTimeout(() => void loadRunSummaries(), 1_500);
  const ok = await Promise.race([settled, new Promise(resolve => setTimeout(() => resolve(true), 1_200))]);
  if (ok) showFeedback('success', `Started "${ routine?.name ?? id }".`);
  void settled.finally(() => {
    const next = new Set(runRequests.value);
    next.delete(id);
    runRequests.value = next;
    void loadRunSummaries();
  });
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

function onPublishById(id: string) {
  const routine = routinesController.routines.value.find(r => r.id === id);
  if (routine) void onPublishRoutine(routine);
}

function onDeleteById(id: string) {
  const routine = routinesController.routines.value.find(r => r.id === id);
  if (routine) void onDelete(routine);
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

// A package can add workflows, skills, agents and more in one go, so
// refresh the workflows list after install / remove.
async function onPackagesInstalled() {
  await routinesController.load();
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
    await routinesController.load();
    showFeedback('success', 'Imported.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Routines] Import failed:', err);
    window.alert(`Import failed: ${ msg }`);
  }
}
</script>

<style scoped lang="scss">
@import '@pkg/assets/styles/routines-theme.scss';
@import '@pkg/assets/styles/studio-ui.scss';

.routines-home {
  @include routines-theme-vars;

  // Fills the BrowserTab body. The Studio shell inside owns all scrolling.
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  color: var(--text);
  background: var(--nx-paper, var(--bg-page, #f3f6fa));
  font-family: var(--sans);
  -webkit-font-smoothing: antialiased;
}
.routines-home > :deep(.use-cases) { flex: 1; min-height: 0; border-radius: 0; }

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
</style>
