<template>
  <div
    class="agent-config"
    :class="{ dark: isDark }"
  >
    <div class="node-field">
      <label
        class="node-field-label"
        :class="{ dark: isDark }"
      >Agent</label>
      <div
        ref="comboWrapperRef"
        class="combo-wrapper"
      >
        <input
          ref="comboInputRef"
          class="node-field-input combo-input"
          :class="{ dark: isDark }"
          :value="comboQuery"
          placeholder="Search or select an agent..."
          autocomplete="off"
          @focus="onComboFocus"
          @input="onComboInput"
          @keydown="onComboKeydown"
        >
        <button
          class="combo-toggle"
          :class="{ dark: isDark }"
          tabindex="-1"
          @mousedown.prevent="toggleComboDropdown"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <div
          v-if="comboOpen"
          class="combo-dropdown"
          :class="{ dark: isDark }"
        >
          <div
            v-if="filteredAgents.length === 0"
            class="combo-empty"
          >
            No agents found
          </div>
          <button
            v-for="(a, idx) in filteredAgents"
            :key="a.id"
            class="combo-option"
            :class="{ active: idx === comboHighlight, selected: a.id === config.agentId, dark: isDark }"
            @mousedown.prevent="selectAgent(a)"
            @mouseenter="comboHighlight = idx"
          >
            <span class="combo-option-name">{{ a.name }}</span>
            <span
              v-if="a.description"
              class="combo-option-desc"
            >{{ a.description }}</span>
          </button>
        </div>
      </div>
    </div>

    <div class="node-field">
      <div class="field-header">
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Additional Prompt</label>
        <button
          class="var-insert-btn"
          :class="{ dark: isDark }"
          title="Insert variable"
          @click="openVarMenu('additionalPrompt', $event)"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
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
      />
    </div>

    <div class="node-field">
      <div class="field-header">
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Orchestrator Instructions</label>
        <button
          class="var-insert-btn"
          :class="{ dark: isDark }"
          title="Insert variable"
          @click="openVarMenu('orchestratorInstructions', $event)"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
        </button>
      </div>
      <textarea
        ref="orchestratorInstructionsRef"
        class="node-field-input node-field-textarea"
        :class="{ dark: isDark }"
        rows="4"
        placeholder="Guide the orchestrator on how to deploy this sub-agent. The orchestrator will formulate the actual task message..."
        :value="config.orchestratorInstructions || ''"
        @input="onOrchestratorInstructionsChange"
        @contextmenu.prevent="onTextareaContextMenu('orchestratorInstructions', $event)"
      />
    </div>

    <div class="node-field">
      <label
        class="node-field-label"
        :class="{ dark: isDark }"
      >Success Criteria</label>
      <textarea
        class="node-field-input node-field-textarea"
        :class="{ dark: isDark }"
        rows="3"
        placeholder="How the orchestrator validates this agent's output..."
        :value="config.successCriteria || ''"
        @input="onSuccessCriteriaChange"
      />
    </div>

    <div class="node-field">
      <label
        class="node-field-label"
        :class="{ dark: isDark }"
      >Completion Contract</label>
      <textarea
        class="node-field-input node-field-textarea"
        :class="{ dark: isDark }"
        rows="5"
        placeholder="HAND_BACK&#10;Summary: [1-3 paragraph summary of what was accomplished]&#10;Artifact: /artifacts/[path-to-output-file]&#10;Needs user input: yes/no&#10;Suggested next action: [optional next step]"
        :value="config.completionContract || ''"
        @input="onCompletionContractChange"
      />
    </div>

    <div
      class="node-field help-section"
      :class="{ dark: isDark }"
    >
      <p
        class="help-title"
        :class="{ dark: isDark }"
      >
        How agents work
      </p>
      <p
        class="help-text"
        :class="{ dark: isDark }"
      >
        Select a Sulla agent to run at this step. The <strong>orchestrator</strong> formulates the
        actual task message based on your instructions and upstream context.
      </p>
      <p
        class="help-text"
        :class="{ dark: isDark }"
      >
        <strong>Additional Prompt</strong> is injected directly into the sub-agent's prompt.
        <strong>Orchestrator Instructions</strong> guide the orchestrator on what to tell the sub-agent.
      </p>
      <p
        class="help-text"
        :class="{ dark: isDark }"
      >
        <strong>Completion Contract</strong> describes the response format the sub-agent must follow,
        wrapped in <code>&lt;completion-contract&gt;</code> tags.
        <strong>Success Criteria</strong> is used by the orchestrator to evaluate the response after the agent completes.
      </p>
      <p
        class="help-text"
        :class="{ dark: isDark }"
      >
        Click the <code>&lt;/&gt;</code> icon or <strong>right-click</strong> in a textarea to
        insert <strong>variables</strong> from upstream nodes &mdash; e.g.
        <code v-text="varToken('trigger.result')" />.
      </p>
    </div>

    <!-- Variable picker menu (teleported to body) -->
    <Teleport to="body">
      <div
        v-if="varMenu.visible"
        class="var-menu-overlay"
        @click="closeVarMenu"
      >
        <div
          ref="varMenuRef"
          class="var-menu"
          :class="{ dark: isDark }"
          :style="varMenuStyle"
          @click.stop
        >
          <div
            class="var-menu-header"
            :class="{ dark: isDark }"
          >
            Insert Variable
          </div>

          <!-- Trigger (always available) -->
          <div class="var-menu-group">
            <div
              class="var-menu-group-label"
              :class="{ dark: isDark }"
            >
              Trigger
            </div>
            <button
              class="var-menu-item"
              :class="{ dark: isDark }"
              @click="insertVariable('trigger.result')"
            >
              <code v-text="varToken('trigger.result')" />
              <span class="var-desc">Trigger payload</span>
            </button>
          </div>

          <!-- Upstream nodes -->
          <div
            v-if="upstreamNodes.length > 0"
            class="var-menu-group"
          >
            <div
              class="var-menu-group-label"
              :class="{ dark: isDark }"
            >
              Upstream Nodes
            </div>
            <template
              v-for="node in upstreamNodes"
              :key="node.nodeId"
            >
              <button
                class="var-menu-item"
                :class="{ dark: isDark }"
                @click="insertVariable(node.label + '.result')"
              >
                <code v-text="varToken(node.label + '.result')" />
                <span class="var-desc">Output from {{ node.label }}</span>
              </button>
              <button
                v-if="node.category === 'agent'"
                class="var-menu-item"
                :class="{ dark: isDark }"
                @click="insertVariable(node.label + '.threadId')"
              >
                <code v-text="varToken(node.label + '.threadId')" />
                <span class="var-desc">Thread ID from {{ node.label }}</span>
              </button>
            </template>
          </div>

          <div
            v-if="upstreamNodes.length === 0"
            class="var-menu-empty"
            :class="{ dark: isDark }"
          >
            No upstream nodes connected yet.
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ipcRenderer } from 'electron';
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';

