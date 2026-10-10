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
            :ptt="recPtt"
            :finishing="recFinishing"
            @stop="stopVoice(true)"
          />

          <div class="composer-tools">
            <ComposerAttach :open="controller.staged.value.length > 0" @pick="onAttach" />
            <button class="context-btn" type="button" title="Add context" @click="addContext">@</button>
            <button class="model-btn" type="button" title="Switch agent or model" @click="controller.openModal('model')">
              <span class="model-avatar">{{ modelInitial }}</span>
              <span class="model-name">{{ controller.model.value.name }}</span>
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

          <input
            ref="fileInputRef"
            type="file"
            multiple
            class="hidden-file-input"
            @change="onFilesSelected"
          >
        </div>
      </div>

      <div class="hints">
        <HeartbeatControl />
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

import { FIRST_RUN_STARTER_PROMPT_KEY } from '../../../firstRunStarter';
import { useChatController } from '../../controller/useChatController';
import { useCommandPopover } from '../../composables/useCommandPopover';
import { useArtifactMentions } from '../../composables/useArtifactMentions';
import { useReflexIntent } from '../../composables/useReflexIntent';
import { AttachmentService } from '../../services/AttachmentService';
import { VoiceSessionAdapter } from '../../services/VoiceSessionAdapter';

import { defaultSlashCommands, type SlashCommand, type MentionTarget } from '../../models/Command';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

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
const inputRef     = ref<InstanceType<typeof ComposerInput> | null>(null);
const wrapEl       = ref<HTMLElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

// ─── Placeholder + keyboard hints ──────────────────────────────────
const placeholder = computed(() => {
  if (isNoir.value) return 'Ask Sulla anything…';
  return controller.isRunning.value
    ? 'send while Sulla is working — queued'
    : 'reply — /  for commands · @ for context · drop files to attach';
});
const isNoir = ref(typeof document !== 'undefined' && document.documentElement.classList.contains('theme-noir-dark'));
let themeObserver: MutationObserver | null = null;

const canSendDraft = computed(() => draft.value.trim().length > 0 || controller.staged.value.length > 0);
const modelInitial = computed(() => controller.model.value.name.trim().charAt(0).toUpperCase() || 'S');
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

function addContext(): void {
  const suffix = draft.value && !draft.value.endsWith(' ') ? ' @' : '@';
  draft.value += suffix;
  nextTick(() => inputRef.value?.focus());
}

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
  controller.send(trimmed || '(attached)', [...controller.staged.value]);
  draft.value = '';
}

