<template>
  <div class="node-panel" :class="{ dark: isDark }">
    <div class="node-panel-header" :class="{ dark: isDark }">
      <span class="node-panel-title">{{ panelTitle }}</span>
      <button class="node-panel-close" :class="{ dark: isDark }" title="Close" @click="$emit('close')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <div class="node-panel-body">
      <!-- Label field (all node types) -->
      <div class="node-field">
        <label class="node-field-label" :class="{ dark: isDark }">Label</label>
        <input
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="node.label"
          @input="$emit('update-label', node.id, ($event.target as HTMLInputElement).value)"
        />
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
import ToolCallNodeConfig from './workflow/ToolCallNodeConfig.vue';
import RouterNodeConfig from './workflow/RouterNodeConfig.vue';
import ConditionNodeConfig from './workflow/ConditionNodeConfig.vue';
import FlowControlNodeConfig from './workflow/FlowControlNodeConfig.vue';
import IONodeConfig from './workflow/IONodeConfig.vue';

const props = defineProps<{
  isDark: boolean;
  node: {
    id: string;
    label: string;
    type?: string;
    data?: WorkflowNodeData;
  };
  upstreamNodes?: UpstreamNodeInfo[];
}>();

defineEmits<{
  'close': [];
  'update-label': [nodeId: string, label: string];
  'update-trigger': [nodeId: string, triggerType: string];
  'update-node-config': [nodeId: string, config: Record<string, any>];
}>();

const panelTitle = computed(() => {
  if (props.node.data?.category) {
    const cat = props.node.data.category;
    if (cat === 'trigger') return 'Trigger';
    if (cat === 'agent') return props.node.data?.subtype === 'tool-call' ? 'Tool Call' : 'Agent';
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
  background: #f8fafc;
  color: #333;
  font-size: 13px;
  user-select: none;
  overflow: hidden;
}

.node-panel.dark {
  background: var(--bg-surface, #1e293b);
  color: #ccc;
}

.node-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 12px;
  height: 35px;
  flex-shrink: 0;
  background: #f8fafc;
  border-bottom: 1px solid #cbd5e1;
}

.node-panel-header.dark {
  background: var(--bg-surface, #1e293b);
  border-bottom-color: #3c3c3c;
}

.node-panel-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
}

.node-panel-header.dark .node-panel-title {
  color: #94a3b8;
}

.node-panel-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: #94a3b8;
  border-radius: 4px;
  cursor: pointer;
}

.node-panel-close:hover {
  background: rgba(0,0,0,0.06);
  color: #475569;
}

.node-panel-close.dark {
  color: #64748b;
}

.node-panel-close.dark:hover {
  background: rgba(255,255,255,0.08);
  color: #94a3b8;
}

.node-panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.node-field {
  padding: 12px;
  border-bottom: 1px solid #e2e8f0;
}

.node-panel.dark .node-field {
  border-bottom-color: #3c3c5c;
}

.node-field-label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
  margin-bottom: 6px;
}

.node-field-label.dark {
  color: #94a3b8;
}

.node-field-input {
  width: 100%;
  padding: 6px 8px;
  font-size: 13px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  background: #fff;
  color: #1e293b;
  outline: none;
  box-sizing: border-box;
}

.node-field-input:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

.node-field-input.dark {
  background: #2d2d44;
  border-color: #3c3c5c;
  color: #e2e8f0;
}

.node-field-input.dark:focus {
  border-color: #6366f1;
}
</style>
