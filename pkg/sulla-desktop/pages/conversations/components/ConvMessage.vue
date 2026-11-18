<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<script setup lang="ts">
import type { MessageView } from '../ConversationScreenStore';
import ConvAvatar from './ConvAvatar.vue';
import ConvIcon from './ConvIcon.vue';
import ConvText from './ConvText.vue';

defineProps<{ message: MessageView }>();
</script>

<!-- Mockup templates, verbatim structure: youMsg / pMsg (avatar, name, time), agentMsg (robot avatar, name, .who pill, time), and the .sys pill. -->
<template>
  <div v-if="message.side === 'system'" class="sys" :class="message.sysTone"><ConvIcon :name="message.sysTone === 'bad' ? 'stop' : 'info'" /><ConvText :text="message.text" /></div>
  <div v-else-if="message.side === 'agent'" class="msg agent-msg">
    <ConvAvatar bot :theirs="message.theirs" />
    <div class="body">
      <div class="hd"><b>{{ message.name }}</b><span class="who" :class="message.theirs ? 'theirs' : 'you'">{{ message.actsFor }}</span><time>{{ message.time }}</time></div>
      <div v-if="message.text" class="tx"><ConvText :text="message.text" /></div>
    </div>
  </div>
  <div v-else class="msg">
    <ConvAvatar :ini="message.initials" :color="message.tone" />
    <div class="body">
      <div class="hd"><b>{{ message.name }}</b><time>{{ message.time }}</time></div>
      <div v-if="message.text" class="tx"><ConvText :text="message.text" /></div>
    </div>
  </div>
</template>
