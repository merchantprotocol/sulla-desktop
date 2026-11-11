<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Composer — the only container in the bottom region. Orchestrates:
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
  <div class="composer-wrap" ref="wrapEl">
    <div class="composer-inner">
      <RunControls />
      <CommandPopover @choose="choosePopoverItem" />

      <div class="composer-card">
        <div class="composer-top">
          <QueueStrip />
          <AttachmentTray />
          <div v-if="intent" class="usecase-intent" role="status">
            <span>{{ intentLabel }}</span><button type="button" aria-label="Remove use-case intent" @mousedown.prevent @click="intent = null">×</button>
          </div>

          <!-- Live intent: what Reflex would run for this draft right now. -->
          <div
            v-if="reflexChip"
            :class="['reflex-intent', reflexChip.kind]"
            role="status"
            aria-live="polite"
          >
            <button
              v-if="reflexChip.kind === 'suggest'"
              type="button"
              class="reflex-intent-btn"
              title="Run instantly with Reflex (Tab) — Esc to dismiss"
              @mousedown.prevent
              @click="acceptReflexIntent"
            >
              <span class="bolt">⚡</span>{{ reflexChip.text }}<kbd>⇥</kbd>
            </button>
            <span v-else><span class="bolt">{{ reflexChip.kind === 'done' ? '⚡' : '!' }}</span>{{ reflexChip.text }}</span>
          </div>
        </div>

        <div :class="['composer', { recording: isRecording }]">
          <span class="glyph">—</span>

          <div v-if="showUseCaseSuggestions" class="usecase-suggestions" role="listbox" aria-label="Use-case suggestions">
            <button v-for="(item, index) in suggestions" :id="`usecase-option-${index}`" :key="`${item.type}:${item.slug}`" type="button" role="option" :aria-selected="selectedSuggestion === index" :class="{ selected: selectedSuggestion === index }" @mousedown.prevent @click="pickSuggestion(item)">
              <span class="suggestion-kind">{{ item.type }}</span><span>{{ item.title }}</span><small>{{ item.description }}</small><kbd v-if="index < 5">⌘{{ index + 1 }}</kbd>
            </button>
          </div>

          <!-- Text mode -->
          <ComposerInput
            v-if="!isRecording"
            ref="inputRef"
            :model-value="draft"
            :placeholder="placeholder"
            :active-descendant="selectedSuggestion >= 0 ? `usecase-option-${selectedSuggestion}` : undefined"
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

          <div class="composer-tools">
            <ComposerAttach :open="filesMenuOpen" @pick="toggleFilesMenu" />
            <FilesAttachMenu :open="filesMenuOpen" :recent="recentFiles" :recording="screenRecording" :uploading="filesImporting" :upload-error="filesImportError" @browse="browseFiles" @upload="uploadFromMac" @choose="stageFilesReference" @screenshot="takeScreenshot" @record="toggleScreenRecording" />
            <HeartbeatControl />
            <button class="model-btn" type="button" :title="selectionTitle" @click="controller.openModal('model')">
              <span class="model-avatar">{{ modelInitial }}</span>
              <span class="model-name">{{ selectionLabel }}</span>
              <span class="model-caret">▾</span>
            </button>
            <span class="tool-spacer" />
            <button class="usage-meter" type="button" title="Context usage" @click="controller.openModal('tokens')">
              <span class="usage-ring" :style="{ '--usage': `${usagePercent}%` }" />
              <span>{{ usagePercent }}%</span>
            </button>
            <ComposerMic :live="isRecording" @toggle="toggleVoice" />
            <ComposerSend
              :running="controller.isRunning.value"
              :can-send="canSendDraft"
              @send="onSend(draft)"
            />
          </div>

        </div>
      </div>

      <div class="hints">
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
          <template v-else-if="draft.trim()">
            <span><kbd>⏎</kbd> send</span>
            <span><kbd>⇧⏎</kbd> new line</span>
            <span><kbd>Tab</kbd> run with Reflex</span>
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

