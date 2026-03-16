<template>
  <div
    class="h-full overflow-hidden font-sans page-root"
    :class="{ dark: isDark }"
  >
    <PostHogTracker page-name="Agent" />
    <div class="flex h-full flex-col">
      <AgentHeader
        :is-dark="isDark"
        :toggle-theme="toggleTheme"
      />

      <!-- Loading overlay while system boots -->
      <StartupOverlay
        @overlay-visible="showOverlay = $event"
        @system-ready="systemReady = $event"
      />

      <!-- Main agent interface -->
      <div
        v-if="hasMessages"
        id="chat-scroll-container"
        ref="chatScrollContainer"
        class="min-h-0 flex-1 overflow-y-auto"
        :class="{ 'blur-sm pointer-events-none select-none': showOverlay }"
      >
        <div class="relative mx-auto flex w-full max-w-8xl xl:px-12 sm:px-2 lg:px-8 justify-center">
          <div
            class="min-w-0 py-16 max-w-[768px] flex-auto px-4 lg:pr-0 lg:pl-8 xl:px-16"
          >
            <div
              id="chat-messages-list"
              ref="transcriptEl"
              class="pb-8"
            >
              <div
                v-for="m in displayMessages"
                :key="m.id"
                class="mb-8"
              >
                <div
                  v-if="m.role === 'user'"
                  class="flex justify-end"
                >
                  <div class="max-w-[min(760px,92%)] rounded-3xl p-6 bg-surface-alt ring-1 ring-edge-subtle">
                    <div class="whitespace-pre-wrap text-content">
                      {{ m.content }}
                    </div>
                  </div>
                </div>

                <div
                  v-else-if="m.kind === 'tool'"
                  class="max-w-[min(760px,92%)]"
                >
                  <div
                    v-if="m.toolCard"
                    class="tool-card-cc"
                    :class="{ expanded: isToolCardExpanded(m.id) }"
                  >
                    <!-- Header row: status dot + tool name + description -->
                    <button
                      type="button"
                      class="tool-card-cc-header"
                      @click="toggleToolCard(m.id)"
                    >
                      <span
                        class="tool-card-cc-dot"
                        :class="m.toolCard.status"
                      />
                      <span class="tool-card-cc-name">{{ toolCardLabel(m.toolCard) }}</span>
                      <span
                        v-if="m.toolCard.description"
                        class="tool-card-cc-desc"
                      >{{ m.toolCard.description }}</span>
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 15 15"
                        fill="none"
                        class="tool-card-cc-chevron"
                        :class="{ open: isToolCardExpanded(m.id) }"
                      >
                        <path
                          d="M3.13523 6.15803C3.3241 5.95657 3.64052 5.94637 3.84197 6.13523L7.5 9.56464L11.158 6.13523C11.3595 5.94637 11.6759 5.95657 11.8648 6.15803C12.0536 6.35949 12.0434 6.67591 11.842 6.86477L7.84197 10.6148C7.64964 10.7951 7.35036 10.7951 7.15803 10.6148L3.15803 6.86477C2.95657 6.67591 2.94637 6.35949 3.13523 6.15803Z"
                          fill="currentColor"
                          fill-rule="evenodd"
                          clip-rule="evenodd"
                        />
                      </svg>
                    </button>
                    <!-- Command line preview (always visible for exec-like tools) -->
                    <div
                      v-if="toolCardCommand(m.toolCard)"
                      class="tool-card-cc-cmd"
                    >
                      <span class="tool-card-cc-cmd-label">IN</span>
                      <code class="tool-card-cc-cmd-text">{{ toolCardCommand(m.toolCard) }}</code>
                    </div>
                    <!-- Exit code row (visible when result available) -->
                    <div
                      v-if="m.toolCard.status !== 'running' && toolCardCommand(m.toolCard)"
                      class="tool-card-cc-cmd"
                    >
                      <span class="tool-card-cc-cmd-label">OUT</span>
                      <code
                        class="tool-card-cc-cmd-text tool-card-cc-exit"
                        :class="m.toolCard.status"
                      >{{ m.toolCard.status === 'success' ? '0' : '1' }}</code>
                    </div>
                    <!-- Expanded details -->
                    <div
                      v-show="isToolCardExpanded(m.id)"
                      class="tool-card-cc-body"
                    >
                      <div
                        v-if="toolCardOutput(m.toolCard)"
                        class="tool-card-cc-output"
                      >
                        <pre>{{ toolCardOutput(m.toolCard) }}</pre>
                      </div>
                      <div
                        v-if="!toolCardCommand(m.toolCard) && m.toolCard.args && Object.keys(m.toolCard.args).length > 0"
                        class="tool-card-cc-output"
                      >
                        <div class="tool-card-cc-section-label">
                          Arguments
                        </div>
                        <pre>{{ JSON.stringify(m.toolCard.args, null, 2) }}</pre>
                      </div>
                      <div
                        v-if="!toolCardCommand(m.toolCard) && m.toolCard.result !== undefined"
                        class="tool-card-cc-output"
                      >
                        <div class="tool-card-cc-section-label">
                          Result
                        </div>
                        <pre>{{ typeof m.toolCard.result === 'string' ? m.toolCard.result : JSON.stringify(m.toolCard.result, null, 2) }}</pre>
                      </div>
                      <div
                        v-if="m.toolCard.error"
                        class="tool-card-cc-error"
                      >
                        {{ m.toolCard.error }}
                      </div>
                    </div>
                  </div>
                  <pre
                    v-else
                    class="prism-code language-shell"
                  ><code><span class="token plain">{{ m.content }}</span>
 </code></pre>
                </div>

                <div
                  v-else-if="m.kind === 'channel_message'"
                  class="max-w-[min(760px,92%)]"
                >
                  <div class="rounded border border-indigo-200 dark:border-indigo-800/50 bg-indigo-50/50 dark:bg-indigo-950/20">
                    <button
                      type="button"
                      class="w-full px-4 py-2 flex items-center justify-between text-left transition-colors hover:bg-indigo-100/50 dark:hover:bg-indigo-900/20"
                      @click="toggleToolCard(m.id)"
                    >
                      <div class="flex items-center gap-2">
                        <span class="rounded-full bg-indigo-100 dark:bg-indigo-900/40 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:text-indigo-300">
                          {{ m.channelMeta?.senderId || 'agent' }}
                        </span>
                        <span class="text-xs text-slate-500 dark:text-slate-400">channel message</span>
                      </div>
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 15 15"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        class="text-slate-400 transition-transform"
                        :class="isToolCardExpanded(m.id) ? 'rotate-180' : ''"
                      >
                        <path
                          d="M3.13523 6.15803C3.3241 5.95657 3.64052 5.94637 3.84197 6.13523L7.5 9.56464L11.158 6.13523C11.3595 5.94637 11.6759 5.95657 11.8648 6.15803C12.0536 6.35949 12.0434 6.67591 11.842 6.86477L7.84197 10.6148C7.64964 10.7951 7.35036 10.7951 7.15803 10.6148L3.15803 6.86477C2.95657 6.67591 2.94637 6.35949 3.13523 6.15803Z"
                          fill="currentColor"
                          fill-rule="evenodd"
                          clip-rule="evenodd"
                        />
                      </svg>
                    </button>
                    <div
                      v-show="isToolCardExpanded(m.id)"
                      class="px-4 pb-3 text-sm text-slate-700 dark:text-slate-300"
                      v-html="renderMarkdown(m.content)"
                    />
                  </div>
                </div>

                <div
                  v-else-if="m.kind === 'thinking'"
                  class="thinking-bubble max-w-[min(760px,92%)]"
                >
                  <div class="thinking-bubble-inner">
                    <div
                      class="thinking-bubble-content text-xs text-content-muted italic"
                      v-html="renderMarkdown(m.content)"
                    />
                  </div>
                </div>

                <div
                  v-else-if="m.kind === 'html'"
                  class="max-w-[min(760px,92%)]"
                >
                  <div class="flex gap-3">
                    <div
                      class="sulla-avatar"
                      aria-hidden="true"
                    >
                      S
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="sulla-name">
                        Sulla
                      </div>
                      <HtmlMessageRenderer
                        :content="m.content"
                        :is-dark="isDark"
                      />
                    </div>
                  </div>
                </div>

                <div
                  v-else
                  class="max-w-[min(760px,92%)]"
                >
                  <div
                    v-if="m.image"
                    class="space-y-2"
                  >
                    <img
                      :src="m.image.dataUrl"
                      :alt="m.image.alt || ''"
                      class="block h-auto max-w-full rounded-xl border border-black/10 dark:border-white/10"
                    >
                    <div
                      v-if="m.image.alt"
                      class="text-xs text-content-secondary"
                    >
                      {{ m.image.alt }}
                    </div>
                  </div>
                  <div
                    v-else
                    class="flex gap-3"
                  >
                    <div
                      class="sulla-avatar"
                      aria-hidden="true"
                    >
                      S
                    </div>
                    <div>
                      <div class="sulla-name">
                        Sulla
                      </div>
                      <div
                        class="prose max-w-none prose-slate dark:text-slate-400 dark:prose-invert"
                        v-html="renderMarkdown(m.content)"
                      />
                    </div>
                  </div>
                </div>
              </div>
              <div
                v-if="loading || graphRunning"
                class="mb-3 flex items-center gap-2 px-4"
              >
                <span class="activity-dot" />
                <span class="text-sm font-bold text-secondary">{{ currentActivity || 'Thinking' }}..<span class="blink-dot">.</span></span>
              </div>
              <div
                v-if="showContinueButton"
                class="flex justify-end mb-3"
              >
                <button
                  type="button"
                  class="rounded-lg bg-content px-4 py-2 text-sm font-medium text-page shadow-sm hover:bg-surface-hover transition-colors"
                  @click="continueRun"
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Composer: in-flow below chat (not fixed) when messages exist -->
      <div
        v-if="hasMessages"
        class="flex-none border-t border-edge bg-page/80 backdrop-blur"
        :class="{ 'blur-sm pointer-events-none select-none': showOverlay }"
      >
        <div class="relative mx-auto flex w-full max-w-8xl justify-center sm:px-2 lg:px-8 xl:px-12">
          <div class="max-w-[768px] min-w-0 flex-auto px-4 lg:pr-0 lg:pl-8 xl:px-16">
            <div class="pb-3">
              <div class="flex h-full flex-col items-center">
                <AgentComposer
                  v-model="query"
                  :loading="loading"
                  :show-overlay="showOverlay"
                  :has-messages="hasMessages"
                  :graph-running="graphRunning"
                  :model-selector="modelSelector"
                  @send="send"
                  @stop="stop"
                  @primary-action="handlePrimaryAction"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Empty state: centered composer -->
      <div
        v-else
        class="flex min-h-0 flex-1 items-center justify-center bg-page"
        :class="{ 'blur-sm pointer-events-none select-none': showOverlay }"
      >
        <div class="w-full px-4">
          <div class="flex h-full flex-col items-center justify-center">
            <AgentComposer
              v-model="query"
              form-class="group/composer mx-auto mb-3 w-full max-w-3xl"
              panel-class="z-10"
              :loading="loading"
              :show-overlay="showOverlay"
              :has-messages="hasMessages"
              :graph-running="graphRunning"
              :model-selector="modelSelector"
              @send="send"
              @stop="stop"
              @primary-action="handlePrimaryAction"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import StartupOverlay from './agent/StartupOverlay.vue';
