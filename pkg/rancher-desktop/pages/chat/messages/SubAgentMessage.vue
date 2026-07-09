<template>
  <SubAgentBubble
    v-if="message.subAgentActivity"
    :activity="message.subAgentActivity"
    :is-dark="isDark"
  />
</template>

<script setup lang="ts">
import { useChatDisplay } from './context';

import SubAgentBubble from '@pkg/pages/editor/workflow/SubAgentBubble.vue';

import type { ChatMessage } from '@pkg/pages/agent/ChatInterface';

defineProps<{ message: ChatMessage }>();

const { isDark } = useChatDisplay();
</script>
