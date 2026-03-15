<template>
  <div
    class="toolcall-config"
    :class="{ dark: isDark }"
  >
    <!-- Integration selector -->
    <div class="node-field">
      <label
        class="node-field-label"
        :class="{ dark: isDark }"
      >Integration</label>
      <select
        class="node-field-input"
        :class="{ dark: isDark }"
        :value="config.integrationSlug || ''"
        @change="onIntegrationChange"
      >
        <option value="">
          -- Select Integration --
        </option>
        <option
          v-for="i in integrations"
          :key="i.slug"
          :value="i.slug"
        >
          {{ i.slug }} ({{ i.version }})
        </option>
      </select>
    </div>

    <!-- Endpoint selector -->
    <div
      v-if="config.integrationSlug"
      class="node-field"
    >
      <label
        class="node-field-label"
        :class="{ dark: isDark }"
      >Endpoint</label>
      <select
        class="node-field-input"
        :class="{ dark: isDark }"
        :value="config.endpointName || ''"
        @change="onEndpointChange"
      >
        <option value="">
          -- Select Endpoint --
        </option>
        <option
          v-for="ep in endpoints"
          :key="ep.name"
          :value="ep.name"
        >
          {{ ep.method }} {{ ep.name }} &mdash; {{ ep.description }}
        </option>
      </select>
    </div>

    <!-- Account selector -->
    <div
      v-if="config.integrationSlug"
      class="node-field"
    >
      <label
        class="node-field-label"
        :class="{ dark: isDark }"
      >Connection (Account)</label>
      <select
        class="node-field-input"
        :class="{ dark: isDark }"
        :value="config.accountId || 'default'"
        @change="onAccountChange"
      >
        <option
          v-for="acc in accounts"
          :key="acc.account_id"
          :value="acc.account_id"
        >
          {{ acc.label || acc.account_id }}{{ acc.connected ? ' (connected)' : '' }}
        </option>
        <option
          v-if="accounts.length === 0"
          value="default"
        >
          default
        </option>
      </select>
    </div>

    <!-- Parameter defaults -->
    <div
      v-if="selectedEndpoint && paramDefs.length > 0"
      class="node-field"
    >
      <label
        class="node-field-label"
        :class="{ dark: isDark }"
      >Parameters</label>
      <div
        v-for="param in paramDefs"
        :key="param.name"
        class="param-row"
      >
        <div class="param-header">
          <span
            class="param-name"
            :class="{ dark: isDark }"
          >{{ param.name }}</span>
          <span
            v-if="param.required"
            class="param-required"
          >required</span>
          <span
            v-if="param.type"
            class="param-type"
            :class="{ dark: isDark }"
          >{{ param.type }}</span>
        </div>
        <div
          v-if="param.description"
          class="param-desc"
          :class="{ dark: isDark }"
        >
          {{ param.description }}
        </div>
        <div class="param-input-row">
          <input
            class="node-field-input"
            :class="{ dark: isDark }"
            :placeholder="param.default != null ? String(param.default) : 'Value or {{variable}}'"
            :value="config.defaults[param.name] || ''"
            @input="onParamChange(param.name, ($event.target as HTMLInputElement).value)"
          >
          <button
            class="var-insert-btn"
            :class="{ dark: isDark }"
            title="Insert variable"
            @click="openVarMenu(param.name, $event)"
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
        <div
          v-if="param.enum && param.enum.length > 0"
          class="param-enum"
          :class="{ dark: isDark }"
        >
          Options: {{ param.enum.join(', ') }}
        </div>
      </div>
    </div>

    <!-- Pre-call description -->
    <div class="node-field">
      <label
        class="node-field-label"
        :class="{ dark: isDark }"
      >Pre-Call Description</label>
      <textarea
        class="node-field-input node-field-textarea"
        :class="{ dark: isDark }"
        rows="3"
        placeholder="Describe the purpose of this call for the orchestrator to validate parameters..."
        :value="config.preCallDescription || ''"
        @input="onPreCallDescriptionChange"
      />
    </div>

    <!-- Help -->
    <div
      class="node-field help-section"
      :class="{ dark: isDark }"
    >
      <p
        class="help-title"
        :class="{ dark: isDark }"
      >
        How tool calls work
      </p>
      <p
        class="help-text"
        :class="{ dark: isDark }"
      >
        Select an <strong>integration</strong> and <strong>endpoint</strong> to call at this workflow step.
        Set default values for parameters, or use <code v-text="'{{variable}}'" /> to inject outputs from
        upstream nodes.
      </p>
      <p
        class="help-text"
        :class="{ dark: isDark }"
      >
        The <strong>Connection</strong> determines which saved credentials are used for authentication.
        Use <strong>Pre-Call Description</strong> to tell the orchestrator what this call should accomplish
        so it can validate the parameters before execution.
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
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { ipcRenderer } from 'electron';
import type { ToolCallNodeConfig } from './types';

