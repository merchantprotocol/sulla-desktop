<!--
  Composer — the only container in the bottom region. Orchestrates:
    • Queue strip (visible only when queued messages exist)
    • Attachment tray (visible when staged attachments exist)
    • Command popover (slash / mention autocomplete)
    • Run controls (stop / continue)
    • Either the textarea OR the voice panel, mutually exclusive
    • Mic + paperclip buttons + keyboard hints

  Reads everything from the controller. The only "logic" here is:
    1. send() / queue()   on Enter
    2. stage file          on paperclip click (demo picks a random file)
    3. start/stop voice    on mic click — delegates to VoiceSessionAdapter
-->
<template>
  <div class="composer-wrap" ref="wrapEl">
    <div class="composer-inner">
      <RunControls />
      <QueueStrip />
      <AttachmentTray />
      <CommandPopover @choose="choosePopoverItem" />

      <div :class="['composer', { recording: isRecording }]">
        <span class="glyph">—</span>

        <!-- Text mode -->
        <ComposerInput
          v-if="!isRecording"
          ref="inputRef"
          :model-value="draft"
          :placeholder="placeholder"
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
          @stop="stopVoice(true)"
        />

        <ComposerAttach @pick="onAttach" />
        <input
          ref="fileInputRef"
          type="file"
          multiple
          class="hidden-file-input"
          @change="onFilesSelected"
        >
        <ComposerMic :live="isRecording" @toggle="toggleVoice" />

        <span class="hints">
          <span><kbd>⏎</kbd> send</span>
          <span><kbd>⌘/</kbd> voice</span>
          <span><kbd>?</kbd> help</span>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import ComposerInput      from './ComposerInput.vue';
import ComposerMic        from './ComposerMic.vue';
import ComposerAttach     from './ComposerAttach.vue';
import ComposerVoicePanel from './ComposerVoicePanel.vue';
import AttachmentTray     from './AttachmentTray.vue';
import QueueStrip         from './QueueStrip.vue';
import RunControls        from './RunControls.vue';
import CommandPopover     from './CommandPopover.vue';

import { useChatController } from '../../controller/useChatController';
import { useCommandPopover } from '../../composables/useCommandPopover';
import { useArtifactMentions } from '../../composables/useArtifactMentions';
import { AttachmentService } from '../../services/AttachmentService';
import { VoiceSessionAdapter } from '../../services/VoiceSessionAdapter';

import { defaultSlashCommands, type SlashCommand, type MentionTarget } from '../../models/Command';

const controller = useChatController();

const draft        = ref('');
const inputRef     = ref<InstanceType<typeof ComposerInput> | null>(null);
const wrapEl       = ref<HTMLElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

// ─── Placeholder + keyboard hints ──────────────────────────────────
const placeholder = computed(() => {
  return controller.isRunning.value
    ? 'send while Sulla is working — queued'
    : 'reply — /  for commands · @ for context · drop files to attach';
});

// ─── Voice state bridge ────────────────────────────────────────────
const isRecording  = computed(() => controller.voice.value.phase === 'recording');
const recStartedAt = computed(() => controller.voice.value.phase === 'recording' ? controller.voice.value.startedAt : 0);
const recLevel     = computed(() => controller.voice.value.phase === 'recording' ? controller.voice.value.level    : 0);
const recSpeaking  = computed(() => controller.voice.value.phase === 'recording' ? controller.voice.value.speaking : false);

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
      window.dispatchEvent(new CustomEvent('chat:voice-toggle'));
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
  const trimmed = text.trim();

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
  controller.send(trimmed || '(attached)', [...controller.staged.value]);
  draft.value = '';
}

function onKeydown(e: KeyboardEvent): void {
  const p = controller.popover.value;
  if (p.open) {
    if (e.key === 'ArrowDown') { e.preventDefault(); controller.movePopoverSelection(1); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); controller.movePopoverSelection(-1); }
    if (e.key === 'Enter')     { e.preventDefault(); choosePopoverItem(p.selected); }
    if (e.key === 'Escape')    { e.preventDefault(); controller.hidePopover(); }
  }
}

// ─── Attachments ──────────────────────────────────────────────────
// Paperclip click opens the native file picker; each chosen file is
// wrapped into an Attachment (with an object-URL preview for images)
// and staged on the controller. Resetting the input's `value` after a
// pick lets the user re-select the same file next time without us
// swallowing the change event.
function onAttach(): void {
  fileInputRef.value?.click();
}

function onFilesSelected(ev: Event): void {
  const input = ev.target as HTMLInputElement;
  const files = input.files;
  if (files && files.length > 0) {
    for (const file of Array.from(files)) {
      controller.stageAttachment(AttachmentService.fromFile(file));
    }
  }
  input.value = '';
}

// ─── Voice ─────────────────────────────────────────────────────────
// Real voice — mic + whisper + TTS via VoiceSessionAdapter, which
// listens to `chat:voice-toggle` window events on its own.
const voiceAdapter = new VoiceSessionAdapter(controller, {
  onError: (msg) => {
    // Surface through a transient error bubble so it doesn't get lost.
    console.warn('[Composer] voice error:', msg);
  },
});

function toggleVoice(): void {
  void voiceAdapter.toggle();
}

function stopVoice(commit: boolean): void {
  voiceAdapter.stop(commit);
}

onBeforeUnmount(() => {
  voiceAdapter.dispose();
  window.removeEventListener('chat:quote', onQuoteFromTurn as EventListener);
});

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
onMounted(() => {
  window.addEventListener('chat:quote', onQuoteFromTurn as EventListener);
  // Warm the artifact mention cache so the first `@` keystroke has data.
  artifactMentions.prefetch();
});

defineExpose({ wrapEl, focus: () => inputRef.value?.focus() });
</script>

<style scoped>
.composer-wrap {
  position: absolute; bottom: 32px; left: 12%; right: 12%;
  z-index: 15;
}
.chat-root.artifact-open .composer-wrap { left: 10%; right: 10%; }
.composer-inner {
  max-width: 960px; margin: 0 auto;
  position: relative;
}
.chat-root.artifact-open .composer-inner { max-width: 720px; }

.composer {
  display: flex; align-items: baseline; gap: 18px;
  padding-bottom: 14px;
  border-bottom: 1px solid rgba(80, 150, 179, 0.35);
  transition: border-color 0.2s ease;
}
.composer:focus-within {
  border-bottom-color: var(--steel-400);
  box-shadow: 0 14px 20px -14px rgba(106, 176, 204, 0.3);
}
.composer.recording { border-bottom-color: var(--steel-400); }
.composer.recording .glyph { color: var(--steel-400); animation: chat-pulse 1.2s infinite; }

.glyph {
  font-family: var(--serif); font-style: italic; font-size: 24px;
  color: var(--steel-400); line-height: 0.6; flex-shrink: 0;
}

.hints {
  display: flex; gap: 18px;
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.3em;
  text-transform: uppercase; color: var(--read-4);
  flex-shrink: 0; align-self: center;
}
.hints span::before {
  content: ""; display: inline-block; width: 1px; height: 9px;
  background: var(--read-5); margin-right: 14px; vertical-align: -1px;
}
.hints span:first-child::before { display: none; }
.hints kbd {
  font-family: var(--mono); font-size: 9px;
  padding: 1px 5px; border-radius: 3px;
  background: rgba(168, 192, 220, 0.1);
  border: 1px solid rgba(168, 192, 220, 0.2);
  color: var(--steel-200); margin-right: 4px;
}

.hidden-file-input {
  display: none;
}
</style>
