<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <aside
    v-if="visible && !collapsed"
    class="sd-artifact-panel"
    :class="{ expanded }"
  >
    <ArtifactTabs
      :show-agent="!!agent"
      :agent-active="view === 'agent'"
      @artifact-select="view = 'artifact'"
      @agent-select="view = 'agent'"
      @collapse="emit('toggle-collapse')"
    />
    <template v-if="view === 'artifact' && active">
      <ArtifactHeader
        :artifact="active"
        @expand="onExpand"
      />
      <ArtifactBody :artifact="active" />
    </template>
    <section v-else-if="agent" class="sd-agent-detail">
      <header>
        <span class="sd-avatar">{{ agentName(agent.agentId).charAt(0) }}</span>
        <div>
          <h3>{{ agent.label }}</h3>
          <small>{{ agent.agentId }} · {{ agent.kind === 'job' ? 'hidden' : 'own tab' }}</small>
        </div>
      </header>
      <div class="sd-facts">
        <div>
          <b><i class="sd-dot" :class="`is-${agent.status}`" />{{ statusLabel }}</b>
          <small>status</small>
        </div>
        <div>
          <b>{{ elapsed }}</b>
          <small>elapsed</small>
        </div>
      </div>
      <h4>{{ agent.status === 'running' ? 'Doing now' : 'Last activity' }}</h4>
      <p>{{ agent.lastActivity }}</p>
      <h4>Job id</h4>
      <pre>{{ agent.jobId }}</pre>
      <div class="sd-actions">
        <button
          v-if="agent.conversationId || agent.agentTab"
          class="primary"
          @click="emit('open-agent', agent)"
        >Open chat</button>
        <button
          v-if="agent.status === 'running'"
          class="danger"
          :disabled="stopping"
          @click="stopAgent"
        >{{ stopping ? 'Stopping…' : 'Stop' }}</button>
        <button v-else @click="emit('dismiss-agent', agent)">Dismiss</button>
      </div>
    </section>
  </aside>
  <button
    v-else-if="visible"
    type="button"
    class="sd-artifact-tab"
    :class="{ working }"
    title="Show side panel"
    aria-label="Show side panel"
    @click="emit('toggle-collapse')"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M14.5 4.5v15" />
    </svg>
    <b>{{ agent && !active ? 'Agent' : `Artifacts · ${count}` }}</b>
  </button>
</template>
    <section v-else-if="agent" class="sd-agent-detail">
      <header><span class="sd-avatar">{{ agentName(agent.agentId).charAt(0) }}</span><div><h3>{{ agent.label }}</h3><small>{{ agent.agentId }} · {{ agent.kind === 'job' ? 'hidden' : 'own tab' }}</small></div></header>
      <div class="sd-facts"><div><b><i class="sd-dot" :class="`is-${agent.status}`"/>{{ statusLabel }}</b><small>status</small></div><div><b>{{ elapsed }}</b><small>elapsed</small></div></div>
      <h4>{{ agent.status === 'running' ? 'Doing now' : 'Last activity' }}</h4><p>{{ agent.lastActivity }}</p>
      <h4>Job id</h4><pre>{{ agent.jobId }}</pre>
      <div class="sd-actions"><button v-if="agent.conversationId || agent.agentTab" class="primary" @click="emit('open-agent', agent)">Open chat</button><button v-if="agent.status === 'running'" class="danger" :disabled="stopping" @click="stopAgent">{{ stopping ? 'Stopping…' : 'Stop' }}</button><button v-else @click="emit('dismiss-agent', agent)">Dismiss</button></div>
    </section>
  </aside>
  <button v-else-if="visible" type="button" class="sd-artifact-tab" :class="{ working }" title="Show side panel" aria-label="Show side panel" @click="emit('toggle-collapse')"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M14.5 4.5v15"/></svg><b>{{ agent && !active ? 'Agent' : `Artifacts · ${count}` }}</b></button>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ThreadAgentCard } from '@pkg/main/agentsIpc';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import ArtifactTabs from './ArtifactTabs.vue';
import ArtifactHeader from './ArtifactHeader.vue';
import ArtifactBody from './ArtifactBody.vue';
import { useChatController } from '../../controller/useChatController';

const props = defineProps<{ collapsed?: boolean; agent?: ThreadAgentCard | null }>();
const emit = defineEmits<{
  'toggle-collapse': [];
  'open-agent': [card: ThreadAgentCard];
  'dismiss-agent': [card: ThreadAgentCard];
}>();
const controller = useChatController();
const count = computed(() => controller.artifacts.value.list.length);
const active = computed(() => controller.activeArtifact.value);
const visible = computed(() => count.value > 0 || !!props.agent);
const working = computed(() => controller.artifacts.value.list.some(a => a.status === 'working' || a.status === 'editing'));
const expanded = ref(false);
const view = ref<'artifact' | 'agent'>(props.agent ? 'agent' : 'artifact');
const now = ref(Date.now());
const stopping = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

