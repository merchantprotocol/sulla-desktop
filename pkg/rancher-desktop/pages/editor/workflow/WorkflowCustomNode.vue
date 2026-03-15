<template>
  <div
    class="workflow-custom-node"
    :class="{
      selected,
      'exec-running': data.execution?.status === 'running',
      'exec-completed': data.execution?.status === 'completed',
      'exec-failed': data.execution?.status === 'failed',
      'exec-waiting': data.execution?.status === 'waiting',
      'exec-skipped': data.execution?.status === 'skipped',
    }"
  >
    <!-- Loop node: 4 custom handles with labels -->
    <template v-if="data.subtype === 'loop'">
      <!-- In (top): label above the dot -->
      <div class="loop-handle-top">
        <span
          class="loop-handle-label loop-label-in"
          :class="{ dark: isDark }"
        >In</span>
        <Handle
          id="loop-entry"
          type="target"
          :position="Position.Top"
          class="node-handle"
        />
      </div>

      <!-- Start (bottom): dot then label below, like condition True/False -->
      <div class="loop-handles-bottom">
        <div class="route-handle-col">
          <Handle
            id="loop-start"
            type="source"
            :position="Position.Bottom"
            class="node-handle route-handle-dot"
          />
          <span
            class="route-handle-label"
            :class="{ dark: isDark }"
          >Start</span>
        </div>
      </div>

      <!-- Back (right): dot with label below it, left-aligned -->
      <div class="loop-handle-right">
        <Handle
          id="loop-back"
          type="target"
          :position="Position.Right"
          class="node-handle"
        />
        <span
          class="loop-handle-label loop-label-back"
          :class="{ dark: isDark }"
        >Back</span>
      </div>

      <!-- Exit (left): dot then label below, right-aligned so "t" is at the dot -->
      <div class="loop-handle-left">
        <div class="route-handle-col loop-exit-col">
          <Handle
            id="loop-exit"
            type="source"
            :position="Position.Left"
            class="node-handle route-handle-dot"
          />
          <span
            class="route-handle-label"
            :class="{ dark: isDark }"
          >Exit</span>
        </div>
      </div>
    </template>

    <!-- Target handle (top) — hidden for trigger nodes and loop nodes -->
    <Handle
      v-if="data.category !== 'trigger' && data.subtype !== 'loop'"
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
      >
      <span
        v-else
        class="node-icon-svg"
        v-html="iconSvg"
      />
    </div>

    <!-- Thinking bubble — appears when agent node is running and has thinking messages -->
    <div
      v-if="hasThinkingMessages"
      class="thinking-bubble"
      :class="{ dark: isDark, expanded: thinkingExpanded }"
      @click.stop="thinkingExpanded = !thinkingExpanded"
    >
      <!-- Collapsed: small bubble with animated dots -->
      <div
        v-if="!thinkingExpanded"
        class="thinking-bubble-collapsed nodrag nowheel nopan"
      >
        <span class="thinking-dots">
          <span class="dot" />
          <span class="dot" />
          <span class="dot" />
        </span>
      </div>

      <!-- Expanded: scrollable conversation panel -->
      <div
        v-else
        class="thinking-bubble-expanded nodrag nowheel nopan"
        @click.stop
      >
        <div class="thinking-bubble-header">
          <span class="thinking-bubble-title">Agent Thinking</span>
          <button
            class="thinking-bubble-close"
            @click.stop="thinkingExpanded = false"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
            >
              <line
                x1="18"
                y1="6"
                x2="6"
                y2="18"
              /><line
                x1="6"
                y1="6"
                x2="18"
                y2="18"
              />
            </svg>
          </button>
        </div>
        <div
          ref="messagesContainer"
          class="thinking-bubble-messages"
          @wheel.stop
        >
          <div
            v-for="(msg, idx) in thinkingMessages"
            :key="idx"
            class="thinking-msg"
            :class="msg.role"
          >
            <div class="thinking-msg-content">
              {{ msg.content }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Label -->
    <div class="node-label">
      {{ data.label }}
    </div>

    <!-- Execution status badge -->
    <div
      v-if="data.execution"
      class="node-exec-badge"
      :class="data.execution.status"
    >
      <svg
        v-if="data.execution.status === 'running'"
        class="exec-spinner"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
      ><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
      <svg
        v-else-if="data.execution.status === 'completed'"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
      ><polyline points="20 6 9 17 4 12" /></svg>
      <svg
        v-else-if="data.execution.status === 'failed'"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
      ><line
        x1="18"
        y1="6"
        x2="6"
        y2="18"
      /><line
        x1="6"
        y1="6"
        x2="18"
        y2="18"
      /></svg>
      <svg
        v-else-if="data.execution.status === 'waiting'"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
      ><circle
        cx="12"
        cy="12"
        r="10"
      /><path d="M12 6v6l4 2" /></svg>
    </div>

    <!-- Source handle (bottom) — hidden when node has route handles or custom handles (loop) -->
    <Handle
      v-if="routeHandles.length === 0 && data.subtype !== 'loop'"
      type="source"
      :position="Position.Bottom"
      class="node-handle"
    />

    <!-- Route output handles (bottom) — one per configured route -->
    <div
      v-if="routeHandles.length > 0"
      class="route-handles-bar"
    >
      <div
        v-for="route in routeHandles"
        :key="route.id"
        class="route-handle-col"
      >
        <Handle
          :id="route.id"
          type="source"
          :position="Position.Bottom"
          class="node-handle route-handle-dot"
        />
        <span
          class="route-handle-label"
          :class="{ dark: isDark }"
        >{{ route.label }}</span>
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
  id:       string;
  data:     WorkflowNodeData;
  selected: boolean;
  isDark:   boolean;
}>();

