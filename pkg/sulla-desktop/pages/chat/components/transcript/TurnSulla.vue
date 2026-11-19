<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Sulla's completed reply, rendered through a markdown pipeline that
  mirrors the existing BrowserTabChat (marked + DOMPurify).

  Hover actions:
    • Copy       → clipboard
    • Regenerate → controller.regenerate(msg.id) — trims to the previous
                   user message and re-runs
    • Quote      → window event 'chat:quote' (composer will listen)
    • Pin/Unpin  → controller.togglePin(msg.id); label toggles off msg.pinned
    • Fork       → console.log (registry hook TBD)

  Right-click → shared ChatContextMenu anchored at the cursor.
-->
<template>
  <div
    ref="turnEl"
    class="chat-turn sulla chat-fade-in"
    @contextmenu.prevent="onContextMenu"
    @mousemove="onHoverBlock"
    @mouseleave="releaseBlock"
  >
    <span class="chat-role"><span
      class="noir-avatar"
      aria-hidden="true"
    >S</span>Sulla · {{ timeLabel }}</span>
    <IsolatedHtml
      v-if="isHtmlDocument"
      class="chat-body"
      :html="msg.text"
    />
    <div
      v-else
      class="chat-body"
      v-html="rendered"
    />
    <button
      v-if="hoverBlock"
      type="button"
      class="block-reply"
      :style="{ top: `${hoverBlock.top}px` }"
      title="Reply to this part"
      @mousedown.prevent
      @mouseenter="holdBlock"
      @mouseleave="releaseBlock"
      @click="replyToBlock"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
      ><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" /></svg>
      Reply
    </button>
    <ChatFileCard v-for="file in fileReferences" :key="`${file.fileId}:${file.versionId}`" :reference="file" />
    <TurnActions
      role="sulla"
      :pinned="msg.pinned"
      :latest="isLatest"
      @copy="copy"
      @regenerate="onRegenerate"
      @quote="onQuote"
      @pin="onPin"
      @fork="onFork"
    />

    <ChatContextMenu
      ref="ctxMenu"
      @new-chat="onNewChat"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

import IsolatedHtml from './IsolatedHtml.vue';
import TurnActions from './TurnActions.vue';
import ChatContextMenu from '../../ChatContextMenu.vue';
import ChatFileCard from '../files/ChatFileCard.vue';
import { useChatController } from '../../controller/useChatController';
import { renderMarkdown } from '../../messages/markdown';
import { A2aCardMarkup } from '../../messages/a2aCardMarkup';
import { structureReply } from '../../messages/replyStructure';
import { parseDurableFileReferences } from '@pkg/shared/filesReferences';

import type { SullaMessage } from '../../models/Message';

/**
 * Detect raw HTML-ish content. When the agent emits things like a bare
 * `<style>…</style>` block or an unwrapped `<html>` document, those need
 * Shadow DOM isolation so their CSS doesn't bleed into the host app.
 * Everything else keeps going through the normal marked/DOMPurify pipe.
 */
const HTML_DOC_RE = /<style\b|<script\b|<!doctype|<html\b|<body\b|<head\b/i;

const props = defineProps<{ msg: SullaMessage }>();
// Kept for back-compat with any parents that still listen.
defineEmits<{
  (e: 'regenerate'): void; (e: 'quote'): void; (e: 'pin'): void; (e: 'fork'): void;
}>();

const controller = useChatController();
/** The newest Sulla reply keeps its actions in view without hovering. */
const isLatest = computed(() => controller.messages.value.findLast(message => message.kind === 'sulla')?.id === props.msg.id);
const ctxMenu = ref<InstanceType<typeof ChatContextMenu> | null>(null);

const timeLabel = computed(() => {
  const d = new Date(props.msg.createdAt);
  return `${ d.getHours() % 12 || 12 }:${ String(d.getMinutes()).padStart(2, '0') }`;
});

const isHtmlDocument = computed(() => HTML_DOC_RE.test(props.msg.text || ''));

