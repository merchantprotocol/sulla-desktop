<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- Message posted by another agent (for example Heartbeat or Mobile). -->
<template>
  <div class="channel-msg" :data-agent="msg.agent.toLowerCase()">
    <div class="chead">
      <span class="agent">{{ msg.agent }}</span>
      <span class="ch">#{{ msg.channel }}</span>
      <span class="ts">{{ timeLabel }}</span>
    </div>
    <div class="body" v-html="msg.text" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ChannelMessage as Msg } from '../../models/Message';

const props = defineProps<{ msg: Msg }>();
const timeLabel = computed(() => {
  const d = new Date(props.msg.createdAt);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
});
</script>

<style scoped>
.channel-msg {
  padding: 14px 16px; margin: 4px 0;
  border-radius: 10px;
  background: var(--accent-glow);
  border: 1px solid var(--accent-dim);
  border-left: 3px solid var(--accent-hover);
  position: relative;
}
.chead {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--text-muted);
  margin-bottom: 6px;
  display: flex; align-items: center; gap: 10px;
}
.chead .agent { color: var(--accent-hover); font-weight: 700; }
.chead .ch {
  padding: 1px 7px; border-radius: 3px;
  background: var(--accent-dim);
  border: 1px solid var(--accent-dim);
  color: var(--accent-hover); font-size: 9px;
}
.chead .ts { margin-left: auto; color: var(--text-dim); font-size: 9.5px; }
.body {
  font-family: var(--font-display); font-size: 15.5px; line-height: 1.6;
  color: var(--text-primary);
}
.channel-msg[data-agent="heartbeat"] { border-left-color: var(--accent-hover); }
.channel-msg[data-agent="mobile"]    { border-left-color: var(--accent-hover); }
</style>
