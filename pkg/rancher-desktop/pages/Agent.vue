<template>
  <div class="h-screen overflow-hidden bg-white text-[#0d0d0d] dark:bg-slate-900 dark:text-neutral-50 font-sans" :class="{ dark: isDark }">
    <PostHogTracker page-name="Agent" />
    <div class="flex h-screen flex-col">

      <AgentHeader :is-dark="isDark" :toggle-theme="toggleTheme" />

    <!-- Loading overlay while system boots -->
    <StartupOverlay
      @overlay-visible="showOverlay = $event"
      @system-ready="systemReady = $event"
    />

    <!-- Main agent interface -->
    <div ref="chatScrollContainer" id="chat-scroll-container" class="flex min-h-0 flex-1 overflow-y-auto" :class="{ 'blur-sm pointer-events-none select-none': showOverlay }">
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          v-if="hasMessages"
          class="relative mx-auto flex w-full flex-1 "
          :class="isAssetPaneExpanded ? 'max-w-none justify-start' : 'max-w-8xl xl:px-12 sm:px-2 lg:px-8 justify-center'"
        >
          <div v-if="!isAssetPaneExpanded" class="hidden lg:relative lg:block lg:flex-none lg:w-72 xl:w-80 bg-slate-50 dark:bg-slate-800/30">
            <div class="sticky top-[15px] pt-[15px] h-[calc(100vh-5rem-15px)] w-full overflow-x-hidden overflow-y-auto">

              <AgentPersonaLibrary/>

            </div>
          </div>

          <div
            class="min-w-0 py-16"
            :class="isAssetPaneExpanded
              ? 'flex-[0_0_30%] px-4 lg:pr-2 lg:pl-4 xl:px-6'
              : 'max-w-2xl flex-auto px-4 lg:max-w-none lg:pr-0 lg:pl-8 xl:px-16'"
          >
            <div ref="transcriptEl" id="chat-messages-list" class="pb-40">
              <div
                v-for="m in displayMessages"
                :key="m.id"
                class="mb-8"
              >
                <div v-if="m.role === 'user'" class="flex justify-end">
                  <div class="max-w-[min(760px,92%)] rounded-3xl p-6 bg-sky-50 dark:bg-slate-800/60 dark:ring-1 dark:ring-slate-300/10">
                    <div class="whitespace-pre-wrap text-sky-900 dark:text-slate-100">{{ m.content }}</div>
                  </div>
                </div>

                <div v-else-if="m.kind === 'tool'" class="max-w-[min(760px,92%)]">
                  <div v-if="m.toolCard" class="rounded border border-slate-200 bg-slate-900 px-4 dark:border-slate-700 dark:bg-slate-800/50">
                    <button
                      type="button"
                      class="w-full px-4 py-2 flex items-center justify-between transition-colors"
                      @click="toggleToolCard(m.id)"
                    >
                      <div class="flex items-center gap-2">
                        <span class="font-mono token comment">{{ m.toolCard.toolName }}</span>
                        <span
                          class="rounded-full px-2 py-0.5 text-xs font-medium"
                          :class="m.toolCard.status === 'success' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : m.toolCard.status === 'failed' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' : 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'"
                        >
                          {{ m.toolCard.status }}
                        </span>
                      </div>
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 15 15"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        class="text-slate-500 transition-transform"
                        :class="isToolCardExpanded(m.id) ? 'rotate-180' : ''"
                      >
                        <path d="M3.13523 6.15803C3.3241 5.95657 3.64052 5.94637 3.84197 6.13523L7.5 9.56464L11.158 6.13523C11.3595 5.94637 11.6759 5.95657 11.8648 6.15803C12.0536 6.35949 12.0434 6.67591 11.842 6.86477L7.84197 10.6148C7.64964 10.7951 7.35036 10.7951 7.15803 10.6148L3.15803 6.86477C2.95657 6.67591 2.94637 6.35949 3.13523 6.15803Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"/>
                      </svg>
                    </button>
                    <div v-show="isToolCardExpanded(m.id)" class="px-4 pb-3">
                      <div v-if="m.toolCard.args && Object.keys(m.toolCard.args).length > 0" class="mb-2">
                        <div class="text-xs font-semibold text-slate-600 dark:text-slate-400">Arguments:</div>
                        <pre class="mt-1 overflow-x-auto rounded bg-slate-800 p-2 text-xs text-slate-400 dark:bg-slate-900/50"><code>{{ JSON.stringify(m.toolCard.args, null, 2) }}</code></pre>
                      </div>
                      <div v-if="m.toolCard.result !== undefined" class="mb-2">
                        <div class="text-xs font-semibold text-slate-600 dark:text-slate-400">Result:</div>
                        <pre class="mt-1 overflow-x-auto rounded bg-slate-800 p-2 text-xs text-slate-400 dark:bg-slate-900/50"><code>{{ typeof m.toolCard.result === 'string' ? m.toolCard.result : JSON.stringify(m.toolCard.result, null, 2) }}</code></pre>
                      </div>
                      <div v-if="m.toolCard.error" class="text-xs text-red-600 dark:text-red-400">
                        Error: {{ m.toolCard.error }}
                      </div>
                    </div>
                  </div>
                  <pre v-else class="prism-code language-shell"><code><span class="token plain">{{ m.content }}</span>
 </code></pre>
                </div>

                <div v-else-if="m.kind === 'channel_message'" class="max-w-[min(760px,92%)]">
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
                        width="16" height="16" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg"
                        class="text-slate-400 transition-transform"
                        :class="isToolCardExpanded(m.id) ? 'rotate-180' : ''"
                      >
                        <path d="M3.13523 6.15803C3.3241 5.95657 3.64052 5.94637 3.84197 6.13523L7.5 9.56464L11.158 6.13523C11.3595 5.94637 11.6759 5.95657 11.8648 6.15803C12.0536 6.35949 12.0434 6.67591 11.842 6.86477L7.84197 10.6148C7.64964 10.7951 7.35036 10.7951 7.15803 10.6148L3.15803 6.86477C2.95657 6.67591 2.94637 6.35949 3.13523 6.15803Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"/>
                      </svg>
                    </button>
                    <div v-show="isToolCardExpanded(m.id)" class="px-4 pb-3 text-sm text-slate-700 dark:text-slate-300" v-html="renderMarkdown(m.content)" />
                  </div>
                </div>

                <div v-else-if="m.kind === 'thinking'" class="thinking-bubble max-w-[min(760px,92%)]">
                  <div class="thinking-bubble-inner">
                    <div class="thinking-bubble-content text-xs text-slate-400 dark:text-slate-500 italic" v-html="renderMarkdown(m.content)" />
                  </div>
                </div>

                <div v-else class="max-w-[min(760px,92%)]">
                  <div v-if="m.image" class="space-y-2">
                    <img
                      :src="m.image.dataUrl"
                      :alt="m.image.alt || ''"
                      class="block h-auto max-w-full rounded-xl border border-black/10 dark:border-white/10"
                    >
                    <div v-if="m.image.alt" class="text-xs text-[#0d0d0d]/60 dark:text-white/60">
                      {{ m.image.alt }}
                    </div>
                  </div>
                  <div v-else class="prose max-w-none prose-slate dark:text-slate-400 dark:prose-invert" v-html="renderMarkdown(m.content)" />
                </div>
              </div>
              <div
                v-if="loading"
                class="mb-3 flex justify-start"
              >
                <div class="relative max-w-[min(760px,92%)] whitespace-pre-wrap rounded-xl px-4 py-3 text-sm leading-6 text-neutral-900 dark:text-neutral-100">
                  <div class="absolute -inset-px rounded-xl border-2 border-transparent [background:linear-gradient(var(--quick-links-hover-bg,var(--color-sky-50)),var(--quick-links-hover-bg,var(--color-sky-50)))_padding-box,linear-gradient(to_top,var(--color-indigo-400),var(--color-cyan-400),var(--color-sky-500))_border-box] dark:[--quick-links-hover-bg:var(--color-slate-800)]"></div>
                  <div class="relative">Thinking...</div>
                </div>
              </div>
              <div v-if="showContinueButton" class="flex justify-end mb-3">
                <button
                  type="button"
                  class="rounded-lg bg-black px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-neutral-800 active:bg-neutral-700 transition-colors"
                  @click="continueRun"
                >
                  Continue
                </button>
              </div>
            </div>
          </div>

          <div
            class="hidden xl:sticky xl:top-0 xl:block xl:max-h-[calc(100vh-1rem-10rem)]"
            :class="isAssetPaneExpanded ? 'xl:flex-[0_0_70%] xl:overflow-hidden' : 'xl:flex-none xl:overflow-y-auto'"
            @wheel="handleAssetPaneScrollLock"
            @touchmove="handleAssetPaneScrollLock"
          >
            <div :class="isAssetPaneExpanded ? 'h-full w-full' : 'w-72'">
              <div v-if="latestChatError" class="my-8 flex rounded-3xl p-6 bg-amber-50 dark:bg-slate-800/60 dark:ring-1 dark:ring-slate-300/10">
                <svg aria-hidden="true" viewBox="0 0 32 32" fill="none" class="h-8 w-8 flex-none [--icon-foreground:var(--color-amber-900)] [--icon-background:var(--color-amber-100)]">
                  <defs>
                    <radialGradient cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" id="_ChatWarn-gradient" gradientTransform="rotate(65.924 1.519 20.92) scale(25.7391)">
                      <stop stop-color="#FDE68A" offset=".08"></stop>
                      <stop stop-color="#F59E0B" offset=".837"></stop>
                    </radialGradient>
                    <radialGradient cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" id="_ChatWarn-gradient-dark" gradientTransform="matrix(0 24.5 -24.5 0 16 5.5)">
                      <stop stop-color="#FDE68A" offset=".08"></stop>
                      <stop stop-color="#F59E0B" offset=".837"></stop>
                    </radialGradient>
                  </defs>
                  <g class="dark:hidden">
                    <circle cx="20" cy="20" r="12" fill="url(#_ChatWarn-gradient)"></circle>
                    <path d="M3 16c0 7.18 5.82 13 13 13s13-5.82 13-13S23.18 3 16 3 3 8.82 3 16Z" fill-opacity="0.5" class="fill-(--icon-background) stroke-(--icon-foreground)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                    <path d="m15.408 16.509-1.04-5.543a1.66 1.66 0 1 1 3.263 0l-1.039 5.543a.602.602 0 0 1-1.184 0Z" class="fill-(--icon-foreground) stroke-(--icon-foreground)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                    <path d="M16 23a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" fill-opacity="0.5" stroke="currentColor" class="fill-(--icon-background) stroke-(--icon-foreground)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                  </g>
                  <g class="hidden dark:inline">
                    <path fill-rule="evenodd" clip-rule="evenodd" d="M2 16C2 8.268 8.268 2 16 2s14 6.268 14 14-6.268 14-14 14S2 23.732 2 16Zm11.386-4.85a2.66 2.66 0 1 1 5.228 0l-1.039 5.543a1.602 1.602 0 0 1-3.15 0l-1.04-5.543ZM16 20a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" fill="url(#_ChatWarn-gradient-dark)"></path>
                  </g>
                </svg>
                <div class="ml-4 flex-auto">
                  <p class="not-prose font-display text-xl text-amber-900 dark:text-amber-500">Oh no! Something bad happened!</p>
                  <div class="prose mt-2.5 text-amber-800 [--tw-prose-underline:var(--color-amber-400)] [--tw-prose-background:var(--color-amber-50)] prose-a:text-amber-900 prose-code:text-amber-900 dark:text-slate-300 dark:[--tw-prose-underline:var(--color-sky-700)] dark:prose-code:text-slate-300">
                    <p>{{ latestChatError }}</p>
                  </div>
                </div>
              </div>

              <div class="flex flex-col gap-2" :class="isAssetPaneExpanded ? 'h-full min-h-0 pb-2' : ''">
                <AgentPersonaAssetCard
                  v-for="asset in visiblePersonaAssets"
                  :key="asset.id"
                  :asset="asset"
                  :asset-size="getAssetSize(asset.id)"
                  :is-active="assetIsActive(asset)"
                  :sanitize-asset-html="sanitizeAssetHtml"
                  :thread-id="currentThreadId || undefined"
                  @toggle-size="cycleAssetSize(asset.id)"
                  @document-format="applyDocumentFormat"
                  @document-input="onDocumentAssetInput"
                />
              </div>
            </div>
            </div>
          </div>

          <div
            :class="hasMessages ? 'fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200 bg-white/80 pt-6 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80' : 'flex flex-1 items-center justify-center bg-white dark:bg-slate-900'"
          >
            <div v-if="hasMessages" class="relative mx-auto flex w-full max-w-8xl justify-center sm:px-2 lg:px-8 xl:px-12">
              <div class="max-w-2xl min-w-0 flex-auto px-4 lg:max-w-none lg:pr-0 lg:pl-8 xl:px-16">
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

          <div v-else class="w-full px-4">
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
    </div>
  </div>