import ComposerInput      from './ComposerInput.vue';
import ComposerMic        from './ComposerMic.vue';
import ComposerAttach     from './ComposerAttach.vue';
import ComposerVoicePanel from './ComposerVoicePanel.vue';
import ComposerSend       from './ComposerSend.vue';
import AttachmentTray     from './AttachmentTray.vue';
import QueueStrip         from './QueueStrip.vue';
import RunControls        from './RunControls.vue';
import HeartbeatControl   from './HeartbeatControl.vue';
import CommandPopover     from './CommandPopover.vue';
import FilesAttachMenu, { type FilesReference } from './FilesAttachMenu.vue';

import { FIRST_RUN_STARTER_PROMPT_KEY } from '../../../firstRunStarter';
import { useChatController } from '../../controller/useChatController';
import { useCommandPopover } from '../../composables/useCommandPopover';
import { useArtifactMentions } from '../../composables/useArtifactMentions';
import { useReflexIntent } from '../../composables/useReflexIntent';
import { useSelectionLabel } from '../../composables/useSelectionLabel';
import { AttachmentService } from '../../services/AttachmentService';
import { VoiceSessionAdapter } from '../../services/VoiceSessionAdapter';
import type { SuggestedUseCase } from '../../../../main/UseCaseSuggestionQuery';

import { defaultSlashCommands, type SlashCommand, type MentionTarget } from '../../models/Command';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

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
const suggestions = ref<SuggestedUseCase[]>([]);
const selectedSuggestion = ref(-1);
const intent = ref<SuggestedUseCase | null>(null);
const dismissedTopic = ref('');
let suggestionTimer: ReturnType<typeof setTimeout> | undefined;
let suggestionRequest = 0;
const topicKey = computed(() => draft.value.trim().toLowerCase().split(/\s+/).slice(-4).join(' '));
const showUseCaseSuggestions = computed(() => !isRecording.value && !controller.popover.value.open && !intent.value && suggestions.value.length > 0 && topicKey.value !== dismissedTopic.value);
const intentLabel = computed(() => intent.value ? intent.value.type === 'skill' ? `Use skill: ${intent.value.title}` : intent.value.type === 'agent' ? `Ask ${intent.value.title}` : `Run ${intent.value.title}` : '');
function pickSuggestion(item: SuggestedUseCase): void { intent.value = item; selectedSuggestion.value = -1; suggestions.value = []; }
function onSuggestionInput(text: string): void {
  selectedSuggestion.value = -1;
  if (suggestionTimer) clearTimeout(suggestionTimer);
  const query = text.trim();
  if (query.length < 3) { suggestions.value = []; return; }
  const request = ++suggestionRequest;
  suggestionTimer = setTimeout(() => {
    void ipcRenderer.invoke('use-case-suggest:query' as any, query, { limit: 5 }).then((result: { items?: SuggestedUseCase[] }) => {
      if (request === suggestionRequest && Array.isArray(result?.items)) suggestions.value = result.items.filter(item => ['skill', 'agent', 'workflow', 'recipe'].includes(item.type)).slice(0, 5);
    }).catch(() => { if (request === suggestionRequest) suggestions.value = []; });
  }, 150);
}
watch(draft, value => { onSuggestionInput(value); if (topicKey.value !== dismissedTopic.value) dismissedTopic.value = ''; });
onBeforeUnmount(() => { if (suggestionTimer) clearTimeout(suggestionTimer); });
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

const canSendDraft = computed(() => !filesImporting.value && (draft.value.trim().length > 0 || controller.staged.value.length > 0));
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