import AgentHeader from './agent/AgentHeader.vue';
import AgentComposer from './agent/AgentComposer.vue';
import PostHogTracker from '@pkg/components/PostHogTracker.vue';
import HtmlMessageRenderer from '@pkg/components/HtmlMessageRenderer.vue';

import { ref, onMounted, onUnmounted, computed, nextTick, watch } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { AgentSettingsController } from './agent/AgentSettingsController';
import { ChatInterface, type ChatMessage } from './agent/ChatInterface';
import { AgentModelSelectorController } from './agent/AgentModelSelectorController';
import { useTheme } from '@pkg/composables/useTheme';
import { getN8nVueBridgeService } from '@pkg/agent/services/N8nVueBridgeService';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { getHumanPresenceTracker } from '@pkg/agent/services/HumanPresenceTracker';
import './assets/AgentModelSelector.css';

const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|flac|m4a|aac|webm)$/i;

const audioRenderer: marked.RendererObject = {
  link({ href, text }: { href: string; text: string }) {
    if (href && AUDIO_EXTENSIONS.test(href)) {
      const fileName = text || href.split('/').pop() || 'audio';
      const mimeMap: Record<string, string> = {
        mp3:  'audio/mpeg',
        wav:  'audio/wav',
        ogg:  'audio/ogg',
        flac: 'audio/flac',
        m4a:  'audio/mp4',
        aac:  'audio/aac',
        webm: 'audio/webm',
      };
      const ext = ((AUDIO_EXTENSIONS.exec(href))?.[1] || 'mp3').toLowerCase();
      const mime = mimeMap[ext] || 'audio/mpeg';
      return `<div class="sulla-audio-player">
        <div class="sulla-audio-label">${ fileName }</div>
        <audio controls preload="metadata">
          <source src="${ href }" type="${ mime }">
        </audio>
      </div>`;
    }
    return false;
  },
};