// Long replies are regrouped into Summary / Issues / Next steps sections for scanning.
const a2aCards = new A2aCardMarkup();
const rendered = computed(() => structureReply(renderMarkdown(a2aCards.render(props.msg.text))));
const fileReferences = computed(() => {
  const refs = [...(props.msg.fileReferences ?? [])].map(item => ({ ...item.fileRef!, name: item.name })).filter(item => item.fileId);
  refs.push(...parseDurableFileReferences(props.msg.text));
  return refs.filter((item, index) => refs.findIndex(other => other.fileId === item.fileId && other.versionId === item.versionId) === index);
});

function copy(): void {
  navigator.clipboard?.writeText(props.msg.text).catch(() => undefined);

  console.log('[chat] copied sulla message', props.msg.id);
}

function onRegenerate(): void {
  controller.regenerate(props.msg.id);
}

function onPin(): void {
  controller.togglePin(props.msg.id);
}

/** Reply to the whole message (the turn's hover action). */
function onQuote(): void {
  sendReply(props.msg.text);
}

// ── Reply to one block (paragraph, list item, section card, code block) ──
const REPLY_BLOCKS = 'p, li, pre, blockquote, table, section.reply-section > :is(h2, h3)';
const turnEl = ref<HTMLElement | null>(null);
const hoverBlock = ref<{ el: HTMLElement; top: number } | null>(null);

// The button sits just outside the message, so the pointer crosses padding
// and a gap on its way there. Losing the block only hides the button after a
// short grace period, which reaching the button cancels.
const RELEASE_GRACE_MS = 400;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

function holdBlock(): void {
  clearTimeout(releaseTimer);
  releaseTimer = undefined;
}

function releaseBlock(): void {
  if (!hoverBlock.value || releaseTimer) return;
  releaseTimer = setTimeout(() => {
    releaseTimer = undefined;
    hoverBlock.value = null;
  }, RELEASE_GRACE_MS);
}

onBeforeUnmount(() => clearTimeout(releaseTimer));

function onHoverBlock(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest('.block-reply')) return;
  const block = target?.closest<HTMLElement>(REPLY_BLOCKS);
  const turn = turnEl.value;
  if (!block || !turn?.contains(block)) {
    releaseBlock();
    return;
  }
  holdBlock();
  // A section heading stands for its whole card.
  const el = block.matches('h2, h3') ? block.parentElement! : block;
  if (hoverBlock.value?.el === el) return;
  hoverBlock.value = { el, top: el.getBoundingClientRect().top - turn.getBoundingClientRect().top };
}

function replyToBlock(): void {
  if (hoverBlock.value) sendReply(hoverBlock.value.el.innerText);
  holdBlock();
  hoverBlock.value = null;
}

function sendReply(excerpt: string): void {
  window.dispatchEvent(new CustomEvent('chat:reply', { detail: { threadId: controller.thread.value.id, excerpt } }));
}

function onFork(): void {
  // Forking needs a registry hook that doesn't exist yet. Visual-only for now.

  console.log('fork from', props.msg.id);
}

function onContextMenu(ev: MouseEvent): void {
  ctxMenu.value?.show(ev, props.msg.text);
}

function onNewChat(): void {
  window.dispatchEvent(new CustomEvent('chat:new-chat'));
}
</script>

<style scoped>
/* Hover "Reply" for the block under the pointer, pinned to the turn's right edge. */
.chat-turn.sulla { position: relative; }
.block-reply {
  position: absolute; right: -8px; z-index: 3;
  display: inline-flex; align-items: center; gap: 5px;
  height: 26px; padding: 0 9px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--border-default); background: var(--bg-surface);
  color: var(--text-secondary); font: 500 12px var(--font-body);
  box-shadow: var(--elev-float);
  transform: translateX(100%);
}
.block-reply:hover { color: var(--text-primary); border-color: var(--accent); }
/* Invisible bridge over the gap back to the message, so the pointer never
   "leaves" while travelling to the button. */
.block-reply::before { content: ''; position: absolute; top: -6px; bottom: -6px; right: 100%; width: 16px; }
.block-reply svg { width: 13px; height: 13px; fill: currentColor; }
.noir-avatar {
  display: none;
}
</style>
