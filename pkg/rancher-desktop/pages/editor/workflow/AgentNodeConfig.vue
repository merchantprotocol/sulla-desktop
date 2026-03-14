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
      <div class="field-header">
        <label class="node-field-label" :class="{ dark: isDark }">Additional Prompt</label>
        <button
          class="var-insert-btn"
          :class="{ dark: isDark }"
          title="Insert variable"
          @click="openVarMenu('additionalPrompt', $event)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="16 18 22 12 16 6"></polyline>
            <polyline points="8 6 2 12 8 18"></polyline>
          </svg>
        </button>
      </div>
      <textarea
        ref="additionalPromptRef"
        class="node-field-input node-field-textarea"
        :class="{ dark: isDark }"
        rows="4"
        placeholder="Additional instructions for this agent..."
        :value="config.additionalPrompt || ''"
        @input="onPromptChange"
        @contextmenu.prevent="onTextareaContextMenu('additionalPrompt', $event)"
      ></textarea>
    </div>

    <div class="node-field">
      <div class="field-header">
        <label class="node-field-label" :class="{ dark: isDark }">User Message</label>
        <button
          class="var-insert-btn"
          :class="{ dark: isDark }"
          title="Insert variable"
          @click="openVarMenu('userMessage', $event)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="16 18 22 12 16 6"></polyline>
            <polyline points="8 6 2 12 8 18"></polyline>
          </svg>
        </button>
      </div>
      <textarea
        ref="userMessageRef"
        class="node-field-input node-field-textarea"
        :class="{ dark: isDark }"
        rows="4"
        placeholder="Message sent to this agent. Use {{variableName}} to inject upstream outputs..."
        :value="config.userMessage || ''"
        @input="onUserMessageChange"
        @contextmenu.prevent="onTextareaContextMenu('userMessage', $event)"
      ></textarea>
    </div>

    <div class="node-field">
      <div class="field-header">
        <label class="node-field-label" :class="{ dark: isDark }">Before Prompt</label>
        <button
          class="var-insert-btn"
          :class="{ dark: isDark }"
          title="Insert variable"
          @click="openVarMenu('beforePrompt', $event)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="16 18 22 12 16 6"></polyline>
            <polyline points="8 6 2 12 8 18"></polyline>
          </svg>
        </button>
      </div>
      <textarea
        ref="beforePromptRef"
        class="node-field-input node-field-textarea"
        :class="{ dark: isDark }"
        rows="3"
        placeholder="Instructions for the orchestrator before this agent runs..."
        :value="config.beforePrompt || ''"
        @input="onBeforePromptChange"
        @contextmenu.prevent="onTextareaContextMenu('beforePrompt', $event)"
      ></textarea>
    </div>

    <div class="node-field">
      <label class="node-field-label" :class="{ dark: isDark }">Success Criteria</label>
      <textarea
        class="node-field-input node-field-textarea"
        :class="{ dark: isDark }"
        rows="3"
        placeholder="How the orchestrator validates this agent's output..."
        :value="config.successCriteria || ''"
        @input="onSuccessCriteriaChange"
      ></textarea>
    </div>

    <div class="node-field">
      <label class="node-field-label" :class="{ dark: isDark }">Completion Contract</label>
      <textarea
        class="node-field-input node-field-textarea"
        :class="{ dark: isDark }"
        rows="5"
        placeholder="HAND_BACK&#10;Summary: [1-3 paragraph summary of what was accomplished]&#10;Artifact: /artifacts/[path-to-output-file]&#10;Needs user input: yes/no&#10;Suggested next action: [optional next step]"
        :value="config.completionContract || ''"
        @input="onCompletionContractChange"
      ></textarea>
    </div>

    <div class="node-field help-section" :class="{ dark: isDark }">
      <p class="help-title" :class="{ dark: isDark }">How agents work</p>
      <p class="help-text" :class="{ dark: isDark }">
        Select a Sulla agent to run at this step. Use <strong>User Message</strong> to specify
        exactly what gets sent to the agent as its input.
      </p>
      <p class="help-text" :class="{ dark: isDark }">
        <strong>Before Prompt</strong> is shown to the orchestrator before the agent fires.
        <strong>Success Criteria</strong> is used by the orchestrator to validate the result after the agent completes.
      </p>
      <p class="help-text" :class="{ dark: isDark }">
        <strong>Completion Contract</strong> defines the format the sub-agent must use when handing back results.
        Leave empty to use the default HAND_BACK format. The orchestrator parses this to decide: approve, retry, or ask user.
      </p>
      <p class="help-text" :class="{ dark: isDark }">
        Click the <code>&lt;/&gt;</code> icon or <strong>right-click</strong> in a textarea to
        insert <strong>variables</strong> from upstream nodes &mdash; e.g.
        <code v-text="varToken('trigger.result')"></code>.
      </p>
    </div>

    <!-- Variable picker menu (teleported to body) -->
    <Teleport to="body">
      <div v-if="varMenu.visible" class="var-menu-overlay" @click="closeVarMenu">
        <div
          ref="varMenuRef"
          class="var-menu"
          :class="{ dark: isDark }"
          :style="varMenuStyle"
          @click.stop
        >
          <div class="var-menu-header" :class="{ dark: isDark }">Insert Variable</div>

          <!-- Trigger (always available) -->
          <div class="var-menu-group">
            <div class="var-menu-group-label" :class="{ dark: isDark }">Trigger</div>
            <button class="var-menu-item" :class="{ dark: isDark }" @click="insertVariable('trigger.result')">
              <code v-text="varToken('trigger.result')"></code>
              <span class="var-desc">Trigger payload</span>
            </button>
          </div>

          <!-- Upstream nodes -->
          <div v-if="upstreamNodes.length > 0" class="var-menu-group">
            <div class="var-menu-group-label" :class="{ dark: isDark }">Upstream Nodes</div>
            <template v-for="node in upstreamNodes" :key="node.nodeId">
              <button class="var-menu-item" :class="{ dark: isDark }" @click="insertVariable(node.label + '.result')">
                <code v-text="varToken(node.label + '.result')"></code>
                <span class="var-desc">Output from {{ node.label }}</span>
              </button>
              <button
                v-if="node.category === 'agent'"
                class="var-menu-item" :class="{ dark: isDark }"
                @click="insertVariable(node.label + '.threadId')"
              >
                <code v-text="varToken(node.label + '.threadId')"></code>
                <span class="var-desc">Thread ID from {{ node.label }}</span>
              </button>
            </template>
          </div>

          <div v-if="upstreamNodes.length === 0" class="var-menu-empty" :class="{ dark: isDark }">
            No upstream nodes connected yet.
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, nextTick } from 'vue';
import { ipcRenderer } from 'electron';
import type { AgentNodeConfig } from './types';

