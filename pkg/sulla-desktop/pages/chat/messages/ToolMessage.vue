<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
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
