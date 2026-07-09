<template>
  <div class="max-w-[min(760px,92%)]">
    <div class="flex gap-3">
      <img
        :src="botLogoUrl"
        alt=""
        class="h-8 w-8 rounded-full"
        aria-hidden="true"
      >
      <div>
        <div class="sulla-name dark:text-slate-400">
          {{ botName }}
        </div>
        <div
          class="prose max-w-none prose-slate dark:text-slate-400 dark:prose-invert"
          v-html="renderMarkdown(message.content)"
        /><span
          v-if="!(message as any)._completed"
          class="streaming-cursor"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useChatDisplay } from './context';
import { renderMarkdown } from './markdown';

import type { ChatMessage } from '@pkg/pages/agent/ChatInterface';

defineProps<{ message: ChatMessage }>();

const { botName, botLogoUrl } = useChatDisplay();
</script>

<style scoped>
.streaming-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--accent-primary, #3b82f6);
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blinkCursor 0.8s step-end infinite;
}

@keyframes blinkCursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
</style>
