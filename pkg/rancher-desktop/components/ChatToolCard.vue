<template>
  <div
    class="tool-card-cc"
    :class="{ expanded: isExpanded, dark: isDark }"
  >
    <button
      type="button"
      class="tool-card-cc-header"
      @click="toggle"
    >
      <span
        class="tool-card-cc-dot"
        :class="toolCard.status"
      />
      <span class="tool-card-cc-name">{{ displayLabel }}</span>
      <span class="tool-card-cc-desc">{{ toolCard.description || toolCard.summary || '' }}</span>
      <svg
        width="14"
        height="14"
        viewBox="0 0 15 15"
        fill="none"
        class="tool-card-cc-chevron"
        :class="{ open: isExpanded }"
      >
        <path
          d="M3.13523 6.15803C3.3241 5.95657 3.64052 5.94637 3.84197 6.13523L7.5 9.56464L11.158 6.13523C11.3595 5.94637 11.6759 5.95657 11.8648 6.15803C12.0536 6.35949 12.0434 6.67591 11.842 6.86477L7.84197 10.6148C7.64964 10.7951 7.35036 10.7951 7.15803 10.6148L3.15803 6.86477C2.95657 6.67591 2.94637 6.35949 3.13523 6.15803Z"
          fill="currentColor"
          fill-rule="evenodd"
          clip-rule="evenodd"
        />
      </svg>
    </button>
    <div
      v-if="displayInput"
      class="tool-card-cc-cmd"
    >
      <span class="tool-card-cc-cmd-label">IN</span>
      <code class="tool-card-cc-cmd-text">{{ displayInput }}</code>
    </div>
    <div
      v-if="toolCard.status !== 'running' && displayInput"
      class="tool-card-cc-cmd"
    >
      <span class="tool-card-cc-cmd-label">OUT</span>
      <code
        class="tool-card-cc-cmd-text tool-card-cc-exit"
        :class="toolCard.status"
      >{{ toolCard.status === 'success' ? '0' : '1' }}</code>
    </div>
    <div
      v-show="isExpanded"
      class="tool-card-cc-body"
    >
      <div
        v-if="displayOutput"
        class="tool-card-cc-output"
      >
        <pre>{{ displayOutput }}</pre>
      </div>
      <div
        v-if="!displayOutput && !displayInput && toolCard.args && Object.keys(toolCard.args).length > 0"
        class="tool-card-cc-output"
      >
        <div class="tool-card-cc-section-label">
          Arguments
        </div>
        <pre>{{ JSON.stringify(toolCard.args, null, 2) }}</pre>
      </div>
      <div
        v-if="!displayOutput && !displayInput && toolCard.result !== undefined"
        class="tool-card-cc-output"
      >
        <div class="tool-card-cc-section-label">
          Result
        </div>
        <pre>{{ typeof toolCard.result === 'string' ? toolCard.result : JSON.stringify(toolCard.result, null, 2) }}</pre>
      </div>
      <div
        v-if="toolCard.error"
        class="tool-card-cc-error"
      >
        {{ toolCard.error }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ChatMessage } from '@pkg/agent/database/registry/AgentPersonaRegistry';

const EXEC_TOOL_NAMES = new Set(['exec', 'exec_command', 'shell', 'bash', 'run_command']);

const props = defineProps<{
  toolCard: NonNullable<ChatMessage['toolCard']>;
  isDark?: boolean;
}>();

const isExpanded = ref(false);

function toggle() {
  isExpanded.value = !isExpanded.value;
}

const displayLabel = computed(() => {
  if (props.toolCard.label) return props.toolCard.label;
  return EXEC_TOOL_NAMES.has(props.toolCard.toolName) ? 'Bash' : props.toolCard.toolName;
});

const displayInput = computed(() => {
  if (props.toolCard.input) return props.toolCard.input;
  if (!EXEC_TOOL_NAMES.has(props.toolCard.toolName)) return null;
  const cmd = props.toolCard.args?.command ?? props.toolCard.args?.cmd;
  return typeof cmd === 'string' ? cmd : null;
});

const displayOutput = computed(() => {
  if (props.toolCard.output) return props.toolCard.output;
  if (!props.toolCard.result) return null;
  const r = props.toolCard.result as any;
  if (typeof r.responseString === 'string' && r.responseString.trim()) return r.responseString;
  if (typeof r.result === 'string' && r.result.trim()) return r.result;
  if (typeof r === 'string' && r.trim()) return r;
  return null;
});
</script>

<style scoped>
.tool-card-cc {
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-page);
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--fs-code);
}

.tool-card-cc-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
  color: var(--text-primary);
  text-align: left;
}

.tool-card-cc-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.tool-card-cc-dot.running { background: var(--status-warning); animation: dotPulse 1.5s ease-in-out infinite; }
.tool-card-cc-dot.success { background: var(--status-success); }
.tool-card-cc-dot.failed  { background: var(--status-error); }

@keyframes dotPulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

.tool-card-cc-name {
  font-weight: var(--weight-bold);
  font-size: var(--fs-code);
  color: var(--text-primary);
}

.tool-card-cc-desc {
  font-weight: var(--weight-normal);
  font-size: var(--fs-code);
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-card-cc-chevron {
  color: var(--text-muted);
  transition: transform 0.15s ease;
  flex-shrink: 0;
  margin-left: auto;
}
.tool-card-cc-chevron.open {
  transform: rotate(180deg);
}

.tool-card-cc-cmd {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 2px 12px 2px 20px;
  font-size: var(--fs-body-sm);
}

.tool-card-cc-cmd-label {
  font-size: var(--fs-caption);
  font-weight: var(--weight-bold);
  color: var(--text-muted);
  text-transform: uppercase;
  flex-shrink: 0;
  min-width: 24px;
}

.tool-card-cc-cmd-text {
  color: var(--text-secondary);
  word-break: break-all;
  white-space: pre-wrap;
}

.tool-card-cc-exit.success { color: var(--status-success); }
.tool-card-cc-exit.failed  { color: var(--status-error); }

.tool-card-cc-body {
  border-top: 1px solid var(--border-default);
  margin: 6px 0 0;
}

.tool-card-cc-output {
  padding: 8px 12px;
}
.tool-card-cc-output pre {
  margin: 0;
  padding: 0;
  background: none;
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow-y: auto;
}

.tool-card-cc-section-label {
  font-size: var(--fs-caption);
  font-weight: var(--weight-bold);
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 4px;
}

.tool-card-cc-error {
  padding: 8px 12px;
  font-size: var(--fs-body-sm);
  color: var(--status-error);
}
</style>
