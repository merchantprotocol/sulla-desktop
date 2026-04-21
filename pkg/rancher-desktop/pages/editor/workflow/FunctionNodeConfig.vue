<template>
  <div
    class="toolcall-config"
    :class="{ dark: isDark }"
  >
    <!-- Function picker -->
    <div class="node-field">
      <label
        class="node-field-label"
        :class="{ dark: isDark }"
      >Function</label>
      <input
        v-model="functionFilter"
        class="node-field-input"
        :class="{ dark: isDark }"
        type="text"
        placeholder="Search functions…"
      >
      <select
        class="node-field-input select-spaced"
        :class="{ dark: isDark }"
        :value="config.functionRef || ''"
        @change="onFunctionChange"
      >
        <option value="">
          -- Select Function --
        </option>
        <option
          v-for="fn in filteredFunctions"
          :key="fn.slug"
          :value="fn.slug"
        >
          {{ fn.name || fn.slug }} · {{ fn.runtime }}
        </option>
      </select>
      <div
        v-if="selectedFunction"
        class="fn-summary"
        :class="{ dark: isDark }"
      >
        <div class="fn-summary-head">
          <span class="fn-summary-name">{{ selectedFunction.name || selectedFunction.slug }}</span>
          <span
            class="runtime-badge"
            :class="[`rt-${ selectedFunction.runtime }`, { dark: isDark }]"
          >{{ selectedFunction.runtime }}</span>
        </div>
        <div
          v-if="selectedFunction.description"
          class="fn-summary-desc"
          :class="{ dark: isDark }"
        >
          {{ selectedFunction.description }}
        </div>
      </div>
    </div>

    <!-- Inputs -->
    <template v-if="selectedFunction && inputEntries.length > 0">
      <div class="section-divider" />
      <p
        class="section-title"
        :class="{ dark: isDark }"
      >
        Inputs
      </p>
      <div class="node-field">
        <div
          v-for="entry in inputEntries"
          :key="entry.name"
          class="param-row"
        >
          <div class="param-header">
            <span
              class="param-name"
              :class="{ dark: isDark }"
            >{{ entry.name }}</span>
            <span
              v-if="entry.required"
              class="param-required"
            >required</span>
            <span
              v-if="entry.type"
              class="param-type"
              :class="{ dark: isDark }"
            >{{ entry.type }}</span>
          </div>
          <div
            v-if="entry.description"
            class="param-desc"
            :class="{ dark: isDark }"
            :title="entry.description"
          >
            {{ entry.description }}
          </div>
          <div class="param-input-row">
            <input
              :ref="(el) => registerInputRef(entry.name, el as HTMLInputElement | null)"
              class="node-field-input"
              :class="{ dark: isDark }"
              :placeholder="entry.default != null ? String(entry.default) : 'Value or {{ upstream.result }}'"
              :value="config.inputs?.[entry.name] ?? ''"
              @input="onInputChange(entry.name, ($event.target as HTMLInputElement).value)"
            >
            <button
              class="var-insert-btn"
              :class="{ dark: isDark }"
              title="Insert variable"
              @click="openVarMenu(entry.name, $event)"
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
          <!-- Upstream chips — quick-insert helpers -->
          <div
            v-if="upstreamChips.length > 0"
            class="chip-row"
          >
            <button
              v-for="chip in upstreamChips"
              :key="chip.token"
              type="button"
              class="chip"
              :class="{ dark: isDark }"
              :title="`Insert ${ chip.token }`"
              @click="insertChip(entry.name, chip.token)"
            >
              {{ chip.label }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- Vault bindings -->
    <template v-if="envNames.length > 0">
      <div class="section-divider" />
      <p
        class="section-title"
        :class="{ dark: isDark }"
      >
        Vault Bindings
      </p>
      <div class="node-field">
        <p
          class="help-text"
          :class="{ dark: isDark }"
        >
          Each env var is resolved at invocation time from the Sulla vault.
          The resolved value never touches the database, logs, or agent context.
        </p>
        <div
          v-for="envName in envNames"
          :key="envName"
          class="param-row"
        >
          <div class="param-header">
            <span
              class="param-name"
              :class="{ dark: isDark }"
            >{{ envName }}</span>
            <span
              class="param-type"
              :class="{ dark: isDark }"
            >env</span>
          </div>
          <div class="vault-grid">
            <label
              class="sub-label"
              :class="{ dark: isDark }"
            >Account ID</label>
            <input
              class="node-field-input"
              :class="{ dark: isDark }"
              type="text"
              placeholder="e.g. default"
              :value="config.vaultAccounts?.[envName]?.accountId ?? ''"
              @input="onVaultChange(envName, 'accountId', ($event.target as HTMLInputElement).value)"
            >
            <label
              class="sub-label"
              :class="{ dark: isDark }"
            >Secret Path</label>
            <input
              class="node-field-input"
              :class="{ dark: isDark }"
              type="text"
              placeholder="e.g. stripe/live/secret_key"
              :value="config.vaultAccounts?.[envName]?.secretPath ?? ''"
              @input="onVaultChange(envName, 'secretPath', ($event.target as HTMLInputElement).value)"
            >
          </div>
        </div>
      </div>
    </template>

    <!-- Outputs (read-only) -->
    <template v-if="selectedFunction && outputEntries.length > 0">
      <div class="section-divider" />
      <p
        class="section-title"
        :class="{ dark: isDark }"
      >
        Outputs
      </p>
      <div class="node-field">
        <p
          class="help-text"
          :class="{ dark: isDark }"
        >
          Available downstream as <code v-text="'{{ ' + (nodeLabel || nodeId) + '.output.<name> }}'" />
        </p>
        <div
          v-for="entry in outputEntries"
          :key="entry.name"
          class="param-row readonly"
        >
          <div class="param-header">
            <span
              class="param-name"
              :class="{ dark: isDark }"
            >{{ entry.name }}</span>
            <span
              v-if="entry.type"
              class="param-type"
              :class="{ dark: isDark }"
            >{{ entry.type }}</span>
          </div>
          <div
            v-if="entry.description"
            class="param-desc"
            :class="{ dark: isDark }"
          >
            {{ entry.description }}
          </div>
        </div>
      </div>
    </template>

    <!-- Timeout override (collapsible) -->
    <div class="section-divider" />
    <div class="node-field">
      <button
        class="disclosure"
        :class="{ dark: isDark }"
        type="button"
        @click="timeoutOpen = !timeoutOpen"
      >
        <span class="disclosure-caret">{{ timeoutOpen ? '▾' : '▸' }}</span>
        <span>Timeout Override</span>
        <span
          v-if="config.timeoutOverride"
          class="disclosure-value"
        >{{ config.timeoutOverride }}</span>
      </button>
      <div
        v-if="timeoutOpen"
        class="disclosure-body"
      >
        <input
          class="node-field-input"
          :class="{ dark: isDark }"
          type="text"
          placeholder="e.g. 30s, 2m, 500ms (blank = use function default)"
          :value="config.timeoutOverride ?? ''"
          @input="onTimeoutChange(($event.target as HTMLInputElement).value)"
        >
        <p
          class="help-text"
          :class="{ dark: isDark }"
        >
          Override the function's declared timeout. Leave blank (or type
          <code>null</code>) to use the function default.
        </p>
      </div>
    </div>

    <!-- Variable picker menu -->
    <Teleport to="body">
      <div
        v-if="varMenu.visible"
        class="var-menu-overlay"
        @click="closeVarMenu"
      >
        <div
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
import { ipcRenderer } from 'electron';
import { ref, reactive, computed, onMounted } from 'vue';

