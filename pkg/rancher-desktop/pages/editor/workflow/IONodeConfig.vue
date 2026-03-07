<template>
  <div class="io-config" :class="{ dark: isDark }">
    <!-- User Input -->
    <template v-if="subtype === 'user-input'">
      <div class="node-field">
        <label class="node-field-label" :class="{ dark: isDark }">Prompt Text</label>
        <textarea
          class="node-field-input node-field-textarea"
          :class="{ dark: isDark }"
          rows="3"
          placeholder="e.g. Please provide your order number so I can look it up"
          :value="config.promptText || ''"
          @input="updateField('promptText', ($event.target as HTMLTextAreaElement).value)"
        ></textarea>
      </div>
      <div class="node-field help-section">
        <p class="help-text" :class="{ dark: isDark }">
          Pauses the workflow and sends the prompt text to the user. The workflow resumes
          when the user replies, and their response is passed to the next node as input.
        </p>
      </div>
    </template>

    <!-- Transfer -->
    <template v-else-if="subtype === 'transfer'">
      <div class="node-field">
        <label class="node-field-label" :class="{ dark: isDark }">Target Workflow</label>
        <select
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="config.targetWorkflowId || ''"
          @change="updateField('targetWorkflowId', ($event.target as HTMLSelectElement).value || null)"
        >
          <option value="">-- Select Workflow --</option>
          <option v-for="wf in workflows" :key="wf.id" :value="wf.id">{{ wf.name }}</option>
        </select>
      </div>
      <div class="node-field help-section">
        <p class="help-text" :class="{ dark: isDark }">
          Hands off the conversation to another workflow entirely. The current workflow ends
          and the target workflow takes over from this point. Use this for escalation
          or switching between completely different conversation flows.
        </p>
      </div>
    </template>

    <!-- Response -->
    <template v-else-if="subtype === 'response'">
      <div class="node-field">
        <div class="field-header">
          <label class="node-field-label" :class="{ dark: isDark }">Response Template</label>
          <button
            class="var-insert-btn"
            :class="{ dark: isDark }"
            title="Insert variable"
            @click="openVarMenu($event)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="16 18 22 12 16 6"></polyline>
              <polyline points="8 6 2 12 8 18"></polyline>
            </svg>
          </button>
        </div>
        <textarea
          ref="responseTemplateRef"
          class="node-field-input node-field-textarea"
          :class="{ dark: isDark }"
          rows="4"
          placeholder="Leave empty to pass through upstream output, or use {{variable}} syntax..."
          :value="config.responseTemplate || ''"
          @input="updateField('responseTemplate', ($event.target as HTMLTextAreaElement).value)"
          @contextmenu.prevent="onContextMenu($event)"
        ></textarea>
      </div>
      <div class="node-field help-section">
        <p class="help-text" :class="{ dark: isDark }">
          Sends a response back to the user. Use the template to compose the output from
          upstream variables, or leave it empty to pass through the previous node's output directly.
        </p>
      </div>
    </template>

    <!-- Variable picker menu (teleported to body) -->
    <Teleport to="body">
      <div v-if="varMenu.visible" class="var-menu-overlay" @click="closeVarMenu">
        <div
          class="var-menu"
          :class="{ dark: isDark }"
          :style="varMenuStyle"
          @click.stop
        >
          <div class="var-menu-header" :class="{ dark: isDark }">Insert Variable</div>

          <div class="var-menu-group">
            <div class="var-menu-group-label" :class="{ dark: isDark }">Trigger</div>
            <button class="var-menu-item" :class="{ dark: isDark }" @click="insertVariable('trigger.result')">
              <code v-text="varToken('trigger.result')"></code>
              <span class="var-desc">Trigger payload</span>
            </button>
          </div>

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
import { ref, reactive, computed, onMounted } from 'vue';
import { ipcRenderer } from 'electron';
import type { IONodeSubtype } from './types';
import type { UpstreamNodeInfo } from './AgentNodeConfig.vue';

const MENU_WIDTH = 260;

const props = defineProps<{
  isDark: boolean;
  nodeId: string;
  subtype: IONodeSubtype;
  config: Record<string, any>;
  upstreamNodes?: UpstreamNodeInfo[];
}>();

const emit = defineEmits<{
  'update-config': [nodeId: string, config: Record<string, any>];
}>();

const workflows = ref<{ id: string; name: string }[]>([]);
const responseTemplateRef = ref<HTMLTextAreaElement | null>(null);

const varMenu = reactive({
  visible: false,
  rawX: 0,
  rawY: 0,
});

const varMenuStyle = computed(() => {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const menuHeight = 320;

  let x = varMenu.rawX;
  let y = varMenu.rawY;

  if (x + MENU_WIDTH > vw - 8) x = vw - MENU_WIDTH - 8;
  if (x < 8) x = 8;
  if (y + menuHeight > vh - 8) y = vh - menuHeight - 8;
  if (y < 8) y = 8;

  return { top: y + 'px', left: x + 'px' };
});

const upstreamNodes = computed(() => props.upstreamNodes || []);

onMounted(async() => {
  if (props.subtype === 'transfer') {
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

function openVarMenu(event: MouseEvent) {
  if (varMenu.visible) {
    closeVarMenu();
    return;
  }
  const btn = event.currentTarget as HTMLElement;
  const rect = btn.getBoundingClientRect();
  varMenu.rawX = rect.right - MENU_WIDTH;
  varMenu.rawY = rect.bottom + 4;
  varMenu.visible = true;
}

function onContextMenu(event: MouseEvent) {
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
  const textarea = responseTemplateRef.value;

  if (textarea) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentValue = textarea.value;
    const newValue = currentValue.substring(0, start) + token + currentValue.substring(end);
    textarea.value = newValue;

    updateField('responseTemplate', newValue);

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
.io-config { padding: 0; }

.node-field {
  padding: 12px;
  border-bottom: 1px solid #e2e8f0;
}
.io-config.dark .node-field { border-bottom-color: #3c3c5c; }

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
  min-height: 60px;
}

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
