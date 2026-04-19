<template>
  <div
    class="flex h-full flex-col bg-page"
    @contextmenu.prevent="onContextMenu"
  >
    <ChatContextMenu
      ref="chatContextMenu"
      @new-chat="openNewChat"
    />
    <!-- Chat messages -->
    <div
      v-if="hasMessages"
      ref="chatScrollContainer"
      class="min-h-0 flex-1 overflow-y-auto"
    >
      <div class="relative mx-auto flex w-full max-w-8xl xl:px-12 sm:px-2 lg:px-8 justify-center">
        <div class="min-w-0 py-16 max-w-[768px] flex-auto px-4 lg:pr-0 lg:pl-8 xl:px-16">
          <div
            ref="transcriptEl"
            class="pb-8"
          >
            <div
              v-for="m in displayMessages"
              :key="m.id"
              class="mb-8"
            >
              <div
                v-if="m.kind === 'voice_interim'"
                class="flex justify-end"
              >
                <div class="max-w-[min(760px,92%)] rounded-3xl p-6 bg-surface-alt ring-1 ring-edge-subtle opacity-70">
                  <div class="whitespace-pre-wrap text-content italic">
                    <span class="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse mr-2 align-middle" />{{ m.content }}
                  </div>
                </div>
              </div>
              <div
                v-else-if="m.role === 'user'"
                class="flex justify-end"
              >
                <div class="max-w-[min(760px,92%)] rounded-3xl p-6 bg-surface-alt ring-1 ring-edge-subtle">
                  <img
                    v-if="m.image?.dataUrl"
                    :src="m.image.dataUrl"
                    :alt="m.image.alt || 'Attached image'"
                    class="mb-2 max-h-64 rounded-xl object-contain"
                  >
                  <div class="whitespace-pre-wrap text-content">
                    {{ m.content }}
                  </div>
                </div>
              </div>

              <div
                v-else-if="m.kind === 'tool' && m.toolCard"
                class="max-w-[min(760px,92%)]"
              >
                <ChatToolCard :tool-card="m.toolCard" />
              </div>

              <SubAgentBubble
                v-else-if="m.kind === 'sub_agent_activity' && m.subAgentActivity"
                :activity="m.subAgentActivity"
                :is-dark="isDark"
              />

              <!-- ── Compact Inline Thinking (DNA Helix) ── -->
              <div
                v-else-if="m.kind === 'thinking'"
                class="thinking-inline"
                :class="{
                  completed: !!(m as any)._completed && !expandedThinking.has(m.id),
                  expanded: !!(m as any)._completed && expandedThinking.has(m.id),
                }"
                @click="toggleThinking(m.id)"
              >
                <div
                  v-if="!(m as any)._completed"
                  class="ti-helix-col"
                >
                  <div class="helix-container">
                    <div class="helix-dot t1" /><div class="helix-dot t2" /><div class="helix-dot t3" /><div class="helix-dot t4" /><div class="helix-dot t5" />
                    <div class="helix-dot b1" /><div class="helix-dot b2" /><div class="helix-dot b3" /><div class="helix-dot b4" /><div class="helix-dot b5" />
                    <div class="helix-rung" /><div class="helix-rung" /><div class="helix-rung" /><div class="helix-rung" /><div class="helix-rung" />
                  </div>
                  <div class="ti-stem" />
                  <div class="ti-elapsed">
                    {{ thinkingElapsed(m) }}
                  </div>
                </div>
                <div class="ti-content">
                  <div class="ti-label">
                    {{ (m as any)._completed ? `Synthesized in ${thinkingElapsed(m)}` : 'Synthesizing' }}
                  </div>
                  <div class="ti-stream">
                    <div
                      :ref="el => scrollThinkingToBottom(el)"
                      class="ti-stream-inner"
                    >
                      <div
                        v-for="(line, idx) in splitThinkingLines(m.content)"
                        :key="idx"
                        class="ti-thought"
                      >
                        <span class="ti-thought-num">{{ String(idx + 1).padStart(2, '0') }}</span>
                        <span v-html="renderMarkdown(line)" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div
                v-else-if="m.kind === 'streaming'"
                class="max-w-[min(760px,92%)]"
              >
                <div class="flex gap-3">
                  <img
                    :src="botLogoUrl"
                    alt=""
                    class="h-8 w-8 rounded-full"
                    aria-hidden="true"
                  >
                  <div>
                    <div class="sulla-name dark:text-slate-400">
                      {{ botName }}
                    </div>
                    <div
                      class="prose max-w-none prose-slate dark:text-slate-400 dark:prose-invert"
                      v-html="renderMarkdown(m.content)"
                    /><span class="streaming-cursor" />
                  </div>
                </div>
              </div>

              <div
                v-else-if="m.kind === 'html'"
                class="max-w-[min(760px,92%)]"
              >
                <div class="flex gap-3">
                  <img
                    :src="botLogoUrl"
                    alt=""
                    class="h-8 w-8 rounded-full"
                    aria-hidden="true"
                  >
                  <div class="flex-1 min-w-0">
                    <div class="sulla-name dark:text-slate-400">
                      {{ botName }}
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
                  <img
                    :src="botLogoUrl"
                    alt=""
                    class="h-8 w-8 rounded-full"
                    aria-hidden="true"
                  >
                  <div>
                    <div class="sulla-name dark:text-slate-400">
                      {{ botName }}
                    </div>
                    <div
                      class="prose max-w-none prose-slate dark:text-slate-400 dark:prose-invert"
                      v-html="renderMarkdown(m.content)"
                    />
                  </div>
                </div>
              </div>
            </div>

            <!-- Queued Messages (like Windsurf) -->
            <div
              v-if="hasQueuedMessages"
              class="mb-6 space-y-2"
            >
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
                      <div class="whitespace-pre-wrap text-content/70 text-sm">
                        {{ msg.content }}
                      </div>
                      <div
                        v-if="msg.attachments?.length"
                        class="mt-2 flex gap-1"
                      >
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
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 15 15"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                        >
                          <path
                            d="M7.14645 2.14645C7.34171 1.95118 7.65829 1.95118 7.85355 2.14645L11.8536 6.14645C12.0488 6.34171 12.0488 6.65829 11.8536 6.85355C11.6583 7.04882 11.3417 7.04882 11.1464 6.85355L8 3.70711L8 12.5C8 12.7761 7.77614 13 7.5 13C7.22386 13 7 12.7761 7 12.5L7 3.70711L3.85355 6.85355C3.65829 7.04882 3.34171 7.04882 3.14645 6.85355C2.95118 6.65829 2.95118 6.34171 3.14645 6.14645L7.14645 2.14645Z"
                            fill="currentColor"
                            fill-rule="evenodd"
                            clip-rule="evenodd"
                          />
                        </svg>
                      </button>
                      <button
                        v-if="idx < queuedMessages.length - 1"
                        type="button"
                        class="p-1 rounded text-content-muted hover:text-content hover:bg-surface-hover transition-colors"
                        title="Move down"
                        @click="moveQueuedMessageDown(msg.id)"
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 15 15"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                          style="transform: rotate(180deg)"
                        >
                          <path
                            d="M7.14645 2.14645C7.34171 1.95118 7.65829 1.95118 7.85355 2.14645L11.8536 6.14645C12.0488 6.34171 12.0488 6.65829 11.8536 6.85355C11.6583 7.04882 11.3417 7.04882 11.1464 6.85355L8 3.70711L8 12.5C8 12.7761 7.77614 13 7.5 13C7.22386 13 7 12.7761 7 12.5L7 3.70711L3.85355 6.85355C3.65829 7.04882 3.34171 7.04882 3.14645 6.85355C2.95118 6.65829 2.95118 6.34171 3.14645 6.14645L7.14645 2.14645Z"
                            fill="currentColor"
                            fill-rule="evenodd"
                            clip-rule="evenodd"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        class="p-1 rounded text-content-muted hover:text-green-500 hover:bg-green-500/10 transition-colors"
                        title="Send now (inject into running conversation)"
                        @click="injectQueuedMessage(msg.id)"
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 15 15"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                        >
                          <path
                            d="M1.20308 1.04312C1.00481 0.954998 0.772341 1.0048 0.627577 1.16641C0.482813 1.32802 0.458794 1.56455 0.568117 1.75196L3.92115 7.50002L0.568117 13.2481C0.458794 13.4355 0.482813 13.672 0.627577 13.8336C0.772341 13.9952 1.00481 14.045 1.20308 13.9569L14.7031 7.95693C14.8836 7.87668 15 7.69762 15 7.50002C15 7.30243 14.8836 7.12337 14.7031 7.04312L1.20308 1.04312ZM4.84553 7.10002L2.21234 2.586L13.2689 7.50002L2.21234 12.414L4.84553 7.90002H9C9.22091 7.90002 9.4 7.72093 9.4 7.50002C9.4 7.27911 9.22091 7.10002 9 7.10002H4.84553Z"
                            fill="currentColor"
                            fill-rule="evenodd"
                            clip-rule="evenodd"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        class="p-1 rounded text-content-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
                        title="Remove from queue"
                        @click="removeQueuedMessage(msg.id)"
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 15 15"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                        >
                          <path
                            d="M11.7816 4.03157C12.0724 3.74081 12.0724 3.25991 11.7816 2.96915C11.4909 2.67839 11.0099 2.67839 10.7192 2.96915L7.50005 6.18827L4.28091 2.96915C3.99015 2.67839 3.50925 2.67839 3.21849 2.96915C2.92773 3.25991 2.92773 3.74081 3.21849 4.03157L6.43761 7.25071L3.21849 10.4698C2.92773 10.7606 2.92773 11.2415 3.21849 11.5323C3.50925 11.823 3.99015 11.823 4.28091 11.5323L7.50005 8.31315L10.7192 11.5323C11.0099 11.823 11.4909 11.823 11.7816 11.5323C12.0724 11.2415 12.0724 10.7606 11.7816 10.4698L8.56248 7.25071L11.7816 4.03157Z"
                            fill="currentColor"
                            fill-rule="evenodd"
                            clip-rule="evenodd"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Thinking indicator (graph running, not TTS) -->
            <div
              v-if="loading || (graphRunning && !isTTSPlaying)"
              class="mb-3 flex items-center gap-2 px-4"
            >
              <div class="typing-dots">
                <span class="typing-dot" />
                <span class="typing-dot" />
                <span class="typing-dot" />
              </div>
            </div>
            <!-- Sulla speaking indicator -->
            <div
              v-if="isTTSPlaying"
              class="mb-3 flex items-center gap-2 px-4"
            >
              <div
                class="sulla-speaking-indicator flex items-center gap-1.5 text-xs font-medium"
                style="color: var(--text-muted);"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path
                    d="M11 5L6 9H2v6h4l5 4V5z"
                    fill="currentColor"
                  />
                  <path
                    class="sulla-wave sulla-wave-1"
                    d="M15.54 8.46a5 5 0 0 1 0 7.07"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    fill="none"
                  />
                  <path
                    class="sulla-wave sulla-wave-2"
                    d="M18.07 5.93a9 9 0 0 1 0 12.73"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    fill="none"
                  />
                </svg>
                <span>{{ botName }} is speaking...</span>
              </div>
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
    <div
      v-else
      class="flex min-h-0 flex-1 overflow-y-auto bg-page"
    >
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
          :show-goals-onboarding="showGoalsOnboarding"
          :show-business-onboarding="showBusinessOnboarding"
          @send="send"
          @stop="stop"
          @primary-action="handlePrimaryAction"
          @toggle-recording="voice.toggleRecording()"
          @stop-tts="voice.stopTTS()"
          @pick="(mode: string) => emit('set-mode', mode as BrowserTabMode)"
          @start-onboarding="startOnboarding"
          @start-business-onboarding="startBusinessOnboarding"
        />
      </div>
    </div>
    <!-- Voice error toast -->
    <Transition name="toast-fade">
      <div
        v-if="voiceToast"
        class="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle
            cx="12"
            cy="12"
            r="10"
          /><line
            x1="12"
            y1="8"
            x2="12"
            y2="12"
          /><line
            x1="12"
            y1="16"
            x2="12.01"
            y2="16"
          />
        </svg>
        {{ voiceToast }}
        <button
          type="button"
          class="ml-2 opacity-70 hover:opacity-100"
          @click="voiceToast = ''"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          ><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
        </button>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';

