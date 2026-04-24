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
        :pinned="pinnedEntries"
        :rehydratable-ids="rehydratableThreadIds"
        @activate="onActivate"
        @jump-to="onJumpTo"
        @archived-click="onArchivedClick"
      />

      <main class="main">
        <!--
          Header backdrop: blurred, dimmed bar behind StatusBadges +
          SessionMark so transcript content scrolling up doesn't collide
          with the header chrome. Sits below the badges (z-index) but
          above the transcript.
        -->
        <div class="header-backdrop" aria-hidden="true" />
        <!--
          Composer backdrop: same fade trick at the bottom so transcript
          content scrolling up doesn't fight the composer. Masked on the
          right so Canvas's bottom-right steel-blue glow (chat-glow.b)
          keeps breathing through.
        -->
        <div class="composer-backdrop" aria-hidden="true" />
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
    <TokenUsageModal />
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
import TokenUsageModal    from './components/chrome/TokenUsageModal.vue';
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

import { ipcRenderer }           from '@pkg/utils/ipcRenderer';

import type { Thread }   from './models/Thread';
import { asThreadId, type ThreadId } from './types/chat';

/**
 * Shape returned by `conversation-history:get-recent`. Defined locally
 * because the renderer can't import the main-process model class.
 */
interface HistoryRecord {
  id:             string;
  type:           string;
  title:          string;
  thread_id?:     string;
  status:         string;
  created_at:     string;
  last_active_at: string;
  pinned:         boolean;
  message_count:  number;
}

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
      // Stale pointer — tab remembers a thread that was never persisted
      // (or got removed). Drop the pointer so we don't keep pointing at
      // a ghost on every reopen. Fresh thread gets created below.
      persister.clearTabThread(props.tabId);
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
// App-wide conversation history (Postgres-backed, shared across every
// open chat). Fetched on mount via the main-process IPC. Merged into the
// thread list below so the HistoryRail surfaces every past chat, not
// just threads this renderer's LocalStoragePersister happens to hold.
const recentHistory = ref<HistoryRecord[]>([]);

async function loadRecentHistory(): Promise<void> {
  try {
    const rows = await ipcRenderer.invoke(
      'conversation-history:get-recent' as any,
      200,
      'chat',
    ) as HistoryRecord[] | undefined;
    recentHistory.value = Array.isArray(rows) ? rows : [];
  } catch {
    recentHistory.value = [];
  }
}

function historyToThread(h: HistoryRecord): Thread {
  const id = asThreadId(h.thread_id || h.id);
  const createdAt  = Date.parse(h.created_at)     || Date.now();
  const updatedAt  = Date.parse(h.last_active_at) || createdAt;
  return {
    id,
    title: h.title || 'Untitled',
    createdAt,
    updatedAt,
    messages: [],
  };
}

/**
 * Ids that can be fully rehydrated into a working ChatController — live
 * controllers in the registry or persisted ThreadStates on disk. Entries
 * outside this set (Postgres-only history rows) render as archived in the
 * HistoryRail with a no-op click.
 */
const rehydratableThreadIds = computed<Set<ThreadId>>(() => {
  const s = new Set<ThreadId>();
  for (const ctrl of registry.all()) s.add(ctrl.thread.value.id);
  for (const state of persister.list()) s.add(state.thread.id);
  return s;
});

function onArchivedClick(_id: ThreadId): void {
  // No hydration path yet for Postgres-only conversations — surface a
  // transient status so the user isn't left wondering why nothing
  // happened. Full rehydration would need an IPC to load the thread's
  // turns from conversation_history, which isn't built yet.
  window.dispatchEvent(new CustomEvent('chat:status', {
    detail: 'That chat is archived — its transcript isn\'t available in this session yet.',
  }));
}

const allThreads = computed<Thread[]>(() => {
  // Priority order: live controllers (freshest) → LocalStoragePersister
  // (per-tab snapshots) → app-wide conversation history (shared, may be
  // from other tabs/sessions). Deduped by id.
  const seen   = new Set<ThreadId>();
  const out: Thread[] = [];

  for (const ctrl of registry.all()) {
    const t = ctrl.thread.value;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }

  for (const s of persister.list()) {
    if (seen.has(s.thread.id)) continue;
    seen.add(s.thread.id);
    out.push(s.thread);
  }

  for (const h of recentHistory.value) {
    const t = historyToThread(h);
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }

  return out;
});