marked.use({ renderer: audioRenderer });

const renderMarkdown = (markdown: string): string => {
  const raw = typeof markdown === 'string' ? markdown : String(markdown || '');
  const html = (marked(raw) as string) || '';
  return DOMPurify.sanitize(html, {
    USE_PROFILES:       { html: true },
    ADD_TAGS:           ['audio', 'source'],
    ADD_ATTR:           ['controls', 'preload', 'src', 'type'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file):|data:image\/(?:png|gif|jpe?g|webp);base64,|\/|\.|#)/i,
  });
};

const { isDark, toggleTheme, currentTheme, setTheme, availableThemes, themeGroups } = useTheme();
const syncN8nInterfaceTheme = (): void => {
  const n8nVueBridgeService = getN8nVueBridgeService();
  if (isDark.value) {
    n8nVueBridgeService.setDarkMode();
    return;
  }

  n8nVueBridgeService.setLightMode();
};

const showOverlay = ref(false);
const modelName = ref('');
const modelMode = ref<'local' | 'remote'>('local');
const systemReady = ref(false);

const settingsController = new AgentSettingsController(
  {
    modelName,
    modelMode,
  },
);

const chatController = new ChatInterface();

const presenceTracker = getHumanPresenceTracker();

const {
  query,
  messages,
  hasMessages,
  graphRunning,
} = chatController;

