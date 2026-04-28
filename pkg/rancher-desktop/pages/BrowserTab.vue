<template>
  <div
    class="h-full overflow-hidden font-sans page-root flex flex-col"
    :class="{ dark: isDark }"
  >
    <AgentHeader
      :is-dark="isDark"
      :toggle-theme="toggleTheme"
    />

    <!-- Browser toolbar — always visible in welcome and browser modes -->
    <template v-if="tabMode === 'welcome' || tabMode === 'browser'">
      <div class="flex items-center gap-2 px-4 py-2 browser-toolbar">
        <button
          class="browser-nav-btn"
          type="button"
          aria-label="Go back"
          :disabled="!canGoBack"
          @click="goBack"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            class="h-4 w-4"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <button
          class="browser-nav-btn"
          type="button"
          aria-label="Go forward"
          :disabled="!canGoForward"
          @click="goForward"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            class="h-4 w-4"
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <button
          class="browser-nav-btn"
          type="button"
          :aria-label="loading ? 'Stop loading' : 'Reload'"
          @click="loading ? stop() : reload()"
        >
          <svg
            v-if="loading"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            class="h-4 w-4 loading-x"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            class="h-4 w-4"
          >
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 16h5v5" />
          </svg>
        </button>

        <form
          class="flex-1 relative"
          @submit.prevent="navigate"
        >
          <input
            ref="addressInput"
            v-model="addressBarUrl"
            type="text"
            class="address-bar"
            placeholder="Search or enter URL"
            @focus="($event.target as HTMLInputElement).select()"
            @keydown.meta.l.prevent="focusAddressBar"
          >
          <!-- Loading progress bar inside address bar -->
          <div
            v-if="loading"
            class="address-bar-progress"
          />
        </form>
      </div>
    </template>

    <!-- Welcome / New Tab page -->
    <template v-if="tabMode === 'welcome'">
      <div class="flex-1 min-h-0 overflow-hidden">
        <NewTabWelcome
          @start-chat="onStartChat"
          @set-mode="onSetMode"
        />
      </div>
    </template>

    <!-- Browser mode: WebContentsView positioning container -->
    <template v-else-if="tabMode === 'browser'">
      <div
        ref="viewContainerRef"
        class="view-container"
      />
    </template>

    <!-- Embedded page modes -->
    <template v-else-if="tabMode === 'calendar'">
      <div class="flex-1 min-h-0 overflow-auto">
        <AgentCalendar embedded />
      </div>
    </template>

    <template v-else-if="tabMode === 'integrations'">
      <div class="flex-1 min-h-0 overflow-auto">
        <AgentIntegrations
          embedded
          @switch-to-vault="onSetMode('vault')"
          @create-account="onIntegrationsCreateAccount"
        />
      </div>
    </template>

    <template v-else-if="tabMode === 'vault'">
      <div class="flex-1 min-h-0 overflow-auto">
        <!-- Vault sub-navigation: list → picker → editor -->
        <AgentConnectedAccounts
          v-if="vaultScreen === 'list'"
          embedded
          @new-account="showIntegrationPicker"
          @edit-account="showAccountEditor"
          @generate-password="openGeneratorStandalone"
        />
        <AgentIntegrations
          v-else-if="vaultScreen === 'picker'"
          embedded
          @back-to-vault="returnToVaultList"
          @create-account="showNewAccountEditor"
        />
        <AgentIntegrationDetail
          v-else-if="vaultScreen === 'detail'"
          :integration-id="editorIntegrationId"
          embedded
          @back="showIntegrationPicker"
          @saved="onAccountSaved"
        />
        <AccountEditor
          v-else-if="vaultScreen === 'editor'"
          :integration-id="editorIntegrationId"
          :account-id="editorAccountId"
          :prefill-password="generatedPasswordForEditor"
          embedded
          @back="goBackFromEditor"
          @saved="onAccountSaved"
          @deleted="onAccountDeleted"
          @open-generator="openGeneratorFromEditor"
        />
        <PasswordGenerator
          v-else-if="vaultScreen === 'generator'"
          :show-use-button="!!generatorTargetField"
          @back="goBackFromGenerator"
          @use-password="onUseGeneratedPassword"
        />
      </div>
    </template>

    <template v-else-if="tabMode === 'account'">
      <div class="flex-1 min-h-0 overflow-auto">
        <MyAccount />
      </div>
    </template>

    <!-- Document mode: raw HTML rendered in Shadow DOM -->
    <template v-else-if="tabMode === 'document'">
      <div class="flex-1 min-h-0 overflow-auto bg-[#0d1117]">
        <HtmlMessageRenderer
          v-if="tabContent"
          :content="tabContent"
          :is-dark="isDark"
          :full-page="true"
          class="h-full w-full"
        />
        <div
          v-else
          class="flex h-full items-center justify-center text-sm text-slate-500"
        >
          Document content unavailable
        </div>
      </div>
    </template>

    <!-- Chat mode: independent chat session per tab -->
    <template v-else-if="tabMode === 'chat'">
      <div class="flex-1 min-h-0 overflow-hidden">
        <BrowserTabChat
          :tab-id="props.tabId"
          @set-mode="onSetMode"
          @navigate-url="onNavigateUrl"
        />
      </div>
    </template>

    <!-- History mode: browsable conversation history -->
    <template v-else-if="tabMode === 'history'">
      <div class="flex-1 min-h-0 overflow-hidden">
        <HistoryTab @navigate-entry="onHistoryNavigate" />
      </div>
    </template>

    <!-- Secretary mode: continuous transcription with wake word -->
    <template v-else-if="tabMode === 'secretary'">
      <div class="flex-1 min-h-0 overflow-hidden">
        <SecretaryMode
          :tab-id="props.tabId"
          @set-mode="onSetMode"
        />
      </div>
    </template>

    <!-- Routines: playbill landing page, switches to canvas when a routine is opened -->
    <template v-else-if="tabMode === 'routines' || tabMode === 'marketplace'">
      <div class="flex-1 min-h-0 overflow-hidden relative">
        <RoutinesHome
          v-if="!activeRoutineId"
          :initial-tab="routinesLandingTab ?? (tabMode === 'marketplace' ? 'marketplace' : 'mywork')"
          @open-workflow="onOpenRoutine"
          @use-template="onUseTemplate"
          @new-blank="onNewBlankRoutine"
        />
        <template v-else>
          <AgentRoutines
            :key="activeRoutineId"
            :workflow-id="activeRoutineId"
            :initial-mode="activeRoutineMode"
            @back-to-home="onBackToRoutinesHome"
          />
          <button
            type="button"
            class="routines-back-btn"
            @click="onBackToRoutinesHome"
          >
            ← All routines
          </button>
        </template>
      </div>
    </template>

    <!-- Labs: experimental features panel -->
    <template v-else-if="tabMode === 'labs'">
      <div class="flex-1 min-h-0 overflow-hidden">
        <LabsPage />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';