export interface UpstreamNodeInfo {
  nodeId: string;
  label: string;
  subtype: string;
  category: string;
}

const props = defineProps<{
  isDark: boolean;
  nodeId: string;
  config: AgentNodeConfig;
  upstreamNodes: UpstreamNodeInfo[];
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
const userMessageRef = ref<HTMLTextAreaElement | null>(null);
const additionalPromptRef = ref<HTMLTextAreaElement | null>(null);
const beforePromptRef = ref<HTMLTextAreaElement | null>(null);
const varMenuRef = ref<HTMLElement | null>(null);

const MENU_WIDTH = 260;

type VarMenuTarget = 'userMessage' | 'additionalPrompt' | 'beforePrompt';

const varMenu = reactive({
  visible: false,
  target: '' as VarMenuTarget,
  rawX: 0,
  rawY: 0,
});

/** Clamp menu position so it stays within the viewport */
const varMenuStyle = computed(() => {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const menuHeight = 320; // max-height from CSS

  let x = varMenu.rawX;
  let y = varMenu.rawY;

  // Clamp right edge
  if (x + MENU_WIDTH > vw - 8) {
    x = vw - MENU_WIDTH - 8;
  }
  // Clamp left edge
  if (x < 8) x = 8;
  // Clamp bottom edge
  if (y + menuHeight > vh - 8) {
    y = vh - menuHeight - 8;
  }
  if (y < 8) y = 8;

  return { top: y + 'px', left: x + 'px' };
});

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

function onUserMessageChange(event: Event) {
  const el = event.target as HTMLTextAreaElement;
  emit('update-config', props.nodeId, {
    ...props.config,
    userMessage: el.value,
  });
}

function onPromptChange(event: Event) {
  const el = event.target as HTMLTextAreaElement;
  emit('update-config', props.nodeId, {
    ...props.config,
    additionalPrompt: el.value,
  });
}

function onBeforePromptChange(event: Event) {
  const el = event.target as HTMLTextAreaElement;
  emit('update-config', props.nodeId, {
    ...props.config,
    beforePrompt: el.value,
  });
}

function onSuccessCriteriaChange(event: Event) {
  const el = event.target as HTMLTextAreaElement;
  emit('update-config', props.nodeId, {
    ...props.config,
    successCriteria: el.value,
  });
}

function onCompletionContractChange(event: Event) {
  const el = event.target as HTMLTextAreaElement;
  emit('update-config', props.nodeId, {
    ...props.config,
    completionContract: el.value,
  });
}

/** Open variable menu from the icon button — anchor to the left of the button */
function openVarMenu(target: VarMenuTarget, event: MouseEvent) {
  if (varMenu.visible && varMenu.target === target) {
    closeVarMenu();
    return;
  }
  const btn = event.currentTarget as HTMLElement;
  const rect = btn.getBoundingClientRect();
  varMenu.target = target;
  // Anchor to right edge of button, menu opens to the left
  varMenu.rawX = rect.right - MENU_WIDTH;
  varMenu.rawY = rect.bottom + 4;
  varMenu.visible = true;
}

/** Open variable menu from right-click on a textarea */
function onTextareaContextMenu(target: VarMenuTarget, event: MouseEvent) {
  varMenu.target = target;
  varMenu.rawX = event.clientX;
  varMenu.rawY = event.clientY;
  varMenu.visible = true;
}

function closeVarMenu() {
  varMenu.visible = false;
}

function varToken(name: string): string {
  return `{{${name}}}`;
}

function insertVariable(varName: string) {
  const token = `{{${varName}}}`;
  const textareaRef = varMenu.target === 'userMessage' ? userMessageRef : varMenu.target === 'beforePrompt' ? beforePromptRef : additionalPromptRef;
  const textarea = textareaRef.value;

  if (textarea) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentValue = textarea.value;
    const newValue = currentValue.substring(0, start) + token + currentValue.substring(end);
    textarea.value = newValue;

    // Update the config
    const configKey = varMenu.target;
    emit('update-config', props.nodeId, {
      ...props.config,
      [configKey]: newValue,
    });

    // Restore cursor position after the inserted token
    const newCursorPos = start + token.length;
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    });
  }

  closeVarMenu();
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

