<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="flex justify-end">
    <div class="max-w-[min(760px,92%)]">
      <div
        class="sulla-name text-right mb-1"
        style="color: var(--text-muted);"
      >
        You
      </div>
      <div class="rounded-3xl p-6 bg-surface-alt ring-1 ring-edge-subtle">
        <img
          v-if="message.image?.dataUrl"
          :src="message.image.dataUrl"
          :alt="message.image.alt || 'Attached image'"
          class="mb-2 max-h-64 rounded-xl object-contain"
        >
        <div class="whitespace-pre-wrap text-content">
          {{ message.content }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ChatMessage } from '@pkg/pages/agent/ChatInterface';

defineProps<{ message: ChatMessage }>();
</script>