import type { FunctionNodeConfig } from './types';

export interface UpstreamNodeInfo {
  nodeId:   string;
  label:    string;
  subtype:  string;
  category: string;
}

interface FunctionItem {
  slug:        string;
  name:        string;
  description: string;
  runtime:     'python' | 'shell' | 'node';
  inputs:      Record<string, Record<string, unknown>>;
  outputs:     Record<string, Record<string, unknown>>;
  permissions: { env: string[] };
}

interface SchemaEntry {
  name:         string;
  type:         string;
  description?: string;
  required?:    boolean;
  default?:     unknown;
}

const props = defineProps<{
  isDark:        boolean;
  nodeId:        string;
  config:        FunctionNodeConfig;
  upstreamNodes: UpstreamNodeInfo[];
  /** Optional label for the current node (used in output help copy). */
  nodeLabel?:    string;
}>();

const emit = defineEmits<{
  'update-config': [nodeId: string, config: FunctionNodeConfig];
}>();

const functions = ref<FunctionItem[]>([]);
const functionFilter = ref('');
const timeoutOpen = ref(false);
const inputRefs = new Map<string, HTMLInputElement>();

const MENU_WIDTH = 260;
const varMenu = reactive({
  visible:   false,
  paramName: '',
  rawX:      0,
  rawY:      0,
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

  return { top: `${ y }px`, left: `${ x }px` };
});

const selectedFunction = computed<FunctionItem | null>(() => {
  const ref = props.config?.functionRef;
  if (!ref) return null;

  return functions.value.find(f => f.slug === ref) ?? null;
});