export interface UpstreamNodeInfo {
  nodeId:   string;
  label:    string;
  subtype:  string;
  category: string;
}

interface IntegrationInfo {
  slug:      string;
  version:   string;
  endpoints: EndpointInfo[];
}

interface EndpointInfo {
  name:         string;
  path:         string;
  method:       string;
  description:  string;
  auth:         string;
  queryParams?: ParamInfo[];
}

interface ParamInfo {
  name:         string;
  type:         string;
  required:     boolean;
  default?:     any;
  description?: string;
  enum?:        string[];
}

interface AccountInfo {
  account_id: string;
  label:      string;
  connected:  boolean;
}

const props = defineProps<{
  isDark:        boolean;
  nodeId:        string;
  config:        ToolCallNodeConfig;
  upstreamNodes: UpstreamNodeInfo[];
}>();

const emit = defineEmits<{
  'update-config': [nodeId: string, config: ToolCallNodeConfig];
}>();

const integrations = ref<IntegrationInfo[]>([]);
const accounts = ref<AccountInfo[]>([]);
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
  return { top: y + 'px', left: x + 'px' };
});

const endpoints = computed<EndpointInfo[]>(() => {
  if (!props.config.integrationSlug) return [];
  const integration = integrations.value.find(i => i.slug === props.config.integrationSlug);
  return integration?.endpoints || [];
});

const selectedEndpoint = computed<EndpointInfo | null>(() => {
  if (!props.config.endpointName) return null;
  return endpoints.value.find(ep => ep.name === props.config.endpointName) || null;
});

const paramDefs = computed<ParamInfo[]>(() => {
  return selectedEndpoint.value?.queryParams || [];
});

onMounted(async() => {
  await loadIntegrations();
  if (props.config.integrationSlug) {
    await loadAccounts(props.config.integrationSlug);
  }
});

watch(() => props.config.integrationSlug, async(slug) => {
  if (slug) {
    await loadAccounts(slug);
  } else {
    accounts.value = [];
  }
});

function varToken(name: string): string {
  return `{{${ name }}}`;
}

async function loadIntegrations() {
  try {
    const list = await ipcRenderer.invoke('configapi-list-integrations');
    integrations.value = (list || []).map((i: any) => ({
      slug:      i.slug,
      version:   i.version || '',
      endpoints: (i.endpoints || []).map((ep: any) => ({
        name:        ep.name,
        path:        ep.path,
        method:      ep.method,
        description: ep.description || '',
        auth:        ep.auth || 'none',
        queryParams: ep.queryParams || [],
      })),
    }));
  } catch {
    integrations.value = [];
  }
}

async function loadAccounts(slug: string) {
  try {
    const list = await ipcRenderer.invoke('integration-accounts', slug);
    accounts.value = list || [];
  } catch {
    accounts.value = [];
  }
}

function onIntegrationChange(event: Event) {
  const el = event.target as HTMLSelectElement;
  emit('update-config', props.nodeId, {
    ...props.config,
    integrationSlug: el.value,
    endpointName:    '',
    accountId:       'default',
    defaults:        {},
  });
}

function onEndpointChange(event: Event) {
  const el = event.target as HTMLSelectElement;
  emit('update-config', props.nodeId, {
    ...props.config,
    endpointName: el.value,
    defaults:     {},
  });
}

function onPreCallDescriptionChange(event: Event) {
  const el = event.target as HTMLTextAreaElement;
  emit('update-config', props.nodeId, {
    ...props.config,
    preCallDescription: el.value,
  });
}

function onAccountChange(event: Event) {
  const el = event.target as HTMLSelectElement;
  emit('update-config', props.nodeId, {
    ...props.config,
    accountId: el.value,
  });
}

function onParamChange(paramName: string, value: string) {
  const newDefaults = { ...props.config.defaults };
  if (value) {
    newDefaults[paramName] = value;
  } else {
    delete newDefaults[paramName];
  }
  emit('update-config', props.nodeId, {
    ...props.config,
    defaults: newDefaults,
  });
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
  const token = `{{${ varName }}}`;
  const paramName = varMenu.paramName;
  const current = props.config.defaults[paramName] || '';
  const newDefaults = { ...props.config.defaults, [paramName]: current + token };
  emit('update-config', props.nodeId, {
    ...props.config,
    defaults: newDefaults,
  });
  closeVarMenu();
}
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

.node-field-textarea {
  resize: vertical;
  font-family: inherit;
  min-height: 60px;
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

.param-enum {
  font-size: var(--fs-caption);
  color: var(--text-muted);
  margin-top: 3px;
}
.param-enum.dark { color: var(--text-secondary); }

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
