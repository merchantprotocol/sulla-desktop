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

    <!-- Thinking bubble — appears when agent node is running and has thinking messages -->
    <div
      v-if="hasThinkingMessages"
      class="thinking-bubble"
      :class="{ dark: isDark, expanded: thinkingExpanded }"
      @click.stop="thinkingExpanded = !thinkingExpanded"
    >
      <!-- Collapsed: small bubble with animated dots -->
      <div v-if="!thinkingExpanded" class="thinking-bubble-collapsed">
        <span class="thinking-dots">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </span>
      </div>

      <!-- Expanded: scrollable conversation panel -->
      <div v-else class="thinking-bubble-expanded" @click.stop>
        <div class="thinking-bubble-header">
          <span class="thinking-bubble-title">Agent Thinking</span>
          <button class="thinking-bubble-close" @click.stop="thinkingExpanded = false">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="thinking-bubble-messages" ref="messagesContainer">
          <div
            v-for="(msg, idx) in thinkingMessages"
            :key="idx"
            class="thinking-msg"
            :class="msg.role"
          >
            <div class="thinking-msg-content">{{ msg.content }}</div>
          </div>
        </div>
      </div>
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
import { computed, ref, watch, nextTick } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import { getNodeDefinition } from './nodeRegistry';
import type { WorkflowNodeData, NodeThinkingMessage } from './types';

const props = defineProps<{
  id: string;
  data: WorkflowNodeData;
  selected: boolean;
  isDark: boolean;
}>();

const sullaIconUrl = new URL('../../../../../resources/icons/sulla-node-icon.png', import.meta.url).href;

const thinkingExpanded = ref(false);
const messagesContainer = ref<HTMLElement | null>(null);

const iconSvg = computed(() => {
  const def = getNodeDefinition(props.data.subtype);
  return def?.iconSvg ?? '';
});

const thinkingMessages = computed<NodeThinkingMessage[]>(() => {
  return props.data.execution?.thinkingMessages ?? [];
});

const hasThinkingMessages = computed(() => {
  return thinkingMessages.value.length > 0;
});

// Auto-scroll to bottom when new messages arrive while expanded
watch(() => thinkingMessages.value.length, () => {
  if (thinkingExpanded.value && messagesContainer.value) {
    nextTick(() => {
      messagesContainer.value!.scrollTop = messagesContainer.value!.scrollHeight;
    });
  }
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
  position: relative;
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

/* ── Thinking bubble ── */

.thinking-bubble {
  position: absolute;
  top: -4px;
  left: calc(100% + 6px);
  z-index: 10;
  cursor: pointer;
  animation: bubble-appear 0.2s ease-out;
}

.thinking-bubble-collapsed {
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  border-radius: 12px 12px 12px 4px;
  padding: 4px 8px;
  display: flex;
  align-items: center;
  gap: 2px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  transition: transform 0.15s, box-shadow 0.15s;
}

.thinking-bubble-collapsed:hover {
  transform: scale(1.08);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}

.thinking-bubble.dark .thinking-bubble-collapsed {
  background: #2d2d44;
  border-color: #4a4a6a;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
}

.thinking-dots {
  display: flex;
  gap: 3px;
  align-items: center;
}

.thinking-dots .dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #6366f1;
  animation: dot-bounce 1.4s ease-in-out infinite;
}

.thinking-dots .dot:nth-child(2) {
  animation-delay: 0.2s;
}

.thinking-dots .dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes dot-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30%           { transform: translateY(-3px); opacity: 1; }
}

@keyframes bubble-appear {
  from { opacity: 0; transform: scale(0.8) translateX(-4px); }
  to   { opacity: 1; transform: scale(1) translateX(0); }
}

/* ── Expanded thinking panel ── */

.thinking-bubble-expanded {
  width: 280px;
  max-height: 320px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  cursor: default;
}

.thinking-bubble.dark .thinking-bubble-expanded {
  background: #1e1e32;
  border-color: #4a4a6a;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.thinking-bubble-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}

.thinking-bubble.dark .thinking-bubble-header {
  border-bottom-color: #3a3a5a;
}

.thinking-bubble-title {
  font-size: 11px;
  font-weight: 600;
  color: #6366f1;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.thinking-bubble-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: #94a3b8;
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
}

.thinking-bubble-close:hover {
  background: #f1f5f9;
  color: #475569;
}

.thinking-bubble.dark .thinking-bubble-close:hover {
  background: #2d2d44;
  color: #e2e8f0;
}

.thinking-bubble-messages {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.thinking-msg {
  display: flex;
}

.thinking-msg.assistant {
  justify-content: flex-start;
}

.thinking-msg.system {
  justify-content: center;
}

.thinking-msg-content {
  font-size: 12px;
  line-height: 1.4;
  padding: 5px 8px;
  border-radius: 8px;
  max-width: 240px;
  word-wrap: break-word;
  white-space: pre-wrap;
}

.thinking-msg.assistant .thinking-msg-content {
  background: #f1f5f9;
  color: #334155;
}

.thinking-bubble.dark .thinking-msg.assistant .thinking-msg-content {
  background: #2d2d44;
  color: #e2e8f0;
}

.thinking-msg.system .thinking-msg-content {
  background: transparent;
  color: #94a3b8;
  font-style: italic;
  font-size: 11px;
}

/* Scrollbar styling */
.thinking-bubble-messages::-webkit-scrollbar {
  width: 4px;
}

.thinking-bubble-messages::-webkit-scrollbar-track {
  background: transparent;
}

.thinking-bubble-messages::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 2px;
}

.thinking-bubble.dark .thinking-bubble-messages::-webkit-scrollbar-thumb {
  background: #4a4a6a;
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
