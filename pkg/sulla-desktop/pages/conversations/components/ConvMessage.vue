<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<script setup lang="ts">
import type { MessageView } from '../ConversationScreenStore';
import ConvAvatar from './ConvAvatar.vue';
import ConvText from './ConvText.vue';

defineProps<{ message: MessageView }>();
</script>

<template>
  <div class="msg" :class="{ 'agent-msg': message.side === 'agent' }">
    <ConvAvatar v-if="message.side === 'agent'" bot />
    <ConvAvatar v-else :ini="message.initials" :color="message.side === 'me' ? 'a' : ''" />
    <div class="body">
      <div class="hd"><b>{{ message.name }}</b><time>{{ message.time }}</time></div>
      <div class="tx"><ConvText :text="message.text" /></div>
    </div>
  </div>
</template>
