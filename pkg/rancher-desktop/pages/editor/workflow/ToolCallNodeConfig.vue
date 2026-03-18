<template>
  <div
    class="toolcall-config"
    :class="{ dark: isDark }"
  >
    <!-- Category selector -->
    <div class="node-field">
      <label
        class="node-field-label"
        :class="{ dark: isDark }"
      >Category</label>
      <select
        class="node-field-input"
        :class="{ dark: isDark }"
        :value="selectedCategory"
        @change="onCategoryChange"
      >
        <option value="">
          -- Select Category --
        </option>
        <option
          v-for="cat in toolCategories"
          :key="cat.category"
          :value="cat.category"
        >
          {{ cat.category }} — {{ cat.description }}
        </option>
      </select>
    </div>

    <!-- Tool selector -->
    <div
      v-if="selectedCategory"
      class="node-field"
    >
      <label
        class="node-field-label"
        :class="{ dark: isDark }"
      >Tool</label>
      <select
        class="node-field-input"
        :class="{ dark: isDark }"
        :value="config.toolName || ''"
        @change="onToolChange"
      >
        <option value="">
          -- Select Tool --
        </option>
        <option
          v-for="t in categoryTools"
          :key="t.name"
          :value="t.name"
        >
          {{ t.name }}
        </option>
      </select>
      <p
        v-if="selectedToolDescription"
        class="help-text"
        :class="{ dark: isDark }"
      >
        {{ selectedToolDescription }}
      </p>
    </div>

    <!-- Parameter fields (auto-generated from schemaDef) -->
    <template v-if="config.toolName && Object.keys(toolSchema).length > 0">
      <div class="section-divider" />
      <p
        class="section-title"
        :class="{ dark: isDark }"
      >
        Parameters
      </p>

      <div
        v-for="(spec, paramName) in toolSchema"
        :key="paramName"
        class="node-field"
      >
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >
          {{ paramName }}
          <span
            v-if="spec.optional"
            class="optional-badge"
          >(optional)</span>
        </label>

        <!-- Enum field -->
        <select
          v-if="spec.type === 'enum' && spec.enum"
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="config.defaults[paramName] || ''"
          @change="onParamChange(paramName, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">
            -- Select --
          </option>
          <option
            v-for="opt in spec.enum"
            :key="opt"
            :value="opt"
          >
            {{ opt }}
          </option>
        </select>

        <!-- Boolean field -->
        <select
          v-else-if="spec.type === 'boolean'"
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="config.defaults[paramName] || ''"
          @change="onParamChange(paramName, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">
            -- Select --
          </option>
          <option value="true">
            true
          </option>
          <option value="false">
            false
          </option>
        </select>

        <!-- Number field -->
        <input
          v-else-if="spec.type === 'number'"
          type="number"
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="config.defaults[paramName] || ''"
          :placeholder="spec.description || paramName"
          @input="onParamChange(paramName, ($event.target as HTMLInputElement).value)"
        >

        <!-- Object / Array field (JSON textarea) -->
        <textarea
          v-else-if="spec.type === 'object' || spec.type === 'array'"
          class="node-field-input node-field-textarea"
          :class="{ dark: isDark }"
          :value="config.defaults[paramName] || ''"
          :placeholder="spec.description || `JSON ${ spec.type }`"
          rows="3"
          @input="onParamChange(paramName, ($event.target as HTMLTextAreaElement).value)"
        />

        <!-- String field (default) -->
        <input
          v-else
          type="text"
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="config.defaults[paramName] || ''"
          :placeholder="spec.description || paramName"
          @input="onParamChange(paramName, ($event.target as HTMLInputElement).value)"
        >

        <p
          v-if="spec.description"
          class="param-description"
          :class="{ dark: isDark }"
        >
          {{ spec.description }}
        </p>
      </div>
    </template>

    <!-- Variable insertion hint -->
    <div
      class="help-block"
      :class="{ dark: isDark }"
    >
      <p
        class="help-text"
        :class="{ dark: isDark }"
      >
        Use <code v-text="'{{variable}}'" /> syntax in parameter values to inject outputs from upstream nodes.
        The tool executes directly and returns its result to the orchestrator.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { ipcRenderer } from 'electron';
import type { ToolCallNodeConfig } from './types';

export interface UpstreamNodeInfo {
  nodeId:   string;
  label:    string;
  subtype:  string;
  category: string;
}

interface ToolCategoryInfo {
  category:    string;
  description: string;
  tools:       { name: string; description: string; operationTypes: string[] }[];
}

interface FieldSpec {
  type:         string;
  enum?:        string[];
  description?: string;
  optional?:    boolean;
  default?:     unknown;
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

const toolCategories = ref<ToolCategoryInfo[]>([]);
const toolSchema = ref<Record<string, FieldSpec>>({});
const selectedCategory = ref('');

// Derive initial category from existing toolName (e.g. reopening a configured node)
function deriveCategoryFromTool(toolName: string): string {
  for (const cat of toolCategories.value) {
    if (cat.tools.some(t => t.name === toolName)) {
      return cat.category;
    }
  }
  return '';
}

const categoryTools = computed(() => {
  const cat = toolCategories.value.find(c => c.category === selectedCategory.value);
  return cat?.tools || [];
});

const selectedToolDescription = computed(() => {
  if (!props.config.toolName) return '';
  for (const cat of toolCategories.value) {
    const tool = cat.tools.find(t => t.name === props.config.toolName);
    if (tool) return tool.description;
  }
  return '';
});

function emitConfig(patch: Partial<ToolCallNodeConfig>) {
  emit('update-config', props.nodeId, { ...props.config, ...patch });
}

function onCategoryChange(e: Event) {
  const cat = (e.target as HTMLSelectElement).value;
  selectedCategory.value = cat;
  emitConfig({ toolName: '', defaults: {} });
  toolSchema.value = {};
}

async function onToolChange(e: Event) {
  const name = (e.target as HTMLSelectElement).value;
  emitConfig({ toolName: name, defaults: {} });
  if (name) {
    await loadSchema(name);
  } else {
    toolSchema.value = {};
  }
}

function onParamChange(paramName: string, value: string) {
  const defaults = { ...props.config.defaults, [paramName]: value };
  emitConfig({ defaults });
}

async function loadSchema(toolName: string) {
  try {
    const schema = await ipcRenderer.invoke('tools-get-schema', toolName);
    toolSchema.value = schema || {};
  } catch {
    toolSchema.value = {};
  }
}

onMounted(async() => {
  try {
    toolCategories.value = await ipcRenderer.invoke('tools-list-by-category');
  } catch {
    toolCategories.value = [];
  }
  if (props.config.toolName) {
    selectedCategory.value = deriveCategoryFromTool(props.config.toolName);
    await loadSchema(props.config.toolName);
  }
});

watch(() => props.config.toolName, async(newName) => {
  if (newName) {
    await loadSchema(newName);
  } else {
    toolSchema.value = {};
  }
});
</script>

<style scoped>
.toolcall-config {
  display: flex;
  flex-direction: column;
}

.node-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
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
}

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
  font-family: monospace;
}

.section-divider {
  border-top: 1px solid var(--bg-surface-hover);
  margin: 0;
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

.optional-badge {
  font-weight: 400;
  font-size: 11px;
  opacity: 0.6;
  text-transform: none;
  letter-spacing: normal;
}

.param-description {
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.7;
  margin: 0;
  line-height: 1.4;
}

.help-block {
  padding: 12px;
}

.help-text {
  font-size: 11px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.4;
}
</style>