import AccountEditor from './AccountEditor.vue';
import AgentCalendar from './AgentCalendar.vue';
import AgentConnectedAccounts from './AgentConnectedAccounts.vue';
import AgentIntegrationDetail from './AgentIntegrationDetail.vue';
import AgentIntegrations from './AgentIntegrations.vue';
import AgentRoutines from './AgentRoutines.vue';
// Swapped to the new componentized chat at ./chat/ChatPage.vue.
// Old implementation at ./BrowserTabChat.vue is kept for rollback.
import BrowserTabChat from './chat/ChatPage.vue';
import HistoryTab from './HistoryTab.vue';
import MyAccount from './MyAccount.vue';
import NewTabWelcome from './NewTabWelcome.vue';
import PasswordGenerator from './PasswordGenerator.vue';
import LabsPage from './LabsPage.vue';
import RoutinesHome from './RoutinesHome.vue';
import SecretaryMode from './SecretaryMode.vue';
import AgentHeader from './agent/AgentHeader.vue';
import { useStartupProgress } from './agent/useStartupProgress';

import HtmlMessageRenderer from '@pkg/components/HtmlMessageRenderer.vue';
import { useBrowserTabs, type BrowserTabMode } from '@pkg/composables/useBrowserTabs';
import { useTheme } from '@pkg/composables/useTheme';
import { useVaultUnlock } from '@pkg/composables/useVaultUnlock';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const MODE_TITLES: Record<BrowserTabMode, string> = {
  welcome:      'New Tab',
  browser:      'New Tab',
  chat:         'Chat',
  calendar:     'Calendar',
  integrations: 'Integrations',
  document:     'Document',
  secretary:    'Secretary',
  vault:        'Password Manager',
  account:      'My Account',
  history:      'History',
  routines:     'Routines',
  marketplace:  'Sulla Studio',
  labs:         'Labs',
};

