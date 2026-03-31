<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="browser-ctx-overlay"
      @click="hide"
      @contextmenu.prevent="hide"
    />
    <div
      v-if="visible"
      ref="menuRef"
      class="browser-ctx-menu"
      :style="{ top: posY + 'px', left: posX + 'px' }"
      @contextmenu.prevent
    >
      <!-- Spelling suggestions -->
      <template v-if="ctx.misspelledWord">
        <button
          v-for="suggestion in ctx.dictionarySuggestions.slice(0, 5)"
          :key="suggestion"
          class="browser-ctx-item spelling-suggestion"
          @click="doAction('replace-selection', { text: suggestion })"
        >
          <span>{{ suggestion }}</span>
        </button>
        <div v-if="ctx.dictionarySuggestions.length" class="browser-ctx-separator" />
        <button
          class="browser-ctx-item"
          @click="doAction('add-to-dictionary', { word: ctx.misspelledWord })"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span>Add to Dictionary</span>
        </button>
        <div class="browser-ctx-separator" />
      </template>

      <!-- Navigation -->
      <template v-if="ctx.canGoBack || ctx.canGoForward">
        <button
          class="browser-ctx-item"
          :class="{ disabled: !ctx.canGoBack }"
          :disabled="!ctx.canGoBack"
          @click="emit('go-back')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <span>Back</span>
        </button>
        <button
          class="browser-ctx-item"
          :class="{ disabled: !ctx.canGoForward }"
          :disabled="!ctx.canGoForward"
          @click="emit('go-forward')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
          <span>Forward</span>
        </button>
      </template>
      <button
        class="browser-ctx-item"
        @click="emit('reload')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
          <path d="M16 16h5v5" />
        </svg>
        <span>Reload</span>
        <span class="browser-ctx-shortcut">&#x2318;R</span>
      </button>
      <div class="browser-ctx-separator" />

      <!-- Link actions -->
      <template v-if="ctx.linkURL">
        <button
          class="browser-ctx-item"
          @click="emit('open-link-tab', ctx.linkURL)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
          <span>Open Link in New Tab</span>
        </button>
        <button
          class="browser-ctx-item"
          @click="copyToClipboard(ctx.linkURL)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <span>Copy Link Address</span>
        </button>
        <div class="browser-ctx-separator" />
      </template>

      <!-- Image actions -->
      <template v-if="ctx.mediaType === 'image'">
        <button
          class="browser-ctx-item"
          @click="emit('open-link-tab', ctx.srcURL)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <span>Open Image in New Tab</span>
        </button>
        <button
          class="browser-ctx-item"
          @click="doAction('copy-image', { x: ctx.x, y: ctx.y })"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
          <span>Copy Image</span>
        </button>
        <button
          class="browser-ctx-item"
          @click="copyToClipboard(ctx.srcURL)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <span>Copy Image Address</span>
        </button>
        <button
          class="browser-ctx-item"
          @click="doAction('save-image', { srcURL: ctx.srcURL, suggestedFilename: suggestedImageName })"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span>Save Image As...</span>
        </button>
        <div class="browser-ctx-separator" />
      </template>

      <!-- Editable actions (undo/redo) -->
      <template v-if="ctx.isEditable">
        <button
          class="browser-ctx-item"
          @click="doAction('undo')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7v6h6" />
            <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
          </svg>
          <span>Undo</span>
          <span class="browser-ctx-shortcut">&#x2318;Z</span>
        </button>
        <button
          class="browser-ctx-item"
          @click="doAction('redo')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 7v6h-6" />
            <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
          </svg>
          <span>Redo</span>
          <span class="browser-ctx-shortcut">&#x2318;&#x21E7;Z</span>
        </button>
        <div class="browser-ctx-separator" />
      </template>

      <!-- Clipboard actions -->
      <button
        v-if="ctx.selectionText && ctx.isEditable"
        class="browser-ctx-item"
        @click="doAction('cut')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="6" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <line x1="20" y1="4" x2="8.12" y2="15.88" />
          <line x1="14.47" y1="14.48" x2="20" y2="20" />
          <line x1="8.12" y1="8.12" x2="12" y2="12" />
        </svg>
        <span>Cut</span>
        <span class="browser-ctx-shortcut">&#x2318;X</span>
      </button>
      <button
        v-if="ctx.selectionText"
        class="browser-ctx-item"
        @click="doAction('copy')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
        <span>Copy</span>
        <span class="browser-ctx-shortcut">&#x2318;C</span>
      </button>
      <button
        v-if="ctx.isEditable"
        class="browser-ctx-item"
        @click="doAction('paste')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
        </svg>
        <span>Paste</span>
        <span class="browser-ctx-shortcut">&#x2318;V</span>
      </button>
      <button
        class="browser-ctx-item"
        @click="doAction('select-all')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 3h18v18H3z" />
          <path d="M8 8h8v8H8z" />
        </svg>
        <span>Select All</span>
        <span class="browser-ctx-shortcut">&#x2318;A</span>
      </button>
      <div class="browser-ctx-separator" />

      <!-- Sulla AI section -->
      <div class="browser-ctx-subheader">Sulla AI</div>

      <button
        v-if="ctx.selectionText"
        class="browser-ctx-item ai-item"
        @click="emitAI('ask', ctx.selectionText)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M12 7v2" />
          <path d="M12 13h.01" />
        </svg>
        <span>Ask Sulla about this</span>
      </button>

      <button
        v-if="ctx.selectionText && ctx.selectionText.length > 100"
        class="browser-ctx-item ai-item"
        @click="emitAI('summarize', ctx.selectionText)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
        <span>Summarize</span>
      </button>

      <!-- Translate submenu -->
      <template v-if="ctx.selectionText">
        <div class="browser-ctx-subheader-sm">Translate to...</div>
        <button
          v-for="lang in translateLanguages"
          :key="lang.code"
          class="browser-ctx-item ai-item translate-item"
          @click="emitAI('translate', ctx.selectionText, lang.code)"
        >
          <span class="translate-flag">{{ lang.flag }}</span>
          <span>{{ lang.name }}</span>
        </button>
        <div class="browser-ctx-separator" />
      </template>

      <button
        class="browser-ctx-item ai-item"
        @click="emitAI('explain-page')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </svg>
        <span>Explain this page</span>
      </button>

      <button
        class="browser-ctx-item ai-item"
        @click="emitAI('screenshot-analyze')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
        <span>Screenshot &amp; Analyze</span>
      </button>

      <div class="browser-ctx-separator" />

      <!-- Page actions -->
      <button
        class="browser-ctx-item"
        @click="doAction('view-source', { x: ctx.x, y: ctx.y })"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
        <span>View Page Source</span>
      </button>
      <button
        class="browser-ctx-item"
        @click="doAction('inspect', { x: ctx.x, y: ctx.y })"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
        <span>Inspect Element</span>
      </button>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export interface BrowserContextPayload {
  tabId:                string;
  x:                    number;
  y:                    number;
  selectionText:        string;
  linkURL:              string;
  srcURL:               string;
  mediaType:            string;
  isEditable:           boolean;
  misspelledWord:       string;
  dictionarySuggestions: string[];
  canGoBack:            boolean;
  canGoForward:         boolean;
  pageURL:              string;
}