const statusLabel = computed(() => ({ running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped' })[props.agent?.status || 'done']);
const elapsed = computed(() => {
  if (!props.agent) return '';
  const seconds = Math.max(0, Math.floor(((props.agent.finishedAt ?? now.value) - props.agent.createdAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
});
const selectedAgentKey = computed(() => props.agent ? `${props.agent.kind}:${props.agent.jobId}:${props.agent.taskIndex}` : '');

function agentName(id: string): string {
  return id.split('-').map(part => ({ codex: 'Codex', sol: 'Sol', luna: 'Luna' })[part] || part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function onExpand(): void {
  expanded.value = !expanded.value;
  window.dispatchEvent(new CustomEvent('chat:artifact-expand', { detail: { expanded: expanded.value } }));
}

async function stopAgent(): Promise<void> {
  if (!props.agent || stopping.value) return;
  stopping.value = true;
  try {
    await ipcRenderer.invoke('agents:stop-job' as any, props.agent.jobId);
  } finally {
    stopping.value = false;
  }
}

watch(selectedAgentKey, (key, previousKey) => {
  if (key && key !== previousKey) view.value = 'agent';
});
watch(visible, value => {
  if (!value) expanded.value = false;
});
onMounted(() => timer = setInterval(() => now.value = Date.now(), 1000));
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>
<style scoped>
.sd-artifact-panel {
  overflow: hidden;
  width: 420px;
  height: calc(100% - 16px);
  margin: 8px;
  background: color-mix(in srgb,var(--bg-surface) 82%,transparent);
  backdrop-filter: blur(12px);
  border-radius: 14px;
  box-shadow: 0 1px 2px color-mix(in srgb,var(--text-primary) 8%,transparent),inset 0 0 0 1px var(--border-default);
  display: flex;
  flex-direction: column;
  transition: width .3s ease;
  color: var(--text-primary);
}
.sd-artifact-panel.expanded {
  width: 70vw !important;
}
.sd-agent-detail {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}
.sd-agent-detail>header {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
}
.sd-avatar {
  width: 36px;
  height: 36px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg,var(--accent-primary),var(--text-primary));
  color: var(--bg-surface);
  font-weight: 700;
}
.sd-agent-detail h3 {
  margin: 0;
  font: italic 500 18px/1.2 var(--serif);
  letter-spacing: -.01em;
}
.sd-agent-detail header small {
  display: block;
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 12.5px;
}
.sd-facts {
  display: grid;
  grid-template-columns: repeat(2,1fr);
  gap: 1px;
  overflow: hidden;
  margin-bottom: 20px;
  border-radius: 12px;
  background: var(--border-default);
  box-shadow: inset 0 0 0 1px var(--border-default);
}
.sd-facts div {
  padding: 10px 12px;
  background: var(--bg-surface);
}
.sd-facts b {
  display: block;
  font: 500 15px/1.2 var(--serif);
}
.sd-facts small {
  color: var(--text-muted);
  font-size: 12px;
}
.sd-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  vertical-align: 2px;
}
.sd-dot.is-running {
  background: var(--accent-primary);
}
.sd-dot.is-done {
  background: var(--text-success);
}
.sd-dot.is-failed {
  background: var(--text-error);
}
.sd-dot.is-stopped {
  background: var(--text-warning);
}
.sd-agent-detail h4 {
  margin: 18px 0 8px;
  color: var(--text-muted);
  font: 11px var(--mono);
  letter-spacing: .06em;
  text-transform: uppercase;
}
.sd-agent-detail p {
  margin: 0;
  font-size: 13.5px;
}
.sd-agent-detail pre {
  margin: 0;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--bg-surface-alt);
  color: var(--text-secondary);
  font: 12px/1.55 var(--mono);
  white-space: pre-wrap;
  word-break: break-word;
}
.sd-actions {
  display: flex;
  gap: 8px;
  margin-top: 20px;
}
.sd-actions button {
  height: 36px;
  padding: 0 14px;
  border: 1px solid var(--border-default);
  border-radius: 10px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-weight: 500;
  cursor: pointer;
}
.sd-actions .primary {
  border: 0;
  background: var(--accent-primary);
  color: var(--bg-surface);
}
.sd-actions .danger {
  color: var(--text-error);
}
.sd-artifact-tab {
  position: absolute;
  top: 50%;
  right: 0;
  z-index: 6;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 5px;
  border: 1px solid var(--border-default);
  border-right: 0;
  border-radius: 9px 0 0 9px;
  background: var(--bg-surface);
  color: var(--text-muted);
  cursor: pointer;
}
.sd-artifact-tab svg {
  width: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
}
.sd-artifact-tab b {
  writing-mode: vertical-rl;
  font: 600 10px var(--mono);
  letter-spacing: .12em;
  text-transform: uppercase;
}
</style>
