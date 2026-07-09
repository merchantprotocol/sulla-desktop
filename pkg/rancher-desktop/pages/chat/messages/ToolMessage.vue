<template>
  <div class="max-w-[min(760px,92%)]">
    <ChatToolCard
      v-if="message.toolCard"
      :tool-card="message.toolCard"
    />
  </div>
</template>

<script setup lang="ts">
import ChatToolCard from '@pkg/components/ChatToolCard.vue';

import type { ChatMessage } from '@pkg/pages/agent/ChatInterface';

defineProps<{ message: ChatMessage }>();
</script>
