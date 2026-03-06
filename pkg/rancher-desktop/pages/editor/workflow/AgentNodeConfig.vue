<template>
  <div class="agent-config" :class="{ dark: isDark }">
    <div class="node-field">
      <label class="node-field-label" :class="{ dark: isDark }">Agent</label>
      <select
        class="node-field-input"
        :class="{ dark: isDark }"
        :value="config.agentId || ''"
        @change="onAgentChange"
      >
        <option value="">-- Select Agent --</option>
        <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
      </select>
    </div>

    <div class="node-field">
      <label class="node-field-label" :class="{ dark: isDark }">Additional Prompt</label>
      <textarea
        class="node-field-input node-field-textarea"
        :class="{ dark: isDark }"
        rows="4"
        placeholder="Additional instructions for this agent..."
        :value="config.additionalPrompt || ''"
        @input="onPromptChange"
      ></textarea>
    </div>
    <div class="node-field help-section" :class="{ dark: isDark }">
      <p class="help-title" :class="{ dark: isDark }">How agents work</p>
      <p class="help-text" :class="{ dark: isDark }">
        Select a Sulla agent to run at this step. The agent receives the output from
        the previous node as its input message.
      </p>
      <p class="help-text" :class="{ dark: isDark }">
        Use <strong>Additional Prompt</strong> to give this agent extra context specific to this
        workflow step &mdash; for example, "Focus only on extracting the customer's order number"
        or "Respond in Spanish". This is appended to the agent's built-in prompt.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { ipcRenderer } from 'electron';
import type { AgentNodeConfig } from './types';

const props = defineProps<{
  isDark: boolean;
  nodeId: string;
  config: AgentNodeConfig;
}>();

const emit = defineEmits<{
  'update-config': [nodeId: string, config: AgentNodeConfig];
}>();

interface AgentInfo {
  id: string;
  name: string;
  description: string;
  type: string;
}

const agents = ref<AgentInfo[]>([]);

onMounted(async() => {
  try {
    agents.value = await ipcRenderer.invoke('agents-list');
  } catch {
    agents.value = [];
  }
});

function onAgentChange(event: Event) {
  const el = event.target as HTMLSelectElement;
  const agent = agents.value.find(a => a.id === el.value);

  emit('update-config', props.nodeId, {
    ...props.config,
    agentId:   el.value || null,
    agentName: agent?.name ?? '',
  });
}

function onPromptChange(event: Event) {
  const el = event.target as HTMLTextAreaElement;

  emit('update-config', props.nodeId, {
    ...props.config,
    additionalPrompt: el.value,
  });
}
</script>

<style scoped>
.agent-config {
  padding: 0;
}

.node-field {
  padding: 12px;
  border-bottom: 1px solid #e2e8f0;
}

.agent-config.dark .node-field {
  border-bottom-color: #3c3c5c;
}

.node-field-label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
  margin-bottom: 6px;
}

.node-field-label.dark {
  color: #94a3b8;
}

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

.node-field-input.dark:focus {
  border-color: #6366f1;
}

.node-field-textarea {
  resize: vertical;
  font-family: inherit;
  min-height: 60px;
}

.help-section { border-bottom: none; }

.help-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
  margin: 0 0 8px;
}
.help-title.dark { color: #94a3b8; }

.help-text {
  font-size: 11px;
  color: #94a3b8;
  margin: 0 0 6px;
  line-height: 1.5;
}
.help-text:last-child { margin-bottom: 0; }
.help-text.dark { color: #64748b; }
</style>
