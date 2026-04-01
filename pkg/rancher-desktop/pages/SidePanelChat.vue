<template>
  <div class="flex h-screen flex-col bg-page" :class="{ dark: isDark }">
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-edge px-3 py-2">
      <div class="flex items-center gap-2">
        <div class="sulla-avatar text-xs" aria-hidden="true">S</div>
        <span class="text-sm font-medium text-content">Sulla</span>
      </div>
      <button
        type="button"
        class="rounded p-1 text-content-muted hover:bg-surface-hover hover:text-content transition-colors"
        title="Close side panel"
        @click="closePanel"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>

    <!-- Tab context banner -->
    <div v-if="tabContext" class="flex items-center gap-2 border-b border-edge px-3 py-1.5 bg-surface-alt/50">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="flex-shrink-0 text-content-muted">
        <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
      </svg>
      <div class="min-w-0 flex-1 truncate text-xs text-content-muted" :title="tabContext.url">
        {{ tabContext.title || tabContext.url }}
      </div>
    </div>

    <!-- Chat messages -->
    <div
      v-if="hasMessages"
      ref="chatScrollContainer"
      class="min-h-0 flex-1 overflow-y-auto"
    >
      <div class="px-3 py-4">
        <div ref="transcriptEl" class="pb-4">
          <div
            v-for="m in displayMessages"
            :key="m.id"
            class="mb-4"
          >
            <div v-if="m.role === 'user'" class="flex justify-end">
              <div class="max-w-[92%] rounded-2xl p-3 bg-surface-alt ring-1 ring-edge-subtle">
                <img
                  v-if="m.image?.dataUrl"
                  :src="m.image.dataUrl"
                  :alt="m.image.alt || 'Attached image'"
                  class="mb-2 max-h-48 rounded-lg object-contain"
                >
                <div class="whitespace-pre-wrap text-sm text-content">{{ m.content }}</div>
              </div>
            </div>

            <div v-else-if="m.kind === 'tool' && m.toolCard" class="max-w-[92%]">
              <ChatToolCard :tool-card="m.toolCard" />
            </div>

            <div v-else-if="m.kind === 'thinking'" class="thinking-bubble max-w-[92%]">
              <div class="thinking-bubble-inner">
                <div class="thinking-bubble-content text-xs text-content-muted italic" v-html="renderMarkdown(m.content)" />
              </div>
            </div>

            <div v-else-if="m.kind === 'streaming'" class="max-w-[92%]">
              <div class="flex gap-2">
                <div class="sulla-avatar text-xs flex-shrink-0" aria-hidden="true">S</div>
                <div class="min-w-0">
                  <div class="prose prose-sm max-w-none prose-slate dark:text-slate-400 dark:prose-invert" v-html="renderMarkdown(m.content)" /><span class="streaming-cursor" />
                </div>
              </div>
            </div>

            <div v-else-if="m.kind === 'html'" class="max-w-[92%]">
              <div class="flex gap-2">
                <div class="sulla-avatar text-xs flex-shrink-0" aria-hidden="true">S</div>
                <div class="flex-1 min-w-0">
                  <HtmlMessageRenderer :content="m.content" :is-dark="isDark" />
                </div>
              </div>
            </div>

            <div v-else class="max-w-[92%]">
              <div v-if="m.image" class="space-y-2">
                <img :src="m.image.dataUrl" :alt="m.image.alt || ''" class="block h-auto max-w-full rounded-lg border border-black/10 dark:border-white/10">
              </div>
              <div v-else class="flex gap-2">
                <div class="sulla-avatar text-xs flex-shrink-0" aria-hidden="true">S</div>
                <div class="min-w-0">
                  <div class="prose prose-sm max-w-none prose-slate dark:text-slate-400 dark:prose-invert" v-html="renderMarkdown(m.content)" />
                </div>
              </div>
            </div>
          </div>

          <!-- Thinking indicator -->
          <div v-if="loading || graphRunning" class="mb-3 flex items-center gap-2 px-1">
            <div class="typing-dots">
              <span class="typing-dot" />
              <span class="typing-dot" />
              <span class="typing-dot" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div v-else class="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4">
      <div class="text-center text-sm text-content-muted">
        <div class="sulla-avatar mx-auto mb-3 text-lg" aria-hidden="true">S</div>
        <p>Ask Sulla anything</p>
      </div>
    </div>

    <!-- Composer -->
    <div class="flex-none border-t border-edge bg-page/80 backdrop-blur px-3 py-2">
      <AgentComposer
        ref="composerRef"
        v-model="query"
        :loading="loading"
        :show-overlay="false"
        :has-messages="hasMessages"
        :graph-running="graphRunning"
        :tts-playing="false"
        :is-recording="false"
        :audio-level="0"
        :recording-duration="0"
        :voice-configured="false"
        :model-selector="modelSelector"
        @send="sendWithAttachments"
        @stop="stop"
        @primary-action="handlePrimaryAction"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import AgentComposer from './agent/AgentComposer.vue';