// ─── Voice state bridge ────────────────────────────────────────────
const isRecording  = computed(() => controller.voice.value.phase === 'recording');
const recStartedAt = computed(() => controller.voice.value.phase === 'recording' ? controller.voice.value.startedAt : 0);
const recLevel     = computed(() => controller.voice.value.phase === 'recording' ? controller.voice.value.level    : 0);
const recSpeaking  = computed(() => controller.voice.value.phase === 'recording' ? controller.voice.value.speaking : false);
const recPtt       = computed(() => controller.voice.value.phase === 'recording' && !!controller.voice.value.ptt);
const recFinishing = computed(() => controller.voice.value.phase === 'recording' && !!controller.voice.value.finishing);

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

// ─── Live intent (Reflex) ──────────────────────────────────────────
// While the human types, Reflex previews the action it would run for the
// draft. Tab runs it instantly (no model turn); Enter still sends normally;
// Esc hides the chip until the draft changes.
const reflexIntentEnabled = computed(() => !isRecording.value && !controller.popover.value.open);
const reflexIntent = useReflexIntent(draft, reflexIntentEnabled);
const reflexChip = computed(() => {
  if (reflexIntent.flash.value) {
    return { kind: reflexIntent.flash.value.kind, text: reflexIntent.flash.value.kind === 'done' ? `Done — ${ reflexIntent.flash.value.text }` : reflexIntent.flash.value.text };
  }
  if (reflexIntent.preview.value && reflexIntentEnabled.value) return { kind: 'suggest' as const, text: reflexIntent.preview.value.label };
  return null;
});

async function acceptReflexIntent(): Promise<void> {
  if (await reflexIntent.accept()) {
    draft.value = '';
    controller.hidePopover();
  }
  inputRef.value?.focus();
}

// ─── Slash command actions ─────────────────────────────────────────
// When the user picks a bare slash command from the popover — or types
// one and hits Enter — intercept the send() and run the matching action
// instead of shipping the text downstream.

/** Returns true if the command was handled (and the caller should skip the normal send). */
function tryRunSlashAction(cmd: SlashCommand): boolean {
  switch (cmd.action) {
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

  // Only navigate on the very first message (empty history) — no surrounding words.
  if (navigateUrl && looksLikeUrl(trimmed) && !trimmed.includes(' ') && !controller.staged.value.length && controller.messages.value.length === 0) {
    navigateUrl(trimmed);
    draft.value = '';
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

  if (!trimmed && controller.staged.value.length === 0) return;
  const directive = intent.value ? `[Use-case intent: ${intentLabel.value}; type=${intent.value.type}; slug=${intent.value.slug}]\n` : '';
  controller.send(`${directive}${trimmed || '(attached)'}`, [...controller.staged.value]);
  draft.value = '';
  intent.value = null;
}

function onKeydown(e: KeyboardEvent): void {
  const p = controller.popover.value;
  if (!p.open && showUseCaseSuggestions.value) {
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedSuggestion.value = (selectedSuggestion.value + 1) % suggestions.value.length; return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); selectedSuggestion.value = selectedSuggestion.value <= 0 ? suggestions.value.length - 1 : selectedSuggestion.value - 1; return; }
    if (e.key === 'Escape') { e.preventDefault(); if (selectedSuggestion.value >= 0) selectedSuggestion.value = -1; else dismissedTopic.value = topicKey.value; return; }
    if ((e.metaKey || e.ctrlKey) && /^[1-5]$/.test(e.key)) { e.preventDefault(); const item = suggestions.value[Number(e.key) - 1]; if (item) pickSuggestion(item); return; }
    if (e.key === 'Enter' && selectedSuggestion.value >= 0) { e.preventDefault(); const item = suggestions.value[selectedSuggestion.value]; if (item) pickSuggestion(item); return; }
  }
  if (!p.open && reflexIntent.preview.value) {
    if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      void acceptReflexIntent();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); reflexIntent.dismiss(); return; }
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
  void voiceAdapter.toggle();
}

function stopVoice(commit: boolean): void {
  void voiceAdapter.stop(commit);
}

