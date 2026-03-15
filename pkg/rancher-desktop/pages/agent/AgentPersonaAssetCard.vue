<template>
  <div
    class="overflow-hidden border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900/60"
    :class="isLarge ? 'flex min-h-0 flex-1 flex-col border-l rounded-none' : 'rounded-xl'"
  >
    <button
      type="button"
      class="flex h-10 w-full items-center justify-between gap-2 border-b border-slate-200 px-3 text-left transition-colors hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/80"
      @click="emit('toggle-size')"
    >
      <div class="min-w-0 flex items-center gap-2">
        <span
          class="inline-flex h-2 w-2 rounded-full"
          :class="isActive ? 'bg-emerald-500' : 'bg-slate-400 dark:bg-slate-500'"
        />
        <span class="truncate text-xs font-semibold tracking-wide text-slate-700 dark:text-slate-200">
          {{ asset.title }}
        </span>
        <span
          class="rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
          :class="isActive ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'"
        >
          {{ isActive ? 'Active' : 'Idle' }}
        </span>
        <span class="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          {{ asset.type }}
        </span>
      </div>
      <svg
        width="14"
        height="14"
        viewBox="0 0 15 15"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        class="shrink-0 text-slate-500 transition-transform"
        :class="isLarge ? 'rotate-180' : ''"
        aria-hidden="true"
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
      class="min-h-0 flex-1"
      :class="isLarge ? 'h-full' : ''"
    >
      <div
        v-if="asset.type === 'iframe'"
        class="overflow-hidden min-h-0"
        :class="isLarge ? 'h-full' : 'h-56'"
      >
        <webview
          v-if="useWebview"
          ref="webviewEl"
          :src="asset.url || ''"
          :title="asset.title"
          class="block h-full w-full bg-white"
          :style="frameStyle"
        />
        <iframe
          v-else
          :src="asset.url || ''"
          :title="asset.title"
          class="block h-full w-full bg-white"
          :style="frameStyle"
        />
      </div>

      <div
        v-else
        class="flex h-full min-h-0 flex-col bg-white dark:bg-slate-900"
      >
        <template v-if="assetSize === 'medium'">
          <div class="h-56 overflow-hidden border-t border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50">
            <div
              class="origin-top-left scale-[0.5] px-2 py-1 text-[11px] leading-4 text-slate-700 opacity-80 dark:text-slate-300"
              v-html="sanitizeAssetHtml(asset.content || '<p>Empty document</p>')"
            />
          </div>
        </template>
        <template v-else>
          <div class="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-800/50">
            <button
              type="button"
              class="rounded px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
              @click="emit('document-format', 'bold')"
            >
              Bold
            </button>
            <button
              type="button"
              class="rounded px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
              @click="emit('document-format', 'italic')"
            >
              Italic
            </button>
            <button
              type="button"
              class="rounded px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
              @click="emit('document-format', 'underline')"
            >
              Underline
            </button>
            <button
              type="button"
              class="rounded px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
              @click="emit('document-format', 'formatBlock', '<h3>')"
            >
              H3
            </button>
            <button
              type="button"
              class="rounded px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
              @click="emit('document-format', 'insertUnorderedList')"
            >
              • List
            </button>
            <button
              type="button"
              class="rounded px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
              @click="emit('document-format', 'insertOrderedList')"
            >
              1. List
            </button>
            <button
              type="button"
              class="rounded px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
              @click="emit('document-format', 'createLink')"
            >
              Link
            </button>
          </div>
          <div
            contenteditable="true"
            class="min-h-0 flex-1 overflow-y-auto p-3 text-sm leading-6 text-slate-800 outline-none dark:text-slate-100"
            @input="emit('document-input', asset.id, $event)"
            @blur="emit('document-input', asset.id, $event)"
            v-html="sanitizeAssetHtml(asset.content || '')"
          />
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type CSSProperties } from 'vue';

import type { PersonaSidebarAsset } from '@pkg/agent';
import { getN8nVueBridgeService, N8nVueBridgeService, type N8nWebviewLike } from '@pkg/agent/services/N8nVueBridgeService';
import { WebviewHostBridge, type WebviewLike, type HostBridgeEventMap, setActiveHostBridge, hostBridgeRegistry } from '@pkg/agent/scripts/injected';
import { getWebSocketClientService } from '@pkg/agent/services/WebSocketClientService';

type AssetSize = 'medium' | 'large';
const N8N_INTERFACE_CHANNEL = 'n8n_interface';

const props = defineProps<{
  asset:             PersonaSidebarAsset;
  assetSize:         AssetSize;
  isActive:          boolean;
  sanitizeAssetHtml: (html: string) => string;
  threadId?:         string;
}>();

