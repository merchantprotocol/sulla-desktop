<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Sulla reply in-flight. Identical styling to TurnSulla with a trailing
  cursor until streaming ends (controller flips kind to 'sulla').
-->
<template>
  <div class="chat-turn sulla chat-fade-in">
    <span class="chat-role"><span
      class="noir-avatar"
      aria-hidden="true"
    >S</span>Sulla · {{ timeLabel }} · responding</span>
    <div class="chat-body">
      <InlineReplyBody :text="msg.text" agent-cards />
      <span
        class="chat-cursor"
        aria-hidden="true"
      />
    </div>
    <div class="writing-status">
      <span aria-hidden="true" />Writing…
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import InlineReplyBody from './InlineReplyBody.vue';
import type { StreamingMessage } from '../../models/Message';

const props = defineProps<{ msg: StreamingMessage }>();

const timeLabel = computed(() => {
  const d = new Date(props.msg.createdAt);
  return `${ d.getHours() % 12 || 12 }:${ String(d.getMinutes()).padStart(2, '0') }`;
});

</script>

<style scoped>
.writing-status,
.noir-avatar {
  display: none;
}
</style>