import type { AgentNodeConfig } from './types';

export interface UpstreamNodeInfo {
  nodeId:   string;
  label:    string;
  subtype:  string;
  category: string;
}

const props = defineProps<{
  isDark:        boolean;
  nodeId:        string;
  config:        AgentNodeConfig;
  upstreamNodes: UpstreamNodeInfo[];
}>();

const emit = defineEmits<{
  'update-config': [nodeId: string, config: AgentNodeConfig];
}>();

interface AgentInfo {
  id:          string;
  name:        string;
  description: string;
  type:        string;
}

const agents = ref<AgentInfo[]>([]);
const orchestratorInstructionsRef = ref<HTMLTextAreaElement | null>(null);
const additionalPromptRef = ref<HTMLTextAreaElement | null>(null);
const varMenuRef = ref<HTMLElement | null>(null);
const comboInputRef = ref<HTMLInputElement | null>(null);
const comboWrapperRef = ref<HTMLElement | null>(null);
const comboOpen = ref(false);
const comboSearch = ref('');
const comboHighlight = ref(0);

const MENU_WIDTH = 260;

type VarMenuTarget = 'orchestratorInstructions' | 'additionalPrompt';

const varMenu = reactive({
  visible: false,
  target:  '' as VarMenuTarget,
  rawX:    0,
  rawY:    0,
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

// ── Combobox logic ──

const comboQuery = computed(() => {
  if (comboOpen.value) return comboSearch.value;
  const selected = agents.value.find(a => a.id === props.config.agentId);
  return selected?.name ?? '';
});

const filteredAgents = computed(() => {
  const q = comboSearch.value.toLowerCase().trim();
  if (!q) return agents.value;
  return agents.value.filter(a =>
    a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q),
  );
});

function onComboFocus() {
  comboSearch.value = '';
  comboOpen.value = true;
  comboHighlight.value = 0;
}

function onComboInput(e: Event) {
  comboSearch.value = (e.target as HTMLInputElement).value;
  comboOpen.value = true;
  comboHighlight.value = 0;
}

function onComboKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (comboHighlight.value < filteredAgents.value.length - 1) comboHighlight.value++;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (comboHighlight.value > 0) comboHighlight.value--;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const agent = filteredAgents.value[comboHighlight.value];
    if (agent) selectAgent(agent);
  } else if (e.key === 'Escape') {
    comboOpen.value = false;
    comboInputRef.value?.blur();
  }
}

