<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Composer — the only container in the bottom region. Orchestrates:
    • Thread status line and its details, docked above the card
    • Queue strip (visible only when queued messages exist)
    • Attachment tray (visible when staged attachments exist)
    • Command popover (slash / mention autocomplete)
    • Run controls (stop / continue)
    • Either the textarea OR the voice panel, mutually exclusive
    • Mic + paperclip buttons
    • Keyboard hints row below the input underline

  Reads everything from the controller. The only "logic" here is:
    1. send() / queue()   on Enter
    2. stage file          on paperclip click (demo picks a random file)
    3. start/stop voice    on mic click — delegates to VoiceSessionAdapter
-->
<template>
  <div
    ref="wrapEl"
    class="composer-wrap"
  >
    <div class="composer-inner">
      <RunControls />
      <CommandPopover @choose="choosePopoverItem" />
      <ShelfPanel
        v-if="shelfRequest"
        :key="`${shelfRequest.mode}:${shelfRequest.name ?? ''}`"
        :request="shelfRequest"
        @close="shelfRequest = null"
      />
      <!-- Kept mounted in the side dock (it also drives the tab dots); the tabs and lanes show its content there. -->
      <div class="dock-status">
        <ThreadStatusLine>
          <template #end>
            <span
              class="dock-divider"
              aria-hidden="true"
            />
            <button
              type="button"
              class="dock-move"
              :class="{ on: drawerOpen }"
              :title="drawerOpen ? 'Close the side panel' : 'Open the side panel'"
              :aria-label="drawerOpen ? 'Close the side panel' : 'Open the side panel: agents, results, decisions and files'"
              :aria-pressed="drawerOpen"
              @click="setPosition(drawerOpen ? 'bottom' : 'side')"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
              ><rect
                x="3"
                y="4"
                width="18"
                height="16"
                rx="2"
              /><path d="M15 4v16" /></svg>
            </button>
          </template>
        </ThreadStatusLine>
      </div>
      <div class="composer-card">
        <div class="composer-top">
          <div v-if="remoteChat.bound.value" class="remote-chat-status" role="status">
            <strong>{{ remoteChat.bound.value.name }}</strong> ·
            <span class="remote-chat-dot" :class="{ live: remoteChat.status.value.startsWith('Connected') }" aria-hidden="true" />
            {{ remoteChat.status.value }}
          </div>
          <div v-if="remoteChat.note.value || remoteWarning" class="remote-chat-status" role="status">{{ remoteChat.note.value || remoteWarning }}</div>
          <div
            v-if="replyTo"
            class="reply-chip"
            role="status"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
            ><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" /></svg>
            <span class="reply-chip-text"><b>Replying to</b> {{ replyTo }}</span>
            <button
              type="button"
              class="reply-chip-x"
              aria-label="Cancel reply"
              title="Cancel reply (Esc)"
              @mousedown.prevent
              @click="replyTo = ''"
            >
              ×
            </button>
          </div>
          <QueueStrip />
          <AttachmentTray />
          <div v-if="useCases.intent.value" class="usecase-intent">
            <span class="usecase-chip" role="status">
              <span :class="['usecase-type', useCases.intent.value.item.type]" aria-hidden="true" />
              <span class="usecase-verb">{{ intentLabel.verb }}</span><b>{{ intentLabel.title }}</b>
              <button type="button" class="usecase-chip-x" :aria-label="`Remove ${ intentLabel.title }`" title="Remove (⌫ on empty draft)" @mousedown.prevent @click="useCases.removeIntent()">×</button>
            </span>
            <div v-if="useCases.intent.value.fields.length" class="usecase-inputs">
              <label
                v-for="field in useCases.intent.value.fields"
                :key="field.name"
                :class="['usecase-field', { missing: field.required && !field.value.trim() }]"
              >
                <span>{{ field.label || field.name }}</span>
                <input v-model="field.value" type="text" :placeholder="field.required ? 'required' : ''">
              </label>
            </div>
          </div>

        </div>

        <div
          :class="['composer', { recording: isRecording }]"
          @mousedown="focusFromBar"
        >
          <span class="glyph">—</span>

          <div v-if="useCases.open.value" class="usecase-strip">
            <div class="usecase-strip-hd">
              <span class="usecase-lbl">Use cases</span>
              <span>{{ useCases.strip.items.length }} {{ useCases.strip.items.length === 1 ? 'match' : 'matches' }}</span>
              <span class="usecase-sp" />
              <span v-if="useCases.strip.latencyMs" class="usecase-lat">{{ useCases.strip.latencyMs }} ms</span>
              <button
                type="button"
                class="usecase-strip-x" tabindex="-1" aria-label="Hide suggestions" title="Hide until the topic changes (Esc)" @mousedown.prevent @click="useCases.dismiss()"
              >
                ×
              </button>
            </div>
            <ul
              id="usecase-list"
              class="usecase-list" role="listbox" aria-label="Suggested use cases" @mousedown.prevent
            >
              <li
                v-for="(item, index) in useCases.strip.items"
                :id="`usecase-option-${ index }`"
                :key="`${ item.type }:${ item.slug }`"
                role="option"
                :aria-selected="useCases.strip.active === index"
                class="usecase-row"
                @click="pickUseCase(item)"
              >
                <span :class="['usecase-type', item.type]">{{ USE_CASE_TYPE_LABEL[item.type] }}</span>
                <span class="usecase-row-main"><span class="usecase-row-t">{{ item.title }}</span><span class="usecase-row-d">{{ item.description }}</span></span>
                <span class="usecase-row-why"><em v-if="item.reason">{{ item.reason }}</em><kbd>{{ modKey }}{{ index + 1 }}</kbd></span>
              </li>
            </ul>
          </div>

          <!-- Text mode -->
          <ComposerInput
            v-if="!isRecording"
            ref="inputRef"
            :model-value="draft"
            :placeholder="placeholder"
            :active-descendant="useCases.open.value && useCases.strip.active >= 0 ? `usecase-option-${ useCases.strip.active }` : undefined"
            @update:modelValue="draft = $event"
            @send="onSend"
            @keydown="onKeydown"
          />

          <!-- Voice mode -->
          <ComposerVoicePanel
            v-else
            :started-at="recStartedAt"
            :level="recLevel"
            :speaking="recSpeaking"
            :ptt="recPtt"
            :finishing="recFinishing"
            @stop="stopVoice(true)"
          />

          <div class="composer-tools" :class="{ 'remote-enabled': remoteChat.available.value || remoteChat.remote.value }">
            <ComposerAttach :open="filesMenuOpen" @pick="toggleFilesMenu" />
            <FilesAttachMenu :open="filesMenuOpen" :recent="recentFiles" :recording="screenRecording" :uploading="filesImporting" :upload-error="filesImportError" @browse="browseFiles" @upload="uploadFromMac" @choose="stageFilesReference" @screenshot="takeScreenshot" @record="toggleScreenRecording" />
            <HeartbeatControl />
            <button v-if="!remoteChat.remote.value" class="model-btn" type="button" :title="side ? `${selectionTitle} · ${usagePercent}% of context used` : selectionTitle" :style="{ '--usage': `${usagePercent}%` }" @click="controller.openModal('model')">
              <span class="model-avatar">{{ modelInitial }}</span>
              <span class="model-name">{{ selectionLabel }}</span>
              <span class="model-caret">▾</span>
            </button>
            <select v-else class="model-btn remote-model" aria-label="Model" :value="remoteModelKey" @change="onRemoteModel">
              <option value="">Choose model</option>
              <option v-for="model in remoteChat.models.value" :key="modelKey(model)" :value="modelKey(model)">
                {{ model.modelId }} · {{ model.providerId }}
              </option>
            </select>
            <EnvironmentPicker v-if="remoteChat.available.value || remoteChat.remote.value"
              :selected="remoteSelected" :devices="remoteDevices"
              :bound="Boolean(remoteChat.bound.value || controller.messages.value.length)"
              @choose="chooseEnvironment" />
            <span class="tool-spacer" />
            <button
              class="usage-meter" type="button" title="Context usage"
              @click="controller.openModal('tokens')"
            >
              <span class="usage-ring" :style="{ '--usage': `${usagePercent}%` }" />
              <span>{{ usagePercent }}%</span>
            </button>
            <ComposerMic :live="isRecording" @toggle="toggleVoice" />
            <ComposerSend
              :running="remoteChat.remote.value ? remoteChat.running.value : controller.isRunning.value"
              :can-send="canSendDraft"
              @send="onSend(draft)"
            />
          </div>

        </div>
      </div>

      <div
        v-if="reportingLevel !== 'info'"
        class="hints"
        :class="{ 'hints-contextual': contextualHints }"
      >
        <div class="classic-guide">
          <span><kbd>⏎</kbd> send</span>
          <span><kbd>hold ␣</kbd> talk</span>
          <span><kbd>⌘/</kbd> voice</span>
          <span><kbd>?</kbd> help</span>
        </div>
        <div class="noir-guide">
          <template v-if="isRecording">
            <span><kbd>⌘/</kbd> stop listening</span>
          </template>
          <template v-else-if="controller.popover.value.open">
            <span><kbd>↑↓</kbd> choose</span>
            <span><kbd>⏎</kbd> run</span>
            <span><kbd>esc</kbd> close</span>
          </template>
          <template v-else-if="useCases.intent.value">
            <span><kbd>⏎</kbd> {{ intentSendHint }}</span>
            <span><kbd>⌫</kbd> remove chip (empty draft)</span>
            <span><kbd>⇧⏎</kbd> new line</span>
          </template>
          <template v-else-if="useCases.open.value && useCases.strip.active >= 0">
            <span><kbd>↑↓</kbd> choose</span>
            <span><kbd>⏎</kbd> pick</span>
            <span><kbd>esc</kbd> back to typing</span>
          </template>
          <template v-else-if="useCases.open.value">
            <span><kbd>⏎</kbd> send</span>
            <span><kbd>↓</kbd> suggestions</span>
            <span><kbd>{{ modKey }}1–5</kbd> pick</span>
            <span><kbd>esc</kbd> hide</span>
          </template>
          <template v-else-if="draft.trim()">
            <span><kbd>⏎</kbd> send</span>
            <span><kbd>⇧⏎</kbd> new line</span>
          </template>
          <template v-else>
            <span><kbd>/</kbd> commands</span>
            <span><kbd>@</kbd> context</span>
            <span><kbd>⌘/</kbd> voice</span>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';