function onKeydown(e: KeyboardEvent): void {
  const p = controller.popover.value;
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
  themeObserver?.disconnect();
  voiceAdapter.dispose();
  reflexIntent.dispose();
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
  themeObserver = new MutationObserver(() => {
    isNoir.value = document.documentElement.classList.contains('theme-noir-dark');
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('chat:quote', onQuoteFromTurn as EventListener);
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
.context-btn, .model-btn, .usage-meter, .tool-spacer, .noir-guide { display: none; }

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
  display: flex; justify-content: flex-end; gap: 18px;
  margin-top: 8px;
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.3em;
  text-transform: uppercase; color: var(--read-4);
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

.reflex-intent {
  position: absolute; bottom: 100%; left: 42px;
  margin-bottom: 8px;
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.04em;
  color: var(--steel-200);
  animation: reflex-intent-in 0.14s ease-out;
}
.reflex-intent-btn, .reflex-intent > span {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 4px 10px; border-radius: 999px;
  background: rgba(106, 176, 204, 0.12);
  border: 1px solid rgba(106, 176, 204, 0.35);
  color: inherit; font: inherit; cursor: pointer;
}
.reflex-intent-btn:hover { background: rgba(106, 176, 204, 0.2); }
.reflex-intent.done > span { border-color: rgba(120, 200, 150, 0.45); background: rgba(120, 200, 150, 0.12); cursor: default; }
.reflex-intent.error > span { border-color: rgba(220, 140, 120, 0.45); background: rgba(220, 140, 120, 0.1); cursor: default; }
.reflex-intent .bolt { color: var(--steel-400); }
.reflex-intent kbd {
  font-family: var(--mono); font-size: 9px;
  padding: 1px 5px; border-radius: 3px;
  background: rgba(168, 192, 220, 0.1);
  border: 1px solid rgba(168, 192, 220, 0.2);
  color: var(--steel-200);
}
@keyframes reflex-intent-in {
  from { opacity: 0; transform: translateY(3px); }
  to   { opacity: 1; transform: none; }
}

.hidden-file-input {
  display: none;
}

/* Noir is a visual skin over the existing controller and keyboard behavior. */
:global(.theme-noir-dark) .composer-wrap {
  bottom: 0;
  left: 0;
  right: 0;
  padding: 0 20px 14px;
}
:global(.theme-noir-dark) .composer-inner {
  max-width: 760px;
}
:global(.theme-noir-dark) .chat-root.artifact-open .composer-wrap { left: 0; right: 0; }
:global(.theme-noir-dark) .chat-root.artifact-open .composer-inner { max-width: 760px; }
:global(.theme-noir-dark) .composer-card {
  display: block;
  position: relative;
  border-radius: 22px;
  background: rgba(3, 6, 12, 0.72);
  box-shadow: inset 0 0 0 1px rgba(168, 192, 220, 0.14), 0 16px 44px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(22px) saturate(135%);
  transition: box-shadow 0.3s cubic-bezier(.22, 1, .36, 1),
    transform 0.58s linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013, 1);
}
:global(.theme-noir-dark) .composer-card:focus-within {
  transform: translateY(-2px);
  box-shadow: inset 0 0 0 1px rgba(106, 176, 204, 0.55),
    0 0 0 4px rgba(80, 150, 179, 0.12), 0 0 44px rgba(80, 150, 179, 0.16),
    0 20px 56px rgba(0, 0, 0, 0.5);
}
:global(.theme-noir-dark) .composer-top {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 10px;
}
:global(.theme-noir-dark) .reflex-intent {
  position: static;
  width: max-content;
  margin: 10px 0 0;
  color: #dee4ec;
  font-family: var(--font-body);
  font-size: 12px;
  letter-spacing: 0;
  animation: noir-reflex-in 0.42s cubic-bezier(.22, 1, .36, 1) both;
}
:global(.theme-noir-dark) .reflex-intent-btn,
:global(.theme-noir-dark) .reflex-intent > span {
  height: 28px;
  padding: 0 6px 0 10px;
  border: 0;
  border-radius: 14px;
  background: linear-gradient(90deg, rgba(80, 150, 179, 0.18), rgba(80, 150, 179, 0.04));
  box-shadow: inset 0 0 0 0.5px rgba(106, 176, 204, 0.35);
}
:global(.theme-noir-dark) .reflex-intent kbd {
  padding: 2px 7px;
  border: 0;
  border-radius: 6px;
  color: #f3f5f8;
  background: rgba(168, 192, 220, 0.12);
  font-size: 10.5px;
}
@keyframes noir-reflex-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
:global(.theme-noir-dark) .composer {
  display: flex;
  align-items: stretch;
  gap: 0;
  min-height: 102px;
  padding: 0;
  flex-wrap: wrap;
  border: 0;
  box-shadow: none;
}
:global(.theme-noir-dark) .composer:focus-within,
:global(.theme-noir-dark) .composer.recording { border: 0; box-shadow: none; }
:global(.theme-noir-dark) .glyph { display: none; }
:global(.theme-noir-dark) .composer-tools {
  display: flex;
  align-items: center;
  gap: 2px;
  width: 100%;
  min-height: 52px;
  padding: 6px 8px 8px;
  border-top: 1px solid rgba(168, 192, 220, 0.07);
}
:global(.theme-noir-dark) .context-btn {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: #a9b3c1;
  background: transparent;
  font: 600 15px var(--mono);
  cursor: pointer;
}
:global(.theme-noir-dark) .context-btn:hover { color: #f3f5f8; background: rgba(80, 150, 179, 0.12); }
:global(.theme-noir-dark) .model-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  max-width: 190px;
  margin: 0 4px;
  padding: 0 10px 0 3px;
  border: 0;
  border-radius: 15px;
  color: #dee4ec;
  background: rgba(168, 192, 220, 0.06);
  box-shadow: inset 0 0 0 1px rgba(168, 192, 220, 0.1);
  font: 500 12.5px var(--font-body);
  cursor: pointer;
}
:global(.theme-noir-dark) .model-btn:hover { background: rgba(80, 150, 179, 0.14); }
:global(.theme-noir-dark) .model-avatar {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border-radius: 50%;
  color: #03060c;
  background: linear-gradient(135deg, #a8c0dc, #5096b3);
  font-size: 11px;
  font-weight: 700;
}
:global(.theme-noir-dark) .model-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:global(.theme-noir-dark) .model-caret { color: #7a8291; font-size: 9px; }
:global(.theme-noir-dark) .tool-spacer { display: block; flex: 1; }
:global(.theme-noir-dark) .usage-meter {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border: 0;
  color: #7a8291;
  background: transparent;
  font: 11px var(--mono);
  cursor: pointer;
}
:global(.theme-noir-dark) .usage-ring {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: conic-gradient(#6ab0cc 0 var(--usage), rgba(168, 192, 220, 0.12) var(--usage) 100%);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));
}
:global(.theme-noir-dark) .hints {
  position: relative;
  justify-content: center;
  min-height: 14px;
  margin-top: 9px;
  gap: 0;
  color: #484f5a;
  font-size: 10.5px;
  letter-spacing: 0;
  text-transform: none;
}
:global(.theme-noir-dark) .classic-guide { display: none; }
:global(.theme-noir-dark) .noir-guide { display: flex; gap: 4px; }
:global(.theme-noir-dark) .noir-guide span::before { display: none; }
:global(.theme-noir-dark) .hints kbd {
  margin: 0;
  padding: 0;
  border: 0;
  color: #a9b3c1;
  background: transparent;
  font-size: inherit;
  font-weight: 500;
}
:global(.theme-noir-dark) .noir-guide span:not(:last-child)::after { content: " ·"; color: #484f5a; }
:global(.theme-noir-dark) .hints :deep(.heartbeat-control) {
  position: absolute;
  right: 88px;
  bottom: 23px;
  z-index: 4;
  margin: 0;
}

@media (max-width: 680px) {
  :global(.theme-noir-dark) .composer-wrap { padding-right: 10px; padding-left: 10px; }
  :global(.theme-noir-dark) .model-name, :global(.theme-noir-dark) .usage-meter > span:last-child { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  :global(.theme-noir-dark) .composer-card,
  :global(.theme-noir-dark) .reflex-intent { animation: none; transition: none; }
}
</style>
