<template>
  <div
    class="flow-control-config"
    :class="{ dark: isDark }"
  >
    <!-- Wait / Delay -->
    <template v-if="subtype === 'wait'">
      <div class="node-field">
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Delay</label>
        <div class="delay-row">
          <input
            class="node-field-input delay-amount"
            :class="{ dark: isDark }"
            type="number"
            min="1"
            :value="config.delayAmount || 5"
            @input="updateField('delayAmount', Number(($event.target as HTMLInputElement).value))"
          >
          <select
            class="node-field-input delay-unit"
            :class="{ dark: isDark }"
            :value="config.delayUnit || 'seconds'"
            @change="updateField('delayUnit', ($event.target as HTMLSelectElement).value)"
          >
            <option value="seconds">
              Seconds
            </option>
            <option value="minutes">
              Minutes
            </option>
            <option value="hours">
              Hours
            </option>
          </select>
        </div>
      </div>
      <div class="node-field help-section">
        <p
          class="help-text"
          :class="{ dark: isDark }"
        >
          Pauses the workflow for the specified duration before continuing to the next node.
          Useful for rate limiting, cooldown periods, or waiting for external processes.
        </p>
      </div>
    </template>

    <!-- Loop -->
    <template v-else-if="subtype === 'loop'">
      <div class="node-field">
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Max Iterations</label>
        <input
          class="node-field-input"
          :class="{ dark: isDark }"
          type="number"
          min="1"
          :value="config.maxIterations || 10"
          @input="updateField('maxIterations', Number(($event.target as HTMLInputElement).value))"
        >
      </div>
      <div class="node-field">
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Stop Condition</label>
        <textarea
          class="node-field-input node-field-textarea"
          :class="{ dark: isDark }"
          rows="2"
          :placeholder="config.conditionMode === 'llm'
            ? 'e.g. Has the agent completed the task successfully?'
            : 'e.g. {{Agent.result}} contains done'"
          :value="config.condition || ''"
          @input="updateField('condition', ($event.target as HTMLTextAreaElement).value)"
        />
      </div>
      <div class="node-field">
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Condition Mode</label>
        <div class="behavior-toggle">
          <button
            class="behavior-btn"
            :class="{ active: config.conditionMode !== 'llm', dark: isDark }"
            @click="updateField('conditionMode', 'template')"
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
            ><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
            Template
          </button>
          <button
            class="behavior-btn"
            :class="{ active: config.conditionMode === 'llm', dark: isDark }"
            @click="updateField('conditionMode', 'llm')"
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
            ><circle
              cx="12"
              cy="12"
              r="10"
            /><path d="M12 6v6l4 2" /></svg>
            LLM
          </button>
        </div>
        <p
          class="config-hint"
          :class="{ dark: isDark }"
          style="margin-top: 6px;"
        >
          {{ config.conditionMode === 'llm'
            ? 'The orchestrator evaluates the condition in natural language after each iteration.'
            : 'Condition is evaluated using variable template matching against the last body output.'
          }}
        </p>
      </div>
      <div class="node-field help-section">
        <p
          class="help-text"
          :class="{ dark: isDark }"
        >
          Connect the <strong>loop body</strong> between the bottom (start) and right (back) handles.
          The loop repeats until the condition is met or max iterations reached.
          Exit continues from the left handle. Each iteration accumulates conversation context.
        </p>
      </div>
    </template>

    <!-- Merge -->
    <template v-else-if="subtype === 'merge'">
      <div class="node-field">
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Merge Strategy</label>
        <select
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="config.strategy || 'wait-all'"
          @change="updateField('strategy', ($event.target as HTMLSelectElement).value)"
        >
          <option value="wait-all">
            Wait for all branches
          </option>
          <option value="first">
            Continue on first completion
          </option>
        </select>
      </div>
      <div class="node-field help-section">
        <p
          class="help-text"
          :class="{ dark: isDark }"
        >
          Collects results from parallel branches. <strong>Wait for all</strong> waits until
          every incoming branch finishes. <strong>First completion</strong> continues as soon
          as any one branch is done.
        </p>
      </div>
    </template>

    <!-- Sub-workflow -->
    <template v-else-if="subtype === 'sub-workflow'">
      <div class="node-field">
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Workflow</label>
        <select
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="config.workflowId || ''"
          @change="updateField('workflowId', ($event.target as HTMLSelectElement).value || null)"
        >
          <option value="">
            -- Select Workflow --
          </option>
          <option
            v-for="wf in workflows"
            :key="wf.id"
            :value="wf.id"
          >
            {{ wf.name }}
          </option>
        </select>
      </div>
      <div class="node-field">
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Behavior</label>
        <div class="behavior-toggle">
          <button
            class="behavior-btn"
            :class="{ active: config.awaitResponse !== false, dark: isDark }"
            @click="updateField('awaitResponse', true)"
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
            ><polyline points="20 6 9 17 4 12" /></svg>
            Await Response
          </button>
          <button
            class="behavior-btn"
            :class="{ active: config.awaitResponse === false, dark: isDark }"
            @click="updateField('awaitResponse', false)"
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
            ><line
              x1="5"
              y1="12"
              x2="19"
              y2="12"
            /><polyline points="12 5 19 12 12 19" /></svg>
            Fire &amp; Forget
          </button>
        </div>
        <p
          class="config-hint"
          :class="{ dark: isDark }"
          style="margin-top: 6px;"
        >
          {{ config.awaitResponse === false
            ? 'Sub-workflow runs independently. This node is a dead end — no output is passed downstream.'
            : 'Waits for the sub-workflow to finish and passes its response to the next node.'
          }}
        </p>
      </div>
    </template>

    <!-- Parallel -->
    <template v-else-if="subtype === 'parallel'">
      <div class="node-field help-section">
        <p
          class="help-text"
          :class="{ dark: isDark }"
        >
          Forks execution into parallel branches. Connect multiple outgoing edges from this node
          &mdash; each connected path runs simultaneously. Use a <strong>Merge</strong> node
          downstream to collect results from all branches before continuing.
        </p>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { ipcRenderer } from 'electron';
