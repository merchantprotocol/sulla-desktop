<!--
  ChatPage — the top-level container that owns layout and wiring.
  Absolutely nothing here mutates state directly; everything flows
  through the injected ChatController.

  This is the route target for the new chat UI. To wire into the
  existing app, mount it under BrowserTab/NewTabWelcome/etc.

  Phase-0 behavior:
    • If `tabId` prop is provided, registers that as the thread id.
    • If a LocalStoragePersister-persisted thread matches, hydrates it.
    • Otherwise creates a fresh thread.
    • The demo Transport responds to user sends with a canned
      thinking + tool + streaming reply sequence so the UI is alive.
-->
<template>
  <div class="chat-root" :class="{ 'artifact-open': hasArtifact, 'history-open': historyOpen }">
    <Canvas />

    <div class="shell">
      <HistoryRail
        :open="historyOpen"
        :threads="allThreads"
        :active-id="activeThreadId"
        @activate="onActivate"
      />

      <main class="main">
        <StatusBadges />
        <SessionMark editable />
        <SearchBar />

        <EmptyState
          v-if="controller.messages.value.length === 0"
          :suggestions="suggestions"
          :show-goals="showGoals"
          :show-business="showBusiness"
          @pick="onSuggestion"
          @mode="onModePick"
          @start-onboarding="onStartGoals"
          @start-business-onboarding="onStartBusiness"
        />
        <Transcript v-else />

        <Composer />
      </main>

      <ArtifactSidebar />
    </div>

    <ModelSwitcherModal />
    <ShortcutsModal />
    <DropOverlay :active="dragActive" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';

import Canvas             from './components/chrome/Canvas.vue';
import StatusBadges       from './components/chrome/StatusBadges.vue';
import SessionMark        from './components/chrome/SessionMark.vue';
import DropOverlay        from './components/chrome/DropOverlay.vue';
import ModelSwitcherModal from './components/chrome/ModelSwitcherModal.vue';
import ShortcutsModal     from './components/chrome/ShortcutsModal.vue';
import SearchBar          from './components/chrome/SearchBar.vue';

import Transcript        from './components/transcript/Transcript.vue';
import Composer          from './components/composer/Composer.vue';
import ArtifactSidebar   from './components/artifact/ArtifactSidebar.vue';
import HistoryRail       from './components/history/HistoryRail.vue';
import EmptyState        from './components/empty/EmptyState.vue';

import { ChatController }        from './controller/ChatController';
import { ThreadRegistry }        from './controller/ThreadRegistry';
import {
  ChatControllerKey, ThreadRegistryKey,
} from './controller/useChatController';

import { LocalStoragePersister } from './services/LocalStoragePersister';
import { PersonaAdapter }        from './services/PersonaAdapter';

import { useDragDrop }           from './composables/useDragDrop';
import { useKeyboardShortcuts }  from './composables/useKeyboardShortcuts';
import { useResizeSync }         from './composables/useResizeSync';

import type { Message } from './models/Message';
import type { Thread } from './models/Thread';
import type { ThreadId } from './types/chat';

// ─── Props ────────────────────────────────────────────────────────
const props = defineProps<{
  /** Per-tab scoping key. Threads opened with this tabId are persisted distinctly. */
  tabId?: string;
  /** Optional override model id on first boot. */
  initialModelId?: string;
}>();

// ─── Emits (to BrowserTab for mode switching + URL opening) ────────
const emit = defineEmits<{
  (e: 'set-mode', mode: string): void;
  (e: 'navigate-url', url: string): void;
}>();

// ─── Registry + controller (single-source-of-truth root) ─────────
const persister = new LocalStoragePersister();
const registry  = new ThreadRegistry(persister);

// Each tab starts fresh. The history rail exposes persisted threads
// so the user can explicitly rehydrate any past conversation.
const controller = registry.create({ tabId: props.tabId });

// Provide so every descendant can call `useChatController()`.
provide(ChatControllerKey, controller);
provide(ThreadRegistryKey, registry);

// ─── Real backend bridge via the existing persona/ChatInterface ───
// Each tab gets its own adapter+persona. The adapter registers itself
// as the controller's sendHandler, so user sends flow through the
// persona and responses flow back into the controller.
const adapter = new PersonaAdapter(controller, { tabId: props.tabId });
onBeforeUnmount(() => { adapter.dispose(); controller.dispose(); });