</template>

<script setup lang="ts">
import StartupOverlay from './agent/StartupOverlay.vue';
import AgentHeader from './agent/AgentHeader.vue';
import AgentPersonaLibrary from './agent/personas/AgentPersonaLibrary.vue';
import AgentPersonaAssetCard from './agent/AgentPersonaAssetCard.vue';
import AgentComposer from './agent/AgentComposer.vue';
import PostHogTracker from '@pkg/components/PostHogTracker.vue';

import { ref, onMounted, onUnmounted, computed, nextTick, watch } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  type PersonaSidebarAsset,
} from '@pkg/agent';
import { AgentSettingsController } from './agent/AgentSettingsController';
import { ChatInterface } from './agent/ChatInterface';
import { FrontendGraphWebSocketService } from '@pkg/agent/services/FrontendGraphWebSocketService';
import { AgentModelSelectorController } from './agent/AgentModelSelectorController';
import { getAgentPersonaRegistry, type ChatMessage } from '@pkg/agent';
import { getN8nVueBridgeService } from '@pkg/agent/services/N8nVueBridgeService';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { getHumanPresenceTracker } from '@pkg/agent/services/HumanPresenceTracker';
import './assets/AgentModelSelector.css';
import './agent/personas/persona-profiles.css';

const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|flac|m4a|aac|webm)$/i;