import type { FlowControlNodeSubtype } from './types';

const props = defineProps<{
  isDark:  boolean;
  nodeId:  string;
  subtype: FlowControlNodeSubtype;
  config:  Record<string, any>;
}>();

const emit = defineEmits<{
  'update-config': [nodeId: string, config: Record<string, any>];
}>();

const workflows = ref<{ id: string; name: string }[]>([]);

onMounted(async() => {
  if (props.subtype === 'sub-workflow') {
    try {
      workflows.value = await ipcRenderer.invoke('workflow-list');
    } catch {
      workflows.value = [];
    }
  }
});

function updateField(field: string, value: any) {
  emit('update-config', props.nodeId, { ...props.config, [field]: value });
}
</script>

<style scoped>
.flow-control-config { padding: 0; }

.node-field {
  padding: 12px;
  border-bottom: 1px solid var(--border-default);
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
.node-field-label.dark { color: var(--text-muted); }

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

.node-field-textarea {
  resize: vertical;
  font-family: inherit;
  min-height: 40px;
}

.delay-row {
  display: flex;
  gap: 6px;
}
.delay-amount { flex: 1; }
.delay-unit { flex: 1; }

.behavior-toggle {
  display: flex;
  gap: 4px;
}

.behavior-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 7px 6px;
  border: 1px solid var(--bg-surface-hover);
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-semibold);
  cursor: pointer;
}
.behavior-btn.active { border-color: var(--accent-primary); color: var(--text-info); background: rgba(99, 102, 241, 0.06); }

.config-hint {
  font-size: var(--fs-code);
  color: var(--text-muted);
  margin: 0;
  line-height: 1.4;
}
.config-hint.dark { color: var(--text-secondary); }

.help-section { border-bottom: none; }

.help-text {
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  margin: 0 0 6px;
  line-height: 1.5;
}
.help-text:last-child { margin-bottom: 0; }
.help-text.dark { color: var(--text-secondary); }
</style>