// ─── Derived state ────────────────────────────────────────────────
const hasArtifact    = computed(() => controller.artifacts.value.list.length > 0);
const historyOpen    = computed(() => controller.sidebar.value.historyOpen);
const activeThreadId = computed(() => controller.thread.value.id);
const allThreads = computed<Thread[]>(() => {
  // Union of in-memory + persisted.
  const memIds = new Set(registry.all().map(c => c.thread.value.id));
  const fromMem = registry.all().map(c => c.thread.value);
  const fromDisk = persister.list()
    .filter(s => !memIds.has(s.thread.id))
    .map(s => s.thread);
  return [...fromMem, ...fromDisk];
});

const suggestions = Object.freeze([
  'What\'s on my calendar today?',
  'Summarize yesterday\'s changes',
  'Open a new browser tab',
  'Draft a daily briefing',
]);

function onSuggestion(text: string): void {
  controller.send(text);
}

function onModePick(mode: 'integrations' | 'browser' | 'routines' | 'calendar'): void {
  emit('set-mode', mode);
}

// ─── Onboarding state (goals / business) ──────────────────────────
// The existing ChatInterface ecosystem exposes check-goals-onboarding
// and check-business-onboarding IPC handlers. We read them on mount
// so the getting-started cards only appear when the matching identity
// file is missing.
const showGoals    = ref(false);
const showBusiness = ref(false);

onMounted(async () => {
  try {
    const ipc = (window as any).require?.('electron')?.ipcRenderer;
    if (!ipc) return;
    const [g, b] = await Promise.all([
      ipc.invoke('check-goals-onboarding'),
      ipc.invoke('check-business-onboarding'),
    ]);
    showGoals.value    = !!g;
    showBusiness.value = !!b;
  } catch { /* no IPC in dev — hide both */ }
});

function onStartGoals(): void {
  showGoals.value = false;
  controller.send('I\'m new here — help me set my goals and get to know how I work best.');
}

function onStartBusiness(): void {
  showBusiness.value = false;
  const botName = controller.model.value.name ?? 'Sulla';
  controller.send(`I want to put ${ botName } to work on my business.`);
}

function onActivate(id: ThreadId): void {
  const next = registry.activate(id);
  if (next) return;
  // Not in memory yet — hydrate from disk.
  const state = persister.load(id);
  if (state) registry.open(state, props.tabId);
}

// ─── Composables ───────────────────────────────────────────────────
// Pass the controller in explicitly because Vue doesn't let a component
// inject its own provide(). Descendants can still just call useChatController().
const { active: dragActive } = useDragDrop(controller);
useKeyboardShortcuts({
  controller,
  onVoiceToggle: () => {
    // The Composer owns voice lifecycle; we just emit a window event
    // it listens for, so we don't have to thread a ref through.
    window.dispatchEvent(new CustomEvent('chat:voice-toggle'));
  },
});

// Composer resize sync — keep Transcript padding in lockstep with composer height.
const mainRef     = ref<HTMLElement | null>(null);
const composerRef = ref<HTMLElement | null>(null);

onMounted(() => {
  mainRef.value     = document.querySelector('.chat-root .main');
  composerRef.value = document.querySelector('.chat-root .composer-wrap');
});

useResizeSync(mainRef, composerRef);

// When the active thread changes, force a re-render hook for derivations
// that aren't deeply reactive on their own.
watch(() => registry.activeId.value, () => { /* noop — registry is reactive */ });
</script>

<style src="./styles/tokens.css"></style>
<style src="./styles/reading.css"></style>
<style src="./styles/canvas.css"></style>
<style scoped>
.chat-root {
  position: relative;
  width: 100%; height: 100%;
  min-height: 0;
  overflow: hidden;
  background: #050810;
  color: var(--read-2);
  font-family: var(--sans);
}
.shell {
  position: absolute; inset: 0; z-index: 5;
  display: grid;
  grid-template-columns: 0 1fr 0;
  transition: grid-template-columns 0.35s ease;
  --scroller-pad-b: 240px;
}
.chat-root.history-open  .shell                    { grid-template-columns: 260px 1fr 0; }
.chat-root.artifact-open .shell                    { grid-template-columns: 0 1fr 560px; }
.chat-root.history-open.artifact-open .shell       { grid-template-columns: 260px 1fr 560px; }

.main {
  position: relative;
  overflow: hidden;
}
</style>
