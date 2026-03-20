<template>
  <div class="flex h-full flex-col bg-page" @contextmenu.prevent="onContextMenu">
    <ChatContextMenu ref="chatContextMenu" @new-chat="openNewChat" />
    <!-- Chat messages -->
    <div
      v-if="hasMessages"
      ref="chatScrollContainer"
      class="min-h-0 flex-1 overflow-y-auto"
    >
      <div class="relative mx-auto flex w-full max-w-8xl xl:px-12 sm:px-2 lg:px-8 justify-center">
        <div class="min-w-0 py-16 max-w-[768px] flex-auto px-4 lg:pr-0 lg:pl-8 xl:px-16">
          <div ref="transcriptEl" class="pb-8">
            <div
              v-for="m in displayMessages"
              :key="m.id"
              class="mb-8"
            >
              <div v-if="m.role === 'user'" class="flex justify-end">
                <div class="max-w-[min(760px,92%)] rounded-3xl p-6 bg-surface-alt ring-1 ring-edge-subtle">
                  <div class="whitespace-pre-wrap text-content">{{ m.content }}</div>
                </div>
              </div>

              <div v-else-if="m.kind === 'tool'" class="max-w-[min(760px,92%)]">
                <div
                  v-if="m.toolCard"
                  class="tool-card-cc"
                  :class="{ expanded: expandedToolCards.has(m.id) }"
                >
                  <button type="button" class="tool-card-cc-header" @click="toggleToolCard(m.id)">
                    <span class="tool-card-cc-dot" :class="m.toolCard.status" />
                    <span class="tool-card-cc-name">{{ m.toolCard.label || m.toolCard.toolName }}</span>
                    <span class="tool-card-cc-desc">{{ m.toolCard.description || m.toolCard.summary || '' }}</span>
                    <svg width="14" height="14" viewBox="0 0 15 15" fill="none" class="tool-card-cc-chevron" :class="{ open: expandedToolCards.has(m.id) }">
                      <path d="M3.13523 6.15803C3.3241 5.95657 3.64052 5.94637 3.84197 6.13523L7.5 9.56464L11.158 6.13523C11.3595 5.94637 11.6759 5.95657 11.8648 6.15803C12.0536 6.35949 12.0434 6.67591 11.842 6.86477L7.84197 10.6148C7.64964 10.7951 7.35036 10.7951 7.15803 10.6148L3.15803 6.86477C2.95657 6.67591 2.94637 6.35949 3.13523 6.15803Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" />
                    </svg>
                  </button>
                  <div v-if="m.toolCard.input" class="tool-card-cc-cmd">
                    <span class="tool-card-cc-cmd-label">IN</span>
                    <code class="tool-card-cc-cmd-text">{{ m.toolCard.input }}</code>
                  </div>
                  <div v-if="m.toolCard.status !== 'running' && m.toolCard.input" class="tool-card-cc-cmd">
                    <span class="tool-card-cc-cmd-label">OUT</span>
                    <code class="tool-card-cc-cmd-text tool-card-cc-exit" :class="m.toolCard.status">{{ m.toolCard.status === 'success' ? '0' : '1' }}</code>
                  </div>
                  <div v-show="expandedToolCards.has(m.id)" class="tool-card-cc-body">
                    <div v-if="m.toolCard.output" class="tool-card-cc-output">
                      <pre>{{ m.toolCard.output }}</pre>
                    </div>
                    <div v-if="!m.toolCard.output && !m.toolCard.input && m.toolCard.args && Object.keys(m.toolCard.args).length > 0" class="tool-card-cc-output">
                      <div class="tool-card-cc-section-label">Arguments</div>
                      <pre>{{ JSON.stringify(m.toolCard.args, null, 2) }}</pre>
                    </div>
                    <div v-if="!m.toolCard.output && !m.toolCard.input && m.toolCard.result !== undefined" class="tool-card-cc-output">
                      <div class="tool-card-cc-section-label">Result</div>
                      <pre>{{ typeof m.toolCard.result === 'string' ? m.toolCard.result : JSON.stringify(m.toolCard.result, null, 2) }}</pre>
                    </div>
                    <div v-if="m.toolCard.error" class="tool-card-cc-error">{{ m.toolCard.error }}</div>
                  </div>
                </div>
              </div>

              <SubAgentBubble
                v-else-if="m.kind === 'sub_agent_activity' && m.subAgentActivity"
                :activity="m.subAgentActivity"
                :is-dark="isDark"
              />

              <div v-else-if="m.kind === 'thinking'" class="thinking-bubble max-w-[min(760px,92%)]">
                <div class="thinking-bubble-inner">
                  <div class="thinking-bubble-content text-xs text-content-muted italic" v-html="renderMarkdown(m.content)" />
                </div>
              </div>

              <div v-else-if="m.kind === 'html'" class="max-w-[min(760px,92%)]">
                <div class="flex gap-3">
                  <div class="sulla-avatar" aria-hidden="true">S</div>
                  <div class="flex-1 min-w-0">
                    <div class="sulla-name">Sulla</div>
                    <HtmlMessageRenderer :content="m.content" :is-dark="isDark" />
                  </div>
                </div>
              </div>

              <div v-else class="max-w-[min(760px,92%)]">
                <div v-if="m.image" class="space-y-2">
                  <img :src="m.image.dataUrl" :alt="m.image.alt || ''" class="block h-auto max-w-full rounded-xl border border-black/10 dark:border-white/10">
                  <div v-if="m.image.alt" class="text-xs text-content-secondary">{{ m.image.alt }}</div>
                </div>
                <div v-else class="flex gap-3">
                  <div class="sulla-avatar" aria-hidden="true">S</div>
                  <div>
                    <div class="sulla-name">Sulla</div>
                    <div class="prose max-w-none prose-slate dark:text-slate-400 dark:prose-invert" v-html="renderMarkdown(m.content)" />
                  </div>
                </div>
              </div>
            </div>
            <div v-if="loading || graphRunning" class="mb-3 flex items-center gap-2 px-4">
              <span class="activity-dot" />
              <span class="text-sm font-bold text-secondary">{{ currentActivity || 'Thinking' }}..<span class="blink-dot">.</span></span>
            </div>
            <div v-if="showContinueButton" class="flex justify-end mb-3">
              <button type="button" class="rounded-lg bg-content px-4 py-2 text-sm font-medium text-page shadow-sm hover:bg-surface-hover transition-colors" @click="continueRun">Continue</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Composer: docked at bottom when messages exist -->
    <div
      v-if="hasMessages"
      class="flex-none border-t border-edge bg-page/80 backdrop-blur"
    >
      <div class="relative mx-auto flex w-full max-w-8xl justify-center sm:px-2 lg:px-8 xl:px-12">
        <div class="max-w-[768px] min-w-0 flex-auto px-4 lg:pr-0 lg:pl-8 xl:px-16">
          <div class="pb-3">
            <div class="flex h-full flex-col items-center">
              <AgentComposer
                v-model="query"
                :loading="loading"
                :show-overlay="false"
                :has-messages="hasMessages"
                :graph-running="graphRunning"
                :model-selector="modelSelector"
                @send="send"
                @stop="stop"
                @primary-action="handlePrimaryAction"
                @voice-recorded="handleVoiceRecorded"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty state: editorial landing -->
    <div v-else class="flex min-h-0 flex-1 overflow-y-auto bg-page">
      <div class="w-full min-h-full px-4">
        <ChatOptionsVariantB
          v-model:query="query"
          :loading="loading"
          :graph-running="graphRunning"
          :model-selector="modelSelector"
          :is-first-chat="isFirstChat"
          @send="send"
          @stop="stop"
          @primary-action="handlePrimaryAction"
          @voice-recorded="handleVoiceRecorded"
          @pick="(mode: string) => emit('set-mode', mode as BrowserTabMode)"
          @start-onboarding="startOnboarding"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import AgentComposer from './agent/AgentComposer.vue';
