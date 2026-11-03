<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- Sub-agent activity card. Expands to show its step list. -->
<template>
  <div
    :class="['subagent', statusClass, { open }]"
    @click="open = !open"
  >
    <div class="head">
      <span class="spin" />
      <span class="name">{{ msg.name }}</span>
      <span class="desc">{{ msg.desc }}</span>
      <span class="ts">{{ timeLabel }}</span>
      <span class="status-label">{{ statusLabel }}</span>
      <span class="chev">▸</span>
    </div>
    <span
      v-if="msg.status === 'running'"
      class="progress-track"
      aria-hidden="true"
    ><span /></span>
    <div class="detail">
      <div
        v-for="(s, idx) in msg.steps"
        :key="idx"
        class="step"
      >
        <span class="tag">{{ s.tag }}</span>
        <span>{{ s.text }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import type { SubAgentMessage } from '../../models/Message';

const props = defineProps<{ msg: SubAgentMessage }>();
const open = ref(false);

const statusClass = computed(() => props.msg.status === 'done' ? 'done' : props.msg.status === 'error' ? 'err' : 'running');
const statusLabel = computed(() => props.msg.status === 'done' ? 'Done' : props.msg.status === 'error' ? 'Failed' : 'Running');

const timeLabel = computed(() => {
  const d = new Date(props.msg.createdAt);
  return `${ d.getHours() % 12 || 12 }:${ String(d.getMinutes()).padStart(2, '0') }`;
});
</script>

<style scoped>
.subagent {
  padding: 12px 16px; margin: 4px 0;
  border-radius: 10px;
  background: var(--accent-dim);
  border: 1px solid var(--accent-dim);
  cursor: pointer;
}
.head {
  display: flex; align-items: center; gap: 12px;
  font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.2em;
  text-transform: uppercase; color: var(--accent-hover);
}
.head .spin {
  width: 12px; height: 12px; border-radius: 50%;
  border: 1.5px solid var(--accent-dim);
  border-top-color: var(--accent-hover);
  animation: chat-spin 1s linear infinite;
}
.head .name { font-weight: 700; color: var(--text-muted); }
.head .desc {
  color: var(--text-secondary); text-transform: none; letter-spacing: 0.02em;
  font-family: var(--font-display); font-style: italic; font-size: 13px;
}
.head .desc::before { content: " · "; color: var(--text-dim); }
.head .ts { margin-left: auto; color: var(--text-dim); font-size: 10px; letter-spacing: 0.08em; }
.head .chev { color: var(--text-muted); transition: transform 0.25s ease; font-size: 10px; }
.subagent.open .head .chev { transform: rotate(90deg); }
.detail { max-height: 0; overflow: hidden; transition: max-height 0.3s ease; }
.subagent.open .detail {
  max-height: 280px; padding-top: 10px; margin-top: 8px;
  border-top: 1px solid var(--accent-dim);
}
.step {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-secondary); padding: 3px 0;
  display: flex; gap: 10px;
}
.step .tag {
  padding: 1px 6px; border-radius: 3px;
  background: var(--accent-dim);
  color: var(--accent-hover); font-size: 9px; letter-spacing: 0.1em;
  text-transform: uppercase;
}
.subagent.done { background: var(--status-success-soft); border-color: var(--status-success-soft); }
.subagent.done .head { color: var(--status-success); }
.subagent.done .head .spin {
  border: 1.5px solid var(--status-success); border-top-color: transparent; animation: none;
}
.subagent.err { background: var(--status-warning-soft); border-color: var(--status-warning-soft); }
.subagent.err .head { color: var(--status-error); }
.status-label,
.progress-track { display: none; }
</style>