import AttachmentTray     from './AttachmentTray.vue';
import CommandPopover     from './CommandPopover.vue';
import ComposerAttach     from './ComposerAttach.vue';
import ComposerInput      from './ComposerInput.vue';
import ComposerMic        from './ComposerMic.vue';
import ComposerSend       from './ComposerSend.vue';
import ComposerVoicePanel from './ComposerVoicePanel.vue';
import EnvironmentPicker from './EnvironmentPicker.vue';
import FilesAttachMenu, { type FilesReference } from './FilesAttachMenu.vue';
import HeartbeatControl   from './HeartbeatControl.vue';
import QueueStrip         from './QueueStrip.vue';
import RunControls        from './RunControls.vue';
import ShelfPanel         from './ShelfPanel.vue';
import ThreadStatusLine   from './ThreadStatusLine.vue';

import { FIRST_RUN_STARTER_PROMPT_KEY } from '../../../firstRunStarter';
import { useArtifactMentions } from '../../composables/useArtifactMentions';
import { useCommandPopover } from '../../composables/useCommandPopover';
import { DockPositions } from '../../composables/useDockPosition';
import { useSelectionLabel } from '../../composables/useSelectionLabel';
import { useUseCaseSuggestions } from '../../composables/useUseCaseSuggestions';
import { ChatController } from '../../controller/ChatController';
import { LocalStoragePersister } from '../../services/LocalStoragePersister';
import { asThreadId } from '../../types/chat';
import { useChatController } from '../../controller/useChatController';
import { composeReply, replyExcerpt } from '../../messages/replyQuote';
import { ShelfNotes, type ShelfRequest } from '../../messages/shelfNote';
import { defaultSlashCommands, type SlashCommand, type MentionTarget } from '../../models/Command';
import { AttachmentService } from '../../services/AttachmentService';
import { VoiceSessionAdapter } from '../../services/VoiceSessionAdapter';
import { RemoteChatSession, type RemoteChatTransport, type RemoteDevice, type RemoteModel } from '../../services/RemoteChatSession';
import { useBrowserTabs } from '@pkg/composables/useBrowserTabs';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import type { SuggestedUseCase, SuggestedUseCaseType, UseCaseSuggestionResponse } from '@pkg/shared/useCaseSuggestions';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { ReportingLevel } from '../../models/ReportingLevel';

const props = defineProps<{ reportingLevel: ReportingLevel }>();
const reportingLevel = computed(() => props.reportingLevel);

const controller = useChatController();

// Injected by ChatPage when nested inside a browser tab — lets us open the
// browser directly when the user types a bare URL instead of a chat message.
const navigateUrl = inject<((url: string) => void) | undefined>('chat:navigate-url', undefined);
// Is this chat tab on screen? Undefined (no tab host) counts as active.
const tabActive = inject<Ref<boolean | undefined> | undefined>('chat:is-active', undefined);

