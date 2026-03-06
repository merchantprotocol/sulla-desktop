<template>
  <div
    class="workflow-custom-node"
    :class="{ dark: isDark, selected: selected }"
  >
    <!-- Target handle (top) — hidden for trigger nodes -->
    <Handle
      v-if="data.category !== 'trigger'"
      type="target"
      :position="Position.Top"
      class="node-handle"
    />

    <!-- Icon box -->
    <div class="node-icon-box">
      <img
        v-if="data.subtype === 'agent'"
        :src="sullaIconUrl"
        class="node-icon-img"
        alt="Agent"
      />
      <span v-else class="node-icon-svg" v-html="iconSvg"></span>
    </div>

    <!-- Label -->
    <div class="node-label">{{ data.label }}</div>

    <!-- Source handle (bottom) — hidden when node has route handles -->
    <Handle
      v-if="routeHandles.length === 0"
      type="source"
      :position="Position.Bottom"
      class="node-handle"
    />

    <!-- Route output handles (bottom) — one per configured route -->
    <div v-if="routeHandles.length > 0" class="route-handles-bar">
      <div
        v-for="route in routeHandles"
        :key="route.id"
        class="route-handle-col"
      >
        <Handle
          type="source"
          :id="route.id"
          :position="Position.Bottom"
          class="node-handle route-handle-dot"
        />
        <span class="route-handle-label" :class="{ dark: isDark }">{{ route.label }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import { getNodeDefinition } from './nodeRegistry';
import type { WorkflowNodeData } from './types';

const props = defineProps<{
  id: string;
  data: WorkflowNodeData;
  selected: boolean;
  isDark: boolean;
}>();

const sullaIconUrl = new URL('../../../../../resources/icons/sulla-node-icon.png', import.meta.url).href;

const iconSvg = computed(() => {
  const def = getNodeDefinition(props.data.subtype);
  return def?.iconSvg ?? '';
});

const routeHandles = computed(() => {
  const def = getNodeDefinition(props.data.subtype);
  if (!def?.hasMultipleOutputs) return [];

  // Condition nodes always have True/False outputs
  if (props.data.subtype === 'condition') {
    return [
      { id: 'condition-true',  label: 'True' },
      { id: 'condition-false', label: 'False' },
    ];
  }

  // Router nodes: one handle per configured route
  const routes = props.data.config?.routes;
  if (!Array.isArray(routes) || routes.length === 0) return [];
  return routes.map((r: any, idx: number) => ({
    id:    `route-${idx}`,
    label: r.label || `Route ${idx + 1}`,
  }));
});

</script>

<style scoped>
.workflow-custom-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px;
  min-width: 60px;
}

.node-icon-box {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.workflow-custom-node.dark .node-icon-box {
  background: #2d2d44;
  border-color: #4a4a6a;
}

.workflow-custom-node.selected .node-icon-box {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.3);
}

.node-icon-img {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  object-fit: contain;
}

.node-icon-svg {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #64748b;
}

.workflow-custom-node.dark .node-icon-svg {
  color: #94a3b8;
}

.workflow-custom-node.selected .node-icon-svg {
  color: #6366f1;
}

.workflow-custom-node.dark.selected .node-icon-svg {
  color: #818cf8;
}

.node-label {
  font-size: 11px;
  color: #475569;
  text-align: center;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.2;
}

.workflow-custom-node.dark .node-label {
  color: #94a3b8;
}

.node-handle {
  width: 8px;
  height: 8px;
  background: #6366f1;
  border: 2px solid #fff;
  border-radius: 50%;
}

.workflow-custom-node.dark .node-handle {
  border-color: #1a1a2e;
}

.route-handles-bar {
  display: flex;
  justify-content: center;
  gap: 16px;
  margin-top: 2px;
}

.route-handle-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  position: relative;
}

.route-handle-dot {
  position: relative;
}

.route-handle-label {
  font-size: 8px;
  font-weight: 500;
  color: #475569;
  white-space: nowrap;
  line-height: 1;
  text-align: center;
  max-width: 48px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.route-handle-label.dark {
  color: #94a3b8;
}
</style>
