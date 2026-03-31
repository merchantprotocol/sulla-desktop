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
              <div v-if="m.kind === 'voice_interim'" class="flex justify-end">
                <div class="max-w-[min(760px,92%)] rounded-3xl p-6 bg-surface-alt ring-1 ring-edge-subtle opacity-70">
                  <div class="whitespace-pre-wrap text-content italic">
                    <span class="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse mr-2 align-middle" />{{ m.content }}
                  </div>
                </div>
              </div>
              <div v-else-if="m.role === 'user'" class="flex justify-end">
                <div class="max-w-[min(760px,92%)] rounded-3xl p-6 bg-surface-alt ring-1 ring-edge-subtle">
                  <img
                    v-if="m.image?.dataUrl"
                    :src="m.image.dataUrl"
                    :alt="m.image.alt || 'Attached image'"
                    class="mb-2 max-h-64 rounded-xl object-contain"
                  >
                  <div class="whitespace-pre-wrap text-content">{{ m.content }}</div>
                </div>
              </div>

              <div v-else-if="m.kind === 'tool' && m.toolCard" class="max-w-[min(760px,92%)]">
                <ChatToolCard :tool-card="m.toolCard" />
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

              <div v-else-if="m.kind === 'streaming'" class="max-w-[min(760px,92%)]">
                <div class="flex gap-3">
                  <div class="sulla-avatar dark:text-slate-400" aria-hidden="true">S</div>
                  <div>
                    <div class="sulla-name dark:text-slate-400">Sulla</div>
                    <div class="prose max-w-none prose-slate dark:text-slate-400 dark:prose-invert" v-html="renderMarkdown(m.content)" /><span class="streaming-cursor" />
                  </div>
                </div>
              </div>

              <div v-else-if="m.kind === 'html'" class="max-w-[min(760px,92%)]">
                <div class="flex gap-3">
                  <div class="sulla-avatar dark:text-slate-400" aria-hidden="true">S</div>
                  <div class="flex-1 min-w-0">
                    <div class="sulla-name dark:text-slate-400">Sulla</div>
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
                  <div class="sulla-avatar dark:text-slate-400" aria-hidden="true">S</div>
                  <div>
                    <div class="sulla-name dark:text-slate-400">Sulla</div>
                    <div class="prose max-w-none prose-slate dark:text-slate-400 dark:prose-invert" v-html="renderMarkdown(m.content)" />
                  </div>
                </div>
              </div>
            </div>

            <!-- Queued Messages (like Windsurf) -->
            <div v-if="hasQueuedMessages" class="mb-6 space-y-2">
              <div class="flex items-center gap-2 px-4 mb-2">
                <div class="text-xs font-medium text-content-secondary uppercase tracking-wide">
                  Pending ({{ queuedMessageCount }})
                </div>
                <div class="flex-1 h-px bg-edge" />
                <button
                  type="button"
                  class="text-xs text-content-muted hover:text-content-secondary transition-colors"
                  @click="clearQueue"
                >
                  Clear all
                </button>
              </div>
              <div
                v-for="(msg, idx) in queuedMessages"
                :key="msg.id"
                class="flex justify-end"
              >
                <div class="max-w-[min(760px,92%)] rounded-2xl p-4 bg-surface-alt/50 ring-1 ring-edge-subtle/50 border border-dashed border-edge">
                  <div class="flex items-start gap-3">
                    <div class="flex-1 min-w-0">
                      <div class="whitespace-pre-wrap text-content/70 text-sm">{{ msg.content }}</div>
                      <div v-if="msg.attachments?.length" class="mt-2 flex gap-1">
                        <span
                          v-for="att in msg.attachments"
                          :key="att.name"
                          class="text-xs text-content-muted"
                        >
                          📎 {{ att.name }}
                        </span>
                      </div>
                    </div>
                    <div class="flex items-center gap-1">
                      <button
                        v-if="idx > 0"
                        type="button"
                        class="p-1 rounded text-content-muted hover:text-content hover:bg-surface-hover transition-colors"
                        title="Move up"
                        @click="moveQueuedMessageUp(msg.id)"
                      >
                        <svg width="12" height="12" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M7.14645 2.14645C7.34171 1.95118 7.65829 1.95118 7.85355 2.14645L11.8536 6.14645C12.0488 6.34171 12.0488 6.65829 11.8536 6.85355C11.6583 7.04882 11.3417 7.04882 11.1464 6.85355L8 3.70711L8 12.5C8 12.7761 7.77614 13 7.5 13C7.22386 13 7 12.7761 7 12.5L7 3.70711L3.85355 6.85355C3.65829 7.04882 3.34171 7.04882 3.14645 6.85355C2.95118 6.65829 2.95118 6.34171 3.14645 6.14645L7.14645 2.14645Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"/>
                        </svg>
                      </button>
                      <button
                        v-if="idx < queuedMessages.length - 1"
                        type="button"
                        class="p-1 rounded text-content-muted hover:text-content hover:bg-surface-hover transition-colors"
                        title="Move down"
                        @click="moveQueuedMessageDown(msg.id)"
                      >
                        <svg width="12" height="12" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" style="transform: rotate(180deg)">
                          <path d="M7.14645 2.14645C7.34171 1.95118 7.65829 1.95118 7.85355 2.14645L11.8536 6.14645C12.0488 6.34171 12.0488 6.65829 11.8536 6.85355C11.6583 7.04882 11.3417 7.04882 11.1464 6.85355L8 3.70711L8 12.5C8 12.7761 7.77614 13 7.5 13C7.22386 13 7 12.7761 7 12.5L7 3.70711L3.85355 6.85355C3.65829 7.04882 3.34171 7.04882 3.14645 6.85355C2.95118 6.65829 2.95118 6.34171 3.14645 6.14645L7.14645 2.14645Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"/>
                        </svg>
                      </button>
                      <button
                        type="button"
                        class="p-1 rounded text-content-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
                        title="Remove from queue"
                        @click="removeQueuedMessage(msg.id)"
                      >
                        <svg width="12" height="12" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M11.7816 4.03157C12.0724 3.74081 12.0724 3.25991 11.7816 2.96915C11.4909 2.67839 11.0099 2.67839 10.7192 2.96915L7.50005 6.18827L4.28091 2.96915C3.99015 2.67839 3.50925 2.67839 3.21849 2.96915C2.92773 3.25991 2.92773 3.74081 3.21849 4.03157L6.43761 7.25071L3.21849 10.4698C2.92773 10.7606 2.92773 11.2415 3.21849 11.5323C3.50925 11.823 3.99015 11.823 4.28091 11.5323L7.50005 8.31315L10.7192 11.5323C11.0099 11.823 11.4909 11.823 11.7816 11.5323C12.0724 11.2415 12.0724 10.7606 11.7816 10.4698L8.56248 7.25071L11.7816 4.03157Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Thinking indicator (graph running, not TTS) -->
            <div v-if="loading || (graphRunning && !isTTSPlaying)" class="mb-3 flex items-center gap-2 px-4">
              <div class="typing-dots">
                <span class="typing-dot" />
                <span class="typing-dot" />
                <span class="typing-dot" />
              </div>
            </div>
            <!-- Sulla speaking indicator -->
            <div v-if="isTTSPlaying" class="mb-3 flex items-center gap-2 px-4">
              <div class="sulla-speaking-indicator flex items-center gap-1.5 text-xs font-medium" style="color: var(--text-muted);">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" />
                  <path class="sulla-wave sulla-wave-1" d="M15.54 8.46a5 5 0 0 1 0 7.07" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" />
                  <path class="sulla-wave sulla-wave-2" d="M18.07 5.93a9 9 0 0 1 0 12.73" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" />
                </svg>
                <span>Sulla is speaking...</span>
              </div>
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
          <div class="py-3">
            <div class="flex h-full flex-col items-center">
              <AgentComposer
                ref="composerRef"
                v-model="query"
                :loading="loading"
                :show-overlay="false"
                :has-messages="hasMessages"
                :graph-running="graphRunning"
                :tts-playing="isTTSPlaying"
                :is-recording="isRecording"
                :audio-level="audioLevel"
                :recording-duration="recordingDuration"
                :voice-configured="isVoiceConfigured"
                :model-selector="modelSelector"
                @send="sendWithAttachments"
                @stop="stop"
                @primary-action="handlePrimaryAction"
                @toggle-recording="voice.toggleRecording()"
                @stop-tts="voice.stopTTS()"
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
          :tts-playing="isTTSPlaying"
          :is-recording="isRecording"
          :audio-level="audioLevel"
          :recording-duration="recordingDuration"
          :voice-configured="isVoiceConfigured"
          :model-selector="modelSelector"
          :is-first-chat="isFirstChat"
          @send="send"
          @stop="stop"
          @primary-action="handlePrimaryAction"
          @toggle-recording="voice.toggleRecording()"
          @stop-tts="voice.stopTTS()"
          @pick="(mode: string) => emit('set-mode', mode as BrowserTabMode)"
          @start-onboarding="startOnboarding"
        />
      </div>
    </div>
    <!-- Voice error toast -->
    <Transition name="toast-fade">
      <div
        v-if="voiceToast"
        class="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        {{ voiceToast }}
        <button type="button" class="ml-2 opacity-70 hover:opacity-100" @click="voiceToast = ''">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
        </button>
      </div>
    </Transition>
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
import ChatToolCard from '@pkg/components/ChatToolCard.vue';
import SubAgentBubble from './editor/workflow/SubAgentBubble.vue';
import { ChatInterface, type ChatMessage } from './agent/ChatInterface';
import type { QueuedMessage } from './agent/ChatMessageQueue';
import { useTheme } from '@pkg/composables/useTheme';
import { useVoiceSession } from '@pkg/composables/voice';
import { AgentModelSelectorController } from './agent/AgentModelSelectorController';
import { useBrowserTabs, type BrowserTabMode } from '@pkg/composables/useBrowserTabs';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { chatLogger as console } from '@pkg/agent/utils/agentLogger';

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