function looksLikeUrl(input: string): boolean {
  if (/^https?:\/\//i.test(input)) return true;
  if (/^file:\/\//i.test(input)) return true;
  if (/^localhost(:\d+)?(\/|$)/i.test(input)) return true;
  if (/^127\.0\.0\.1(:\d+)?(\/|$)/.test(input)) return true;
  // Match domain.tld and sub.domain.tld (including www.google.com)
  if (/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}(\/|$)/.test(input)) return true;
  return false;
}

const draft        = ref('');
const { createTab } = useBrowserTabs();
const activityContext = inject<{ tabId?: string }>('chat:activity-context', {});
const remoteTransport: RemoteChatTransport = {
  connect: bound => ipcRenderer.invoke('remote-chat:connect', bound),
  send: frame => ipcRenderer.invoke('remote-chat:send', frame),
  listen: receive => {
    const listener = (_event: unknown, frame: Record<string, unknown>) => receive(frame);
    ipcRenderer.on('remote-chat:frame', listener);
    return () => ipcRenderer.removeListener('remote-chat:frame', listener);
  },
  history: (...args) => ipcRenderer.invoke('remote-chat:history', ...args) as ReturnType<RemoteChatTransport['history']>,
};
const remoteChat = new RemoteChatSession(controller, remoteTransport, text => {
  if (draft.value.trim() === text) draft.value = '';
}, () => tabActive?.value !== false);
const modelKey = (model: RemoteModel) => JSON.stringify([model.providerId, model.modelId]);
const remoteModelKey = computed(() => remoteChat.model.value ? modelKey(remoteChat.model.value) : '');
const remoteDevices = remoteChat.pickerDevices;
const remoteSelected = computed<RemoteDevice | undefined>(() => {
  const id = remoteChat.bound.value?.deviceId ?? remoteChat.selected.value?.id;
  if (!id) return undefined;
  return remoteDevices.value.find(device => device.id === id) ?? { id, name: 'Device', models: [] };
});
const remoteWarning = computed(() => {
  if (!remoteChat.remote.value) return '';
  if (!remoteChat.chosen.value) return `${ remoteSelected.value?.name ?? 'Device' } is unavailable. Your draft stays here.`;
  if (!remoteChat.model.value || !remoteChat.models.value.some(model => modelKey(model) === remoteModelKey.value)) {
    return 'Choose a model available on this device.';
  }
  return '';
});
function onRemoteModel(event: Event): void {
  const key = (event.target as HTMLSelectElement).value;
  remoteChat.model.value = remoteChat.models.value.find(model => modelKey(model) === key);
  remoteChat.note.value = '';
}
async function openDiscoveredThread(canonicalId: string): Promise<void> {
  const discovery = controller.remoteDiscoveries.value.find(item => item.binding.threadId === canonicalId);
  if (!discovery) return;
  const persister = new LocalStoragePersister();
  const existing = persister.list().find(state => state.thread.remote?.threadId === canonicalId
    && state.thread.remote.accountId === discovery.binding.accountId
    && state.thread.remote.workspaceId === discovery.binding.workspaceId);
  const id = existing?.thread.id ?? asThreadId(`t_view_${canonicalId}`);
  let state = existing ?? await persister.loadAsync(id).catch(() => undefined);
  if (state === undefined) return; // A DB error is not a cache miss.
  if (!controller.remoteDiscoveries.value.some(item => item.binding.threadId === canonicalId
      && item.binding.accountId === discovery.binding.accountId && item.binding.workspaceId === discovery.binding.workspaceId)) return;
  if (!state) {
    const blank = new ChatController();
    try {
      state = blank.serialize();
      state.thread = { ...state.thread, id, title: `Remote chat · ${ discovery.binding.name }`,
        updatedAt: discovery.updatedAt, remote: discovery.binding };
      persister.save(state);
    } finally { blank.dispose() }
  } else if (!state.thread.remote || state.thread.remote.accountId !== discovery.binding.accountId
      || state.thread.remote.workspaceId !== discovery.binding.workspaceId
      || state.thread.remote.threadId !== canonicalId || state.thread.remote.deviceId !== discovery.binding.deviceId) {
    return;
  }
  const tab = createTab('about:blank', { mode: 'chat', title: state.thread.title });
  persister.setTabThread(tab.id, id);
  window.dispatchEvent(new CustomEvent('sulla:navigate-tab', { detail: { tabId: tab.id } }));
}

function chooseEnvironment(device?: RemoteDevice): void {
  const bound = remoteChat.bound.value;
  if ((bound?.deviceId ?? remoteChat.selected.value?.id) === device?.id) return;
  if (bound || controller.messages.value.length || controller.isRunning.value) {
    const tab = createTab('about:blank', { mode: 'chat' });
    // Only hand off the environment identity. Never put a draft or a model choice on an auto-send path.
    if (device) sessionStorage.setItem(`remote-chat-environment:${ tab.id }`, JSON.stringify({ id: device.id, name: device.name }));
    window.dispatchEvent(new CustomEvent('sulla:navigate-tab', { detail: { tabId: tab.id } }));
    return;
  }
  remoteChat.select(device);
  if (device) {
    remoteChat.model.value = device.models.find(model =>
      model.providerId === controller.thread.value.providerId && model.modelId === controller.model.value.id);
  }
  nextTick(() => inputRef.value?.focus());
}
// Excerpt the next message replies to; empty when not replying.
const replyTo = ref('');
const inputRef     = ref<InstanceType<typeof ComposerInput> | null>(null);
const wrapEl       = ref<HTMLElement | null>(null);
const filesMenuOpen = ref(false);
const recentFiles = ref<FilesReference[]>([]);
const screenRecording = ref(false);
function onScreenRecordingState(_event:unknown, state:{ recording?:boolean }):void {
  screenRecording.value = state?.recording === true;
}
const filesImporting = ref(false);
const filesImportError = ref('');

// ─── Placeholder + keyboard hints ──────────────────────────────────
const placeholder = computed(() => {
  return controller.isRunning.value
    ? 'send while Sulla is working — queued'
    : 'Ask Sulla anything…';
});

const canSendDraft = computed(() => !filesImporting.value && (remoteChat.remote.value
  ? !!draft.value.trim() && !controller.staged.value.length && !useCases.intent.value && !replyTo.value && remoteChat.canSend()
  : (draft.value.trim().length > 0 || controller.staged.value.length > 0 || !!useCases.intent.value)));
const { label: selectionLabel, title: selectionTitle } = useSelectionLabel();
const modelInitial = computed(() => selectionLabel.value.trim().charAt(0).toUpperCase() || 'S');
const contextLimit = computed(() => {
  const raw = controller.model.value.ctx.toLowerCase().replace(/\s*ctx\s*/, '');
  const amount = Number.parseFloat(raw);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (raw.endsWith('m')) return amount * 1_000_000;
  if (raw.endsWith('k')) return amount * 1_000;
  return amount;
});
const usagePercent = computed(() => {
  if (!contextLimit.value) return 0;
  return Math.min(100, Math.round((controller.usage.value.totalTokens / contextLimit.value) * 100));
});

// ─── Right drawer (side dock): the status row's button opens or closes it ───
const { position: dockPosition, setPosition } = DockPositions.use();
const drawerOpen = computed(() => dockPosition.value === 'side');
const side = computed(() => dockPosition.value === 'side');

// ─── Voice state bridge ────────────────────────────────────────────
const isRecording  = computed(() => controller.voice.value.phase === 'recording');

// ─── Use-case suggestions (type-ahead strip + one intent chip) ─────
const USE_CASE_TYPE_LABEL: Record<SuggestedUseCaseType, string> = { skill: 'Skill', agent: 'Agent', workflow: 'Workflow', recipe: 'Recipe' };
const modKey = /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+';
const useCases = useUseCaseSuggestions({
  draft,
  blocked:  computed(() => isRecording.value || controller.popover.value.open),
  query:    (text, limit) => ipcRenderer.invoke('use-case-suggest:query', text, { limit }) as Promise<UseCaseSuggestionResponse>,
  isNarrow: () => window.matchMedia?.('(max-width: 640px)').matches ?? false,
});
const intentLabel = computed(() => useCases.intent.value ? useCases.directive.label(useCases.intent.value) : { verb: '', title: '' });
const intentSendHint = computed(() => {
  const picked = useCases.intent.value?.item;
  if (!picked) return 'send';
  if (picked.type === 'agent') return `send to ${ picked.title }`;
  if (picked.type === 'skill') return 'send with skill';

  return `send + run ${ picked.title }`;
});
/** The hint row says something beyond the placeholder: recording, a menu, a draft or a use case. */
const contextualHints = computed(() => isRecording.value || controller.popover.value.open || !!useCases.intent.value || useCases.open.value || !!draft.value.trim());
function pickUseCase(item: SuggestedUseCase): void {
  useCases.pick(item);
  inputRef.value?.focus();
}
const recStartedAt = computed(() => controller.voice.value.phase === 'recording' ? controller.voice.value.startedAt : 0);
const recLevel     = computed(() => controller.voice.value.phase === 'recording' ? controller.voice.value.level    : 0);
const recSpeaking  = computed(() => controller.voice.value.phase === 'recording' ? controller.voice.value.speaking : false);
const recPtt       = computed(() => controller.voice.value.phase === 'recording' && !!controller.voice.value.ptt);
const recFinishing = computed(() => controller.voice.value.phase === 'recording' && !!controller.voice.value.finishing);

/** A click anywhere on the message bar that isn't a control puts the cursor in the box. */
function focusFromBar(event: MouseEvent): void {
  if (isRecording.value || (event.target as Element).closest('button, a, input, textarea, select, label, [role="button"], [role="option"], [role="listbox"]')) return;
  event.preventDefault();
  inputRef.value?.focus();
}

// The textarea unmounts while recording; hand focus back when a spoken turn ends
// so the next Space press or typed message works without a click.
watch(isRecording, (recording, was) => {
  if (was && !recording) void nextTick(() => inputRef.value?.focus());
});

// ─── Mention source: artifacts in Library + My Work ───────────────
// The popover used to include hardcoded source files, memory ids, and
// agent names — which leaks engine internals to customers. The only
// thing @-referenceable now is a real artifact the user has installed
// or created locally (routines, skills, functions, recipes, integrations,
// workflows). The composable lazy-loads on first use; `prefetch()` is
// called in onMounted below so the first `@` keystroke already hits a
// warm cache.
const artifactMentions = useArtifactMentions();
const mentionSource = { list: (q: string) => artifactMentions.list(q) };
const taRef = computed(() => inputRef.value?.el ?? null);
useCommandPopover(taRef, mentionSource);

// ─── Slash command actions ─────────────────────────────────────────
// When the user picks a bare slash command from the popover — or types
// one and hits Enter — intercept the send() and run the matching action
// instead of shipping the text downstream.

/** Returns true if the command was handled (and the caller should skip the normal send). */
// /shelve and /resume open a panel above the message box instead of sending text.
const shelfRequest = ref<ShelfRequest | null>(null);

function tryRunSlashAction(cmd: SlashCommand): boolean {
  switch (cmd.action) {
    case 'shelve':
      shelfRequest.value = { mode: 'shelve' };
      return true;
    case 'resume':
      shelfRequest.value = { mode: 'resume' };
      return true;
    case 'clear':
      // ChatController has no reset hook today — emit a window event for
      // ChatPage / ThreadRegistry to pick up. Follow-up agent will wire.
      window.dispatchEvent(new CustomEvent('chat:new-chat', { detail: { reason: 'clear' } }));
      return true;
    case 'new':
      window.dispatchEvent(new CustomEvent('chat:new-chat', { detail: { reason: 'new' } }));
      return true;
    case 'model':
      controller.openModal('model');
      return true;
    case 'tokens':
      controller.openModal('tokens');
      return true;
    case 'help':
      controller.openModal('shortcuts');
      return true;
    case 'voice':
      controller.voiceCommand('toggle');
      return true;
    case 'pin': {
      controller.pinLastReply();
      return true;
    }
    case 'fork': {
      // Fork off the last message; ChatPage listens and opens the snapshot.
      const msgs = controller.messages.value;
      const fromId = msgs.length > 0 ? msgs[msgs.length - 1].id : null;
      window.dispatchEvent(new CustomEvent('chat:fork', { detail: { fromId } }));
      return true;
    }
    // Deliberately unhandled — these need backend / controller methods
    // that don't exist yet. Let them flow through as literal text.
    case 'loop':
    case 'schedule':
    default:
      return false;
  }
}

function choosePopoverItem(idx: number): void {
  const p = controller.popover.value;
  const item = p.items[idx];
  if (!item) return;

  // Slash command + popover is only open when the composer value is a
  // bare slash token — if this is an actionable command, fire it now
  // and skip the text insertion entirely.
  if (p.mode === 'slash' && 'name' in item) {
    const cmd = item as SlashCommand;
    // Only intercept when the whole draft is the slash token the user
    // was completing. "write notes /help" -> still insert as text.
    const currentDraft = draft.value.trim();
    const currentMatchesBare = currentDraft === cmd.name || (p.query === '' ? currentDraft === '/' : currentDraft === `/${ p.query }`);
    if (currentMatchesBare && tryRunSlashAction(cmd)) {
      draft.value = '';
      const ta = taRef.value;
      if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input')); }
      controller.hidePopover();
      return;
    }
  }

  const ta = taRef.value; if (!ta) return;
  const tok = 'name' in item ? (item as SlashCommand).name : (item as MentionTarget).token;
  const re  = p.mode === 'slash' ? /(?:^|\s)(\/\w*)$/ : /(?:^|\s)(@[\w:-]*)$/;
  const value = ta.value;
  const caret = ta.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  const after  = value.slice(caret);
  const replaced = before.replace(re, (m, grabbed) => m.slice(0, m.length - grabbed.length) + tok + ' ');
  ta.value = replaced + after;
  draft.value = ta.value;
  controller.hidePopover();
  ta.focus();
}

// ─── Send ──────────────────────────────────────────────────────────
function onSend(text: string): void {
  // An import is not an attachment until Files returns a durable identity.
  // Holding send here prevents a draft from racing ahead without the file.
  if (filesImporting.value) return;
  const trimmed = text.trim();
  if (remoteChat.remote.value) {
    if (controller.staged.value.length || useCases.intent.value || replyTo.value) {
      remoteChat.note.value = 'Remove attachments, replies, and use-case actions before sending to this device.';
      return;
    }
    void remoteChat.sendDraft(trimmed);
    return;
  }

  // Only navigate on the very first message (empty history) — no surrounding words.
  if (navigateUrl && looksLikeUrl(trimmed) && !trimmed.includes(' ') && !controller.staged.value.length && controller.messages.value.length === 0) {
    navigateUrl(trimmed);
    draft.value = '';
    return;
  }

  // "/shelve name", "/shelve delete name", "/resume name" carry an argument.
  const shelf = ShelfNotes.parseShelfCommand(trimmed);
  if (shelf) {
    shelfRequest.value = shelf.kind === 'delete' ? { mode: 'delete', name: shelf.name } : { mode: shelf.kind, name: shelf.name };
    draft.value = '';
    controller.hidePopover();
    return;
  }

  // Intercept bare slash commands even when there's no open popover
  // (e.g. user typed "/help" and hit Enter immediately).
  if (trimmed.startsWith('/')) {
    const rest = trimmed.slice(1);
    if (/^\w+$/.test(rest)) {
      const cmd = defaultSlashCommands.find(c => c.name.toLowerCase() === trimmed.toLowerCase());
      if (cmd && tryRunSlashAction(cmd)) {
        draft.value = '';
        controller.hidePopover();
        return;
      }
    }
  }

  const picked = useCases.intent.value;
  if (!trimmed && controller.staged.value.length === 0 && !picked) return;
  if (picked) {
    controller.send(useCases.directive.compose(picked, trimmed), [...controller.staged.value], {
      useCaseIntent: useCases.directive.metadata(picked),
      ...(useCases.directive.routeAgentId(picked) ? { agentId: useCases.directive.routeAgentId(picked) } : {}),
    });
    useCases.reset();
  } else {
    const body = trimmed || (replyTo.value ? '' : '(attached)');
    controller.send(replyTo.value ? composeReply(replyTo.value, body) : body, [...controller.staged.value]);
  }
  draft.value = '';
  replyTo.value = '';
}

function onKeydown(e: KeyboardEvent): void {
  const p = controller.popover.value;
  if (!p.open && e.key === 'Escape' && replyTo.value) {
    e.preventDefault();
    replyTo.value = '';
    return;
  }
  if (!p.open) {
    const el = e.target as HTMLTextAreaElement | null;
    const caretAtEnd = !el || (el.selectionStart === el.selectionEnd && el.selectionEnd === el.value.length);
    if (useCases.onKeydown(e, caretAtEnd)) return;
  }
  if (p.open) {
    if (e.key === 'ArrowDown') { e.preventDefault(); controller.movePopoverSelection(1); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); controller.movePopoverSelection(-1); }
    if (e.key === 'Enter')     { e.preventDefault(); choosePopoverItem(p.selected); }
    if (e.key === 'Escape')    { e.preventDefault(); controller.hidePopover(); }
  }
}