const displayMessages = computed(() => {
  return messages.value.filter((m: ChatMessage) => {
    const kind = String((m as any)?.metadata?.kind || '').trim();
    return kind !== 'action_live_n8n_event';
  });
});

const loading = chatController.loading;
const currentActivity = chatController.currentActivity;
const showContinueButton = chatController.showContinueButton;
const activeAssets = chatController.activeAssets;
const threadId = chatController.threadId;

const continueRun = () => {
  chatController.continueRun();
};

const handleModelChanged = async(event: Electron.IpcRendererEvent, data: { model: string; type: 'local' } | { model: string; type: 'remote'; provider: string }) => {
  modelName.value = data.model;
  modelMode.value = data.type;
  // Reload model selector so its internal remote refs stay in sync
  await modelSelector.start();
};

// Track expanded tool cards
const expandedToolCards = ref<Set<string>>(new Set());

function toggleToolCard(messageId: string): void {
  if (expandedToolCards.value.has(messageId)) {
    expandedToolCards.value.delete(messageId);
  } else {
    expandedToolCards.value.add(messageId);
  }
}

function isToolCardExpanded(messageId: string): boolean {
  return expandedToolCards.value.has(messageId);
}

/** Map exec-like tool names to a friendly label (like "Bash" in Claude Code) */
const EXEC_TOOL_NAMES = new Set(['exec', 'exec_command', 'shell', 'bash', 'run_command']);

function toolCardLabel(toolCard: { toolName: string }): string {
  if (EXEC_TOOL_NAMES.has(toolCard.toolName)) {
    return 'Bash';
  }
  return toolCard.toolName;
}

/** Extract the shell command from exec-like tool args */
function toolCardCommand(toolCard: { toolName: string; args?: Record<string, unknown> }): string | null {
  if (!EXEC_TOOL_NAMES.has(toolCard.toolName)) return null;
  const cmd = toolCard.args?.command ?? toolCard.args?.cmd;
  return typeof cmd === 'string' ? cmd : null;
}

/** Extract output text from a tool result */
function toolCardOutput(toolCard: { toolName: string; result?: unknown }): string | null {
  if (!toolCard.result) return null;
  const r = toolCard.result as any;
  // exec tool returns { responseString, successBoolean }
  if (typeof r.responseString === 'string' && r.responseString.trim()) {
    return r.responseString;
  }
  if (typeof r.result === 'string' && r.result.trim()) {
    return r.result;
  }
  if (typeof r === 'string' && r.trim()) {
    return r;
  }
  return null;
}

const chatScrollContainer = ref<HTMLElement | null>(null);
const autoScrollEnabled = ref(true);
const autoScrollThreshold = 140; // pixels from bottom to re-enable
let isUserScrolling = false;
let scrollTimeout: NodeJS.Timeout | null = null;

// Track user-initiated scrolling with mouse/touch events
let scrollListenersAttached = false;