// ─── Message Queue ─────────────────────────────────────────────
const messageQueue = chatController.getQueue();
const queuedMessages = messageQueue.pendingMessages;
const hasQueuedMessages = messageQueue.hasPendingMessages;
const queuedMessageCount = messageQueue.queueLength;

const removeQueuedMessage = (messageId: string) => {
  chatController.removeQueuedMessage(messageId);
};

const clearQueue = () => {
  chatController.clearQueue();
};

const moveQueuedMessageUp = (messageId: string) => {
  chatController.moveQueuedMessageUp(messageId);
};

const moveQueuedMessageDown = (messageId: string) => {
  chatController.moveQueuedMessageDown(messageId);
};

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

const composerRef = ref<InstanceType<typeof AgentComposer> | null>(null);

const send = (metadata?: Record<string, unknown>) => {
  if (isFirstChat.value) {
    isFirstChat.value = false;
    ipcRenderer.invoke('mark-first-chat-complete');
  }
  chatController.send(metadata);
};

const sendWithAttachments = () => {
  if (isFirstChat.value) {
    isFirstChat.value = false;
    ipcRenderer.invoke('mark-first-chat-complete');
  }
  const attachments = composerRef.value?.consumeAttachments?.() || [];
  chatController.send(undefined, attachments.length > 0 ? attachments : undefined);
};
const stop = () => {
  console.log(`[BrowserTabChat:stop] clicked — graphRunning=${graphRunning.value}, ttsPlaying=${isTTSPlaying.value}, recording=${isRecording.value}`);
  voice.stopTTS();
  chatController.stop();
  console.log(`[BrowserTabChat:stop] after chatController.stop() — graphRunning=${graphRunning.value}`);
};
const continueRun = () => chatController.continueRun();
const handlePrimaryAction = () => {
  if (query.value.trim()) send();
};

