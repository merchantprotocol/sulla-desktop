<!--
  Editable thread title shown as a whisper near the top of the page.
  Click to rename — commits on blur or Enter.
-->
<template>
  <div class="session-mark">
    <span class="dot" />
    <span
      ref="titleEl"
      class="title"
      :contenteditable="editable"
      spellcheck="false"
      @keydown.enter.prevent="commit"
      @blur="commit"
    >{{ controller.thread.value.title }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useChatController } from '../../controller/useChatController';

defineProps<{ editable?: boolean }>();
const controller = useChatController();
const titleEl = ref<HTMLElement | null>(null);

function commit(): void {
  const next = (titleEl.value?.textContent || '').trim() || 'New chat';
  controller.renameThread(next);
  titleEl.value?.blur();
}
</script>

<style scoped>
.session-mark {
  position: absolute; top: 32px; left: 50%;
  transform: translateX(-50%);
  z-index: 12;
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.4em;
  text-transform: uppercase;
  color: var(--steel-400);
  display: inline-flex; align-items: center; gap: 14px;
}
.session-mark::before,
.session-mark::after {
  content: ""; width: 28px; height: 1px;
  background: var(--steel-500); opacity: 0.55;
}
.session-mark .dot {
  width: 5px; height: 5px; border-radius: 50%; background: var(--steel-400);
  box-shadow: 0 0 8px var(--steel-400);
  animation: chat-pulse 1.5s infinite;
}
.session-mark .title {
  color: white; font-family: var(--serif); font-style: italic;
  letter-spacing: 0.01em; text-transform: none; font-size: 15px;
  outline: none;
}
.session-mark .title[contenteditable="true"]:focus {
  background: rgba(80, 150, 179, 0.1);
  padding: 2px 8px; border-radius: 4px;
}
</style>
