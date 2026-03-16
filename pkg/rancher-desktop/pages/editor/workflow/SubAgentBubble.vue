<template>
  <div
    class="sub-agent-bubble"
    :class="[statusClass, { dark: isDark, expanded }]"
  >
    <button
      class="sub-agent-header"
      @click="expanded = !expanded"
    >
      <!-- Icon box (mirrors WorkflowNodeCard) -->
      <div
        class="sub-agent-icon"
        :class="statusClass"
      >
        <span
          class="sub-agent-icon-svg"
          v-html="iconSvg"
        />
      </div>

      <!-- Label + latest thinking preview -->
      <div class="sub-agent-info">
        <span class="sub-agent-label">{{ activity.nodeLabel }}</span>
        <span
          v-if="previewText"
          class="sub-agent-preview"
        >{{ previewText }}</span>
      </div>

      <!-- Status indicator -->
      <span
        class="sub-agent-status-dot"
        :class="statusClass"
      />

      <!-- Chevron -->
      <svg
        width="12"
        height="12"
        viewBox="0 0 15 15"
        fill="none"
        class="sub-agent-chevron"
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

    <!-- Expanded body: thinking lines + output/error -->
    <div
      v-show="expanded"
      class="sub-agent-body"
    >
      <div
        v-if="activity.thinkingLines.length > 0"
        class="sub-agent-section"
      >
        <span class="sub-agent-section-label">ACTIVITY</span>
        <div
          ref="thinkingContainer"
          class="sub-agent-thinking-scroll"
        >
          <div
            v-for="(line, idx) in activity.thinkingLines"
            :key="idx"
            class="sub-agent-thinking-line"
          >
            {{ line }}
          </div>
        </div>
      </div>
      <div
        v-if="activity.output"
        class="sub-agent-section"
      >
        <span class="sub-agent-section-label">OUTPUT</span>
        <pre class="sub-agent-section-text">{{ truncate(activity.output, 500) }}</pre>
      </div>
      <div
        v-if="activity.error"
        class="sub-agent-section sub-agent-error"
      >
        <span class="sub-agent-section-label">ERROR</span>
        <pre class="sub-agent-section-text">{{ activity.error }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';

interface SubAgentActivityInfo {
  nodeId:          string;
  nodeLabel:       string;
  status:          'running' | 'completed' | 'failed' | 'blocked';
  thinkingLines:   string[];
  latestThinking?: string;
  output?:         string;
  error?:          string;
}

const props = defineProps<{
  activity: SubAgentActivityInfo;
  isDark:   boolean;
}>();

const expanded = ref(false);
const thinkingContainer = ref<HTMLElement | null>(null);

const statusClass = computed(() => `status-${ props.activity.status }`);

const previewText = computed(() => {
  if (props.activity.status === 'completed') return 'Complete';
  if (props.activity.status === 'failed') return 'Failed';
  if (props.activity.status === 'blocked') return 'Waiting for orchestrator...';
  return props.activity.latestThinking
    ? truncate(props.activity.latestThinking, 80)
    : 'Working...';
});

// Agent node icon (brain/cog style to distinguish from workflow node clock icon)
const iconSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 1 4 4c0 .7-.2 1.4-.5 2H17a3 3 0 0 1 3 3c0 1.2-.7 2.2-1.7 2.7A3 3 0 0 1 17 18H7a3 3 0 0 1-1.3-5.7A3 3 0 0 1 7 8h1.5A4 4 0 0 1 12 2z"/><path d="M9.5 14.5L12 12l2.5 2.5"/><path d="M12 12v6"/></svg>';

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? `${ text.slice(0, max) }...` : text;
}

// Auto-scroll thinking container when new lines arrive
watch(
  () => props.activity.thinkingLines.length,
  async() => {
    if (expanded.value && thinkingContainer.value) {
      await nextTick();
      thinkingContainer.value.scrollTop = thinkingContainer.value.scrollHeight;
    }
  },
);
</script>

<style scoped>
.sub-agent-bubble {
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-surface);
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--fs-code);
  transition: border-color 0.2s;
}