const sullaIconUrl = new URL('../../../../../resources/icons/robot-512-nobg.png', import.meta.url).href;

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
      { id: 'condition-true', label: 'True' },
      { id: 'condition-false', label: 'False' },
    ];
  }

  // Router nodes: one handle per configured route
  const routes = props.data.config?.routes;
  if (!Array.isArray(routes) || routes.length === 0) return [];
  return routes.map((r: any, idx: number) => ({
    id:    `route-${ idx }`,
    label: r.label || `Route ${ idx + 1 }`,
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
  width: 44px;
  height: 44px;
  border-radius: 10px;
  border: 1.5px solid var(--border-strong);
  background: #161b22;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: border-color 0.2s, box-shadow 0.2s;
}

.workflow-custom-node:hover .node-icon-box {
  transform: translateY(-2px);
  border-color: var(--status-success);
  box-shadow:
    0 0 12px rgba(46, 160, 67, 0.4),
    0 4px 20px rgba(46, 160, 67, 0.35),
    0 8px 32px rgba(46, 160, 67, 0.15);
}

.workflow-custom-node.selected .node-icon-box {
  border-color: var(--status-success);
  box-shadow:
    0 0 12px rgba(46, 160, 67, 0.4),
    0 4px 20px rgba(46, 160, 67, 0.35),
    0 8px 32px rgba(46, 160, 67, 0.15);
}

.node-icon-img {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  object-fit: contain;
  filter: grayscale(1) brightness(0.62);
}

.node-icon-svg {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.workflow-custom-node .node-icon-svg {
  color: var(--text-muted);
}

.workflow-custom-node.selected .node-icon-svg {
  color: var(--text-success);
}

.workflow-custom-node.selected .node-icon-svg {
  color: var(--text-success);
}

.node-label {
  font-family: var(--font-mono), 'Courier New', monospace;
  font-size: 9px;
  color: var(--text-secondary);
  text-align: center;
  max-width: 72px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.2;
}

.workflow-custom-node .node-label {
  color: var(--text-muted);
}

.node-handle {
  width: 7px;
  height: 7px;
  background: var(--status-success);
  border: 1.5px solid var(--bg-page);
  border-radius: 50%;
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
  font-size: var(--fs-caption);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
  white-space: nowrap;
  line-height: 1;
  text-align: center;
  max-width: 48px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.route-handle-label.dark {
  color: var(--text-muted);
}

/* ── Loop handle positioning ── */
/* Wrappers pin dots flush against the icon; only labels are offset */

.loop-handle-top {
  position: absolute;
  top: -4px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  z-index: 1;
}

.loop-handles-bottom {
  position: absolute;
  bottom: -9px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  justify-content: center;
  z-index: 1;
}

.loop-handle-right {
  position: absolute;
  right: -14px;
  top: 38%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  z-index: 1;
}

.loop-handle-left {
  position: absolute;
  left: -8px;
  top: 39%;
  transform: translateY(-50%);
  display: flex;
  justify-content: center;
  z-index: 1;
}

/* Exit: adjust dot position */
.loop-handle-left :deep(.vue-flow__handle-left) {
  top: 41%;
  left: 0;
  transform: translate(-50%, -50%);
}

.loop-handle-label {
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  color: var(--text-muted);
  white-space: nowrap;
  line-height: 1;
  pointer-events: none;
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
}

.loop-handle-label.dark {
  color: var(--text-secondary);
}

/* In: label above the dot, raised 1.5x font height */
.loop-label-in {
  margin-top: -11px;
  color: var(--text-secondary);
}

/* Back: adjust dot position */
.loop-handle-right :deep(.vue-flow__handle-right) {
  top: 46%;
  left: -5px;
  transform: translate(50%, -50%);
}

/* Back: label below the dot, B starts at the dot */
.loop-label-back {
  margin-top: 12px;
  margin-left: 0px;
  color: var(--text-secondary);
  text-transform: none;
}

/* Start: label nudged left of dot */
.loop-handles-bottom .route-handle-col {
  margin-left: -11px;
}

/* Exit: label nudged right so "t" aligns with dot */
.loop-handle-left .route-handle-label {
  padding-right: 6px;
}

/* Exit: right-align label so "t" is at the dot */
.loop-exit-col {
  align-items: flex-end;
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
  background: var(--bg-surface-alt);
  border: 1px solid var(--border-default);
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
  background: var(--bg-surface-alt);
  border-color: var(--border-strong);
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
  background: var(--accent-primary);
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
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  cursor: default;
}

.thinking-bubble.dark .thinking-bubble-expanded {
  background: var(--bg-surface);
  border-color: var(--border-strong);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.thinking-bubble-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.thinking-bubble-title {
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  color: var(--text-info);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wider);
}

.thinking-bubble-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
}

.thinking-bubble-close:hover {
  background: var(--bg-surface-alt);
  color: var(--text-secondary);
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
  font-size: var(--fs-caption);
  line-height: 1.4;
  padding: 5px 8px;
  border-radius: 8px;
  max-width: 240px;
  word-wrap: break-word;
  white-space: pre-wrap;
}

.thinking-msg.assistant .thinking-msg-content {
  background: var(--bg-surface-alt);
  color: var(--text-primary);
}

.thinking-msg.system .thinking-msg-content {
  background: transparent;
  color: var(--text-muted);
  font-style: italic;
  font-size: var(--fs-caption);
}

/* Scrollbar styling */
.thinking-bubble-messages::-webkit-scrollbar {
  width: 4px;
}

.thinking-bubble-messages::-webkit-scrollbar-track {
  background: transparent;
}

.thinking-bubble-messages::-webkit-scrollbar-thumb {
  background: var(--bg-surface-hover);
  border-radius: 2px;
}

/* ── Execution status styles ── */

.workflow-custom-node.exec-running .node-icon-box {
  border-color: var(--status-success);
  box-shadow: 0 0 12px rgba(46, 160, 67, 0.4);
  animation: exec-pulse 1.5s ease-in-out infinite;
}

.workflow-custom-node.exec-completed .node-icon-box {
  border-color: var(--status-success);
  box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.25);
}

.workflow-custom-node.exec-failed .node-icon-box {
  border-color: var(--status-error);
  box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.25);
}

.workflow-custom-node.exec-waiting .node-icon-box {
  border-color: var(--status-warning);
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
  0%, 100% { box-shadow: 0 0 12px rgba(46, 160, 67, 0.4); }
  50%      { box-shadow: 0 0 18px rgba(46, 160, 67, 0.25); }
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
  color: var(--text-info);
}

.node-exec-badge.completed {
  color: var(--text-success);
}

.node-exec-badge.failed {
  color: var(--text-error);
}

.node-exec-badge.waiting {
  color: var(--status-warning);
}

.exec-spinner {
  animation: exec-spin 1s linear infinite;
}

@keyframes exec-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
</style>
