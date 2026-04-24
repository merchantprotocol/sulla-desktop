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
    class="chat-turn sulla chat-fade-in"
    @contextmenu.prevent="onContextMenu"
  >
    <span class="chat-role">Sulla · {{ timeLabel }}</span>
    <div class="chat-body" v-html="rendered" />
    <TurnActions
      role="sulla"
      :pinned="msg.pinned"
      @copy="copy"
      @regenerate="onRegenerate"
      @quote="onQuote"
      @pin="onPin"
      @fork="onFork"
    />

    <ChatContextMenu ref="ctxMenu" @new-chat="onNewChat" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import type { SullaMessage } from '../../models/Message';
import TurnActions from './TurnActions.vue';
import ChatContextMenu from '../../ChatContextMenu.vue';
import { useChatController } from '../../controller/useChatController';

const props = defineProps<{ msg: SullaMessage }>();
// Kept for back-compat with any parents that still listen.
defineEmits<{
  (e: 'regenerate'): void; (e: 'quote'): void; (e: 'pin'): void; (e: 'fork'): void;
}>();

const controller = useChatController();
const ctxMenu = ref<InstanceType<typeof ChatContextMenu> | null>(null);

const timeLabel = computed(() => {
  const d = new Date(props.msg.createdAt);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
});

const rendered = computed(() => {
  const html = (marked(props.msg.text || '') as string) || '';
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
  });
});

function copy(): void {
  void navigator.clipboard?.writeText(props.msg.text);
  // eslint-disable-next-line no-console
  console.log('[chat] copied sulla message', props.msg.id);
}

function onRegenerate(): void {
  controller.regenerate(props.msg.id);
}

function onPin(): void {
  controller.togglePin(props.msg.id);
}

function onQuote(): void {
  window.dispatchEvent(new CustomEvent('chat:quote', { detail: props.msg.text }));
}

function onFork(): void {
  // Forking needs a registry hook that doesn't exist yet. Visual-only for now.
  // eslint-disable-next-line no-console
  console.log('fork from', props.msg.id);
}

function onContextMenu(ev: MouseEvent): void {
  ctxMenu.value?.show(ev, props.msg.text);
}

function onNewChat(): void {
  window.dispatchEvent(new CustomEvent('chat:new-chat'));
}
</script>