function attachScrollListeners(container: HTMLElement): void {
  if (scrollListenersAttached) return;
  scrollListenersAttached = true;

  // Detect when user starts scrolling
  const startUserScroll = () => {
    isUserScrolling = true;
  };

  // Detect when user stops scrolling
  const endUserScroll = () => {
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      isUserScrolling = false;
    }, 150);
  };

  // Mouse wheel events
  container.addEventListener('wheel', startUserScroll, { passive: true });
  container.addEventListener('wheel', endUserScroll, { passive: true });

  // Touch events for mobile
  container.addEventListener('touchstart', startUserScroll, { passive: true });
  container.addEventListener('touchend', endUserScroll, { passive: true });

  // Track scroll position changes (only when user is scrolling)
  container.addEventListener('scroll', () => {
    if (!isUserScrolling) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const wasEnabled = autoScrollEnabled.value;
    autoScrollEnabled.value = distanceFromBottom <= autoScrollThreshold;

    if (wasEnabled !== autoScrollEnabled.value) {
      console.log('[Auto-Scroll] State changed:', autoScrollEnabled.value ? 'ENABLED' : 'DISABLED',
        `(${ Math.round(distanceFromBottom) }px from bottom)`);
    }
  }, { passive: true });
}

// Attach scroll listeners when container appears (may be delayed by v-if)
watch(chatScrollContainer, (container) => {
  if (container) {
    attachScrollListeners(container);
  }
});

onMounted(() => {
  if (chatScrollContainer.value) {
    attachScrollListeners(chatScrollContainer.value);
  }
});

// Auto-scroll to bottom when messages change (only if enabled)
watch(() => messages.value.length, async() => {
  await nextTick();
  const container = chatScrollContainer.value;
  if (!container) {
    return;
  }

  if (!autoScrollEnabled.value) {
    console.log('[Auto-Scroll] SKIPPED - user scrolled up, messages count:', messages.value.length);
    return;
  }

  console.log('[Auto-Scroll] Scrolling to bottom, messages count:', messages.value.length);
  container.scrollTop = container.scrollHeight; // Instant scroll, no smooth behavior
}, { flush: 'post' });

const isRunning = computed<boolean>(() => true);

const modelSelector = new AgentModelSelectorController({
  systemReady,
  loading,
  modelName,
  modelMode,
  isRunning,
});

// Listen for new-chat requests from browser tabs (NewTabWelcome)
function handleNewChatEvent(e: Event) {
  const detail = (e as CustomEvent).detail;

  chatController.newChat();
  if (detail?.query) {
    query.value = detail.query;
    nextTick(() => send());
  }
}

onMounted(async() => {
  window.addEventListener('sulla:new-chat', handleNewChatEvent);

  const n8nVueBridgeService = getN8nVueBridgeService();
  n8nVueBridgeService.markInitialized('Agent.vue:onMounted');

  // Start human presence tracker — writes presence to Redis so agents know where the human is
  presenceTracker.setCurrentView('Agent Chat');
  presenceTracker.setCurrentActivity('chatting with agent');
  presenceTracker.setActiveChannel('sulla-desktop');
  presenceTracker.start();

  // Listen for model changes from other windows
  ipcRenderer.on('model-changed', handleModelChanged);

  // Load settings eagerly — SullaSettingsModel has a disk fallback even before Redis/PG are ready
  await settingsController.start();
  await modelSelector.start();
  syncN8nInterfaceTheme();
});

// Re-sync settings when system is fully ready (bootstrap may have updated values)
watch(systemReady, async(ready) => {
  if (ready) {
    await settingsController.start();
    await modelSelector.start();
  }
});

onUnmounted(() => {
  window.removeEventListener('sulla:new-chat', handleNewChatEvent);
  presenceTracker.stop();
  modelSelector.dispose();
  chatController.dispose();
});

const send = () => {
  chatController.send();
};

const stop = () => {
  chatController.stop();
};

const handlePrimaryAction = () => {
  if (query.value.trim()) {
    send();
  }
  // Voice mode is a UI affordance for now; actual voice wiring can be added later.
};

watch(isDark, () => {
  syncN8nInterfaceTheme();
}, { immediate: true });

</script>

<style scoped>
.page-root {
  background: var(--bg-page);
  color: var(--text-primary);
}

/* Scrollbar styling for chat interface */
#chat-scroll-container::-webkit-scrollbar,
#chat-scroll-container *::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

#chat-scroll-container::-webkit-scrollbar-track,
#chat-scroll-container *::-webkit-scrollbar-track {
  background: var(--bg-surface);
  border-radius: 4px;
}