const props = defineProps<{
  tabId:     string;
  isVisible: boolean;
}>();

const { isDark, toggleTheme } = useTheme();
const { updateTab, getTab, createTab } = useBrowserTabs();
const { showOverlay } = useStartupProgress();

const tabMode = computed<BrowserTabMode>(() => getTab(props.tabId)?.mode || 'welcome');
const tabContent = computed(() => getTab(props.tabId)?.content || '');

function onSetMode(mode: BrowserTabMode | string, subTab?: 'mywork' | 'library' | 'marketplace' | string) {
  // Narrow the mode string to a known BrowserTabMode. Unknown values
  // are ignored — they can only arrive from ModeRail's emit, which is
  // typed as `string` for flexibility.
  if (!(mode in MODE_TITLES)) return;
  const typedMode = mode as BrowserTabMode;

  updateTab(props.tabId, { mode: typedMode, title: MODE_TITLES[typedMode] });

  // Library/My Work both route to `routines` mode; a subTab arg lets
  // ModeRail deep-link directly to the right tab inside RoutinesHome.
  if (typedMode === 'routines' && subTab) {
    if (subTab === 'mywork' || subTab === 'library' || subTab === 'marketplace') {
      routinesLandingTab.value = subTab;
    }
  }

  if (typedMode === 'browser') {
    const url = 'https://www.google.com';
    addressBarUrl.value = url;
    loading.value = true;
    ensureView(url);
  }
}

// ── Routines sub-navigation state ──
// When a routine or template is selected, switch from the playbill
// landing view (RoutinesHome) to the canvas editor (AgentRoutines).
// `null` means show the landing view.
const activeRoutineId = ref<string | null>(null);
const activeRoutineMode = ref<'edit' | 'run'>('edit');
// After backing out of a routine we always want to land on My Work,
// even if the user originally opened the routine from the Marketplace
// or Library tab. Null means "defer to tabMode for initial tab".
const routinesLandingTab = ref<'mywork' | 'library' | 'marketplace' | null>(null);

// Notify ModeRail when sub-tab changes so it can highlight the correct icon
watch(routinesLandingTab, (newTab) => {
  if (newTab) {
    window.dispatchEvent(new CustomEvent('sulla:routines-subtab-change', {
      detail: { subTab: newTab },
    }));
  }
}, { immediate: true });

function onOpenRoutine(id: string, mode: 'edit' | 'run' = 'edit') {
  activeRoutineId.value = id;
  activeRoutineMode.value = mode;
}

function onBackToRoutinesHome() {
  activeRoutineId.value = null;
  routinesLandingTab.value = 'mywork';
}

async function onUseTemplate(slug: string) {
  // Clone the template into the workflows table, then open the new
  // routine in the canvas editor. The IPC call does all the heavy
  // lifting (manifest read + workflow wrapping + DB upsert); here we
  // just translate the returned id into a navigation.
  try {
    const result = await ipcRenderer.invoke('routines-template-instantiate', slug);
    activeRoutineId.value = result.id;
  } catch (err) {
    console.error(`[BrowserTab] Failed to instantiate template "${ slug }":`, err);
    // Leave the user on the template list so they can try again.
  }
}