// ─── Voice error toast ───────────────────────────────────────
const voiceToast = ref('');
let voiceToastTimer: ReturnType<typeof setTimeout> | null = null;

function showVoiceToast(message: string): void {
  voiceToast.value = message;
  if (voiceToastTimer) clearTimeout(voiceToastTimer);
  voiceToastTimer = setTimeout(() => { voiceToast.value = ''; }, 5000);
}

// ─── Voice configuration check ──────────────────────────────
const isVoiceConfigured = ref(false);
async function checkVoiceConfig() {
  try {
    const result = await ipcRenderer.invoke('integration-get-value', 'elevenlabs', 'api_key');
    isVoiceConfigured.value = !!(result?.value);
  } catch {
    isVoiceConfigured.value = false;
  }
}

// ─── Voice Session ───────────────────────────────────────────
// OOP voice system: VoiceRecorderService + TTSPlayerService + VoicePipeline
// coordinated by useVoiceSession composable. Auto-cleans up on unmount.
const voice = useVoiceSession({ chatController, messages, onError: showVoiceToast });
const { isRecording, audioLevel, recordingDuration, isTTSPlaying } = voice;

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
  checkVoiceConfig();
});

watch(() => messages.value.length, async () => {
  await nextTick();
  const container = chatScrollContainer.value;
  if (!container || !autoScrollEnabled.value) return;
  container.scrollTop = container.scrollHeight;
}, { flush: 'post' });

// Auto-scroll during streaming: the message array length doesn't change when
// a streaming message is updated in-place, so watch the last message's content.
watch(
  () => {
    const msgs = messages.value;
    const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    return last?.kind === 'streaming' ? last.content : null;
  },
  async (val) => {
    if (val == null) return;
    await nextTick();
    const container = chatScrollContainer.value;
    if (!container || !autoScrollEnabled.value) return;
    container.scrollTop = container.scrollHeight;
  },
  { flush: 'post' },
);

onUnmounted(() => {
  // voice cleanup is handled automatically by useVoiceSession's onUnmounted
  if (graphRunning.value) {
    chatController.stop();
  }
  chatController.dispose();
  modelSelector.dispose();
});
</script>

<style scoped>
/* ── Toast fade transition ── */
.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 0.3s, transform 0.3s;
}
.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

/* ── Typing indicator dots ── */
.typing-dots {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 4px;
}

.typing-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-primary);
  opacity: 0.3;
  animation: typingBounce 1.4s ease-in-out infinite;
}

.typing-dot:nth-child(2) {
  animation-delay: 0.2s;
}

.typing-dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes typingBounce {
  0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-4px); }
}

/* ── Streaming cursor ── */
.streaming-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--accent-primary, #3b82f6);
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blinkCursor 0.8s step-end infinite;
}

@keyframes blinkCursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
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

/* Tool card styles are in ChatToolCard.vue */

/* Theme-aware scrollbar styling for overflow-y-auto containers */
.overflow-y-auto::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.overflow-y-auto::-webkit-scrollbar-track {
  background: var(--bg-surface);
  border-radius: 4px;
}

.overflow-y-auto::-webkit-scrollbar-thumb {
  background: var(--border-default);
  border-radius: 4px;
  transition: background-color 150ms;
}

.overflow-y-auto::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}

.overflow-y-auto::-webkit-scrollbar-corner {
  background: var(--bg-surface);
}
</style>
