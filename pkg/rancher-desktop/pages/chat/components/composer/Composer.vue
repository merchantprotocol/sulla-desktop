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
    3. start/stop voice    on mic click
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
          @stop="stopVoice(true)"
        />

        <ComposerAttach @pick="onAttach" />
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
import { computed, ref } from 'vue';

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
import { AttachmentService } from '../../services/AttachmentService';

import { newMessageId } from '../../types/chat';
import type { SlashCommand, MentionTarget } from '../../models/Command';
import type { InterimMessage } from '../../models/Message';

const controller = useChatController();

const draft    = ref('');
const inputRef = ref<InstanceType<typeof ComposerInput> | null>(null);
const wrapEl   = ref<HTMLElement | null>(null);

// ─── Placeholder + keyboard hints ──────────────────────────────────
const placeholder = computed(() => {
  return controller.isRunning.value
    ? 'send while Sulla is working — queued'
    : 'reply — /  for commands · @ for context · drop files to attach';
});

// ─── Voice state bridge ────────────────────────────────────────────
const isRecording  = computed(() => controller.voice.value.phase === 'recording');
const recStartedAt = computed(() => controller.voice.value.phase === 'recording' ? controller.voice.value.startedAt : 0);

// ─── Slash / mention autocomplete ──────────────────────────────────
const mentionSource = {
  list(q: string): readonly MentionTarget[] {
    // Phase-0 stub. Phase-2 wires into actual file/memory/agent indexes.
    const files = ['GuestBridge.ts','ChatInterface.ts','MessageDispatcher.ts','BrowserTabChat.vue','AgentRoutines.vue','protocol-dark.css'];
    const mems  = [{ id: 'w9oK', summary: 'screenshot race fix' }, { id: 'z7kG', summary: 'stop button bug' }, { id: 'TUoS', summary: 'rebuild workflow' }];
    const agents = ['Heartbeat','Workbench','Mobile','code-researcher','thinker'];
    const out: MentionTarget[] = [];
    files.filter(n => n.toLowerCase().includes(q)).forEach(n => out.push({ token: `@${n}`, label: 'file', kind: 'file' }));
    mems.filter(m => m.id.toLowerCase().includes(q) || m.summary.toLowerCase().includes(q)).forEach(m => out.push({ token: `@mem:${m.id}`, label: m.summary, kind: 'memory' }));
    agents.filter(a => a.toLowerCase().includes(q)).forEach(a => out.push({ token: `@${a.toLowerCase()}`, label: 'agent', kind: 'agent' }));
    return out;
  },
};
const taRef = computed(() => inputRef.value?.el ?? null);
useCommandPopover(taRef, mentionSource);

function choosePopoverItem(idx: number): void {
  const p = controller.popover.value;
  const item = p.items[idx];
  if (!item) return;
  const ta = taRef.value; if (!ta) return;
  const tok = 'name' in item ? (item as SlashCommand).name : (item as MentionTarget).token;
  const re  = p.mode === 'slash' ? /(?:^|\s)(\/\w*)$/ : /(?:^|\s)(@\w*)$/;
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

// ─── Attachments (demo: pick a random file; real: open file picker) ─
function onAttach(): void {
  const demo = [
    { name: 'devtools-timeline.json', size: '48 KB',  kind: 'json' as const },
    { name: 'screenshot-trace.png',   size: '312 KB', kind: 'image' as const },
    { name: 'GuestBridge.ts',         size: '19 KB',  kind: 'ts' as const },
  ];
  const pick = demo[Math.floor(Math.random() * demo.length)];
  controller.stageAttachment(AttachmentService.fromDescriptor(pick));
}

// ─── Voice ─────────────────────────────────────────────────────────
// Phase-0 canned demo: shows the UI, but the real VoiceSession hook
// will replace this in phase 2.
const cannedUtterances = [
  'can you also handle the case where the view is destroyed before the retry finishes?',
  'how do we confirm the retry window still holds for the new batch of tabs?',
];
let interimTimer: ReturnType<typeof setInterval> | null = null;

function toggleVoice(): void {
  if (isRecording.value) stopVoice(true);
  else startVoice();
}

function startVoice(): void {
  // Create an interim message in the transcript
  const interim: InterimMessage = {
    id: newMessageId(), kind: 'interim', createdAt: Date.now(),
    text: '', startedAt: Date.now(),
  };
  controller.appendMessage(interim);
  controller.setVoice({ phase: 'recording', startedAt: Date.now(), interimMessageId: interim.id, level: 0 });

  const line = cannedUtterances[Math.floor(Math.random() * cannedUtterances.length)];
  let i = 0;
  interimTimer = setInterval(() => {
    i++;
    controller.updateMessage<InterimMessage>(interim.id, { text: line.slice(0, i) });
    if (i >= line.length) { if (interimTimer) clearInterval(interimTimer); interimTimer = null; }
  }, 45);
}

function stopVoice(commit: boolean): void {
  if (controller.voice.value.phase !== 'recording') return;
  const v = controller.voice.value;
  if (interimTimer) { clearInterval(interimTimer); interimTimer = null; }
  const interimId = v.interimMessageId;
  const interim = controller.messages.value.find(m => m.id === interimId);
  const text = interim && interim.kind === 'interim' ? interim.text : '';
  controller.removeMessage(interimId);
  controller.stopVoice(commit);
  if (commit && text.trim()) controller.send(text.trim());
}

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
</style>