async function onNewBlankRoutine() {
  try {
    const result = await ipcRenderer.invoke('routines-create-blank');
    activeRoutineId.value = result.id;
  } catch (err) {
    console.error('[BrowserTab] Failed to create blank routine:', err);
  }
}

// ── Vault sub-navigation state ──
const vaultScreen = ref<'list' | 'picker' | 'detail' | 'editor' | 'generator'>('list');
const editorIntegrationId = ref('');
const editorAccountId = ref<string | undefined>(undefined);
const generatorTargetField = ref<string | null>(null);
const generatedPasswordForEditor = ref('');

function setVaultTitle(title: string) {
  updateTab(props.tabId, { title });
}

function returnToVaultList() {
  vaultScreen.value = 'list';
  setVaultTitle('Password Manager');
}

function showIntegrationPicker() {
  vaultScreen.value = 'picker';
  setVaultTitle('New Connection');
}

function showAccountEditor(data: { integrationId: string; accountId: string }) {
  editorIntegrationId.value = data.integrationId;
  editorAccountId.value = data.accountId;
  vaultScreen.value = 'editor';
  setVaultTitle('Edit Account');
}

function showNewAccountEditor(data: { integrationId: string }) {
  editorIntegrationId.value = data.integrationId;
  editorAccountId.value = undefined;
  vaultScreen.value = 'detail';
  setVaultTitle('Connect');
}

function goBackFromEditor() {
  if (editorAccountId.value) {
    returnToVaultList();
  } else {
    showIntegrationPicker();
  }
}

function onAccountSaved() {
  returnToVaultList();
}

function onAccountDeleted() {
  returnToVaultList();
}

function openGeneratorFromEditor(fieldKey: string) {
  generatorTargetField.value = fieldKey;
  generatedPasswordForEditor.value = '';
  vaultScreen.value = 'generator';
  setVaultTitle('Generate Password');
}

function openGeneratorStandalone() {
  generatorTargetField.value = null;
  generatedPasswordForEditor.value = '';
  vaultScreen.value = 'generator';
  setVaultTitle('Generate Password');
}

function goBackFromGenerator() {
  if (generatorTargetField.value) {
    // Return to editor
    vaultScreen.value = 'editor';
    setVaultTitle(editorAccountId.value ? 'Edit Account' : 'New Account');
  } else {
    returnToVaultList();
  }
}

function onUseGeneratedPassword(password: string) {
  if (generatorTargetField.value) {
    generatedPasswordForEditor.value = password;
    vaultScreen.value = 'editor';
    setVaultTitle(editorAccountId.value ? 'Edit Account' : 'New Account');
  } else {
    returnToVaultList();
  }
}

/** Handle "Connect Now" from the standalone Integrations tab — switch to vault flow */
function onIntegrationsCreateAccount(data: { integrationId: string }) {
  onSetMode('vault');
  showNewAccountEditor(data);
}

function onHistoryNavigate(entry: { id: string; type: string; url?: string }) {
  if (entry.type === 'browser' && entry.url && entry.url !== 'about:blank') {
    addressBarUrl.value = normalizeUrl(entry.url);
    navigate();
  }
}

function onNavigateUrl(input: string) {
  addressBarUrl.value = normalizeUrl(input);
  navigate();
}

function onStartChat(_chatQuery: string) {
  // Switch this tab to chat mode
  updateTab(props.tabId, { mode: 'chat', title: 'New Chat' });
}

// ── Context menu AI actions (forwarded from main process) ──

/** Build the tab context object for the side panel. */
function getTabContext() {
  const tab = getTab(props.tabId);

  return {
    url:   addressBarUrl.value || '',
    title: tab?.title || '',
  };
}

/** Open the side panel for this tab and send a rich prompt payload to it. */
async function openSidePanelChat(payload: { prompt: string; selectionText?: string; attachments?: { mediaType: string; base64: string }[] }) {
  await ipcRenderer.invoke('chrome-api:sidePanel:open' as any, { tabId: props.tabId });
  await ipcRenderer.invoke('chrome-api:sidePanel:sendPrompt' as any, {
    prompt:        payload.prompt,
    tab:           getTabContext(),
    selectionText: payload.selectionText,
    attachments:   payload.attachments,
  });
}

