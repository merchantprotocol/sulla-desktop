<template>
  <div class="max-w-[min(760px,92%)]">
    <div class="flex gap-3">
      <img
        :src="botLogoUrl"
        alt=""
        class="h-8 w-8 rounded-full"
        aria-hidden="true"
      >
      <div class="flex-1 min-w-0">
        <div class="sulla-name dark:text-slate-400">
          {{ botName }}
        </div>
        <HtmlMessageRenderer
          :content="message.content"
          :is-dark="isDark"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useChatDisplay } from './context';

import HtmlMessageRenderer from '@pkg/components/HtmlMessageRenderer.vue';

import type { ChatMessage } from '@pkg/pages/agent/ChatInterface';

defineProps<{ message: ChatMessage }>();

const { botName, botLogoUrl, isDark } = useChatDisplay();
</script>
