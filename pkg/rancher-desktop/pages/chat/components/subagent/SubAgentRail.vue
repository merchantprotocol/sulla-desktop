<template>
  <aside
    v-if="agents.length"
    class="subagent-rail"
    aria-label="Sub-agents working in this chat"
    aria-live="polite"
  >
    <header class="rail-header">
      <div class="rail-title">
        <span class="rail-mark" aria-hidden="true">✳</span>
        <span>Working agents</span>
      </div>
      <span class="rail-count">{{ runningCount }} active</span>
    </header>

    <div class="agent-list">
      <article
        v-for="agent in visibleAgents"
        :key="agent.id"
        :class="['agent-card', agent.status]"
      >
        <div class="agent-heading">
          <span class="status-dot" aria-hidden="true" />
          <strong>{{ agent.name }}</strong>
          <span class="agent-status">{{ statusLabel(agent.status) }}</span>
        </div>
        <p class="agent-description">{{ agent.desc }}</p>
        <div v-if="agent.steps.length" class="agent-step">
          <span class="step-tag">{{ latestStep(agent).tag }}</span>
          <span>{{ latestStep(agent).text }}</span>
        </div>
      </article>

      <p v-if="agents.length > visibleAgents.length" class="more-agents">
        +{{ agents.length - visibleAgents.length }} earlier agent updates
      </p>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { SubAgentMessage } from '../../models/Message';

const props = defineProps<{ agents: readonly SubAgentMessage[] }>();

const visibleAgents = computed(() => [...props.agents]
  .sort((a, b) => Number(a.status !== 'running') - Number(b.status !== 'running') || b.createdAt - a.createdAt)
  .slice(0, 8));
const runningCount = computed(() => props.agents.filter(agent => agent.status === 'running').length);

function statusLabel(status: SubAgentMessage['status']): string {
  return status === 'done' ? 'Done' : status === 'error' ? 'Needs attention' : 'Working';
}

function latestStep(agent: SubAgentMessage): SubAgentMessage['steps'][number] {
  return agent.steps[agent.steps.length - 1] ?? { tag: 'working', text: 'Working…' };
}
</script>

<style scoped>
.subagent-rail {
  overflow: hidden;
  padding: 22px 14px;
  background: rgba(8, 13, 24, 0.94);
  border-right: 1px solid rgba(106, 176, 204, 0.14);
  backdrop-filter: blur(18px);
}
.rail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 5px 14px;
  border-bottom: 1px solid rgba(106, 176, 204, 0.13);
}
.rail-title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--read-2);
  font-family: var(--serif);
  font-size: 14px;
}
.rail-mark { color: var(--steel-400); font-size: 16px; }
.rail-count {
  color: var(--read-4);
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.agent-list { display: grid; gap: 9px; padding-top: 12px; }
.agent-card {
  min-width: 0;
  padding: 11px 11px 10px;
  border: 1px solid rgba(106, 176, 204, 0.18);
  border-radius: 10px;
  background: rgba(80, 150, 179, 0.055);
}
.agent-card.done { border-color: rgba(120, 200, 150, 0.2); }
.agent-card.error { border-color: rgba(220, 140, 120, 0.25); }
.agent-heading { display: flex; align-items: center; gap: 7px; min-width: 0; }
.agent-heading strong {
  overflow: hidden;
  color: var(--read-2);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.status-dot {
  width: 7px; height: 7px; flex: 0 0 auto;
  border-radius: 50%;
  background: var(--steel-400);
  box-shadow: 0 0 9px rgba(106, 176, 204, 0.48);
}
.agent-card.running .status-dot { animation: agent-pulse 1.6s ease-in-out infinite; }
.agent-card.done .status-dot { background: var(--ok); box-shadow: none; }
.agent-card.error .status-dot { background: var(--err); box-shadow: none; }
.agent-status {
  margin-left: auto;
  color: var(--read-4);
  font-family: var(--mono);
  font-size: 9px;
  white-space: nowrap;
}
.agent-description {
  display: -webkit-box;
  overflow: hidden;
  margin: 8px 0 0;
  color: var(--read-3);
  font-family: var(--serif);
  font-size: 12px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.agent-step {
  display: flex;
  gap: 7px;
  overflow: hidden;
  margin-top: 9px;
  color: var(--read-4);
  font-family: var(--mono);
  font-size: 9px;
  line-height: 1.4;
}
.step-tag {
  flex: 0 0 auto;
  color: var(--steel-300);
  text-transform: uppercase;
}
.more-agents {
  margin: 2px 4px;
  color: var(--read-4);
  font-family: var(--mono);
  font-size: 9px;
}
@keyframes agent-pulse {
  50% { opacity: 0.4; box-shadow: 0 0 3px rgba(106, 176, 204, 0.2); }
}
@media (max-width: 900px) {
  .subagent-rail { display: none; }
}
</style>