import ChatContextMenu from './chat/ChatContextMenu.vue';
import ChatOptionsVariantB from './chat-options/ChatOptionsVariantB.vue';
import HtmlMessageRenderer from '@pkg/components/HtmlMessageRenderer.vue';
import SubAgentBubble from './editor/workflow/SubAgentBubble.vue';
import { ChatInterface, type ChatMessage } from './agent/ChatInterface';
import { useTheme } from '@pkg/composables/useTheme';
import { AgentModelSelectorController } from './agent/AgentModelSelectorController';
import { useBrowserTabs, type BrowserTabMode } from '@pkg/composables/useBrowserTabs';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{
  tabId: string;
}>();

const emit = defineEmits<{
  'set-mode': [mode: BrowserTabMode];
}>();

const { updateTab } = useBrowserTabs();

/**
 * Generate a short tab title from the user's first message — no LLM required.
 * Grabs the first meaningful sentence/phrase and truncates to ~40 chars.
 */
function generateChatTitle(text: string): string {
  // Collapse whitespace and trim
  let t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 'New Chat';

  // Use only the first line / sentence
  const firstLine = t.split(/[.\n!?]/)[0].trim();
  if (firstLine) t = firstLine;

  // Truncate at a word boundary around 40 chars
  const MAX = 40;
  if (t.length > MAX) {
    const cut = t.lastIndexOf(' ', MAX);
    t = `${ t.slice(0, cut > 10 ? cut : MAX) }\u2026`;
  }

  return t || 'New Chat';
}

