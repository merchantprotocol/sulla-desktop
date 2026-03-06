<template>
  <div class="flow-control-config" :class="{ dark: isDark }">
    <!-- Wait / Delay -->
    <template v-if="subtype === 'wait'">
      <div class="node-field">
        <label class="node-field-label" :class="{ dark: isDark }">Delay</label>
        <div class="delay-row">
          <input
            class="node-field-input delay-amount"
            :class="{ dark: isDark }"
            type="number"
            min="1"
            :value="config.delayAmount || 5"
            @input="updateField('delayAmount', Number(($event.target as HTMLInputElement).value))"
          />
          <select
            class="node-field-input delay-unit"
            :class="{ dark: isDark }"
            :value="config.delayUnit || 'seconds'"
            @change="updateField('delayUnit', ($event.target as HTMLSelectElement).value)"
          >
            <option value="seconds">Seconds</option>
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
          </select>
        </div>
      </div>
      <div class="node-field help-section">
        <p class="help-text" :class="{ dark: isDark }">
          Pauses the workflow for the specified duration before continuing to the next node.
          Useful for rate limiting, cooldown periods, or waiting for external processes.
        </p>
      </div>
    </template>

    <!-- Loop -->
    <template v-else-if="subtype === 'loop'">
      <div class="node-field">
        <label class="node-field-label" :class="{ dark: isDark }">Max Iterations</label>
        <input
          class="node-field-input"
          :class="{ dark: isDark }"
          type="number"
          min="1"
          :value="config.maxIterations || 10"
          @input="updateField('maxIterations', Number(($event.target as HTMLInputElement).value))"
        />
      </div>
      <div class="node-field">
        <label class="node-field-label" :class="{ dark: isDark }">Stop Condition</label>
        <textarea
          class="node-field-input node-field-textarea"
          :class="{ dark: isDark }"
          rows="2"
          placeholder="e.g. response.status === 'complete' or no more items to process"
          :value="config.condition || ''"
          @input="updateField('condition', ($event.target as HTMLTextAreaElement).value)"
        ></textarea>
      </div>
      <div class="node-field help-section">
        <p class="help-text" :class="{ dark: isDark }">
          Repeats the connected nodes up to the max iterations. Stops early if the stop condition
          evaluates to true. The output of each iteration is fed as input to the next.
        </p>
      </div>
    </template>

    <!-- Merge -->
    <template v-else-if="subtype === 'merge'">
      <div class="node-field">
        <label class="node-field-label" :class="{ dark: isDark }">Merge Strategy</label>
        <select
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="config.strategy || 'wait-all'"
          @change="updateField('strategy', ($event.target as HTMLSelectElement).value)"
        >
          <option value="wait-all">Wait for all branches</option>
          <option value="first">Continue on first completion</option>
        </select>
      </div>
      <div class="node-field help-section">
        <p class="help-text" :class="{ dark: isDark }">
          Collects results from parallel branches. <strong>Wait for all</strong> waits until
          every incoming branch finishes. <strong>First completion</strong> continues as soon
          as any one branch is done.
        </p>
      </div>
    </template>

    <!-- Sub-workflow -->
    <template v-else-if="subtype === 'sub-workflow'">
      <div class="node-field">
        <label class="node-field-label" :class="{ dark: isDark }">Workflow</label>
        <select
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="config.workflowId || ''"
          @change="updateField('workflowId', ($event.target as HTMLSelectElement).value || null)"
        >
          <option value="">-- Select Workflow --</option>
          <option v-for="wf in workflows" :key="wf.id" :value="wf.id">{{ wf.name }}</option>
        </select>
      </div>
      <div class="node-field">
        <label class="node-field-label" :class="{ dark: isDark }">Behavior</label>
        <div class="behavior-toggle">
          <button
            class="behavior-btn"
            :class="{ active: config.awaitResponse !== false, dark: isDark }"
            @click="updateField('awaitResponse', true)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            Await Response
          </button>
          <button
            class="behavior-btn"
            :class="{ active: config.awaitResponse === false, dark: isDark }"
            @click="updateField('awaitResponse', false)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            Fire &amp; Forget
          </button>
        </div>
        <p class="config-hint" :class="{ dark: isDark }" style="margin-top: 6px;">
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
        <p class="help-text" :class="{ dark: isDark }">
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
  isDark: boolean;
  nodeId: string;
  subtype: FlowControlNodeSubtype;
  config: Record<string, any>;
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
  border-bottom: 1px solid #e2e8f0;
}
.flow-control-config.dark .node-field { border-bottom-color: #3c3c5c; }

.node-field-label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
  margin-bottom: 6px;
}
.node-field-label.dark { color: #94a3b8; }

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
.node-field-input.dark:focus { border-color: #6366f1; }

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
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  background: #fff;
  color: #64748b;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.behavior-btn.active { border-color: #6366f1; color: #6366f1; background: rgba(99, 102, 241, 0.06); }
.behavior-btn.dark { background: #2d2d44; border-color: #3c3c5c; color: #94a3b8; }
.behavior-btn.dark.active { border-color: #6366f1; color: #818cf8; background: rgba(99, 102, 241, 0.15); }

.config-hint {
  font-size: 12px;
  color: #94a3b8;
  margin: 0;
  line-height: 1.4;
}
.config-hint.dark { color: #64748b; }

.help-section { border-bottom: none; }

.help-text {
  font-size: 11px;
  color: #94a3b8;
  margin: 0 0 6px;
  line-height: 1.5;
}
.help-text:last-child { margin-bottom: 0; }
.help-text.dark { color: #64748b; }
</style>