const emit = defineEmits<{
  (e: 'toggle-size'): void;
  (e: 'document-input', assetId: string, event: Event): void;
  (e: 'document-format', command: string, value?: string): void;
}>();

const webviewEl = ref<HTMLElement | null>(null);
let n8nVueBridgeService: N8nVueBridgeService | null = null;
let hostBridge: WebviewHostBridge | null = null;
const useWebview = ref(true);
const wsService = getWebSocketClientService();
const bridgeUnsubs: (() => void)[] = [];
const hostBridgeUnsubs: (() => void)[] = [];

const isLarge = computed(() => props.assetSize === 'large');
const shouldUseSmallModeZoom = computed(() => {
  return props.asset.type === 'iframe' && props.isActive && props.assetSize === 'medium';
});

const isN8nAsset = computed(() => {
  if (props.asset.type !== 'iframe') {
    return false;
  }

  const url = String(props.asset.url || '').trim();
  return url.includes(':30119');
});

const frameStyle = computed(() => {
  const zoom = shouldUseSmallModeZoom.value ? 0.5 : 1;
  return {
    width:           `${ 100 / zoom }% !important`,
    height:          `${ 100 / zoom }% !important`,
    transform:       `scale(${ zoom })`,
    transformOrigin: 'top left',
  } as CSSProperties;
});

const detachBridge = (): void => {
  if (n8nVueBridgeService) {
    n8nVueBridgeService.detach();
  }
  if (hostBridge) {
    hostBridge.detach();
  }
};

const stopBridgeEventStreaming = (): void => {
  while (bridgeUnsubs.length > 0) {
    const unsub = bridgeUnsubs.pop();
    try {
      unsub?.();
    } catch {
      // no-op
    }
  }
};

const buildBridgeEventContent = (event: 'injected' | 'routeChanged' | 'socketEvent' | 'click' | 'bridgeError', payload: any): string => {
  if (event === 'routeChanged') {
    const path = String(payload?.fullPath || payload?.path || '').trim();
    const title = String(payload?.title || '').trim();
    return `[n8n ui] routeChanged${ path ? ` path=${ path }` : '' }${ title ? ` title="${ title }"` : '' }`;
  }

  if (event === 'socketEvent') {
    const type = String(payload?.type || 'push').trim();
    const channel = String(payload?.channel || '').trim();
    return `[n8n ui] socketEvent type=${ type }${ channel ? ` channel=${ channel }` : '' }`;
  }

  if (event === 'click') {
    const text = String(payload?.text || '').trim();
    const dataTestId = String(payload?.dataTestId || '').trim();
    return `[n8n ui] click${ text ? ` text="${ text }"` : '' }${ dataTestId ? ` dataTestId=${ dataTestId }` : '' }`;
  }

  if (event === 'bridgeError') {
    const message = String(payload?.message || 'unknown').trim();
    return `[n8n ui] bridgeError ${ message }`;
  }

  const url = String(payload?.url || '').trim();
  return `[n8n ui] injected${ url ? ` url=${ url }` : '' }`;
};

const publishBridgeEventToActionNote = async(
  event: 'injected' | 'routeChanged' | 'socketEvent' | 'click' | 'bridgeError',
  payload: unknown,
): Promise<void> => {
  const threadId = String(props.threadId || '').trim();
  if (!threadId) {
    console.log('[SULLA_N8N_VUE_BRIDGE] card:event_skip_no_thread', {
      assetId: props.asset.id,
      event,
    });
    return;
  }

  const content = buildBridgeEventContent(event, payload);

  await wsService.send(N8N_INTERFACE_CHANNEL, {
    type: 'n8n_vue_bridge_event',
    data: {
      threadId,
      eventType: event,
      content,
      payload,
      source:    'n8n_vue_bridge',
      assetId:   props.asset.id,
    },
    timestamp: Date.now(),
  });
};

const ensureBridgeEventStreaming = (): void => {
  if (!n8nVueBridgeService || bridgeUnsubs.length > 0) {
    return;
  }

  bridgeUnsubs.push(n8nVueBridgeService.on('routeChanged', (payload) => {
    void publishBridgeEventToActionNote('routeChanged', payload);
  }));
  bridgeUnsubs.push(n8nVueBridgeService.on('socketEvent', (payload) => {
    void publishBridgeEventToActionNote('socketEvent', payload);
  }));
  bridgeUnsubs.push(n8nVueBridgeService.on('click', (payload) => {
    void publishBridgeEventToActionNote('click', payload);
  }));
  bridgeUnsubs.push(n8nVueBridgeService.on('bridgeError', (payload) => {
    void publishBridgeEventToActionNote('bridgeError', payload);
  }));
};

const stopHostBridgeEventStreaming = (): void => {
  while (hostBridgeUnsubs.length > 0) {
    const unsub = hostBridgeUnsubs.pop();
    try { unsub?.() } catch { /* no-op */ }
  }
};