function onContextMenuAIAction(_event: unknown, payload: { tabId: string; action: string; text?: string; lang?: string; url?: string }) {
  if (payload.tabId !== props.tabId) return;

  const { action, text, lang, url } = payload;

  if (action === 'open-link-tab' && url) {
    createTab(url);

    return;
  }

  // Explain page — fetch page text then open side panel
  if (action === 'ai-explain-page') {
    ipcRenderer.invoke('browser-tab-view:exec-js', props.tabId, 'document.body.innerText').then((pageText) => {
      const pageContent = pageText ? (pageText as string).slice(0, 8000) : '';
      const prompt = pageContent
        ? `Explain this web page (${ addressBarUrl.value }):\n\n${ pageContent }`
        : `Explain the web page I'm currently viewing at ${ addressBarUrl.value }`;

      openSidePanelChat({ prompt, selectionText: pageContent });
    }).catch(() => {
      openSidePanelChat({ prompt: `Explain the web page I'm currently viewing at ${ addressBarUrl.value }` });
    });

    return;
  }

  // Screenshot — capture the page image and attach it
  if (action === 'ai-screenshot') {
    ipcRenderer.invoke('browser-tab:capture-screenshot', { format: 'jpeg', quality: 80 }, props.tabId).then((result: { base64: string; mediaType: string } | null) => {
      if (result) {
        openSidePanelChat({
          prompt:      `Analyze this screenshot of the page I'm viewing at ${ addressBarUrl.value }`,
          attachments: [{ mediaType: result.mediaType, base64: result.base64 }],
        });
      } else {
        openSidePanelChat({ prompt: 'I tried to take a screenshot but it failed. Can you help me analyze the page another way?' });
      }
    }).catch(() => {
      openSidePanelChat({ prompt: 'Screenshot capture failed.' });
    });

    return;
  }

  // Text-based actions
  const AI_PROMPTS: Record<string, () => string> = {
    'ai-ask':       () => `Explain this:\n\n${ text }`,
    'ai-summarize': () => `Summarize the following:\n\n${ text }`,
    'ai-translate': () => `Translate the following to ${ lang }:\n\n${ text }`,
  };

  const promptBuilder = AI_PROMPTS[action];

  if (!promptBuilder) return;

  openSidePanelChat({ prompt: promptBuilder(), selectionText: text });
}

// ── Side panel state: adjust browser view bounds when panel opens/closes ──

const sidePanelOpen = ref(false);

function onSidePanelStateChanged(_event: unknown, state: { open: boolean; width: number; tabId?: string }) {
  // Only respond to side panel state for this tab (or global broadcasts with no tabId)
  if (state.tabId && state.tabId !== props.tabId) return;
  sidePanelOpen.value = state.open;
  nextTick(() => sendBounds());
}

// Bridge setup removed: agent tools now talk to the tab's WebContents
// directly via main-process TabRegistry + GuestBridge. This component is
// now pure chrome (address bar + WebContentsView host).

const viewContainerRef = ref<HTMLDivElement | null>(null);
const addressInput = ref<HTMLInputElement | null>(null);
const addressBarUrl = ref('');
const loading = ref(false);
const canGoBack = ref(false);
const canGoForward = ref(false);
const viewCreated = ref(false);

// Vault save/autofill is now handled entirely in-page via GuestBridgePreload
// (injected dropdown + save toast). No renderer-side banners needed.

/** Returns true if the input looks like a URL the user wants to navigate to */
function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^localhost(:\d+)?/i.test(trimmed)) return true;
  if (/^127\.0\.0\.1(:\d+)?/i.test(trimmed)) return true;
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/|$)/.test(trimmed)) return true;
  return false;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    return 'about:blank';
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^localhost(:\d+)?/i.test(trimmed) || /^127\.0\.0\.1(:\d+)?/i.test(trimmed)) {
    return `http://${ trimmed }`;
  }
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(trimmed)) {
    return `https://${ trimmed }`;
  }

  return `https://www.google.com/search?q=${ encodeURIComponent(trimmed) }`;
}

