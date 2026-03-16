<template>
  <div
    class="wf-node-card"
    :class="[statusClass, { dark: isDark, expanded }]"
  >
    <button
      class="wf-node-card-header"
      @click="expanded = !expanded"
    >
      <!-- Icon box (mirrors WorkflowCustomNode) -->
      <div
        class="wf-node-icon"
        :class="statusClass"
      >
        <span
          class="wf-node-icon-svg"
          v-html="iconSvg"
        />
      </div>

      <!-- Label + progress -->
      <div class="wf-node-info">
        <span class="wf-node-label">{{ node.nodeLabel }}</span>
        <span
          v-if="progressText"
          class="wf-node-progress"
        >{{ progressText }}</span>
      </div>

      <!-- Status indicator -->
      <span
        class="wf-node-status-dot"
        :class="statusClass"
      />

      <!-- Chevron -->
      <svg
        width="12"
        height="12"
        viewBox="0 0 15 15"
        fill="none"
        class="wf-node-chevron"
        :class="{ open: expanded }"
      >
        <path
          d="M3.13523 6.15803C3.3241 5.95657 3.64052 5.94637 3.84197 6.13523L7.5 9.56464L11.158 6.13523C11.3595 5.94637 11.6759 5.95657 11.8648 6.15803C12.0536 6.35949 12.0434 6.67591 11.842 6.86477L7.84197 10.6148C7.64964 10.7951 7.35036 10.7951 7.15803 10.6148L3.15803 6.86477C2.95657 6.67591 2.94637 6.35949 3.13523 6.15803Z"
          fill="currentColor"
          fill-rule="evenodd"
          clip-rule="evenodd"
        />
      </svg>
    </button>

    <!-- Expanded body: prompt (IN) and output/error (OUT) -->
    <div
      v-show="expanded"
      class="wf-node-body"
    >
      <div
        v-if="node.prompt"
        class="wf-node-section"
      >
        <span class="wf-node-section-label">PROMPT</span>
        <pre class="wf-node-section-text">{{ truncate(node.prompt, 500) }}</pre>
      </div>
      <div
        v-if="node.output"
        class="wf-node-section"
      >
        <span class="wf-node-section-label">OUTPUT</span>
        <pre class="wf-node-section-text">{{ truncate(node.output, 500) }}</pre>
      </div>
      <div
        v-if="node.error"
        class="wf-node-section wf-node-error"
      >
        <span class="wf-node-section-label">ERROR</span>
        <pre class="wf-node-section-text">{{ node.error }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

interface WorkflowNodeInfo {
  workflowRunId: string;
  nodeId:        string;
  nodeLabel:     string;
  status:        'running' | 'completed' | 'failed' | 'waiting';
  prompt?:       string;
  output?:       string;
  error?:        string;
  nodeIndex:     number;
  totalNodes:    number;
}

const props = defineProps<{
  node:   WorkflowNodeInfo;
  isDark: boolean;
}>();

const expanded = ref(false);

const statusClass = computed(() => `status-${ props.node.status }`);

const progressText = computed(() => {
  if (props.node.totalNodes <= 0) return '';
  if (props.node.nodeLabel === 'Workflow Started') {
    if (props.node.status === 'completed') return 'Complete';
    if (props.node.status === 'failed') return 'Failed';
    return `${ props.node.totalNodes } steps`;
  }
  return `${ props.node.nodeIndex + 1 } / ${ props.node.totalNodes }`;
});

// Use a generic workflow node icon since we don't have subtype info in chat
const iconSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>';

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? `${ text.slice(0, max) }...` : text;
}
</script>

<style scoped>
.wf-node-card {
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-surface);
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--fs-code);
  transition: border-color 0.2s;
}

.wf-node-card.status-running {
  border-color: var(--status-success);
  box-shadow: 0 0 8px rgba(46, 160, 67, 0.15);
}

.wf-node-card.status-completed {
  border-color: var(--border-default);
}

.wf-node-card.status-failed {
  border-color: var(--status-error);
}

.wf-node-card.status-waiting {
  border-color: var(--status-warning);
}

.wf-node-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
  color: var(--text-primary);
  text-align: left;
}

/* ── Mini icon box (mirrors WorkflowCustomNode) ── */
.wf-node-icon {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1.5px solid var(--border-strong);
  background: var(--bg-surface-alt);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.wf-node-icon.status-running {
  border-color: var(--status-success);
  box-shadow: 0 0 8px rgba(46, 160, 67, 0.3);
  animation: wf-card-pulse 1.5s ease-in-out infinite;
}

.wf-node-icon.status-completed {
  border-color: var(--status-success);
}

.wf-node-icon.status-failed {
  border-color: var(--status-error);
}

.wf-node-icon.status-waiting {
  border-color: var(--status-warning);
  animation: wf-card-pulse-amber 2s ease-in-out infinite;
}

.wf-node-icon-svg {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.status-running .wf-node-icon-svg {
  color: var(--text-success);
}

.status-completed .wf-node-icon-svg {
  color: var(--text-success);
}

.status-failed .wf-node-icon-svg {
  color: var(--text-error);
}

@keyframes wf-card-pulse {
  0%, 100% { box-shadow: 0 0 8px rgba(46, 160, 67, 0.3); }
  50%      { box-shadow: 0 0 14px rgba(46, 160, 67, 0.15); }
}

@keyframes wf-card-pulse-amber {
  0%, 100% { box-shadow: 0 0 6px rgba(245, 158, 11, 0.3); }
  50%      { box-shadow: 0 0 12px rgba(245, 158, 11, 0.15); }
}

/* ── Label + progress ── */
.wf-node-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.wf-node-label {
  font-weight: var(--weight-bold);
  font-size: var(--fs-code);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wf-node-progress {
  font-size: var(--fs-caption);
  color: var(--text-muted);
  font-weight: var(--weight-normal);
}

/* ── Status dot ── */
.wf-node-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.wf-node-status-dot.status-running {
  background: var(--status-success);
  animation: wf-dot-pulse 1.5s ease-in-out infinite;
}

.wf-node-status-dot.status-completed {
  background: var(--status-success);
}

.wf-node-status-dot.status-failed {
  background: var(--status-error);
}

.wf-node-status-dot.status-waiting {
  background: var(--status-warning);
  animation: wf-dot-pulse 2s ease-in-out infinite;
}

@keyframes wf-dot-pulse {
  0%, 100% { opacity: 0.5; }
  50%      { opacity: 1; }
}

/* ── Chevron ── */
.wf-node-chevron {
  color: var(--text-muted);
  transition: transform 0.15s ease;
  flex-shrink: 0;
  margin-left: auto;
}

.wf-node-chevron.open {
  transform: rotate(180deg);
}

/* ── Expanded body ── */
.wf-node-body {
  border-top: 1px solid var(--border-default);
}

.wf-node-section {
  padding: 6px 10px;
}

.wf-node-section + .wf-node-section {
  border-top: 1px solid var(--border-default);
}

.wf-node-section-label {
  display: block;
  font-size: var(--fs-caption);
  font-weight: var(--weight-bold);
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 3px;
  letter-spacing: var(--tracking-wide);
}

.wf-node-section-text {
  margin: 0;
  padding: 0;
  background: none;
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
  line-height: 1.45;
}

.wf-node-error .wf-node-section-text {
  color: var(--text-error);
}
</style>
