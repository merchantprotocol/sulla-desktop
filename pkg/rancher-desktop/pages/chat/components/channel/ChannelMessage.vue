<!-- Message posted by another agent (Heartbeat, Workbench, Mobile). -->
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
  background: rgba(20, 30, 42, 0.45);
  border: 1px solid rgba(168, 192, 220, 0.15);
  border-left: 3px solid var(--steel-400);
  position: relative;
}
.chead {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--read-4);
  margin-bottom: 6px;
  display: flex; align-items: center; gap: 10px;
}
.chead .agent { color: var(--steel-300); font-weight: 700; }
.chead .ch {
  padding: 1px 7px; border-radius: 3px;
  background: rgba(80, 150, 179, 0.12);
  border: 1px solid rgba(80, 150, 179, 0.22);
  color: var(--steel-400); font-size: 9px;
}
.chead .ts { margin-left: auto; color: var(--read-5); font-size: 9.5px; }
.body {
  font-family: var(--serif); font-size: 15.5px; line-height: 1.6;
  color: var(--read-2);
}
.channel-msg[data-agent="heartbeat"] { border-left-color: var(--steel-300); }
.channel-msg[data-agent="workbench"] { border-left-color: var(--steel-500); }
.channel-msg[data-agent="mobile"]    { border-left-color: var(--steel-400); }
</style>