function sendBounds() {
  const el = viewContainerRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  // setBounds() uses logical/CSS pixels, not physical pixels.
  // Subtract footer height (22px) so the view doesn't cover it.
  const FOOTER_HEIGHT = 22;
  const fullWidth = Math.round(rect.width);
  const fullHeight = Math.round(window.innerHeight - rect.y - FOOTER_HEIGHT);
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);

  if (sidePanelOpen.value) {
    // Split the tab area: browser view gets 70%, side panel gets 30%
    const panelWidth = Math.floor(fullWidth * 0.3);
    const browserWidth = fullWidth - panelWidth;

    ipcRenderer.invoke('browser-tab-view:set-bounds', props.tabId, {
      x, y, width: Math.max(browserWidth, 200), height: fullHeight,
    });
    // Position the side panel in the remaining space, inside the tab area
    ipcRenderer.invoke('chrome-api:sidePanel:setBounds' as any, {
      x: x + browserWidth, y, width: panelWidth, height: fullHeight,
    });
  } else {
    ipcRenderer.invoke('browser-tab-view:set-bounds', props.tabId, {
      x, y, width: fullWidth, height: fullHeight,
    });
  }
}

/**
 * Create the WebContentsView if it doesn't exist yet.
 * Must be called after the viewContainerRef div is in the DOM (browser mode).
 */
function ensureView(url: string) {
  if (viewCreated.value) return;
  viewCreated.value = true;

  nextTick(() => {
    const el = viewContainerRef.value;
    const rect = el?.getBoundingClientRect();
    const FOOTER_HEIGHT = 22;
    const remainingHeight = rect ? window.innerHeight - rect.y - FOOTER_HEIGHT : 600;
    const bounds = rect
      ? {
        x:      Math.round(rect.x),
        y:      Math.round(rect.y),
        width:  Math.round(rect.width),
        height: Math.round(remainingHeight),
      }
      : { x: 0, y: 0, width: 800, height: 600 };

    // Ensure the view exists in the main-process TabRegistry (idempotent —
    // if it already exists, this navigates to `url`). Then apply the
    // chrome-derived bounds. Splitting creation from positioning means the
    // agent can open a tab before the UI knows where to render it.
    ipcRenderer.invoke('browser-tab-view:create', props.tabId, url, bounds);
    ipcRenderer.invoke('browser-tab-view:set-bounds', props.tabId, bounds);

    // Do NOT call browser-tab-view:focus here. The `shouldShowView`
    // computed + watch below is the single source of truth; flipping
    // viewCreated.value = true (done above) will trigger the watcher
    // reactively if all other focus conditions are already met.

    // Set up ResizeObserver to track bounds changes. Bounds flow
    // continuously regardless of focus state — the main process caches
    // them and only applies them to the native view when the tab is
    // the focused one.
    if (el) {
      resizeObserver = new ResizeObserver(() => sendBounds());
      resizeObserver.observe(el);
    }
  });
}

function navigate() {
  const input = addressBarUrl.value.trim();
  if (!input) return;

  // Address bar always navigates — normalizeUrl falls back to Google search for non-URL input
  const url = normalizeUrl(input);

  if (tabMode.value !== 'browser') {
    // Update tab mode directly — skip onSetMode so it doesn't call ensureView('google')
    // and set viewCreated=true before we can call ensureView with the real URL below.
    updateTab(props.tabId, { mode: 'browser', title: MODE_TITLES['browser'] });
  }

  addressBarUrl.value = url;
  loading.value = true;

  if (!viewCreated.value) {
    ensureView(url);
  } else {
    ipcRenderer.invoke('browser-tab-view:navigate', props.tabId, url);
  }
}

