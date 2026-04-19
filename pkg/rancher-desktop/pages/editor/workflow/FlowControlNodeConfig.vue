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
        >Loop Mode</label>
        <div class="behavior-toggle">
          <button
            class="behavior-btn"
            :class="{ active: config.loopMode !== 'for-each' && config.loopMode !== 'ask-orchestrator', dark: isDark }"
            @click="updateField('loopMode', 'iterations')"
          >
            Iterations
          </button>
          <button
            class="behavior-btn"
            :class="{ active: config.loopMode === 'for-each', dark: isDark }"
            @click="updateField('loopMode', 'for-each')"
          >
            For Each
          </button>
          <button
            class="behavior-btn"
            :class="{ active: config.loopMode === 'ask-orchestrator', dark: isDark }"
            @click="updateField('loopMode', 'ask-orchestrator')"
          >
            Ask Agent
          </button>
        </div>
        <p
          class="config-hint"
          :class="{ dark: isDark }"
          style="margin-top: 6px;"
        >
          {{ config.loopMode === 'for-each'
            ? 'Iterates over each item from an upstream Merge node\'s collected results.'
            : config.loopMode === 'ask-orchestrator'
              ? 'Asks the orchestrating agent how many iterations to run, then loops that many times.'
              : 'Repeats the loop body up to a fixed number of iterations or until a stop condition is met.'
          }}
        </p>
      </div>
      <div
        v-if="config.loopMode === 'iterations'"
        class="node-field"
      >
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
      <div
        v-if="config.loopMode === 'ask-orchestrator'"
        class="node-field"
      >
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Orchestrator Prompt</label>
        <textarea
          class="node-field-input node-field-textarea"
          :class="{ dark: isDark }"
          rows="3"
          placeholder="e.g. How many additional lenses do you want to process? Respond with just a number."
          :value="config.orchestratorPrompt || ''"
          @input="updateField('orchestratorPrompt', ($event.target as HTMLTextAreaElement).value)"
        />
        <p
          class="config-hint"
          :class="{ dark: isDark }"
          style="margin-top: 6px;"
        >
          The orchestrator's response should be a number. The loop will run that many iterations.
        </p>
      </div>
      <div
        v-if="config.loopMode === 'for-each'"
        class="node-field"
      >
        <p
          class="config-hint"
          :class="{ dark: isDark }"
        >
          Available template variables in the loop body:<br>
          <code v-text="'{{loop.currentItem.result}}'" /> — the current item's output<br>
          <code v-text="'{{loop.currentItem.label}}'" /> — the source node's label<br>
          <code v-text="'{{loop.index}}'" /> — zero-based iteration index
        </p>
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
          <template v-if="config.loopMode === 'for-each'">
            Iterates over each item from the upstream Merge node's collected results.
            Connect the <strong>loop body</strong> between the bottom (start) and right (back) handles.
            Use <code v-text="'{{loop.currentItem.result}}'" /> in body nodes to access the current item.
            Exit continues from the left handle.
          </template>
          <template v-else-if="config.loopMode === 'ask-orchestrator'">
            Before starting, the orchestrator is prompted to decide how many iterations to run.
            Connect the <strong>loop body</strong> between the bottom (start) and right (back) handles.
            Exit continues from the left handle.
          </template>
          <template v-else>
            Connect the <strong>loop body</strong> between the bottom (start) and right (back) handles.
            The loop repeats until the condition is met or max iterations reached.
            Exit continues from the left handle. Each iteration accumulates conversation context.
          </template>
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
        >Orchestrating Agent</label>
        <select
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="config.agentId || ''"
          @change="updateField('agentId', ($event.target as HTMLSelectElement).value || null)"
        >
          <option value="">
            -- Same as parent (default) --
          </option>
          <option
            v-for="ag in agents"
            :key="ag.slug"
            :value="ag.slug"
          >
            {{ ag.name }}
          </option>
        </select>
        <p
          class="config-hint"
          :class="{ dark: isDark }"
          style="margin-top: 6px;"
        >
          {{ config.agentId
            ? 'A dedicated agent will orchestrate this sub-workflow with its own persona and tools.'
            : 'The parent workflow\'s orchestrating agent will run this sub-workflow directly.'
          }}
        </p>
      </div>
      <div
        v-if="config.agentId"
        class="node-field"
      >
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Orchestrator Prompt</label>
        <textarea
          class="node-field-input node-field-textarea"
          :class="{ dark: isDark }"
          rows="3"
          placeholder="Instructions for the orchestrating agent, e.g. 'Focus on SEO optimization when making decisions in this workflow...'"
          :value="config.orchestratorPrompt || ''"
          @input="updateField('orchestratorPrompt', ($event.target as HTMLTextAreaElement).value)"
        />
        <p
          class="config-hint"
          :class="{ dark: isDark }"
          style="margin-top: 6px;"
        >
          Additional context or instructions passed to the orchestrating agent before it begins processing the sub-workflow.
        </p>
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
import { ipcRenderer } from 'electron';
import { ref, onMounted } from 'vue';

import type { UpstreamNodeInfo } from './AgentNodeConfig.vue';
import type { FlowControlNodeSubtype } from './types';

const props = defineProps<{
  isDark:         boolean;
  nodeId:         string;
  subtype:        FlowControlNodeSubtype;
  config:         Record<string, any>;
  upstreamNodes?: UpstreamNodeInfo[];
}>();

const emit = defineEmits<{
  'update-config': [nodeId: string, config: Record<string, any>];
}>();

const workflows = ref<{ id: string; name: string }[]>([]);
const agents = ref<{ slug: string; name: string }[]>([]);

onMounted(async() => {
  if (props.subtype === 'sub-workflow') {
    try {
      workflows.value = await ipcRenderer.invoke('workflow-list');
    } catch {
      workflows.value = [];
    }
    try {
      agents.value = await ipcRenderer.invoke('agents-list');
    } catch {
      agents.value = [];
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