// ─── Attachments ──────────────────────────────────────────────────
// Uploads cross the privileged main-process Files importer. The renderer never
// receives source paths or stages the transient File: a returned durable
// fileId/versionId is the only success condition.
async function toggleFilesMenu():Promise<void> {
  filesMenuOpen.value = !filesMenuOpen.value;
  if (filesMenuOpen.value) recentFiles.value = await ipcRenderer.invoke('files-ui:recent-references', 5).catch(() => []);
}

type FilesPickerResult = FilesReference[] | { references:FilesReference[]; error?:string };

function stagePickerResult(result:FilesPickerResult):void {
  const imported = Array.isArray(result) ? result : result.references;
  if (!Array.isArray(imported)) throw new Error('Files did not return file references.');
  stageFilesReferences(imported);
  if (!Array.isArray(result) && result.error) {
    filesImportError.value = result.error;
    filesMenuOpen.value = true;
  }
}

async function browseFiles():Promise<void> {
  if (filesImporting.value) return;
  filesImportError.value = '';
  filesImporting.value = true;
  try {
    stagePickerResult(await ipcRenderer.invoke('files-ui:pick-reference') as FilesPickerResult);
  } catch (error) {
    filesImportError.value = error instanceof Error ? error.message : 'Could not attach this Files item.';
    filesMenuOpen.value = true;
  } finally {
    filesImporting.value = false;
  }
}