function goBack() {
  ipcRenderer.invoke('browser-tab-view:go-back', props.tabId);
}

function goForward() {
  ipcRenderer.invoke('browser-tab-view:go-forward', props.tabId);
}

function reload() {
  loading.value = true;
  ipcRenderer.invoke('browser-tab-view:reload', props.tabId);
}

function stop() {
  ipcRenderer.invoke('browser-tab-view:stop', props.tabId);
  loading.value = false;
}

function focusAddressBar() {
  addressInput.value?.focus();
  addressInput.value?.select();
}

// Handle keyboard shortcuts
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
    e.preventDefault();
    focusAddressBar();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
    e.preventDefault();
    reload();
  }
}

// IPC state-update listener
function onStateUpdate(_event: unknown, state: { tabId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean }) {
  if (state.tabId !== props.tabId) return;
  addressBarUrl.value = state.url;
  canGoBack.value = state.canGoBack;
  canGoForward.value = state.canGoForward;
  loading.value = state.isLoading;
  if (state.title) {
    updateTab(props.tabId, { title: state.title, url: state.url });
  }
}

// ResizeObserver for bounds tracking
let resizeObserver: ResizeObserver | null = null;

// ── Visibility management ──
// SINGLE SOURCE OF TRUTH on the renderer side. This component is rendered
// with v-show (never removed from DOM), so visibility of the underlying
// native WebContentsView must be driven by reactive state, not lifecycle
// hooks. `shouldShowView` depends on ALL inputs that gate visibility, so
// a change to any of them fires the watcher. The watcher then sends ONE
// event to the main process — `browser-tab-view:focus` with the tabId
// when this view should be visible, or `null` when it shouldn't. The
// main-process BrowserTabViewManager is the authoritative reconciler.
const { loggedIn } = useVaultUnlock();
const shouldShowView = computed(() =>
  props.isVisible
  && !showOverlay.value
  && loggedIn.value
  && viewCreated.value
  && tabMode.value === 'browser',
);

watch(shouldShowView, (visible) => {
  if (visible) {
    window.addEventListener('keydown', onKeydown);
    ipcRenderer.invoke('browser-tab-view:focus', props.tabId);
    nextTick(() => sendBounds());
    // Show this tab's side panel (if it has one) when tab becomes visible
    ipcRenderer.invoke('chrome-api:sidePanel:switchTab' as any, props.tabId);
  } else {
    window.removeEventListener('keydown', onKeydown);
    // Tell main process this tab is no longer the focused one. It won't
    // clobber focus that belongs to a sibling tab — setFocusedTab only
    // acts on transitions where focusedTabId currently equals props.tabId.
    // But to be safe (two tabs racing), we pass the tabId rather than null
    // below — no, that's wrong. We genuinely want "nothing from this
    // component is focused right now." If another BrowserTab.vue instance
    // is visible, ITS watcher will have fired with `visible=true` and
    // claimed focus. Race-safe because main process dedupes via
    // `if (focusedTabId === tabId) return;` at the top of setFocusedTab.
    ipcRenderer.invoke('browser-tab-view:focus', null);
  }
}, { immediate: true });

// ── Lifecycle ──
// onMounted: fires once when the tab is created. Sets URL and creates the WebContentsView.
// onUnmounted: fires when the tab is closed (removed from the tab list).

// Global ModeRail (lives in AgentRouter) dispatches this event when the
// user clicks an icon. Only the visible tab should react — we compare
// props.isVisible so hidden tabs don't fight for mode state.
function onModeRailSelect(e: Event) {
  if (!props.isVisible) return;
  const detail = (e as CustomEvent<{ mode: string; subTab?: string }>).detail;
  if (!detail?.mode) return;
  onSetMode(detail.mode, detail.subTab);
}

