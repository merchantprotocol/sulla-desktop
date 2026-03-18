<template>
  <div
    class="node-panel"
    :class="{ dark: isDark }"
  >
    <div
      class="node-panel-header"
      :class="{ dark: isDark }"
    >
      <span class="node-panel-title">{{ panelTitle }}</span>
      <button
        class="node-panel-close"
        :class="{ dark: isDark }"
        title="Close"
        @click="$emit('close')"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line
            x1="18"
            y1="6"
            x2="6"
            y2="18"
          />
          <line
            x1="6"
            y1="6"
            x2="18"
            y2="18"
          />
        </svg>
      </button>
    </div>

    <div class="node-panel-body">
      <!-- Label field (all node types) -->
      <div class="node-field">
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Label</label>
        <input
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="node.label"
          @input="$emit('update-label', node.id, ($event.target as HTMLInputElement).value)"
        >
      </div>

      <!-- Type-specific config panels -->
      <TriggerNodeConfig
        v-if="node.data?.category === 'trigger'"
        :is-dark="isDark"
        :node-id="node.id"
        :config="node.data.config"
        @update-config="(nodeId, config) => $emit('update-node-config', nodeId, config)"
      />

      <ToolCallNodeConfig
        v-else-if="node.data?.subtype === 'tool-call'"
        :is-dark="isDark"
        :node-id="node.id"
        :config="node.data.config"
        :upstream-nodes="upstreamNodes || []"
        @update-config="(nodeId, config) => $emit('update-node-config', nodeId, config)"
      />

      <IntegrationCallNodeConfig
        v-else-if="node.data?.subtype === 'integration-call'"
        :is-dark="isDark"
        :node-id="node.id"
        :config="node.data.config"
        :upstream-nodes="upstreamNodes || []"
        @update-config="(nodeId, config) => $emit('update-node-config', nodeId, config)"
      />

      <OrchestratorPromptNodeConfig
        v-else-if="node.data?.subtype === 'orchestrator-prompt'"
        :is-dark="isDark"
        :node-id="node.id"
        :config="node.data.config"
        :upstream-nodes="upstreamNodes || []"
        @update-config="(nodeId, config) => $emit('update-node-config', nodeId, config)"
      />

      <AgentNodeConfig
        v-else-if="node.data?.category === 'agent'"
        :is-dark="isDark"
        :node-id="node.id"
        :config="node.data.config"
        :upstream-nodes="upstreamNodes || []"
        @update-config="(nodeId, config) => $emit('update-node-config', nodeId, config)"
      />

      <RouterNodeConfig
        v-else-if="node.data?.subtype === 'router'"
        :is-dark="isDark"
        :node-id="node.id"
        :config="node.data.config"
        @update-config="(nodeId, config) => $emit('update-node-config', nodeId, config)"
      />

      <ConditionNodeConfig
        v-else-if="node.data?.subtype === 'condition'"
        :is-dark="isDark"
        :node-id="node.id"
        :config="node.data.config"
        @update-config="(nodeId, config) => $emit('update-node-config', nodeId, config)"
      />

      <FlowControlNodeConfig
        v-else-if="node.data?.category === 'flow-control'"
        :is-dark="isDark"
        :node-id="node.id"
        :subtype="node.data.subtype"
        :config="node.data.config"
        :upstream-nodes="upstreamNodes || []"
        @update-config="(nodeId, config) => $emit('update-node-config', nodeId, config)"
      />

      <IONodeConfig
        v-else-if="node.data?.category === 'io'"
        :is-dark="isDark"
        :node-id="node.id"
        :subtype="node.data.subtype"
        :config="node.data.config"
        :upstream-nodes="upstreamNodes || []"
        @update-config="(nodeId, config) => $emit('update-node-config', nodeId, config)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { WorkflowNodeData } from './workflow/types';
import type { UpstreamNodeInfo } from './workflow/AgentNodeConfig.vue';
import TriggerNodeConfig from './workflow/TriggerNodeConfig.vue';
import AgentNodeConfig from './workflow/AgentNodeConfig.vue';
import OrchestratorPromptNodeConfig from './workflow/OrchestratorPromptNodeConfig.vue';
import ToolCallNodeConfig from './workflow/ToolCallNodeConfig.vue';
import IntegrationCallNodeConfig from './workflow/IntegrationCallNodeConfig.vue';
import RouterNodeConfig from './workflow/RouterNodeConfig.vue';
import ConditionNodeConfig from './workflow/ConditionNodeConfig.vue';
import FlowControlNodeConfig from './workflow/FlowControlNodeConfig.vue';
import IONodeConfig from './workflow/IONodeConfig.vue';

const props = defineProps<{
  isDark: boolean;
  node: {
    id:    string;
    label: string;
    type?: string;
    data?: WorkflowNodeData;
  };
  upstreamNodes?: UpstreamNodeInfo[];
}>();

defineEmits<{
  close:                [];
  'update-label':       [nodeId: string, label: string];
  'update-trigger':     [nodeId: string, triggerType: string];
  'update-node-config': [nodeId: string, config: Record<string, any>];
}>();

const panelTitle = computed(() => {
  if (props.node.data?.category) {
    const cat = props.node.data.category;
    if (cat === 'trigger') return 'Trigger';
    if (cat === 'agent') {
      if (props.node.data?.subtype === 'tool-call') return 'Tool Call';
      if (props.node.data?.subtype === 'integration-call') return 'Integration Call';
      if (props.node.data?.subtype === 'orchestrator-prompt') return 'Prompt';
      return 'Agent';
    }
    if (cat === 'routing') return 'Routing';
    if (cat === 'flow-control') return 'Flow Control';
    if (cat === 'io') return 'I/O';
  }
  if (props.node.type === 'input') return 'Trigger';
  if (props.node.type === 'output') return 'Output';
  return 'Node';
});
</script>

<style scoped>
.node-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: var(--fs-code);
  user-select: none;
  overflow: hidden;
}

.node-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 12px;
  height: 35px;
  flex-shrink: 0;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-default);
}

.node-panel-title {
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wider);
  color: var(--text-secondary);
}

.node-panel-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: 4px;
  cursor: pointer;
}

.node-panel-close:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.node-panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.node-field {
  padding: 12px;
  border-bottom: 1px solid var(--bg-surface-hover);
}

.node-field-label {
  display: block;
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wider);
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.node-field-input {
  width: 100%;
  padding: 6px 8px;
  font-size: var(--fs-code);
  border: 1px solid var(--bg-surface-hover);
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-primary);
  outline: none;
  box-sizing: border-box;
}

.node-field-input:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}
</style>
