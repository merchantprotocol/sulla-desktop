<template>
  <div class="heartbeat-message">
    <div class="heartbeat-meta">
      <span aria-hidden="true">♥</span>
      <strong>Heartbeat</strong>
      <time :datetime="new Date(msg.createdAt).toISOString()">{{ time }}</time>
      <span>every {{ interval }}</span>
    </div>
    <details>
      <summary>Message</summary>
      <div class="heartbeat-text">
        {{ msg.text }}
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { HeartbeatMessage } from '../../models/Message';

const props = defineProps<{ msg: HeartbeatMessage }>();
const time = computed(() => new Date(props.msg.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
const interval = computed(() => `${ props.msg.intervalMinutes } min`);
</script>

<style scoped>
.heartbeat-message {
  margin: 6px 0; padding: 10px 12px; border: 1px solid var(--accent-border);
  border-radius: 10px; background: var(--accent-dim); color: var(--text-muted);
  font-family: var(--font-body); font-size: 12px;
}
.heartbeat-meta { display: flex; align-items: center; gap: 8px; }
.heartbeat-meta > span:first-child, .heartbeat-meta strong { color: var(--accent); }
.heartbeat-meta time { margin-left: auto; }
details { margin-top: 6px; }
summary { cursor: pointer; color: var(--text-muted); }
.heartbeat-text { margin-top: 8px; white-space: pre-wrap; color: var(--text); line-height: 1.45; }
</style>
