<template>
  <div
    class="orchestrator-prompt-config"
    :class="{ dark: isDark }"
  >
    <div class="node-field">
      <div class="field-header">
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Prompt</label>
        <button
          class="var-insert-btn"
          :class="{ dark: isDark }"
          title="Insert variable"
          @click="openVarMenu($event)"
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
        ref="promptRef"
        class="node-field-input node-field-textarea"
        :class="{ dark: isDark }"
        rows="6"
        placeholder="Leave empty to auto-pass all upstream context, or write a custom prompt..."
        :value="config.prompt || ''"
        @input="onPromptChange"
        @contextmenu.prevent="openVarMenuAt($event)"
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
        How this works
      </p>
      <p
        class="help-text"
        :class="{ dark: isDark }"
      >
        This message is sent to the <strong>orchestrating agent</strong>.
        The orchestrator's response becomes this node's output.
      </p>
      <p
        class="help-text"
        :class="{ dark: isDark }"
      >
        <strong>Leave the prompt empty</strong> to automatically pass all upstream node outputs
        and trigger data to the orchestrator &mdash; no variables needed.
      </p>
      <p
        class="help-text"
        :class="{ dark: isDark }"
      >
        If you write a custom prompt, use the <code>&lt;/&gt;</code> button or
        <strong>right-click</strong> to insert specific upstream values where you need them.
      </p>
    </div>

    <!-- Variable picker menu -->
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
import { ref, reactive, computed } from 'vue';
import type { UpstreamNodeInfo } from './AgentNodeConfig.vue';

const MENU_WIDTH = 260;

const props = defineProps<{
  isDark:        boolean;
  nodeId:        string;
  config:        Record<string, any>;
  upstreamNodes: UpstreamNodeInfo[];
}>();

const emit = defineEmits<{
  'update-config': [nodeId: string, config: Record<string, any>];
}>();

const promptRef = ref<HTMLTextAreaElement | null>(null);
const varMenuRef = ref<HTMLElement | null>(null);

const varMenu = reactive({
  visible: false,
  rawX:    0,
  rawY:    0,
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

function onPromptChange(event: Event) {
  const el = event.target as HTMLTextAreaElement;
  emit('update-config', props.nodeId, { ...props.config, prompt: el.value });
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

function openVarMenuAt(event: MouseEvent) {
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
  const textarea = promptRef.value;

  if (textarea) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentValue = textarea.value;
    const newValue = currentValue.substring(0, start) + token + currentValue.substring(end);
    textarea.value = newValue;

    emit('update-config', props.nodeId, { ...props.config, prompt: newValue });

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
.orchestrator-prompt-config { padding: 0; }

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

.field-header .node-field-label { margin-bottom: 0; }

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
.node-field-label.dark { color: var(--text-muted); }

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
  min-height: 80px;
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
</style>
