<!-- Sub-agent activity card. Expands to show its step list. -->
<template>
  <div :class="['subagent', statusClass, { open }]" @click="open = !open">
    <div class="head">
      <span class="spin" />
      <span class="name">{{ msg.name }}</span>
      <span class="desc">{{ msg.desc }}</span>
      <span class="ts">{{ timeLabel }}</span>
      <span class="chev">▸</span>
    </div>
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

const timeLabel = computed(() => {
  const d = new Date(props.msg.createdAt);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
});
</script>

<style scoped>
.subagent {
  padding: 12px 16px; margin: 4px 0;
  border-radius: 10px;
  background: rgba(80, 150, 179, 0.05);
  border: 1px solid rgba(80, 150, 179, 0.2);
  cursor: pointer;
}
.head {
  display: flex; align-items: center; gap: 12px;
  font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.2em;
  text-transform: uppercase; color: var(--steel-400);
}
.head .spin {
  width: 12px; height: 12px; border-radius: 50%;
  border: 1.5px solid rgba(106, 176, 204, 0.25);
  border-top-color: var(--steel-400);
  animation: chat-spin 1s linear infinite;
}
.head .name { font-weight: 700; color: var(--steel-200); }
.head .desc {
  color: var(--read-3); text-transform: none; letter-spacing: 0.02em;
  font-family: var(--serif); font-style: italic; font-size: 13px;
}
.head .desc::before { content: " · "; color: var(--read-5); }
.head .ts { margin-left: auto; color: var(--read-5); font-size: 10px; letter-spacing: 0.08em; }
.head .chev { color: var(--read-4); transition: transform 0.25s ease; font-size: 10px; }
.subagent.open .head .chev { transform: rotate(90deg); }
.detail { max-height: 0; overflow: hidden; transition: max-height 0.3s ease; }
.subagent.open .detail {
  max-height: 280px; padding-top: 10px; margin-top: 8px;
  border-top: 1px solid rgba(80, 150, 179, 0.15);
}
.step {
  font-family: var(--mono); font-size: 11px;
  color: var(--read-3); padding: 3px 0;
  display: flex; gap: 10px;
}
.step .tag {
  padding: 1px 6px; border-radius: 3px;
  background: rgba(168, 192, 220, 0.1);
  color: var(--steel-300); font-size: 9px; letter-spacing: 0.1em;
  text-transform: uppercase;
}
.subagent.done { background: rgba(134, 239, 172, 0.04); border-color: rgba(134, 239, 172, 0.2); }
.subagent.done .head { color: var(--ok); }
.subagent.done .head .spin {
  border: 1.5px solid var(--ok); border-top-color: transparent; animation: none;
}
.subagent.err { background: rgba(252,165,165,0.04); border-color: rgba(252,165,165,0.22); }
.subagent.err .head { color: var(--err); }
</style>