import HtmlMessageRenderer from '@pkg/components/HtmlMessageRenderer.vue';
import ChatToolCard from '@pkg/components/ChatToolCard.vue';
import { ChatInterface, type ChatMessage } from './agent/ChatInterface';
import { useTheme } from '@pkg/composables/useTheme';
import { AgentModelSelectorController } from './agent/AgentModelSelectorController';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const { isDark } = useTheme();

// Read tab ID from URL hash (e.g. #tabId=abc123) so each tab's panel has its own chat thread
const hashParams = new URLSearchParams(window.location.hash.slice(1));
const panelTabId = hashParams.get('tabId') || 'side-panel';

const chatController = new ChatInterface('sulla-desktop', `side-panel-${ panelTabId }`);

if (!chatController.threadId.value) {
  chatController.newChat();
}

const { query, messages, hasMessages, graphRunning } = chatController;
const loading = chatController.loading;

// Model selector
const modelName = ref('');
const modelMode = ref<'local' | 'remote'>('local');
const systemReady = ref(true);
const isRunning = computed<boolean>(() => true);

const modelSelector = new AgentModelSelectorController({
  systemReady,
  loading,
  modelName,
  modelMode,
  isRunning,
});

const displayMessages = computed(() => {
  return messages.value.filter((m: ChatMessage) => {
    if (m.kind === 'speak') return false;
    if (m.role === 'assistant' && !m.content?.trim() && !m.image && !m.toolCard) return false;
    return true;
  });
});

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

const composerRef = ref<InstanceType<typeof AgentComposer> | null>(null);

const send = () => {
  chatController.send();
};

const sendWithAttachments = () => {
  const attachments = composerRef.value?.consumeAttachments?.() || [];
  chatController.send(undefined, attachments.length > 0 ? attachments : undefined);
};

const stop = () => {
  chatController.stop();
};

const handlePrimaryAction = () => {
  if (query.value.trim()) send();
};

function closePanel() {
  ipcRenderer.invoke('chrome-api:sidePanel:close', {});
}

// Auto-scroll
const chatScrollContainer = ref<HTMLElement | null>(null);

watch(
  () => messages.value.length,
  () => {
    nextTick(() => {
      if (chatScrollContainer.value) {
        chatScrollContainer.value.scrollTop = chatScrollContainer.value.scrollHeight;
      }
    });
  },
);

// Tab context from the most recent prompt
const tabContext = ref<{ url: string; title: string } | null>(null);

// Listen for prompts from main process (rich payload or legacy string).
// Register BEFORE any async work so the listener is ready when sendPrompt fires.
console.log('[SidePanelChat] Registering side-panel:set-prompt listener');

ipcRenderer.on('side-panel:set-prompt' as any, (_event: unknown, payload: string | { prompt: string; tab?: { url: string; title: string }; selectionText?: string; attachments?: Array<{ mediaType: string; base64: string }> }) => {
  console.log('[SidePanelChat] Received prompt payload:', typeof payload, typeof payload === 'string' ? payload.slice(0, 80) : JSON.stringify(payload).slice(0, 200));
  const data = typeof payload === 'string' ? { prompt: payload } : payload;

  if (!data.prompt?.trim()) return;

  // Start a fresh thread for each new context menu action
  chatController.newChat();

  // Store tab context for display
  if (data.tab) {
    tabContext.value = data.tab;
  }

  query.value = data.prompt;

  // Send with attachments if present (e.g. screenshots)
  if (data.attachments?.length) {
    nextTick(() => {
      chatController.send(undefined, data.attachments);
    });
  } else {
    nextTick(() => send());
  }
});

onMounted(async () => {
  await modelSelector.start();
});

onUnmounted(() => {
  ipcRenderer.removeAllListeners('side-panel:set-prompt');
  modelSelector.dispose();
});
</script>

<style scoped>
.bg-page {
  background: var(--bg-page, #0d1117);
}

.text-content {
  color: var(--text-content, #c9d1d9);
}

.text-content-muted {
  color: var(--text-content-muted, #484f58);
}

.border-edge {
  border-color: var(--border-edge, #30363d);
}

.bg-surface-alt {
  background: var(--bg-surface-alt, #161b22);
}

.ring-edge-subtle {
  --tw-ring-color: var(--border-edge-subtle, #21262d);
}

.sulla-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: linear-gradient(135deg, #3a6d8c, #6b9dc2);
  color: #fff;
  font-weight: 700;
  font-size: 11px;
}

.typing-dots {
  display: flex;
  gap: 4px;
  align-items: center;
}

.typing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-content-muted, #484f58);
  animation: typing-bounce 1.4s infinite ease-in-out both;
}

.typing-dot:nth-child(1) { animation-delay: -0.32s; }
.typing-dot:nth-child(2) { animation-delay: -0.16s; }

@keyframes typing-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

.streaming-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--text-content, #c9d1d9);
  margin-left: 2px;
  animation: cursor-blink 1s step-end infinite;
  vertical-align: text-bottom;
}

@keyframes cursor-blink {
  50% { opacity: 0; }
}

.thinking-bubble {
  padding: 8px 12px;
  border-left: 2px solid var(--border-edge, #30363d);
  margin-left: 4px;
}
</style>