async function uploadFromMac():Promise<void> {
  if (filesImporting.value) return;
  filesImportError.value = '';
  filesImporting.value = true;
  try {
    // The authenticated main-process importer returns [] on picker cancellation.
    // A later-file failure can include already committed references alongside a
    // recoverable error, so chat never loses track of a successful Files import.
    stagePickerResult(await ipcRenderer.invoke('files-ui:pick-upload-references') as FilesPickerResult);
  } catch (error) {
    filesImportError.value = error instanceof Error ? error.message : 'Could not import this file into Files.';
    filesMenuOpen.value = true;
  } finally {
    filesImporting.value = false;
  }
}

function stageFilesReference(file:FilesReference):void {
  try {
    stageFilesReferences([file]);
  } catch (error) {
    filesImportError.value = error instanceof Error ? error.message : 'Could not attach this Files item.';
    filesMenuOpen.value = true;
  }
}

function stageFilesReferences(files:FilesReference[]):void {
  // Validate the entire response before mutating staging. A malformed item
  // cannot leave a partial selection that looks like a successful import.
  const attachments = files.map(file => AttachmentService.fromFilesReference(file));
  attachments.forEach(attachment => controller.stageAttachment(attachment));
  if (attachments.length) filesMenuOpen.value = false;
}

async function takeScreenshot():Promise<void> {
  if (filesImporting.value) return;
  filesImportError.value = '';
  filesImporting.value = true;
  try {
    const capture = await ipcRenderer.invoke('files-ui:capture-screenshot', 'area') as { reference:FilesReference };
    stageFilesReference(capture.reference);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not attach the screenshot.';
    if (!message.includes('Screenshot cancelled')) {
      filesImportError.value = message;
      filesMenuOpen.value = true;
    }
  } finally {
    filesImporting.value = false;
  }
}

