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
    <InlineReplyBody class="chat-body" :text="msg.text" agent-cards />
    <button
      v-if="hoverBlock"
      type="button"
      class="block-reply"
      :style="{ top: `${hoverBlock.top}px` }"
      title="Reply to this part"
      aria-label="Reply to this part"
      @mousedown.prevent
      @mouseenter="holdBlock"
      @mouseleave="releaseBlock"
      @click="replyToBlock"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
      ><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" /></svg>
    </button>
    <ChatFileCard v-for="file in fileReferences" :key="`${file.fileId}:${file.versionId}`" :reference="file" />
    <slot name="sources" />
    <TurnActions
      role="sulla"
      :pinned="msg.pinned"
      :latest="false"
      @copy="copy"
      @regenerate="onRegenerate"
      @quote="onQuote"
      @pin="onPin"
      @fork="onFork"
    >
      <span :class="['reply-metadata', 'reply-metadata-standard']">
        <time v-if="replyTime" :datetime="replyTime.iso">{{ replyTime.label }}</time>
        <span v-else>Time not recorded</span>
        <span>{{ msg.replyAttribution?.agent || 'Agent not recorded' }}</span>

      </span>
    </TurnActions>

    <ChatContextMenu
      ref="ctxMenu"
      @new-chat="onNewChat"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

import InlineReplyBody from './InlineReplyBody.vue';
import TurnActions from './TurnActions.vue';
import ChatContextMenu from '../../ChatContextMenu.vue';
import ChatFileCard from '../files/ChatFileCard.vue';
import { useChatController } from '../../controller/useChatController';
import { parseDurableFileReferences } from '@pkg/shared/filesReferences';

import type { SullaMessage } from '../../models/Message';

const props = defineProps<{ msg: SullaMessage; latest?: boolean }>();
// Kept for back-compat with any parents that still listen.
defineEmits<{
  (e: 'regenerate'): void; (e: 'quote'): void; (e: 'pin'): void; (e: 'fork'): void;
}>();

const controller = useChatController();
const ctxMenu = ref<InstanceType<typeof ChatContextMenu> | null>(null);

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const replyTime = computed(() => {
  const date = new Date(props.msg.createdAt);
  return Number.isFinite(date.getTime()) ? { iso: date.toISOString(), label: dateFormat.format(date) } : undefined;
});

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

// ── Reply to one block (paragraph, heading, list item, code block) ──
const REPLY_BLOCKS = 'p, h2, h3, li, pre, blockquote, table';
const turnEl = ref<HTMLElement | null>(null);
const hoverBlock = ref<{ el: HTMLElement; top: number } | null>(null);

// The reply pill stays inside the message boundary. Losing the block only hides the button after a
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
  const el = block;
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
/* Keep the contextual reply inside the transcript, including beside a narrow dock. */
.chat-turn.sulla { position: relative; }
.chat-turn.sulla .chat-body { padding-inline-end: 36px; }
.block-reply {
  position: absolute; right: 0; z-index: 3;
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--border-default); background: var(--bg-surface);
  color: var(--text-secondary); font: 500 12px var(--font-body);
  box-shadow: var(--elev-float);
  max-width: 100%;
}
.block-reply:hover { color: var(--text-primary); border-color: var(--accent); }
.block-reply svg { width: 13px; height: 13px; fill: currentColor; }
.reply-metadata {
  display: flex; flex-wrap: wrap; gap: 2px 8px; min-width: 0;
  margin-inline-start: 8px; color: var(--text-muted);
  overflow-wrap: anywhere;
}
.reply-metadata > :not(:first-child)::before { content: '· '; }
.reply-metadata-standard { opacity: 0; visibility: hidden; transition: opacity .15s ease; }
.chat-turn.sulla:hover .reply-metadata-standard,
.chat-turn.sulla:focus-within .reply-metadata-standard { opacity: 1; visibility: visible; }
</style>