.field-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.field-header .node-field-label {
  margin-bottom: 0;
}

.var-insert-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  background: #f1f5f9;
  color: #64748b;
  cursor: pointer;
  transition: all 0.15s;
}

.var-insert-btn:hover {
  background: #e2e8f0;
  color: #6366f1;
  border-color: #6366f1;
}

.var-insert-btn.dark {
  background: #2d2d44;
  border-color: #3c3c5c;
  color: #94a3b8;
}

.var-insert-btn.dark:hover {
  background: #3c3c5c;
  color: #818cf8;
  border-color: #818cf8;
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

.help-text code {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(99, 102, 241, 0.1);
  color: #6366f1;
}
</style>

<style>
/* Variable picker menu — unscoped so Teleport works */
.var-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
}

.var-menu {
  position: fixed;
  width: 260px;
  max-height: 320px;
  overflow-y: auto;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.12);
  z-index: 10001;
}

.var-menu.dark {
  background: var(--bg-surface, #1e293b);
  border-color: var(--border-default, #3c3c5c);
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}

.var-menu-header {
  padding: 8px 12px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
  border-bottom: 1px solid #e2e8f0;
}

.var-menu-header.dark {
  color: #94a3b8;
  border-bottom-color: #3c3c5c;
}

.var-menu-group {
  padding: 4px 0;
}

.var-menu-group-label {
  padding: 4px 12px;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #94a3b8;
}

.var-menu-group-label.dark {
  color: #64748b;
}

.var-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: #1e293b;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.var-menu-item:hover {
  background: #f1f5f9;
}

.var-menu-item.dark {
  color: #e2e8f0;
}

.var-menu-item.dark:hover {
  background: #2d2d44;
}

.var-menu-item code {
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(99, 102, 241, 0.1);
  color: #6366f1;
  white-space: nowrap;
}

.var-desc {
  font-size: 10px;
  color: #94a3b8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.var-menu-empty {
  padding: 12px;
  font-size: 11px;
  color: #94a3b8;
  text-align: center;
}

.var-menu-empty.dark {
  color: #64748b;
}
</style>