async function toggleScreenRecording():Promise<void> {
  const result = await ipcRenderer.invoke('files-ui:toggle-recording', { mic: true, camera: false }) as { recording:boolean; capture?:{ fileId?:string } };
  screenRecording.value = result.recording;
  if (result.capture?.fileId) {
    const recent = await ipcRenderer.invoke('files-ui:recent-references', 20) as FilesReference[];
    const ref = recent.find(file => file.fileId === result.capture?.fileId);
    if (ref) stageFilesReference(ref);
  }
}

// ─── Voice ─────────────────────────────────────────────────────────
// Real voice — mic + whisper + TTS via VoiceSessionAdapter. It also takes
// commands (⌘/ toggle, hold-Space PTT) from this tab's controller bus.
const voiceAdapter = new VoiceSessionAdapter(controller, {
  onError: (msg) => {
    // Surface through a transient error bubble so it doesn't get lost.
    console.warn('[Composer] voice error:', msg);
  },
  isActive: () => tabActive?.value !== false,
});

// Switching away from a tab cuts its voice — only the conversation on screen talks.
watch(() => tabActive?.value, (active) => {
  if (active === false) voiceAdapter.handleDeactivated();
});

function toggleVoice(): void {
  if (remoteChat.remote.value) return;
  void voiceAdapter.toggle();
}

function stopVoice(commit: boolean): void {
  void voiceAdapter.stop(commit);
}

const refreshRemote = () => { if (tabActive?.value !== false) void remoteChat.refresh(); else void ipcRenderer.invoke('remote-chat:check-identity').catch(() => undefined) };
const resumeRemote = () => { if (tabActive?.value !== false) void remoteChat.refresh(true) };
let remoteRefreshTimer: ReturnType<typeof setInterval>;
watch(() => tabActive?.value, resumeRemote);
onBeforeUnmount(() => {
  remoteChat.dispose();
  controller.openRemoteDiscovery = undefined;
  clearInterval(remoteRefreshTimer);
  window.removeEventListener('online', resumeRemote);
  window.removeEventListener('focus', resumeRemote);
  voiceAdapter.dispose();
  window.removeEventListener('chat:reply', onReplyFromTurn as EventListener);
  window.removeEventListener('chat:draft', onDraftFromCard as EventListener);
  window.removeEventListener('chat:attach-files', onAttachShortcut as EventListener);
  ipcRenderer.removeListener('capture-studio:recording-state', onScreenRecordingState);
});

function onAttachShortcut():void { browseFiles().catch(() => undefined) }

// ─── Reply to a part of a Sulla message ──────────────────────────
// A Reply on a Sulla turn (whole message or one block) sets a cancelable
// "Replying to" chip; the excerpt is sent as a quote ahead of the user's
// words. Every open chat hears the event, so only the matching thread acts.
function onReplyFromTurn(ev: Event): void {
  const detail = (ev as CustomEvent<{ threadId?: string; excerpt?: string }>).detail;
  if (!detail?.excerpt || detail.threadId !== controller.thread.value.id) return;
  replyTo.value = replyExcerpt(detail.excerpt);
  setTimeout(() => {
    const ta = taRef.value;
    if (!ta) return;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  }, 0);
}
// ─── Drafted next step from a result card ────────────────────────
// Puts the text in the message box (after anything already typed) for the
// user to edit and send. Nothing is sent from here.
function onDraftFromCard(ev: Event): void {
  const detail = (ev as CustomEvent<{ threadId?: string; text?: string }>).detail;
  if (!detail?.text?.trim() || detail.threadId !== controller.thread.value.id) return;
  draft.value = draft.value.trim() ? `${ draft.value.trimEnd() }\n\n${ detail.text }` : detail.text;
  setTimeout(() => {
    const ta = taRef.value;
    if (!ta) return;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  }, 0);
}
// ─── First-run starter automation ────────────────────────────────
// The first-run wizard saves the automation the user picked. Prefill it
// once so their first press of Enter starts real work. The key is cleared
// before prefilling so it can never reappear in another composer.
async function prefillFirstRunStarter(): Promise<void> {
  try {
    const prompt = await SullaSettingsModel.get(FIRST_RUN_STARTER_PROMPT_KEY, '');
    if (typeof prompt !== 'string' || !prompt.trim() || draft.value) return;
    await SullaSettingsModel.set(FIRST_RUN_STARTER_PROMPT_KEY, '', 'string');
    draft.value = prompt;
    setTimeout(() => {
      const ta = taRef.value;
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }, 0);
  } catch (err) {
    console.warn('[Composer] First-run starter prefill skipped:', err);
  }
}

onMounted(() => {
  remoteChat.mount();
  controller.openRemoteDiscovery = id => { void openDiscoveredThread(id) };
  if (activityContext.tabId) {
    const key = `remote-chat-environment:${ activityContext.tabId }`;
    const handoff = sessionStorage.getItem(key);
    if (handoff) {
      sessionStorage.removeItem(key);
      try { remoteChat.select({ ...JSON.parse(handoff), models: [] }) } catch { /* Ignore a malformed local handoff. */ }
    }
  }
  refreshRemote();
  remoteRefreshTimer = setInterval(refreshRemote, 12000);
  window.addEventListener('online', resumeRemote);
  window.addEventListener('focus', resumeRemote);
  ipcRenderer.on('capture-studio:recording-state', onScreenRecordingState);
  window.addEventListener('chat:reply', onReplyFromTurn as EventListener);
  window.addEventListener('chat:draft', onDraftFromCard as EventListener);
  window.addEventListener('chat:attach-files', onAttachShortcut as EventListener);
  prefillFirstRunStarter().catch(() => { /* logged inside */ });
  // Warm the artifact mention cache so the first `@` keystroke has data.
  artifactMentions.prefetch();
});

