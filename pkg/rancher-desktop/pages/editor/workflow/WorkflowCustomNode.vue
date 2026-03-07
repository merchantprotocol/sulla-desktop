<template>
  <div
    class="workflow-custom-node"
    :class="{
      dark: isDark,
      selected: selected,
      'exec-running':   data.execution?.status === 'running',
      'exec-completed': data.execution?.status === 'completed',
      'exec-failed':    data.execution?.status === 'failed',
      'exec-waiting':   data.execution?.status === 'waiting',
      'exec-skipped':   data.execution?.status === 'skipped',
    }"
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

    <!-- Execution status badge -->
    <div v-if="data.execution" class="node-exec-badge" :class="data.execution.status">
      <svg v-if="data.execution.status === 'running'" class="exec-spinner" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
      <svg v-else-if="data.execution.status === 'completed'" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      <svg v-else-if="data.execution.status === 'failed'" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      <svg v-else-if="data.execution.status === 'waiting'" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
    </div>

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

/* ── Execution status styles ── */

.workflow-custom-node.exec-running .node-icon-box {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.3);
  animation: exec-pulse 1.5s ease-in-out infinite;
}

.workflow-custom-node.exec-completed .node-icon-box {
  border-color: #22c55e;
  box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.25);
}

.workflow-custom-node.exec-failed .node-icon-box {
  border-color: #ef4444;
  box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.25);
}

.workflow-custom-node.exec-waiting .node-icon-box {
  border-color: #f59e0b;
  box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.25);
  animation: exec-pulse 2s ease-in-out infinite;
}

.workflow-custom-node.exec-skipped .node-icon-box {
  opacity: 0.4;
}

.workflow-custom-node.exec-skipped .node-label {
  opacity: 0.4;
}

@keyframes exec-pulse {
  0%, 100% { box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.3); }
  50%      { box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.15); }
}

.workflow-custom-node.exec-waiting .node-icon-box {
  animation-name: exec-pulse-amber;
}

@keyframes exec-pulse-amber {
  0%, 100% { box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.3); }
  50%      { box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.15); }
}

.node-exec-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  margin-top: -2px;
}

.node-exec-badge.running {
  color: #6366f1;
}

.node-exec-badge.completed {
  color: #22c55e;
}

.node-exec-badge.failed {
  color: #ef4444;
}

.node-exec-badge.waiting {
  color: #f59e0b;
}

.exec-spinner {
  animation: exec-spin 1s linear infinite;
}

@keyframes exec-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
</style>