const filteredFunctions = computed<FunctionItem[]>(() => {
  const q = functionFilter.value.trim().toLowerCase();
  if (!q) return functions.value;

  return functions.value.filter((f) => {
    return f.slug.toLowerCase().includes(q)
      || (f.name || '').toLowerCase().includes(q)
      || (f.description || '').toLowerCase().includes(q)
      || f.runtime.toLowerCase().includes(q);
  });
});

function schemaToEntries(schema: Record<string, Record<string, unknown>> | undefined): SchemaEntry[] {
  if (!schema) return [];

  return Object.entries(schema).map(([name, spec]) => {
    const raw = (spec || {}) as Record<string, unknown>;

    return {
      name,
      type:        typeof raw.type === 'string' ? raw.type : '',
      description: typeof raw.description === 'string' ? raw.description : undefined,
      required:    raw.required === true,
      default:     raw.default,
    };
  });
}

const inputEntries = computed<SchemaEntry[]>(() => schemaToEntries(selectedFunction.value?.inputs));
const outputEntries = computed<SchemaEntry[]>(() => schemaToEntries(selectedFunction.value?.outputs));
const envNames = computed<string[]>(() => selectedFunction.value?.permissions?.env ?? []);

const upstreamChips = computed<{ label: string; token: string }[]>(() => {
  const out: { label: string; token: string }[] = [];
  out.push({ label: 'trigger', token: '{{ trigger.result }}' });
  for (const node of props.upstreamNodes) {
    out.push({
      label: node.label,
      token: `{{ ${ node.label }.result }}`,
    });
  }

  return out;
});

function registerInputRef(name: string, el: HTMLInputElement | null) {
  if (el) {
    inputRefs.set(name, el);
  } else {
    inputRefs.delete(name);
  }
}

function emitPatch(patch: Partial<FunctionNodeConfig>) {
  emit('update-config', props.nodeId, {
    ...currentConfig(),
    ...patch,
  });
}

function currentConfig(): FunctionNodeConfig {
  return {
    functionRef:     props.config?.functionRef ?? '',
    inputs:          props.config?.inputs ?? {},
    vaultAccounts:   props.config?.vaultAccounts ?? {},
    timeoutOverride: props.config?.timeoutOverride ?? null,
  };
}

function hasBindings(): boolean {
  const cfg = currentConfig();
  const inputCount = Object.keys(cfg.inputs || {}).length;
  const vaultCount = Object.keys(cfg.vaultAccounts || {}).length;

  return inputCount > 0 || vaultCount > 0;
}

function onFunctionChange(event: Event) {
  const el = event.target as HTMLSelectElement;
  const slug = el.value;

  if (slug === (props.config?.functionRef ?? '')) return;

  if (hasBindings()) {
    const proceed = typeof window !== 'undefined'
      ? window.confirm('Changing the function will clear your current input and vault bindings. Continue?')
      : true;
    if (!proceed) {
      // revert the select to the previous value
      el.value = props.config?.functionRef ?? '';

      return;
    }
  }

  emit('update-config', props.nodeId, {
    functionRef:     slug,
    inputs:          {},
    vaultAccounts:   {},
    timeoutOverride: props.config?.timeoutOverride ?? null,
  });
}

function onInputChange(name: string, value: string) {
  const inputs = { ...(props.config?.inputs ?? {}) };
  if (value === '') {
    delete inputs[name];
  } else {
    inputs[name] = value;
  }
  emitPatch({ inputs });
}

function onVaultChange(envName: string, field: 'accountId' | 'secretPath', value: string) {
  const vaultAccounts = { ...(props.config?.vaultAccounts ?? {}) };
  const existing = vaultAccounts[envName] ?? { accountId: '', secretPath: '' };
  const next = { ...existing, [field]: value };
  if (!next.accountId && !next.secretPath) {
    delete vaultAccounts[envName];
  } else {
    vaultAccounts[envName] = next;
  }
  emitPatch({ vaultAccounts });
}

function onTimeoutChange(value: string) {
  const trimmed = value.trim();
  const next = (trimmed === '' || trimmed.toLowerCase() === 'null') ? null : trimmed;
  emitPatch({ timeoutOverride: next });
}

function varToken(name: string): string {
  return `{{ ${ name } }}`;
}

function insertChip(paramName: string, token: string) {
  insertAtCursor(paramName, token);
}

function openVarMenu(paramName: string, event: MouseEvent) {
  const btn = event.currentTarget as HTMLElement;
  const rect = btn.getBoundingClientRect();
  varMenu.paramName = paramName;
  varMenu.rawX = rect.right - MENU_WIDTH;
  varMenu.rawY = rect.bottom + 4;
  varMenu.visible = true;
}