function toggleComboDropdown() {
  if (comboOpen.value) {
    comboOpen.value = false;
  } else {
    comboSearch.value = '';
    comboOpen.value = true;
    comboHighlight.value = 0;
    comboInputRef.value?.focus();
  }
}

function selectAgent(agent: AgentInfo) {
  comboOpen.value = false;
  comboSearch.value = '';
  emit('update-config', props.nodeId, {
    ...props.config,
    agentId:   agent.id,
    agentName: agent.name,
  });
}

function onClickOutsideCombo(e: MouseEvent) {
  if (comboWrapperRef.value && !comboWrapperRef.value.contains(e.target as Node)) {
    comboOpen.value = false;
  }
}

onMounted(async() => {
  try {
    agents.value = await ipcRenderer.invoke('agents-list');
  } catch {
    agents.value = [];
  }
  document.addEventListener('mousedown', onClickOutsideCombo);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutsideCombo);
});

function onOrchestratorInstructionsChange(event: Event) {
  const el = event.target as HTMLTextAreaElement;
  emit('update-config', props.nodeId, {
    ...props.config,
    orchestratorInstructions: el.value,
  });
}

function onPromptChange(event: Event) {
  const el = event.target as HTMLTextAreaElement;
  emit('update-config', props.nodeId, {
    ...props.config,
    additionalPrompt: el.value,
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
  return `{{${ name }}}`;
}

function insertVariable(varName: string) {
  const token = `{{${ varName }}}`;
  const textareaRef = varMenu.target === 'orchestratorInstructions' ? orchestratorInstructionsRef : additionalPromptRef;
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
  border-bottom: 1px solid var(--border-default);
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
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: var(--bg-surface-alt);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.var-insert-btn:hover {
  background: var(--bg-surface-hover);
  color: var(--text-info);
  border-color: var(--border-accent);
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

.node-field-label.dark {
  color: var(--text-muted);
}

.node-field-input {
  width: 100%;
  padding: 6px 8px;
  font-size: var(--fs-code);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-primary);
  outline: none;
  box-sizing: border-box;
}

.node-field-input:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

.node-field-textarea {
  resize: vertical;
  font-family: inherit;
  min-height: 60px;
}

/* ── Combobox ── */
.combo-wrapper {
  position: relative;
}

.combo-input {
  padding-right: 28px;
}

.combo-toggle {
  position: absolute;
  right: 1px;
  top: 1px;
  bottom: 1px;
  width: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 0 4px 4px 0;
}

.combo-toggle:hover {
  color: var(--text-secondary);
  background: var(--bg-surface-hover);
}

.combo-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 2px;
  max-height: 200px;
  overflow-y: auto;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.12);
  z-index: 100;
}

.combo-option {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--fs-code);
  cursor: pointer;
  text-align: left;
}

.combo-option.active,
.combo-option:hover {
  background: var(--bg-surface-hover);
}

.combo-option.selected {
  color: var(--text-info);
}

.combo-option-name {
  font-weight: var(--weight-medium);
}

.combo-option-desc {
  font-size: var(--fs-caption);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.combo-empty {
  padding: 10px;
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  text-align: center;
}

.help-section { border-bottom: none; }

.help-title {
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wider);
  color: var(--text-secondary);
  margin: 0 0 8px;
}
.help-title.dark { color: var(--text-muted); }

.help-text {
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  margin: 0 0 6px;
  line-height: 1.5;
}
.help-text:last-child { margin-bottom: 0; }
.help-text.dark { color: var(--text-secondary); }

.help-text code {
  font-size: var(--fs-caption);
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg-accent);
  color: var(--text-info);
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
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.12);
  z-index: 10001;
}

.var-menu-header {
  padding: 8px 12px;
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wider);
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-default);
}

.var-menu-header.dark {
  color: var(--text-muted);
  border-bottom-color: var(--border-default);
}

.var-menu-group {
  padding: 4px 0;
}

.var-menu-group-label {
  padding: 4px 12px;
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wider);
  color: var(--text-muted);
}

.var-menu-group-label.dark {
  color: var(--text-secondary);
}

.var-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--fs-code);
  cursor: pointer;
  text-align: left;
}

.var-menu-item:hover {
  background: var(--bg-surface-alt);
}

.var-menu-item code {
  font-size: var(--fs-body-sm);
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg-accent);
  color: var(--text-info);
  white-space: nowrap;
}

.var-desc {
  font-size: var(--fs-caption);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.var-menu-empty {
  padding: 12px;
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  text-align: center;
}

.var-menu-empty.dark {
  color: var(--text-secondary);
}
</style>