.sub-agent-bubble.status-running {
  border-color: var(--status-success);
  box-shadow: 0 0 8px rgba(46, 160, 67, 0.15);
}

.sub-agent-bubble.status-completed {
  border-color: var(--border-default);
}

.sub-agent-bubble.status-failed {
  border-color: var(--status-error);
}

.sub-agent-bubble.status-blocked {
  border-color: var(--status-warning, #d29922);
  box-shadow: 0 0 8px rgba(210, 153, 34, 0.15);
}

.sub-agent-header {
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

/* ── Icon box ── */
.sub-agent-icon {
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

.sub-agent-icon.status-running {
  border-color: var(--status-success);
  box-shadow: 0 0 8px rgba(46, 160, 67, 0.3);
  animation: sub-agent-pulse 1.5s ease-in-out infinite;
}

.sub-agent-icon.status-completed {
  border-color: var(--status-success);
}

.sub-agent-icon.status-failed {
  border-color: var(--status-error);
}

.sub-agent-icon.status-blocked {
  border-color: var(--status-warning, #d29922);
  animation: sub-agent-pulse-blocked 2s ease-in-out infinite;
}

.sub-agent-icon-svg {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.status-running .sub-agent-icon-svg {
  color: var(--text-success);
}

.status-completed .sub-agent-icon-svg {
  color: var(--text-success);
}

.status-failed .sub-agent-icon-svg {
  color: var(--text-error);
}

.status-blocked .sub-agent-icon-svg {
  color: var(--status-warning, #d29922);
}

@keyframes sub-agent-pulse {
  0%, 100% { box-shadow: 0 0 8px rgba(46, 160, 67, 0.3); }
  50%      { box-shadow: 0 0 14px rgba(46, 160, 67, 0.15); }
}

/* ── Label + preview ── */
.sub-agent-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.sub-agent-label {
  font-weight: var(--weight-bold);
  font-size: var(--fs-code);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sub-agent-preview {
  font-size: var(--fs-caption);
  color: var(--text-muted);
  font-weight: var(--weight-normal);
  font-style: italic;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Status dot ── */
.sub-agent-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.sub-agent-status-dot.status-running {
  background: var(--status-success);
  animation: sub-agent-dot-pulse 1.5s ease-in-out infinite;
}

.sub-agent-status-dot.status-completed {
  background: var(--status-success);
}

.sub-agent-status-dot.status-failed {
  background: var(--status-error);
}

.sub-agent-status-dot.status-blocked {
  background: var(--status-warning, #d29922);
  animation: sub-agent-dot-pulse 2s ease-in-out infinite;
}

@keyframes sub-agent-pulse-blocked {
  0%, 100% { box-shadow: 0 0 8px rgba(210, 153, 34, 0.3); }
  50%      { box-shadow: 0 0 14px rgba(210, 153, 34, 0.15); }
}

@keyframes sub-agent-dot-pulse {
  0%, 100% { opacity: 0.5; }
  50%      { opacity: 1; }
}

/* ── Chevron ── */
.sub-agent-chevron {
  color: var(--text-muted);
  transition: transform 0.15s ease;
  flex-shrink: 0;
  margin-left: auto;
}

.sub-agent-chevron.open {
  transform: rotate(180deg);
}

/* ── Expanded body ── */
.sub-agent-body {
  border-top: 1px solid var(--border-default);
}

.sub-agent-section {
  padding: 6px 10px;
}

.sub-agent-section + .sub-agent-section {
  border-top: 1px solid var(--border-default);
}

.sub-agent-section-label {
  display: block;
  font-size: var(--fs-caption);
  font-weight: var(--weight-bold);
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 3px;
  letter-spacing: var(--tracking-wide);
}

.sub-agent-section-text {
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

.sub-agent-error .sub-agent-section-text {
  color: var(--text-error);
}

/* ── Thinking lines scroll area ── */
.sub-agent-thinking-scroll {
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sub-agent-thinking-line {
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 2px 0;
  border-bottom: 1px solid var(--border-subtle, var(--border-default));
}

.sub-agent-thinking-line:last-child {
  border-bottom: none;
}
</style>