defineExpose({ wrapEl, focus: () => inputRef.value?.focus() });
</script>

<style scoped>
.composer-wrap {
  position: absolute; bottom: 12px; left: 12%; right: 12%;
  z-index: 15;
}
.chat-root.artifact-open .composer-wrap { left: 10%; right: 10%; }
.composer-inner {
  max-width: 960px; margin: 0 auto;
  position: relative;
}
.chat-root.artifact-open .composer-inner { max-width: 720px; }
.composer-card, .composer-top, .composer-tools, .classic-guide { display: contents; }
.model-btn, .usage-meter, .tool-spacer, .noir-guide { display: none; }

.composer {
  display: flex; align-items: baseline; gap: 18px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--accent-glow);
  transition: border-color 0.2s ease;
}
.composer:focus-within {
  border-bottom-color: var(--accent-hover);
  box-shadow: 0 14px 20px -14px var(--accent-glow);
}
.composer.recording { border-bottom-color: var(--accent-hover); }
.composer.recording .glyph { color: var(--accent-hover); animation: chat-pulse 1.2s infinite; }

.glyph {
  font-family: var(--font-display); font-style: italic; font-size: 24px;
  color: var(--accent-hover); line-height: 0.6; flex-shrink: 0;
}

.hints {
  display: flex; justify-content: flex-end; gap: 18px;
  margin-top: 8px;
  font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.3em;
  text-transform: uppercase; color: var(--text-muted);
}
.hints span::before {
  content: ""; display: inline-block; width: 1px; height: 9px;
  background: var(--border-default); margin-right: 14px; vertical-align: -1px;
}
.hints span:first-child::before { display: none; }
.hints kbd {
  font-family: var(--font-mono); font-size: 9px;
  padding: 1px 5px; border-radius: 3px;
  background: var(--accent-dim);
  border: 1px solid var(--accent-dim);
  color: var(--text-muted); margin-right: 4px;
}

.hidden-file-input {
  display: none;
}

/* Noir is a visual skin over the existing controller and keyboard behavior. */
/* The dock is solid: see-through glass let transcript text show behind the status details. */
.composer-wrap {
  bottom: 0;
  left: 0;
  right: 0;
  padding: 0 20px 14px;
}
.composer-inner {
  max-width: 760px;
}
.chat-root.artifact-open .composer-wrap { left: 0; right: 0; }
.chat-root.artifact-open .composer-inner { max-width: 760px; }
.composer-card {
  display: block;
  position: relative;
  border-radius: 22px;
  background: color-mix(in srgb, var(--bg-surface-alt) 72%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border-default) 87.5%, transparent), 0 16px 44px var(--bg-overlay);
  backdrop-filter: blur(22px) saturate(135%);
  transition: box-shadow 0.3s cubic-bezier(.22, 1, .36, 1),
    transform 0.58s linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013, 1);
}
.composer-card:focus-within {
  transform: translateY(-2px);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-hover) 55%, transparent),
    0 0 0 4px color-mix(in srgb, var(--accent) 12%, transparent), 0 0 44px color-mix(in srgb, var(--accent) 16%, transparent),
    0 20px 56px var(--bg-page);
}
.composer-card {
  background: var(--bg-surface);
  box-shadow: inset 0 0 0 1px var(--border-default), var(--elev-float);
}
/* The "you can type here" ring is for the message box, not for clicks in the status details. */
.composer-card:focus-within:not(:has(.composer:focus-within)) { transform: none; box-shadow: inset 0 0 0 1px var(--border-default), var(--elev-float); }
.composer-card:focus-within {
  /* Clear "you can type here" ring: solid accent edge plus a visible halo. */
  box-shadow: inset 0 0 0 1.5px var(--accent), 0 0 0 4px color-mix(in srgb, var(--accent) 28%, transparent), var(--elev-float);
}
.composer-top {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 10px;
}
.composer {
  display: flex;
  align-items: stretch;
  gap: 0;
  min-height: 102px;
  padding: 0;
  flex-wrap: wrap;
  border: 0;
  box-shadow: none;
}
.composer:focus-within,
.composer.recording { border: 0; box-shadow: none; }
.glyph { display: none; }
.composer-tools {
  display: flex;
  align-items: center;
  gap: 2px;
  width: 100%;
  min-height: 52px;
  padding: 6px 8px 8px;
  border-top: 1px solid color-mix(in srgb, var(--border-default) 43.75%, transparent);
}
.model-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  max-width: 190px;
  margin: 0 4px;
  padding: 0 10px 0 3px;
  border: 0;
  border-radius: 15px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--border-default) 37.5%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border-default) 62.5%, transparent);
  font: 500 12.5px var(--font-body);
  cursor: pointer;
}
.remote-enabled .model-btn { display: inline-flex; }
.remote-chat-dot { display: inline-block; width: 6px; height: 6px; background: var(--text-muted); border-radius: 50%; }
.remote-chat-dot.live { background: var(--status-success, var(--accent)); }
.remote-model { padding: 0 9px; }
.remote-chat-status { padding: 4px 8px; font-size: 12px; color: var(--text-secondary); }
.model-btn:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.model-avatar {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border-radius: 50%;
  color: var(--text-on-accent);
  background: linear-gradient(135deg, #a8c0dc, var(--accent));
  font-size: 11px;
  font-weight: 700;
}
.model-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-caret { color: var(--text-dim); font-size: 9px; }
.tool-spacer { display: block; flex: 1; }
.usage-meter {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border: 0;
  color: var(--text-dim);
  background: transparent;
  font: 11px var(--font-mono);
  cursor: pointer;
}
.usage-ring {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: conic-gradient(var(--accent-hover) 0 var(--usage), color-mix(in srgb, var(--border-default) 75%, transparent) var(--usage) 100%);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), var(--bg-page) calc(100% - 2.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), var(--bg-page) calc(100% - 2.5px));
}
.hints {
  position: relative;
  justify-content: center;
  min-height: 14px;
  margin-top: 9px;
  gap: 0;
  color: var(--text-dim);
  font-size: 10.5px;
  letter-spacing: 0;
  text-transform: none;
}
.classic-guide { display: none; }
.noir-guide { display: flex; gap: 4px; }
.noir-guide span::before { display: none; }
.hints kbd {
  margin: 0;
  padding: 0;
  border: 0;
  color: var(--text-muted);
  background: transparent;
  font-size: inherit;
  font-weight: 500;
}
.noir-guide span:not(:last-child)::after { content: " ·"; color: var(--text-dim); }

