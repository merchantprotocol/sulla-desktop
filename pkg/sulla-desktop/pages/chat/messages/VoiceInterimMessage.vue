<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="flex justify-end">
    <div class="max-w-[min(760px,92%)] rounded-3xl p-6 bg-surface-alt ring-1 ring-edge-subtle opacity-70">
      <div class="whitespace-pre-wrap text-content italic">
        <span class="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse mr-2 align-middle" />{{ message.content }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ChatMessage } from '@pkg/pages/agent/ChatInterface';

defineProps<{ message: ChatMessage }>();
</script>