const ensureHostBridgeEventStreaming = (): void => {
  if (!hostBridge || hostBridgeUnsubs.length > 0) return;

  hostBridgeUnsubs.push(hostBridge.on('injected', (payload: HostBridgeEventMap['injected']) => {
    console.log('[SULLA_HOST_BRIDGE] card:injected', { assetId: props.asset.id, payload });
  }));
  hostBridgeUnsubs.push(hostBridge.on('routeChanged', (payload: HostBridgeEventMap['routeChanged']) => {
    console.log('[SULLA_HOST_BRIDGE] card:routeChanged', { assetId: props.asset.id, payload });
  }));
  hostBridgeUnsubs.push(hostBridge.on('click', (payload: HostBridgeEventMap['click']) => {
    console.log('[SULLA_HOST_BRIDGE] card:click', { assetId: props.asset.id, payload });
  }));
};

const attachBridgeIfNeeded = async(): Promise<void> => {
  if (props.asset.type !== 'iframe') {
    detachBridge();
    return;
  }

  await nextTick();

  if (!webviewEl.value) {
    console.log('[SULLA_HOST_BRIDGE] card:webview_ref_missing_fallback_iframe', {
      assetId: props.asset.id,
      url:     props.asset.url || '',
    });
    useWebview.value = false;
    return;
  }

  const candidate = webviewEl.value as unknown as WebviewLike;
  const hasWebviewApi = typeof candidate.getURL === 'function' || typeof candidate.executeJavaScript === 'function';
  const domSrc = (webviewEl.value).getAttribute('src') || '';

  console.log('[SULLA_HOST_BRIDGE] card:webview_runtime_probe', {
    assetId:              props.asset.id,
    tagName:              webviewEl.value.tagName,
    domSrc,
    propUrl:              props.asset.url || '',
    hasGetURL:            typeof candidate.getURL === 'function',
    hasExecuteJavaScript: typeof candidate.executeJavaScript === 'function',
    hasWebviewApi,
  });

  if (!hasWebviewApi) {
    console.log('[SULLA_HOST_BRIDGE] card:webview_api_missing_fallback_iframe', {
      assetId: props.asset.id,
      reason:  'Electron webview APIs not present on rendered element',
    });
    useWebview.value = false;
    detachBridge();
    return;
  }

  useWebview.value = true;

  // Generic host bridge — one per asset card, registered by assetId
  if (!hostBridge) {
    hostBridge = new WebviewHostBridge();
    setActiveHostBridge(hostBridge);
    ensureHostBridgeEventStreaming();
  }
  hostBridge.attach(candidate);

  // Register in the multi-asset registry
  hostBridgeRegistry.registerBridge(props.asset.id, hostBridge, {
    title: props.asset.title,
    url:   props.asset.url || '',
  });
  if (props.isActive) {
    hostBridgeRegistry.setActiveBridge(props.asset.id);
  }

  // N8n-specific bridge — only for n8n assets
  if (isN8nAsset.value) {
    if (!n8nVueBridgeService) {
      n8nVueBridgeService = getN8nVueBridgeService();
      ensureBridgeEventStreaming();
    }
    n8nVueBridgeService.markInitialized('AgentPersonaAssetCard:attach_attempt');
    n8nVueBridgeService.attach(webviewEl.value as unknown as N8nWebviewLike);
  }
};

watch([() => props.asset.type, () => props.asset.url, isN8nAsset], () => {
  void attachBridgeIfNeeded();
}, { immediate: true });

onMounted(() => {
  void attachBridgeIfNeeded();
});

watch(() => props.isActive, (active) => {
  if (active && hostBridge) {
    hostBridgeRegistry.setActiveBridge(props.asset.id);
    setActiveHostBridge(hostBridge);
  }
});

watch(() => props.asset.url, (url) => {
  hostBridgeRegistry.updateMeta(props.asset.id, { url: url || '' });
});

onUnmounted(() => {
  stopBridgeEventStreaming();
  stopHostBridgeEventStreaming();
  hostBridgeRegistry.unregisterBridge(props.asset.id);
  detachBridge();
  n8nVueBridgeService = null;
  // Update singleton to next available bridge
  const nextActive = hostBridgeRegistry.getActiveAssetId();
  const nextEntry = nextActive ? hostBridgeRegistry.resolve(nextActive) : null;
  setActiveHostBridge(nextEntry);
  hostBridge = null;
});
</script>

<style scoped>
:deep(webview) {
  display: inline-flex;
  min-height: 100% !important;
}

:deep(webview::shadow iframe) {
  width: 100% !important;
  height: 100% !important;
  min-height: 100% !important;
}
</style>