@media (max-width: 680px) {
  .composer-wrap { padding-right: 10px; padding-left: 10px; }
  .model-name, .usage-meter > span:last-child { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .composer-card { animation: none; transition: none; }
}
@keyframes usecase-strip-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
/* ─── Use-case suggestions (approved mockup: mockups/usecase-suggestions) ─── */
.usecase-strip {
  width: 100%;
  margin: 8px 8px 0;
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-surface) 96%, transparent);
  box-shadow: inset 0 0 0 1px var(--border-default);
  animation: usecase-strip-in 0.18s cubic-bezier(.22, 1, .36, 1) both;
}
.usecase-strip-hd {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px 4px 14px;
  font-size: 12px; color: var(--text-secondary);
}
.usecase-lbl { font: 500 10.5px/1 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; color: var(--text-muted); }
.usecase-sp { flex: 1; }
.usecase-lat { font: 11px var(--font-mono); color: var(--text-muted); }
.usecase-strip-x, .usecase-chip-x {
  width: 22px; height: 22px; border: 0; border-radius: 6px;
  display: grid; place-items: center;
  background: transparent; color: var(--text-muted); cursor: pointer; font-size: 14px; line-height: 1;
}
.usecase-strip-x:hover, .usecase-chip-x:hover { background: var(--accent-dim); color: var(--text-primary); }
.usecase-list { list-style: none; margin: 0; padding: 2px 8px 8px; }
.usecase-row {
  display: grid; grid-template-columns: 96px minmax(0, 1fr) auto; align-items: center; gap: 10px;
  min-height: 38px; padding: 4px 8px; border-radius: 8px; cursor: pointer;
}
.usecase-row:hover { background: var(--accent-dim); }
.usecase-row[aria-selected="true"] { background: var(--accent-dim); box-shadow: inset 0 0 0 1px var(--accent-border); }
.usecase-type {
  display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 7px; width: max-content;
  background: color-mix(in srgb, var(--border-default) 45%, transparent); color: var(--text-secondary);
  font: 500 10.5px/1 var(--font-mono); letter-spacing: .05em; text-transform: uppercase;
}
.usecase-row-main { min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.usecase-row-t { font-weight: 500; font-size: 13.5px; white-space: nowrap; color: var(--text-primary); }
.usecase-row-d { color: var(--text-secondary); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.usecase-row-why { display: flex; align-items: center; gap: 8px; font: 11px var(--font-mono); color: var(--text-muted); white-space: nowrap; }
.usecase-row-why em { font-style: normal; }
.usecase-row-why kbd {
  font: 500 10.5px/1 var(--font-mono); padding: 3px 5px; border-radius: 5px;
  background: color-mix(in srgb, var(--border-default) 45%, transparent); color: var(--text-secondary);
}
.usecase-intent { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; }
.usecase-chip {
  display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 4px 0 9px; border-radius: 15px;
  width: max-content; max-width: 100%;
  background: var(--accent-dim); box-shadow: inset 0 0 0 1px var(--accent-border);
  color: var(--text-primary); font-size: 12.5px;
  animation: usecase-strip-in 0.24s cubic-bezier(.22, 1, .36, 1) both;
}
.usecase-chip .usecase-type { display: none; }
.usecase-verb { color: var(--accent-hover); }
.usecase-chip b { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.usecase-inputs { display: flex; flex-wrap: wrap; gap: 6px; padding-left: 2px; }
.usecase-field {
  display: inline-flex; align-items: center; height: 26px; border-radius: 8px; overflow: hidden;
  box-shadow: inset 0 0 0 1px var(--border-default); background: var(--bg-surface); font-size: 12px;
}
.usecase-field span {
  display: flex; align-items: center; height: 100%; padding: 0 6px 0 8px;
  font: 11px var(--font-mono); color: var(--text-secondary);
  background: color-mix(in srgb, var(--border-default) 30%, transparent);
}
.usecase-field input {
  border: 0 !important; outline: none; background: transparent !important; box-shadow: none !important;
  height: 100%; padding: 0 8px !important; width: 140px; min-width: 64px;
  font-size: 12.5px; color: var(--text-primary) !important;
}
.usecase-field:focus-within { box-shadow: inset 0 0 0 1px var(--accent-border); }
.usecase-field.missing { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--status-warning) 45%, transparent); }
.usecase-field.missing span { color: var(--status-warning); background: var(--status-warning-soft); }
@media (max-width: 640px) {
  .usecase-row { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; padding: 6px 8px; }
  .usecase-row .usecase-type { grid-column: 1; grid-row: 1; }
  .usecase-row-main { grid-column: 1 / 3; grid-row: 2; flex-direction: column; align-items: stretch; gap: 0; }
  .usecase-row-why { grid-column: 2; grid-row: 1; justify-self: end; }
  .usecase-row-why em { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .usecase-strip, .usecase-chip { animation: none; }
}
/* "Replying to" chip: which part of Sulla's message the next message answers. */
.reply-chip {
  display: flex; align-items: flex-start; gap: 8px;
  margin: 10px 12px 0; padding: 8px 8px 8px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border-default));
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-surface));
  color: var(--text-secondary); font: 13px/1.45 var(--font-body);
}
.reply-chip svg { flex: none; width: 15px; height: 15px; margin-top: 2px; fill: var(--accent); }
.reply-chip-text {
  flex: 1; min-width: 0; overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; white-space: pre-line;
}
.reply-chip-text b { color: var(--text-primary); font-weight: 600; margin-right: 4px; }
.reply-chip-x {
  flex: none; width: 24px; height: 24px; border: 0; border-radius: 6px; cursor: pointer;
  background: transparent; color: var(--text-muted); font-size: 17px; line-height: 1;
}
.reply-chip-x:hover { color: var(--text-primary); background: color-mix(in srgb, var(--text-primary) 8%, transparent); }

/* ─── Side panel toggle ─── */
/* The move button sits at the end of the status row: a hairline, then a quiet icon button. */
.dock-divider { flex: none; width: 1px; height: 18px; background: var(--border-default); }
.dock-move {
  flex: none; display: grid; place-items: center; width: 30px; height: 30px; margin: 0 6px;
  border: 1px solid transparent; border-radius: 8px; background: none; cursor: pointer;
  color: color-mix(in srgb, var(--text-primary) 72%, var(--bg-surface));
  transition: background-color .15s cubic-bezier(.22, 1, .36, 1), color .15s cubic-bezier(.22, 1, .36, 1);
}
.dock-move:hover { background: color-mix(in srgb, var(--text-primary) 8%, transparent); color: var(--text-primary); }
.dock-move:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.dock-move svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; }
.dock-move.on { color: var(--accent); }
</style>
<style scoped src="../../styles/composer-field.css"></style>

<style scoped>
</style>