onMounted(() => {
  // Listen for state updates from the main process
  ipcRenderer.on('browser-tab-view:state-update' as any, onStateUpdate);
  ipcRenderer.on('browser-context-menu:ai-action' as any, onContextMenuAIAction);
  ipcRenderer.on('side-panel:state-changed' as any, onSidePanelStateChanged);
  window.addEventListener('sulla:mode-rail-select', onModeRailSelect);

  // Read initial URL from the shared tab state
  const tab = getTab(props.tabId);
  const url = tab?.url || '';

  if (url && url !== 'about:blank') {
    addressBarUrl.value = url;
    // If URL was set, ensure mode is browser and create the view
    if (tab?.mode === 'welcome') {
      onSetMode('browser');
    }
    ensureView(url);
  }
  // If no URL, stay in welcome mode — view will be created when user navigates
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('sulla:mode-rail-select', onModeRailSelect);

  ipcRenderer.removeListener('browser-tab-view:state-update' as any, onStateUpdate);
  ipcRenderer.removeListener('browser-context-menu:ai-action' as any, onContextMenuAIAction);
  ipcRenderer.removeListener('side-panel:state-changed' as any, onSidePanelStateChanged);

  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }

  if (viewCreated) {
    ipcRenderer.invoke('browser-tab-view:destroy', props.tabId);
  }
});
</script>

<style scoped>
.browser-toolbar {
  background-color: var(--bg-surface-alt);
  border-bottom: 1px solid var(--border-default);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  position: relative;
  z-index: 1;
}

.address-bar {
  width: 100%;
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  background-color: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 1.5rem;
  outline: none;
  transition: border-color 150ms, box-shadow 150ms;
}

.address-bar:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-primary) 25%, transparent);
}

.address-bar::placeholder {
  color: var(--text-muted);
}

/* Loading progress bar — Chrome-style sliding bar under the address bar */
.address-bar-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 2px;
  width: 30%;
  background: var(--accent-primary);
  border-radius: 0 1px 1px 0;
  animation: address-bar-slide 1.2s ease-in-out infinite;
}

@keyframes address-bar-slide {
  0%   { left: 0; width: 30%; }
  50%  { left: 50%; width: 40%; }
  100% { left: 100%; width: 10%; }
}

/* Loading X icon pulse */
.loading-x {
  animation: loading-pulse 0.8s ease-in-out infinite alternate;
}

@keyframes loading-pulse {
  from { opacity: 0.5; }
  to   { opacity: 1; }
}

.browser-nav-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.375rem;
  border-radius: 0.375rem;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color 150ms, background-color 150ms;
}

.browser-nav-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background-color: var(--bg-surface-hover);
}

.browser-nav-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.view-container {
  /* This div is only a positioning reference for the native WebContentsView.
     It must not take up visible space — the WebContentsView renders on top
     of the window at OS level, not inside the DOM. We keep it in the layout
     flow at zero height so getBoundingClientRect() reports the correct
     x/y position (right below the toolbar). */
  flex: 0 0 0px;
  overflow: hidden;
}

/* Theme-aware scrollbar styling for overflow-auto containers */
.overflow-auto::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.overflow-auto::-webkit-scrollbar-track {
  background: var(--bg-surface);
  border-radius: 4px;
}

.overflow-auto::-webkit-scrollbar-thumb {
  background: var(--border-default);
  border-radius: 4px;
  transition: background-color 150ms;
}

.overflow-auto::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}

.overflow-auto::-webkit-scrollbar-corner {
  background: var(--bg-surface);
}

.routines-back-btn {
  position: absolute;
  top: 18px;
  left: 58px;
  /* Below the NodeDrawer (z-index 10) so the library can slide over
     the back button when opened. Above the canvas chrome (brackets at
     z-index 4) so it remains visible the rest of the time. */
  z-index: 5;
  padding: 6px 12px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #c4d4e6;
  background: rgba(20, 30, 54, 0.82);
  border: 1px solid rgba(140, 172, 201, 0.4);
  border-radius: 4px;
  cursor: pointer;
  backdrop-filter: blur(6px);
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.routines-back-btn:hover {
  color: white;
  background: rgba(74, 111, 165, 0.35);
  border-color: rgba(196, 212, 230, 0.65);
}
</style>