function closeVarMenu() {
  varMenu.visible = false;
}

function insertVariable(varName: string) {
  const token = `{{ ${ varName } }}`;
  const paramName = varMenu.paramName;
  insertAtCursor(paramName, token);
  closeVarMenu();
}

function insertAtCursor(paramName: string, token: string) {
  const el = inputRefs.get(paramName);
  const current = props.config?.inputs?.[paramName] ?? '';

  if (el && typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = current.slice(0, start) + token + current.slice(end);
    onInputChange(paramName, next);
    // Move caret to just after the inserted token on next tick.
    setTimeout(() => {
      const pos = start + token.length;
      try {
        el.focus();
        el.setSelectionRange(pos, pos);
      } catch {
        /* noop */
      }
    }, 0);

    return;
  }
  onInputChange(paramName, current + token);
}

onMounted(async() => {
  try {
    const list = await ipcRenderer.invoke('functions-list');
    functions.value = (list ?? []).map((f: any): FunctionItem => ({
      slug:        f.slug,
      name:        f.name,
      description: f.description,
      runtime:     f.runtime,
      inputs:      f.inputs ?? {},
      outputs:     f.outputs ?? {},
      permissions: { env: Array.isArray(f.permissions?.env) ? f.permissions.env : [] },
    }));
  } catch {
    functions.value = [];
  }
});
</script>

<style scoped>
.toolcall-config {
  padding: 0;
}

.node-field {
  padding: 12px;
  border-bottom: 1px solid var(--bg-surface-hover);
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

.select-spaced { margin-top: 6px; }

.fn-summary {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--bg-surface-hover);
  border-radius: 4px;
  background: var(--bg-surface-alt);
}
.fn-summary-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.fn-summary-name {
  font-size: var(--fs-code);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}
.fn-summary-desc {
  margin-top: 4px;
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  line-height: 1.4;
}
.fn-summary-desc.dark { color: var(--text-secondary); }

.runtime-badge {
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wider);
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--bg-accent);
  color: var(--text-info);
}
.runtime-badge.rt-python { opacity: 0.95; }
.runtime-badge.rt-node   { opacity: 0.95; }
.runtime-badge.rt-shell  { opacity: 0.95; }

.section-divider {
  border-top: 1px solid var(--bg-surface-hover);
}

.section-title {
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wider);
  color: var(--text-secondary);
  margin: 0;
  padding: 12px 12px 0;
}

.param-row {
  margin-bottom: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--bg-surface-alt);
}
.param-row:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}
.param-row.readonly { opacity: 0.92; }

.param-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.param-name {
  font-size: var(--fs-code);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.param-required {
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  color: var(--text-error);
  background: var(--bg-error);
  padding: 1px 4px;
  border-radius: 3px;
}

.param-type {
  font-size: var(--fs-caption);
  color: var(--text-muted);
}
.param-type.dark { color: var(--text-secondary); }

.param-desc {
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  margin-bottom: 4px;
  line-height: 1.4;
}
.param-desc.dark { color: var(--text-secondary); }

.param-input-row {
  display: flex;
  gap: 4px;
  align-items: center;
}
.param-input-row .node-field-input {
  flex: 1;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.chip {
  font-size: var(--fs-caption);
  padding: 2px 7px;
  border-radius: 11px;
  border: 1px solid var(--bg-surface-hover);
  background: var(--bg-surface-alt);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  font-family: monospace;
}
.chip:hover {
  background: var(--bg-hover);
  color: var(--text-info);
  border-color: var(--accent-primary);
}

.var-insert-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--bg-surface-hover);
  border-radius: 4px;
  background: var(--bg-surface-alt);
  color: var(--text-secondary);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s;
}
.var-insert-btn:hover {
  background: var(--bg-surface-hover);
  color: var(--text-info);
  border-color: var(--accent-primary);
}

.vault-grid {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 4px 8px;
  align-items: center;
}
.sub-label {
  font-size: var(--fs-caption);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wider);
}
.sub-label.dark { color: var(--text-secondary); }

.help-text {
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  margin: 0 0 8px;
  line-height: 1.5;
}
.help-text.dark { color: var(--text-secondary); }
.help-text code {
  font-size: var(--fs-caption);
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg-accent);
  color: var(--text-info);
}

.disclosure {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 0;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wider);
  cursor: pointer;
}
.disclosure.dark { color: var(--text-muted); }
.disclosure-caret {
  display: inline-block;
  width: 10px;
  color: var(--text-muted);
}
.disclosure-value {
  margin-left: auto;
  font-family: monospace;
  text-transform: none;
  color: var(--text-info);
}
.disclosure-body {
  margin-top: 8px;
}
</style>