// Each tab gets its own ChatInterface keyed by tabId for independent
// localStorage (messages, threadId) while sharing the 'sulla-desktop' WS channel.
const chatController = new ChatInterface('sulla-desktop', props.tabId);

// Start with a fresh thread only if this tab has no persisted thread yet.
// If the tab already has a stored threadId it will be restored automatically.
if (!chatController.threadId.value) {
  chatController.newChat();
}

// Update the tab title from the first user message (one-shot watcher)
let titleSet = chatController.messages.value.some(m => m.role === 'user');
if (!titleSet) {
  const stopTitleWatch = watch(
    () => chatController.messages.value,
    (msgs) => {
      const firstUser = msgs.find(m => m.role === 'user');
      if (firstUser && firstUser.content) {
        updateTab(props.tabId, { title: generateChatTitle(firstUser.content) });
        stopTitleWatch();
      }
    },
    { deep: true },
  );
}

const { isDark } = useTheme();

const chatContextMenu = ref<InstanceType<typeof ChatContextMenu> | null>(null);

function onContextMenu(event: MouseEvent) {
  // Walk up from the click target to find the nearest message bubble
  let msgContent = '';
  let el = event.target as HTMLElement | null;

  while (el && !el.classList.contains('flex-col')) {
    // User message bubble
    if (el.classList.contains('whitespace-pre-wrap')) {
      msgContent = el.textContent?.trim() ?? '';
      break;
    }
    // Assistant prose block
    if (el.classList.contains('prose')) {
      msgContent = el.textContent?.trim() ?? '';
      break;
    }
    el = el.parentElement;
  }

  chatContextMenu.value?.show(event, msgContent);
}

function openNewChat() {
  emit('set-mode', 'chat');
}
const { query, messages, hasMessages, graphRunning } = chatController;
const loading = chatController.loading;
const currentActivity = chatController.currentActivity;
const showContinueButton = chatController.showContinueButton;

// Model selector — shares the same global model settings
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

// First-chat detection — show onboarding card when user has never chatted
const isFirstChat = ref(false);
async function checkFirstChat(): Promise<void> {
  try {
    isFirstChat.value = await ipcRenderer.invoke('check-first-chat');
  } catch {
    isFirstChat.value = false;
  }
}

function startOnboarding(): void {
  isFirstChat.value = false;
  ipcRenderer.invoke('mark-first-chat-complete');
  query.value = 'I\'m new here — help me set my goals and get to know how I work best.';
  nextTick(() => send());
}