import AgentComposer from './agent/AgentComposer.vue';
import { AgentModelSelectorController } from './agent/AgentModelSelectorController';
import { ChatInterface, type ChatMessage } from './agent/ChatInterface';
import ChatContextMenu from './chat/ChatContextMenu.vue';
import ChatOptionsVariantB from './chat-options/ChatOptionsVariantB.vue';
import SubAgentBubble from './editor/workflow/SubAgentBubble.vue';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { chatLogger as console } from '@pkg/agent/utils/agentLogger';
import ChatToolCard from '@pkg/components/ChatToolCard.vue';
import HtmlMessageRenderer from '@pkg/components/HtmlMessageRenderer.vue';
import { useBrowserTabs, type BrowserTabMode } from '@pkg/composables/useBrowserTabs';
import { useTheme } from '@pkg/composables/useTheme';
import { useVoiceSession } from '@pkg/composables/voice';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { QueuedMessage } from './agent/ChatMessageQueue';

const botLogoUrl = new URL('../../../resources/icons/logo-tray-Template@2x-blue.png', import.meta.url).toString();

const props = defineProps<{
  tabId: string;
}>();

const emit = defineEmits<{
  'set-mode':     [mode: BrowserTabMode];
  'navigate-url': [url: string];
}>();

const { updateTab, getTab } = useBrowserTabs();

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
const titleSet = chatController.messages.value.some(m => m.role === 'user');
if (!titleSet) {
  const stopTitleWatch = watch(
    () => chatController.messages.value,
    (msgs) => {
      const firstUser = msgs.find(m => m.role === 'user');
      if (firstUser?.content) {
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

const injectQueuedMessage = (messageId: string) => {
  chatController.injectQueuedMessage(messageId);
};

// If the tab was created with a content field (e.g. from an AI context menu action),
// use it as the initial prompt and auto-send, then clear it.
const botName = ref('Sulla');

onMounted(async() => {
  // Load bot name from settings
  botName.value = await SullaSettingsModel.get('botName', 'Sulla');

  const tab = getTab(props.tabId);

  if (tab?.content?.trim()) {
    query.value = tab.content;
    updateTab(props.tabId, { content: '' });
    nextTick(() => send());
  }
});

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

// Onboarding card visibility — each card hides once its identity file exists
const showGoalsOnboarding = ref(false);
const showBusinessOnboarding = ref(false);
const isFirstChat = computed(() => showGoalsOnboarding.value || showBusinessOnboarding.value);

async function checkFirstChat(): Promise<void> {
  try {
    const [goals, business] = await Promise.all([
      ipcRenderer.invoke('check-goals-onboarding'),
      ipcRenderer.invoke('check-business-onboarding'),
    ]);
    showGoalsOnboarding.value = goals;
    showBusinessOnboarding.value = business;
  } catch {
    showGoalsOnboarding.value = false;
    showBusinessOnboarding.value = false;
  }
}

function startOnboarding(): void {
  showGoalsOnboarding.value = false;
  query.value = 'I\'m new here — help me set my goals and get to know how I work best.';
  nextTick(() => send());
}

function startBusinessOnboarding(): void {
  showBusinessOnboarding.value = false;
  query.value = `I want to put ${ botName.value } to work on my business.`;
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

const expandedThinking = ref(new Set<string>());
const thinkingStartTimes = new Map<string, number>();
const thinkingFinalTimes = new Map<string, string>();
const thinkingTick = ref(0);

/** Reactive tick that drives the live elapsed counter — fires every 100ms */
let _thinkingTimer: ReturnType<typeof setInterval> | null = null;

function ensureThinkingTimer() {
  if (!_thinkingTimer) {
    _thinkingTimer = setInterval(() => { thinkingTick.value++ }, 100);
  }
}

/** Split thinking content into individual lines for card rendering */
const splitThinkingLines = (content: string): string[] => {
  if (!content) return [];
  return content
    .split(/\n+/)
    .map(l => l.trim())
    .filter(l => l.length > 0);
};

const thinkingElapsed = (m: any): string => {
  if (!thinkingStartTimes.has(m.id)) {
    thinkingStartTimes.set(m.id, Date.now());
    ensureThinkingTimer();
  }
  // Once completed, freeze the final time
  if (m._completed) {
    if (!thinkingFinalTimes.has(m.id)) {
      const elapsed = ((Date.now() - thinkingStartTimes.get(m.id)!) / 1000).toFixed(1);
      thinkingFinalTimes.set(m.id, `${ elapsed }s`);
    }
    return thinkingFinalTimes.get(m.id)!;
  }
  // Live counter — thinkingTick dependency makes this reactive
  void thinkingTick.value;
  return `${ ((Date.now() - thinkingStartTimes.get(m.id)!) / 1000).toFixed(1) }s`;
};

onUnmounted(() => {
  if (_thinkingTimer) {
    clearInterval(_thinkingTimer);
    _thinkingTimer = null;
  }
});

const toggleThinking = (id: string) => {
  const next = new Set(expandedThinking.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  expandedThinking.value = next;
};

const scrollThinkingToBottom = (el: any) => {
  if (el instanceof HTMLElement) {
    nextTick(() => { el.scrollTop = el.scrollHeight });
  }
};

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

/** Returns true if the input looks like a URL the user wants to navigate to */
function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^localhost(:\d+)?/i.test(trimmed)) return true;
  if (/^127\.0\.0\.1(:\d+)?/i.test(trimmed)) return true;
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/|$)/.test(trimmed)) return true;
  return false;
}

const send = (metadata?: Record<string, unknown>) => {
  // If the query looks like a URL, open it in a browser tab instead of chatting
  if (!hasMessages.value && looksLikeUrl(query.value)) {
    emit('navigate-url', query.value.trim());
    query.value = '';
    return;
  }
  if (isFirstChat.value) {
    showGoalsOnboarding.value = false;
    showBusinessOnboarding.value = false;
  }
  chatController.send(metadata);
};

const sendWithAttachments = () => {
  // If the query looks like a URL, open it in a browser tab instead of chatting
  if (!hasMessages.value && looksLikeUrl(query.value)) {
    emit('navigate-url', query.value.trim());
    query.value = '';
    return;
  }
  if (isFirstChat.value) {
    showGoalsOnboarding.value = false;
    showBusinessOnboarding.value = false;
  }
  const attachments = composerRef.value?.consumeAttachments?.() || [];
  chatController.send(undefined, attachments.length > 0 ? attachments : undefined);
};
const stop = () => {
  console.log(`[BrowserTabChat:stop] clicked — graphRunning=${ graphRunning.value }, ttsPlaying=${ isTTSPlaying.value }, recording=${ isRecording.value }`);
  voice.stopTTS();
  chatController.stop();
  console.log(`[BrowserTabChat:stop] after chatController.stop() — graphRunning=${ graphRunning.value }`);
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
  voiceToastTimer = setTimeout(() => { voiceToast.value = '' }, 5000);
}

// ─── Voice configuration check ──────────────────────────────
// Voice mode uses the internal whisper transcription pipeline.
// Mic button appears when whisper is installed with a model.
const isVoiceConfigured = ref(false);
async function checkVoiceConfig() {
  try {
    const { ipcRenderer } = require('electron');
    const status = await ipcRenderer.invoke('audio-driver:whisper-detect');
    isVoiceConfigured.value = !!(status?.available && status?.models?.length > 0);
  } catch {
    isVoiceConfigured.value = false;
  }
}
checkVoiceConfig();

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
  const startScroll = () => { isUserScrolling = true };
  const endScroll = () => {
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => { isUserScrolling = false }, 150);
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
onMounted(async() => {
  if (chatScrollContainer.value) attachScrollListeners(chatScrollContainer.value);
  await modelSelector.start();
  checkFirstChat();

  // Scroll to bottom on initial load if messages exist
  if (chatScrollContainer.value && messages.value.length > 0) {
    await nextTick();
    chatScrollContainer.value.scrollTop = chatScrollContainer.value.scrollHeight;
  }
});

watch(() => messages.value.length, async() => {
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
  async(val) => {
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

/* ── DNA Helix ── */
.helix-container {
  width: 40px;
  height: 28px;
  position: relative;
  flex-shrink: 0;
}

.helix-dot {
  position: absolute;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent-primary, #5096b3);
}

.helix-dot.t1 { animation: helixTop 1.6s ease-in-out infinite 0s; left: 2px; }
.helix-dot.t2 { animation: helixTop 1.6s ease-in-out infinite 0.2s; left: 10px; }
.helix-dot.t3 { animation: helixTop 1.6s ease-in-out infinite 0.4s; left: 18px; }
.helix-dot.t4 { animation: helixTop 1.6s ease-in-out infinite 0.6s; left: 26px; }
.helix-dot.t5 { animation: helixTop 1.6s ease-in-out infinite 0.8s; left: 34px; }

.helix-dot.b1 { animation: helixBot 1.6s ease-in-out infinite 0s; left: 2px; }
.helix-dot.b2 { animation: helixBot 1.6s ease-in-out infinite 0.2s; left: 10px; }
.helix-dot.b3 { animation: helixBot 1.6s ease-in-out infinite 0.4s; left: 18px; }
.helix-dot.b4 { animation: helixBot 1.6s ease-in-out infinite 0.6s; left: 26px; }
.helix-dot.b5 { animation: helixBot 1.6s ease-in-out infinite 0.8s; left: 34px; }

@keyframes helixTop {
  0%, 100% { top: 2px;  opacity: 1;   transform: scale(1); }
  50%      { top: 20px; opacity: 0.3; transform: scale(0.6); }
}

@keyframes helixBot {
  0%, 100% { top: 20px; opacity: 0.3; transform: scale(0.6); }
  50%      { top: 2px;  opacity: 1;   transform: scale(1); }
}

.helix-rung {
  position: absolute;
  width: 1px;
  background: rgba(80, 150, 179, 0.15);
  top: 6px;
  height: 16px;
  animation: rungPulse 1.6s ease-in-out infinite;
}
.helix-rung:nth-child(11) { left: 4px;  animation-delay: 0s; }
.helix-rung:nth-child(12) { left: 12px; animation-delay: 0.2s; }
.helix-rung:nth-child(13) { left: 20px; animation-delay: 0.4s; }
.helix-rung:nth-child(14) { left: 28px; animation-delay: 0.6s; }
.helix-rung:nth-child(15) { left: 36px; animation-delay: 0.8s; }

@keyframes rungPulse {
  0%, 100% { opacity: 0.15; }
  25%, 75% { opacity: 0.4; }
  50%      { opacity: 0.15; }
}

/* ── Compact Inline Thinking ── */
.thinking-inline {
  display: flex;
  gap: 14px;
  padding: 0;
  align-items: flex-start;
  cursor: pointer;
}

.ti-helix-col {
  padding-top: 2px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.ti-stem {
  width: 1px;
  flex: 1;
  min-height: 20px;
  background: rgba(80, 150, 179, 0.1);
  animation: stemPulse 2s ease-in-out infinite;
}

@keyframes stemPulse {
  0%, 100% { opacity: 0.3; }
  50%      { opacity: 0.8; }
}

.ti-elapsed {
  font-size: 9px;
  color: rgba(80, 150, 179, 0.35);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ti-content {
  flex: 1;
  min-width: 0;
}

.ti-label {
  font-size: 12px;
  color: var(--accent-primary, #5096b3);
  font-weight: 500;
  margin-bottom: 8px;
}

/* Scrolling thought stream */
.ti-stream {
  position: relative;
  max-height: 110px;
  overflow: hidden;
}

.ti-stream::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 20px;
  background: linear-gradient(to bottom, var(--bg-page, #0d1117), transparent);
  pointer-events: none;
  z-index: 2;
}

.ti-stream::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 24px;
  background: linear-gradient(to top, var(--bg-page, #0d1117), transparent);
  pointer-events: none;
  z-index: 2;
}

.ti-stream-inner {
  max-height: inherit;
  overflow-y: auto;
  scrollbar-width: none;
}

.ti-stream-inner::-webkit-scrollbar {
  display: none;
}

.ti-thought {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 10px;
  margin-bottom: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted, rgba(230, 237, 243, 0.35));
  font-style: italic;
  border-left: 2px solid rgba(80, 150, 179, 0.12);
  border-radius: 0 4px 4px 0;
  background: rgba(80, 150, 179, 0.03);
}

.ti-thought-num {
  color: rgba(80, 150, 179, 0.3);
  font-size: 10px;
  font-style: normal;
  font-weight: 600;
  flex-shrink: 0;
}

.ti-thought :deep(p) {
  margin: 0;
  display: inline;
}

/* ── Completed (collapsed) ── */
.thinking-inline.completed {
  align-items: center;
  transition: opacity 0.3s;
}

.thinking-inline.completed .ti-stream { display: none; }
.thinking-inline.completed .ti-stem { display: none; }
.thinking-inline.completed .ti-elapsed { display: none; }
.thinking-inline.completed .ti-label {
  color: rgba(80, 150, 179, 0.4);
  margin-bottom: 0;
}
.thinking-inline.completed:hover .ti-label { color: rgba(80, 150, 179, 0.55); }

/* ── Expanded (completed + clicked open) ── */
.thinking-inline.expanded {
  align-items: flex-start;
}

.thinking-inline.expanded .ti-stream {
  max-height: none;
}
.thinking-inline.expanded .ti-stream::before,
.thinking-inline.expanded .ti-stream::after { display: none; }
.thinking-inline.expanded .ti-thought { color: var(--text-muted, rgba(230, 237, 243, 0.45)); }
.thinking-inline.expanded .ti-stem { animation: none; opacity: 0.2; }
.thinking-inline.expanded .ti-label { color: rgba(80, 150, 179, 0.4); }

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
