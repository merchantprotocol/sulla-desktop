<template>
  <div class="max-w-[min(760px,92%)]">
    <div
      v-if="message.image"
      class="space-y-2"
    >
      <img
        :src="message.image.dataUrl"
        :alt="message.image.alt || ''"
        class="block h-auto max-w-full rounded-xl border border-black/10 dark:border-white/10"
      >
      <div
        v-if="message.image.alt"
        class="text-xs text-content-secondary"
      >
        {{ message.image.alt }}
      </div>
    </div>
    <div
      v-else
      class="flex gap-3"
    >
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