const displayMessages = computed(() => {
  return messages.value.filter((m: ChatMessage) => {
    const kind = String((m as any)?.metadata?.kind || '').trim();

    if (kind === 'action_live_n8n_event') {
      return false;
    }

    // Speak messages are handled by TTS playback, not displayed in chat
    if (m.kind === 'speak') {
      return false;
    }

    // Silence assistant messages with no displayable content
    if (m.role === 'assistant' && !m.content?.trim() && !m.image && !m.toolCard && !m.subAgentActivity && !m.workflowNode && !m.channelMeta) {
      console.log('[BrowserTabChat] Silenced empty assistant message:', JSON.stringify(m));

      return false;
    }

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

const send = (metadata?: Record<string, unknown>) => {
  if (isFirstChat.value) {
    isFirstChat.value = false;
    ipcRenderer.invoke('mark-first-chat-complete');
  }
  chatController.send(metadata);
};
const stop = () => chatController.stop();
const continueRun = () => chatController.continueRun();
const handlePrimaryAction = () => {
  if (query.value.trim()) send();
};

const transcribing = ref(false);

const handleVoiceRecorded = async(audio: Blob, mimeType: string) => {
  if (transcribing.value) return;
  transcribing.value = true;

  try {
    const arrayBuffer = await audio.arrayBuffer();
    const result = await ipcRenderer.invoke('audio-transcribe', { audio: arrayBuffer, mimeType });

    if (result?.text?.trim()) {
      query.value = result.text.trim();
      await nextTick();
      send({ inputSource: 'microphone' });
    }
  } catch (err: any) {
    console.error('[BrowserTabChat] Transcription failed:', err);
    // Surface error as a user-visible message in the chat
    query.value = `[Transcription error: ${ err?.message || 'Unknown error' }]`;
  } finally {
    transcribing.value = false;
  }
};

// ─── TTS Playback ────────────────────────────────────────────
// Watch for speak messages arriving in the message stream and play them via ElevenLabs TTS.
const ttsQueue: string[] = [];
let ttsPlaying = false;
const processedSpeakIds = new Set<string>();

async function playNextTTS(): Promise<void> {
  if (ttsPlaying || ttsQueue.length === 0) return;
  ttsPlaying = true;

  const text = ttsQueue.shift()!;
  try {
    const result = await ipcRenderer.invoke('audio-speak', { text });
    if (result?.audio) {
      const blob = new Blob([result.audio], { type: result.mimeType || 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      await new Promise<void>((resolve) => {
        audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
        audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
        audio.play().catch(() => resolve());
      });
    }
  } catch (err) {
    console.error('[BrowserTabChat] TTS playback failed:', err);
  } finally {
    ttsPlaying = false;
    playNextTTS(); // Process next in queue
  }
}

watch(messages, (msgs) => {
  for (const m of msgs) {
    if (m.kind === 'speak' && m.content?.trim() && !processedSpeakIds.has(m.id)) {
      processedSpeakIds.add(m.id);
      ttsQueue.push(m.content.trim());
      playNextTTS();
    }
  }
}, { deep: true });

// Tool card helpers
const expandedToolCards = ref<Set<string>>(new Set());
function toggleToolCard(id: string) {
  if (expandedToolCards.value.has(id)) {
    expandedToolCards.value.delete(id);
  } else {
    expandedToolCards.value.add(id);
  }
}


// Auto-scroll
const chatScrollContainer = ref<HTMLElement | null>(null);
const autoScrollEnabled = ref(true);
let isUserScrolling = false;
let scrollTimeout: NodeJS.Timeout | null = null;

function attachScrollListeners(container: HTMLElement) {
  const startScroll = () => { isUserScrolling = true; };
  const endScroll = () => {
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => { isUserScrolling = false; }, 150);
  };
  container.addEventListener('wheel', startScroll, { passive: true });
  container.addEventListener('wheel', endScroll, { passive: true });
  container.addEventListener('touchstart', startScroll, { passive: true });
  container.addEventListener('touchend', endScroll, { passive: true });
  container.addEventListener('scroll', () => {
    if (!isUserScrolling) return;
    const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
    autoScrollEnabled.value = dist <= 140;
  }, { passive: true });
}

watch(chatScrollContainer, (el) => { if (el) attachScrollListeners(el); });
onMounted(async () => {
  if (chatScrollContainer.value) attachScrollListeners(chatScrollContainer.value);
  await modelSelector.start();
  checkFirstChat();
});

watch(() => messages.value.length, async () => {
  await nextTick();
  const container = chatScrollContainer.value;
  if (!container || !autoScrollEnabled.value) return;
  container.scrollTop = container.scrollHeight;
}, { flush: 'post' });

onUnmounted(() => {
  chatController.dispose();
  modelSelector.dispose();
});
</script>

<style scoped>
/* ── Thinking indicator ── */
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

/* ── Thinking bubble ── */
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
</style>