const suggestions = Object.freeze([
  'What\'s on my calendar today?',
  'Summarize my unread emails',
  'Help me draft an email',
  'What should I focus on today?',
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

// ─── Pinboard entries (top of history rail) ───────────────────────
// Walks both live controllers and persisted threads so pins surface
// even when the origin thread isn't currently active. The rail renders
// these above the "Recent" group.
const pinnedEntries = computed(() => {
  const out: { threadId: ThreadId; threadTitle: string; messageId: any; preview: string }[] = [];

  // Live controllers first (fresher state)
  for (const ctrl of registry.all()) {
    const t = ctrl.thread.value;
    for (const m of t.messages) {
      if (!m.pinned) continue;
      const text = (m as any).text || (m as any).body || (m as any).content || '';
      out.push({
        threadId:    t.id,
        threadTitle: t.title,
        messageId:   m.id,
        preview:     String(text).slice(0, 140).replace(/\s+/g, ' ').trim() || '(pinned message)',
      });
    }
  }

  // Persisted threads not currently in memory
  const memIds = new Set(registry.all().map(c => c.thread.value.id));
  for (const state of persister.list()) {
    if (memIds.has(state.thread.id)) continue;
    for (const m of state.thread.messages) {
      if (!m.pinned) continue;
      const text = (m as any).text || (m as any).body || (m as any).content || '';
      out.push({
        threadId:    state.thread.id,
        threadTitle: state.thread.title,
        messageId:   m.id,
        preview:     String(text).slice(0, 140).replace(/\s+/g, ' ').trim() || '(pinned message)',
      });
    }
  }
  return out;
});

/**
 * Activate the pin's thread, then fire a window event so the Transcript
 * can scroll the target message into view. Transcript-side handler is
 * a follow-up; for now the activate gets you there.
 */
function onJumpTo(target: { threadId: ThreadId; messageId: any }): void {
  onActivate(target.threadId);
  // Give the transcript a tick to mount, then nudge it.
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('chat:jump-to-message', {
      detail: { messageId: target.messageId },
    }));
  }, 50);
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
  void loadRecentHistory();
});

// Refresh when the user clears history elsewhere, or when their own
// sends land (last_active_at changes). We also refresh every time the
// history rail opens so stale lists don't stick around between sessions.
function onHistoryCleared(): void { void loadRecentHistory(); }
onMounted(() => {
  ipcRenderer.on('conversation-history:cleared' as any, onHistoryCleared);
});
onBeforeUnmount(() => {
  ipcRenderer.removeListener('conversation-history:cleared' as any, onHistoryCleared);
});
watch(historyOpen, (open) => { if (open) void loadRecentHistory(); });
watch(() => adapter.hasSentMessage.value, (sent) => { if (sent) void loadRecentHistory(); });

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

// ─── Fork listener — /fork ─────────────────────────────────────────
// Snapshots the current thread up through the named message, then
// persists it so it appears in the history rail. The active controller
// stays on the original thread — user can click the fork in history to
// open it. Saves the mess of swapping the adapter mid-tab.
function onForkEvent(ev: Event): void {
  const detail = (ev as CustomEvent<{ fromId?: string }>).detail ?? {};
  const snapshot = controller.forkSnapshot(detail.fromId as any);
  persister.save(snapshot);
}

onMounted(() => {
  window.addEventListener('chat:new-chat', onNewChatEvent);
  window.addEventListener('chat:fork',     onForkEvent);
});
onBeforeUnmount(() => {
  window.removeEventListener('chat:new-chat', onNewChatEvent);
  window.removeEventListener('chat:fork',     onForkEvent);
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

/*
 * Header backdrop — blurred, dimmed gradient behind SessionMark
 * (z-12) and StatusBadges (z-21). Sits above the transcript so
 * scrolled content fades out under the header chrome instead of
 * colliding with it.
 */
.header-backdrop {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 78px;
  z-index: 10;
  pointer-events: none;
  background: linear-gradient(
    to bottom,
    rgba(5, 8, 16, 0.92) 0%,
    rgba(5, 8, 16, 0.78) 55%,
    rgba(5, 8, 16, 0) 100%
  );
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  mask-image: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 1) 0%,
    rgba(0, 0, 0, 1) 65%,
    rgba(0, 0, 0, 0) 100%
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 1) 0%,
    rgba(0, 0, 0, 1) 65%,
    rgba(0, 0, 0, 0) 100%
  );
}

/*
 * Composer backdrop — mirror of the header fade at the bottom of .main.
 * Sits below the Composer (z-15) and above the Transcript so messages
 * scrolling up fade out under the input row. Masked horizontally on
 * the right so Canvas's bottom-right steel-blue glow (chat-glow.b) is
 * preserved and still breathes through.
 */
.composer-backdrop {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 180px;
  z-index: 10;
  pointer-events: none;
  background: linear-gradient(
    to top,
    rgba(5, 8, 16, 0.92) 0%,
    rgba(5, 8, 16, 0.78) 45%,
    rgba(5, 8, 16, 0) 100%
  );
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  /* Two-axis mask:
     - fade out toward the top so the transcript emerges smoothly into
       the fade instead of ending at a hard line;
     - fade out toward the RIGHT so chat-glow.b (around 78% x / 80% y)
       keeps breathing through unmuted. */
  mask-image:
    linear-gradient(to top,   rgba(0,0,0,1) 0%, rgba(0,0,0,1) 55%, rgba(0,0,0,0) 100%),
    linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 55%, rgba(0,0,0,0) 92%);
  mask-composite: intersect;
  -webkit-mask-image:
    linear-gradient(to top,   rgba(0,0,0,1) 0%, rgba(0,0,0,1) 55%, rgba(0,0,0,0) 100%),
    linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 55%, rgba(0,0,0,0) 92%);
  -webkit-mask-composite: source-in;
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