#chat-scroll-container::-webkit-scrollbar-thumb,
#chat-scroll-container *::-webkit-scrollbar-thumb {
  background: var(--bg-surface-hover);
  border-radius: 4px;
}

#chat-scroll-container::-webkit-scrollbar-thumb:hover,
#chat-scroll-container *::-webkit-scrollbar-thumb:hover {
  background: var(--border-strong);
}

#chat-scroll-container::-webkit-scrollbar-corner,
#chat-scroll-container *::-webkit-scrollbar-corner {
  background: var(--bg-surface);
}

/* Thinking bubble — no padding, no bg, no borders, gradient fade top/bottom, max 100px */
.thinking-bubble {
  position: relative;
  max-height: 100px;
  overflow: hidden;
}

.thinking-bubble-inner {
  max-height: 100px;
  overflow-y: auto;
  scrollbar-width: none;
}

.thinking-bubble-inner::-webkit-scrollbar {
  display: none;
}

.thinking-bubble::before,
.thinking-bubble::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 16px;
  pointer-events: none;
  z-index: 1;
}

.thinking-bubble::before {
  top: 0;
  background: linear-gradient(to bottom, color-mix(in srgb, var(--bg-page) 90%, transparent), transparent);
}

.thinking-bubble::after {
  bottom: 0;
  background: linear-gradient(to top, color-mix(in srgb, var(--bg-page) 90%, transparent), transparent);
}

.thinking-bubble-content :deep(p) {
  margin: 0;
}

/* ── Inline Audio Player ── */
.prose :deep(.sulla-audio-player) {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  margin: 6px 0;
  border-radius: 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
}

.prose :deep(.sulla-audio-label) {
  font-size: var(--fs-code);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
  flex-shrink: 0;
}

.prose :deep(.sulla-audio-player audio) {
  flex: 1;
  min-width: 0;
  height: 36px;
}

.prose :deep(.sulla-audio-player audio::-webkit-media-controls-panel) {
  background: transparent;
}

/* ── Claude Code-style tool card ── */
.tool-card-cc {
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-page);
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--fs-code);
}

.tool-card-cc-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
  color: var(--text-primary);
  text-align: left;
}

.tool-card-cc-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.tool-card-cc-dot.running { background: var(--status-warning); animation: dotPulse 1.5s ease-in-out infinite; }
.tool-card-cc-dot.success { background: var(--status-success); }
.tool-card-cc-dot.failed  { background: var(--status-error); }

@keyframes dotPulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

.tool-card-cc-name {
  font-weight: var(--weight-bold);
  font-size: var(--fs-code);
  color: var(--text-primary);
}

.tool-card-cc-desc {
  font-weight: var(--weight-normal);
  font-size: var(--fs-code);
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-card-cc-chevron {
  color: var(--text-muted);
  transition: transform 0.15s ease;
  flex-shrink: 0;
  margin-left: auto;
}
.tool-card-cc-chevron.open {
  transform: rotate(180deg);
}

.tool-card-cc-cmd {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 2px 12px 2px 20px;
  font-size: var(--fs-body-sm);
}

.tool-card-cc-cmd-label {
  font-size: var(--fs-caption);
  font-weight: var(--weight-bold);
  color: var(--text-muted);
  text-transform: uppercase;
  flex-shrink: 0;
  min-width: 24px;
}

.tool-card-cc-cmd-text {
  color: var(--text-secondary);
  word-break: break-all;
  white-space: pre-wrap;
}

.tool-card-cc-exit.success { color: var(--status-success); }
.tool-card-cc-exit.failed  { color: var(--status-error); }

.tool-card-cc-body {
  border-top: 1px solid var(--border-default);
  margin: 6px 0 0;
}

.tool-card-cc-output {
  padding: 8px 12px;
}
.tool-card-cc-output pre {
  margin: 0;
  padding: 0;
  background: none;
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow-y: auto;
}

.tool-card-cc-section-label {
  font-size: var(--fs-caption);
  font-weight: var(--weight-bold);
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 4px;
}

.tool-card-cc-error {
  padding: 8px 12px;
  font-size: var(--fs-body-sm);
  color: var(--status-error);
}

.activity-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-primary);
  animation: activityPulse 1.5s ease-in-out infinite;
  flex-shrink: 0;
}

.blink-dot {
  animation: blinkDot 1s step-end infinite;
}

@keyframes blinkDot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

@keyframes activityPulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

</style>
