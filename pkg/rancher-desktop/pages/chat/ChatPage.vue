<!--
  ChatPage — the top-level container that owns layout and wiring.
  Absolutely nothing here mutates state directly; everything flows
  through the injected ChatController.

  Behavior:
    • Each tab gets its own fresh thread on mount.
    • A PersonaAdapter bridges the existing ChatInterface (persona +
      queue + localStorage) to the controller so user sends flow out
      to the real backend and responses flow back in.
    • The empty-state getting-started view (goals + business onboarding
      cards and quick-action cards) appears when the thread has zero
      messages. The transcript replaces it once a conversation begins.
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
          v-if="!adapter.hasSentMessage.value"
          :suggestions="suggestions"
          @pick="onSuggestion"
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

import { AgentModelSelectorController } from '@pkg/pages/agent/AgentModelSelectorController';

import { ChatController }        from './controller/ChatController';
import { ThreadRegistry }        from './controller/ThreadRegistry';
import {
  ChatControllerKey, ThreadRegistryKey, ModelSelectorKey,
} from './controller/useChatController';
import { findModel }             from './services/ModelRegistry';

import { LocalStoragePersister } from './services/LocalStoragePersister';
import { PersonaAdapter }        from './services/PersonaAdapter';

import { useDragDrop }           from './composables/useDragDrop';
import { useKeyboardShortcuts }  from './composables/useKeyboardShortcuts';
import { useResizeSync }         from './composables/useResizeSync';

import type { Thread }   from './models/Thread';
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
  (e: 'set-mode', mode: string, subTab?: string): void;
  (e: 'navigate-url', url: string): void;
}>();

// ─── Registry + controller (single-source-of-truth root) ─────────
const persister = new LocalStoragePersister();
const registry  = new ThreadRegistry(persister);

// Each tab remembers its last active thread. On mount, if a tabId is
// provided and we can rehydrate a stored thread for it, reopen that
// thread. Otherwise (fresh tab, missing state) start a new thread.
function initController(): ChatController {
  if (props.tabId) {
    const storedId = persister.getTabThread(props.tabId);
    if (storedId) {
      const state = persister.load(storedId);
      if (state) return registry.open(state, props.tabId);
    }
  }
  return registry.create({ tabId: props.tabId });
}

const controller = initController();

// ─── Shared model selector (source of truth for selected model) ───
// AgentModelSelectorController talks to the main-process ModelProviderService
// via IPC — that service owns the DB, llama-server, and broadcasts state
// changes across every open chat (old BrowserTabChat, SidePanelChat, AgentEditor,
// and this new ChatPage). Without this, the new chat page had its own hardcoded
// model list and picking one never reached the backend.
const _modelSysReady  = ref(true);
const _modelLoading   = ref(false);
const _modelIsRunning = ref(false);
const _modelName      = ref<string>('');
const _modelMode      = ref<'remote'>('remote');
const modelSelector   = new AgentModelSelectorController({
  systemReady: _modelSysReady,
  loading:     _modelLoading,
  isRunning:   _modelIsRunning,
  modelName:   _modelName,
  modelMode:   _modelMode,
});
modelSelector.start();

// Mirror the selector's active model into ChatController.model so the
// status badge, PersonaAdapter payload, and anything else reading
// `controller.model.value.name` stays in lockstep with what the backend
// is actually using. findModel() returns a descriptor when the id is in
// the registry; otherwise we synthesize a minimal descriptor so the UI
// still reflects whatever label the backend says is active.
watch(
  [modelSelector.activeModelId, modelSelector.activeModelLabel],
  ([id, label]) => {
    if (!id) return;
    const known = findModel(id);
    controller.switchModel(known ?? {
      id, name: label || id, tier: 'hosted', ctx: '',
    });
  },
  { immediate: true },
);

// Provide so every descendant can call `useChatController()`.
provide(ChatControllerKey, controller);
provide(ThreadRegistryKey, registry);
provide(ModelSelectorKey,  modelSelector);

// ─── Real backend bridge via the existing persona/ChatInterface ───
// Each tab gets its own adapter+persona. The adapter registers itself
// as the controller's sendHandler, so user sends flow through the
// persona and responses flow back into the controller.
const adapter = new PersonaAdapter(controller, { tabId: props.tabId });
onBeforeUnmount(() => {
  adapter.dispose();
  controller.dispose();
  modelSelector.dispose();
});

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
  'Open GuestBridge.ts and show me the capture path',
  'Build me a workflow that deploys to staging',
  'What\'s on my calendar tomorrow?',
  'Summarize yesterday\'s changes',
]);

function onSuggestion(text: string): void {
  controller.send(text);
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

// Persist tab→thread mapping so reopening this tab restores the last
// thread that was active in it. We follow the controller's thread id
// rather than registry.activeId so a thread swap inside the controller
// (hydrate, rename, etc.) is recorded.
watch(() => controller.thread.value.id, (newId) => {
  if (props.tabId && newId) persister.setTabThread(props.tabId, newId);
}, { immediate: true });

// ─── Global "new chat" listener ───────────────────────────────────
// Fired by:
//   • Composer slash commands /clear and /new
//   • Right-click context menu → New Chat (TurnUser / TurnSulla)
// Resets the controller to a fresh thread + tells the adapter to
// clear its ChatInterface (thread id, queue, persona messages).
function onNewChatEvent(): void {
  adapter.newChat();
  controller.newChat();
}
onMounted(() => {
  window.addEventListener('chat:new-chat', onNewChatEvent);
});
onBeforeUnmount(() => {
  window.removeEventListener('chat:new-chat', onNewChatEvent);
});
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
  --scroller-pad-b: 240px;
}

/* Main fills the shell, then shrinks from the edges when a rail opens.
   Both rails are v-if'd, so main can't rely on grid auto-placement — we
   just transition left/right instead. */
.main {
  position: absolute;
  top: 0; bottom: 0;
  left: 0; right: 0;
  overflow: hidden;
  transition: left 0.35s ease, right 0.35s ease;
}
.chat-root.history-open  .main { left: 260px; }
.chat-root.artifact-open .main { right: 560px; }

/* Rails float over the left/right edges at fixed widths. */
.shell :deep(.history) {
  position: absolute;
  top: 0; bottom: 0; left: 0;
  width: 260px;
  z-index: 6;
}
.shell :deep(.artifact) {
  position: absolute;
  top: 0; bottom: 0; right: 0;
  width: 560px;
  z-index: 6;
}
</style>