onBeforeUnmount(() => {
  voiceAdapter.dispose();
  reflexIntent.dispose();
  window.removeEventListener('chat:quote', onQuoteFromTurn as EventListener);
  window.removeEventListener('chat:attach-files', onAttachShortcut as EventListener);
  ipcRenderer.removeListener('capture-studio:recording-state', onScreenRecordingState);
});

function onAttachShortcut():void { browseFiles().catch(() => undefined) }

// ─── Listen for quote events from Sulla turns ────────────────────
// TurnSulla's "Quote" hover action dispatches this; we prefill the
// composer with a markdown blockquote and focus the input.
function onQuoteFromTurn(ev: Event): void {
  const text = (ev as CustomEvent<string>).detail;
  if (!text) return;
  const quoted = text.split('\n').map(l => `> ${ l }`).join('\n');
  draft.value = draft.value
    ? `${ draft.value.replace(/\s+$/, '') }\n\n${ quoted }\n\n`
    : `${ quoted }\n\n`;
  // Focus + move caret to the end.
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
  ipcRenderer.on('capture-studio:recording-state', onScreenRecordingState);
  window.addEventListener('chat:quote', onQuoteFromTurn as EventListener);
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

.reflex-intent {
  position: absolute; bottom: 100%; left: 42px;
  margin-bottom: 8px;
  font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.04em;
  color: var(--text-muted);
  animation: reflex-intent-in 0.14s ease-out;
}
.reflex-intent-btn, .reflex-intent > span {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 4px 10px; border-radius: 999px;
  background: var(--accent-dim);
  border: 1px solid var(--accent-glow);
  color: inherit; font: inherit; cursor: pointer;
}
.reflex-intent-btn:hover { background: var(--accent-dim); }
.reflex-intent.done > span { border-color: var(--status-success); background: var(--status-success-soft); cursor: default; }
.reflex-intent.error > span { border-color: var(--status-warning); background: var(--status-warning-soft); cursor: default; }
.reflex-intent .bolt { color: var(--accent-hover); }
.reflex-intent kbd {
  font-family: var(--font-mono); font-size: 9px;
  padding: 1px 5px; border-radius: 3px;
  background: var(--accent-dim);
  border: 1px solid var(--accent-dim);
  color: var(--text-muted);
}
@keyframes reflex-intent-in {
  from { opacity: 0; transform: translateY(3px); }
  to   { opacity: 1; transform: none; }
}

.hidden-file-input {
  display: none;
}

/* Noir is a visual skin over the existing controller and keyboard behavior. */
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
  background: color-mix(in srgb, var(--bg-surface) 90%, transparent);
  box-shadow: inset 0 0 0 1px var(--border-default), var(--elev-float);
}
.composer-card:focus-within {
  box-shadow: inset 0 0 0 1px var(--accent-border), 0 0 0 4px color-mix(in srgb, var(--accent) 12%, transparent), var(--elev-float);
}
.composer-top {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 10px;
}
.reflex-intent {
  position: static;
  width: max-content;
  margin: 10px 0 0;
  color: var(--text-secondary);
  font-family: var(--font-body);
  font-size: 12px;
  letter-spacing: 0;
  animation: noir-reflex-in 0.42s cubic-bezier(.22, 1, .36, 1) both;
}
.reflex-intent-btn,
.reflex-intent > span {
  height: 28px;
  padding: 0 6px 0 10px;
  border: 0;
  border-radius: 14px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 18%, transparent), color-mix(in srgb, var(--accent) 4%, transparent));
  box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--accent-hover) 35%, transparent);
}
.reflex-intent kbd {
  padding: 2px 7px;
  border: 0;
  border-radius: 6px;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--border-default) 75%, transparent);
  font-size: 10.5px;
}
@keyframes noir-reflex-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
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
  .composer-card,
  .reflex-intent { animation: none; transition: none; }
}
</style>