const translateLanguages = [
  { code: 'es', name: 'Spanish',    flag: '\uD83C\uDDEA\uD83C\uDDF8' },
  { code: 'fr', name: 'French',     flag: '\uD83C\uDDEB\uD83C\uDDF7' },
  { code: 'de', name: 'German',     flag: '\uD83C\uDDE9\uD83C\uDDEA' },
  { code: 'ja', name: 'Japanese',   flag: '\uD83C\uDDEF\uD83C\uDDF5' },
  { code: 'zh', name: 'Chinese',    flag: '\uD83C\uDDE8\uD83C\uDDF3' },
  { code: 'pt', name: 'Portuguese', flag: '\uD83C\uDDE7\uD83C\uDDF7' },
];

const emit = defineEmits<{
  'go-back': [];
  'go-forward': [];
  'reload': [];
  'open-link-tab': [url: string];
  'ai-action': [action: string, text?: string, lang?: string];
}>();

const visible = ref(false);
const posX = ref(0);
const posY = ref(0);
const menuRef = ref<HTMLElement | null>(null);

const emptyCtx: BrowserContextPayload = {
  tabId: '', x: 0, y: 0, selectionText: '', linkURL: '', srcURL: '',
  mediaType: '', isEditable: false, misspelledWord: '',
  dictionarySuggestions: [], canGoBack: false, canGoForward: false, pageURL: '',
};