const audioRenderer: marked.RendererObject = {
  link({ href, text }: { href: string; text: string }) {
    if (href && AUDIO_EXTENSIONS.test(href)) {
      const fileName = text || href.split('/').pop() || 'audio';
      const mimeMap: Record<string, string> = {
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
        flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm',
      };
      const ext = (href.match(AUDIO_EXTENSIONS)?.[1] || 'mp3').toLowerCase();
      const mime = mimeMap[ext] || 'audio/mpeg';
      return `<div class="sulla-audio-player">
        <div class="sulla-audio-label">${fileName}</div>
        <audio controls preload="metadata">
          <source src="${href}" type="${mime}">
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
    USE_PROFILES: { html: true },
    ADD_TAGS: ['audio', 'source'],
    ADD_ATTR: ['controls', 'preload', 'src', 'type'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file):|data:image\/(?:png|gif|jpe?g|webp);base64,|\/|\.|#)/i,
  });
};

const sanitizeAssetHtml = (html: string): string => {
  const raw = typeof html === 'string' ? html : String(html || '');
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(raw);

  if (!looksLikeHtml) {
    return renderMarkdown(raw);
  }

  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ['audio', 'source'],
    ADD_ATTR: ['controls', 'preload', 'src', 'type'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file):|data:image\/(?:png|gif|jpe?g|webp);base64,|\/|\.|#)/i,
  });
};

const THEME_STORAGE_KEY = 'agentTheme';
const isDark = ref(false);

const syncN8nInterfaceTheme = (): void => {
  const n8nVueBridgeService = getN8nVueBridgeService();
  if (isDark.value) {
    n8nVueBridgeService.setDarkMode();
    return;
  }

  n8nVueBridgeService.setLightMode();
};

const currentThreadId = ref<string | null>(null);

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

const frontendGraphController = new FrontendGraphWebSocketService({
  currentThreadId,
});

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

const registry = getAgentPersonaRegistry();
const loading = computed<boolean>(() => {
  const agent = registry.activeAgent.value;
  if (!agent) return false;
  return agent.loading;
});

const showContinueButton = computed<boolean>(() => {
  const persona = registry.getActivePersonaService();
  if (!persona) return false;
  return persona.stopReason.value === 'max_loops' && !persona.graphRunning.value;
});

const continueRun = () => {
  const persona = registry.getActivePersonaService();
  if (persona) {
    persona.emitContinueRun();
  }
};

const handleModelChanged = async (event: Electron.IpcRendererEvent, data: { model: string; type: 'local' } | { model: string; type: 'remote'; provider: string }) => {
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

const chatScrollContainer = ref<HTMLElement | null>(null);
const autoScrollEnabled = ref(true);
const autoScrollThreshold = 140; // pixels from bottom to re-enable
let isUserScrolling = false;
let scrollTimeout: NodeJS.Timeout | null = null;

// Track user-initiated scrolling with mouse/touch events
onMounted(() => {
  const container = chatScrollContainer.value;
  if (!container) return;

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
                  `(${Math.round(distanceFromBottom)}px from bottom)`);
    }
  }, { passive: true });

});

// Auto-scroll to bottom when messages change (only if enabled)
watch(() => messages.value.length, async () => {
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

const latestChatError = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m: ChatMessage = messages.value[i];
    if (m.role === 'error') {
      return m.content;
    }
  }
  return '';
});

const activePersonaService = computed(() => registry.getActivePersonaService());
const personaAssets = computed(() => activePersonaService.value?.activeAssets ?? []);
type AssetSize = 'medium' | 'large';
const assetSizes = ref<Record<string, AssetSize>>({});

const normalizeAssetSize = (value: unknown): AssetSize => {
  return value === 'large' ? 'large' : 'medium';
};

const getAssetSize = (assetId: string): AssetSize => normalizeAssetSize(assetSizes.value[assetId]);

const largeAssetId = computed(() => {
  return personaAssets.value.find((asset) => getAssetSize(asset.id) === 'large')?.id || null;
});

const visiblePersonaAssets = computed(() => {
  if (largeAssetId.value) {
    return personaAssets.value.filter((asset) => asset.id === largeAssetId.value);
  }
  return personaAssets.value;
});

const isAssetPaneExpanded = computed(() => !!largeAssetId.value);

const setAssetSize = (assetId: string, nextSize: AssetSize): void => {
  if (nextSize === 'large') {
    const nextMap: Record<string, AssetSize> = {};
    personaAssets.value.forEach((asset) => {
      nextMap[asset.id] = asset.id === assetId ? 'large' : 'medium';
    });
    assetSizes.value = nextMap;
    return;
  }

  assetSizes.value = {
    ...assetSizes.value,
    [assetId]: nextSize,
  };
};

const cycleAssetSize = (assetId: string): void => {
  const current = getAssetSize(assetId);
  if (current === 'medium') {
    setAssetSize(assetId, 'large');
    return;
  }
  setAssetSize(assetId, 'medium');
};

const handleAssetPaneScrollLock = (event: Event): void => {
  if (!isAssetPaneExpanded.value) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
};

watch(personaAssets, (assets) => {
  const ids = new Set(assets.map((asset) => asset.id));
  const nextSizes: Record<string, AssetSize> = {};
  Object.entries(assetSizes.value).forEach(([assetId, size]) => {
    if (ids.has(assetId)) {
      nextSizes[assetId] = normalizeAssetSize(size);
    }
  });
  assets.forEach((asset) => {
    if (!nextSizes[asset.id]) {
      nextSizes[asset.id] = 'medium';
    }
  });
  assetSizes.value = nextSizes;
}, { immediate: true });

const onDocumentAssetInput = (assetId: string, event: Event): void => {
  const service = activePersonaService.value;
  if (!service) {
    return;
  }
  const target = event.target as HTMLElement;
  service.updateDocumentAssetContent(assetId, target.innerHTML || '');
};

const applyDocumentFormat = (command: string, value?: string): void => {
  if (command === 'createLink') {
    const url = window.prompt('Enter URL');
    if (!url) {
      return;
    }
    document.execCommand(command, false, url);
    return;
  }
  document.execCommand(command, false, value);
};

const assetIsActive = (asset: PersonaSidebarAsset): boolean => {
  return asset.active === true;
};

const isRunning = computed<boolean>(() => {
  const agent = registry.activeAgent.value;
  if (!agent) return false;
  return agent.isRunning;
});

const modelSelector = new AgentModelSelectorController({
  systemReady,
  loading,
  modelName,
  modelMode,
  isRunning,
});

onMounted(async () => {
  const n8nVueBridgeService = getN8nVueBridgeService();
  n8nVueBridgeService.markInitialized('Agent.vue:onMounted');

  // Re-subscribe persona service WS handlers (they get unsubscribed on unmount)
  registry.state.agents.forEach((agent: { agentId: string }) => {
    registry.getOrCreatePersonaService(agent.agentId).startListening();
  });

  // Start human presence tracker — writes presence to Redis so agents know where the human is
  presenceTracker.setCurrentView('Agent Chat');
  presenceTracker.setCurrentActivity('chatting with agent');
  presenceTracker.setActiveChannel('chat-controller');
  presenceTracker.start();

  const stored = localStorage.getItem(THEME_STORAGE_KEY);

  if (stored === 'dark') {
    isDark.value = true;
  } else if (stored === 'light') {
    isDark.value = false;
  } else {
    isDark.value = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  }

  // Listen for model changes from other windows
  ipcRenderer.on('model-changed', handleModelChanged);

  // Load settings eagerly — SullaSettingsModel has a disk fallback even before Redis/PG are ready
  await settingsController.start();
  await modelSelector.start();
  syncN8nInterfaceTheme();
});

// Re-sync settings when system is fully ready (bootstrap may have updated values)
watch(systemReady, async (ready) => {
  if (ready) {
    await settingsController.start();
    await modelSelector.start();
  }
});

onUnmounted(() => {
  presenceTracker.stop();
  modelSelector.dispose();
  // Stop listening on each agent's persona service
  registry.state.agents.forEach((agent: { agentId: string }) => {
    registry.getOrCreatePersonaService(agent.agentId).stopListening();
  });
  chatController.dispose();
  frontendGraphController.dispose();
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
    return;
  }
  // Voice mode is a UI affordance for now; actual voice wiring can be added later.
};

const toggleTheme = () => {
  isDark.value = !isDark.value;
  localStorage.setItem(THEME_STORAGE_KEY, isDark.value ? 'dark' : 'light');
};

watch(isDark, () => {
  syncN8nInterfaceTheme();
}, { immediate: true });

</script>

<style scoped>
/* Match knowledgebase dark-mode scrollbar styling in chat interface */
.dark #chat-scroll-container::-webkit-scrollbar,
.dark #chat-scroll-container *::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.dark #chat-scroll-container::-webkit-scrollbar-track,
.dark #chat-scroll-container *::-webkit-scrollbar-track {
  background: #1e293b;
  border-radius: 4px;
}

.dark #chat-scroll-container::-webkit-scrollbar-thumb,
.dark #chat-scroll-container *::-webkit-scrollbar-thumb {
  background: #475569;
  border-radius: 4px;
}

.dark #chat-scroll-container::-webkit-scrollbar-thumb:hover,
.dark #chat-scroll-container *::-webkit-scrollbar-thumb:hover {
  background: #64748b;
}

.dark #chat-scroll-container::-webkit-scrollbar-corner,
.dark #chat-scroll-container *::-webkit-scrollbar-corner {
  background: #1e293b;
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
  background: linear-gradient(to bottom, rgb(255 255 255 / 0.9), transparent);
}

.thinking-bubble::after {
  bottom: 0;
  background: linear-gradient(to top, rgb(255 255 255 / 0.9), transparent);
}

.dark .thinking-bubble::before {
  background: linear-gradient(to bottom, rgb(15 23 42 / 0.9), transparent);
}

.dark .thinking-bubble::after {
  background: linear-gradient(to top, rgb(15 23 42 / 0.9), transparent);
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
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
}

.dark .prose :deep(.sulla-audio-player) {
  background: #1e293b;
  border-color: #334155;
}

.prose :deep(.sulla-audio-label) {
  font-size: 13px;
  font-weight: 500;
  color: #334155;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
  flex-shrink: 0;
}

.dark .prose :deep(.sulla-audio-label) {
  color: #cbd5e1;
}

.prose :deep(.sulla-audio-player audio) {
  flex: 1;
  min-width: 0;
  height: 36px;
}

.prose :deep(.sulla-audio-player audio::-webkit-media-controls-panel) {
  background: transparent;
}
</style>
