<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="chat-ctx-overlay"
      @click="hide"
      @contextmenu.prevent="hide"
    />
    <div
      v-if="visible"
      ref="menuRef"
      class="chat-ctx-menu"
      :style="{ top: posY + 'px', left: posX + 'px' }"
      @contextmenu.prevent
    >
      <!-- Copy (selected text) -->
      <button
        class="chat-ctx-item"
        :class="{ disabled: !hasSelection }"
        :disabled="!hasSelection"
        @click="doCopy"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
        <span>Copy</span>
        <span class="chat-ctx-shortcut">&#x2318;C</span>
      </button>

      <!-- Select All -->
      <button
        class="chat-ctx-item"
        @click="doSelectAll"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 3h18v18H3z" />
          <path d="M8 8h8v8H8z" />
        </svg>
        <span>Select All</span>
        <span class="chat-ctx-shortcut">&#x2318;A</span>
      </button>

      <div class="chat-ctx-separator" />

      <!-- Copy Message (full message the user right-clicked on) -->
      <button
        v-if="messageContent"
        class="chat-ctx-item"
        @click="doCopyMessage"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span>Copy Message</span>
      </button>

      <div v-if="messageContent" class="chat-ctx-separator" />

      <!-- New Chat -->
      <button
        class="chat-ctx-item"
        @click="doNewChat"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>New Chat</span>
      </button>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue';

const emit = defineEmits<{
  'new-chat': [];
}>();

const visible = ref(false);
const posX = ref(0);
const posY = ref(0);
const hasSelection = ref(false);
const messageContent = ref('');
const menuRef = ref<HTMLElement | null>(null);

function show(event: MouseEvent, msgContent?: string) {
  const sel = window.getSelection();
  hasSelection.value = !!(sel && sel.toString().trim());
  messageContent.value = msgContent ?? '';

  posX.value = event.clientX;
  posY.value = event.clientY;
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

async function writeToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    // Fallback for Electron renderers without secure-context clipboard
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

async function doCopy() {
  const sel = window.getSelection();
  if (sel && sel.toString().trim()) {
    await writeToClipboard(sel.toString());
  }
  hide();
}

function doSelectAll() {
  hide();
  document.execCommand('selectAll');
}

async function doCopyMessage() {
  if (messageContent.value) {
    await writeToClipboard(messageContent.value);
  }
  hide();
}

function doNewChat() {
  hide();
  emit('new-chat');
}

defineExpose({ show, hide });
</script>

<style>
/* Unscoped — teleported to body */
.chat-ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
}

.chat-ctx-menu {
  position: fixed;
  z-index: 10000;
  min-width: 200px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6), 0 0 1px rgba(63, 185, 80, 0.15);
  padding: 6px 0;
  animation: chatCtxFadeIn 0.15s ease-out;
  font-family: var(--ifm-font-family-monospace, ui-monospace, SFMono-Regular, Menlo, monospace);
}

@keyframes chatCtxFadeIn {
  from { opacity: 0; transform: scale(0.96); }
  to   { opacity: 1; transform: scale(1); }
}

.chat-ctx-item {
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

.chat-ctx-item:hover:not(.disabled) {
  background: var(--bg-surface-hover);
  color: var(--accent-primary);
}

.chat-ctx-item:hover:not(.disabled) svg {
  stroke: var(--accent-primary);
}

.chat-ctx-item.disabled {
  opacity: 0.4;
  cursor: default;
}

.chat-ctx-shortcut {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
  padding-left: 16px;
}

.chat-ctx-separator {
  height: 1px;
  background: var(--border-default);
  margin: 4px 0;
}
</style>