const ctx = ref<BrowserContextPayload>({ ...emptyCtx });

const suggestedImageName = computed(() => {
  if (!ctx.value.srcURL) return 'image.png';
  try {
    const url = new URL(ctx.value.srcURL);
    const segments = url.pathname.split('/');
    return segments[segments.length - 1] || 'image.png';
  } catch {
    return 'image.png';
  }
});

function show(payload: BrowserContextPayload) {
  ctx.value = payload;
  posX.value = payload.x;
  posY.value = payload.y;
  visible.value = true;

  nextTick(() => {
    if (!menuRef.value) return;
    const rect = menuRef.value.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (rect.right > vw) posX.value = Math.max(0, vw - rect.width - 4);
    if (rect.bottom > vh) posY.value = Math.max(0, vh - rect.height - 4);
  });
}

function hide() {
  visible.value = false;
}

async function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  hide();
}

function doAction(action: string, payload?: Record<string, unknown>) {
  ipcRenderer.invoke('browser-context-menu:action', ctx.value.tabId, action, payload);
  hide();
}

function emitAI(action: string, text?: string, lang?: string) {
  emit('ai-action', action, text, lang);
  hide();
}

defineExpose({ show, hide });
</script>

<style>
/* Unscoped — teleported to body */
.browser-ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
}

.browser-ctx-menu {
  position: fixed;
  z-index: 10000;
  min-width: 220px;
  max-width: 320px;
  max-height: 80vh;
  overflow-y: auto;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6), 0 0 1px rgba(63, 185, 80, 0.15);
  padding: 6px 0;
  animation: browserCtxFadeIn 0.15s ease-out;
  font-family: var(--ifm-font-family-monospace, ui-monospace, SFMono-Regular, Menlo, monospace);
}

@keyframes browserCtxFadeIn {
  from { opacity: 0; transform: scale(0.96); }
  to   { opacity: 1; transform: scale(1); }
}

.browser-ctx-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 14px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.browser-ctx-item:hover:not(.disabled) {
  background: var(--bg-surface-hover);
  color: var(--accent-primary);
}

.browser-ctx-item:hover:not(.disabled) svg {
  stroke: var(--accent-primary);
}

.browser-ctx-item.disabled {
  opacity: 0.4;
  cursor: default;
}

.browser-ctx-item.spelling-suggestion {
  font-weight: 600;
  color: var(--accent-primary);
}

.browser-ctx-item.ai-item:hover:not(.disabled) {
  color: var(--accent-primary);
}

.browser-ctx-item.translate-item {
  padding-left: 28px;
  font-size: 12px;
}

.translate-flag {
  font-size: 14px;
  line-height: 1;
}

.browser-ctx-shortcut {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
  padding-left: 16px;
}

.browser-ctx-separator {
  height: 1px;
  background: var(--border-default);
  margin: 4px 0;
}

.browser-ctx-subheader {
  padding: 8px 14px 4px;
  font-weight: 600;
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.browser-ctx-subheader-sm {
  padding: 4px 14px 2px;
  font-size: 11px;
  color: var(--text-muted);
}

/* Scrollbar for long menus */
.browser-ctx-menu::-webkit-scrollbar {
  width: 6px;
}

.browser-ctx-menu::-webkit-scrollbar-track {
  background: transparent;
}

.browser-ctx-menu::-webkit-scrollbar-thumb {
  background: var(--border-default);
  border-radius: 3px;
}
</style>
