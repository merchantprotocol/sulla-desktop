<template>
  <div class="agent-form" :class="{ dark: isDark }">
    <div class="form-inner">
      <h2 class="form-title">{{ isEditMode ? 'Edit Agent' : 'Create New Agent' }}</h2>

      <label class="form-label">Agent ID <span class="required">*</span></label>
      <input
        v-model="form.id"
        class="form-input"
        :class="{ dark: isDark, error: errors.id, disabled: isEditMode }"
        :disabled="isEditMode"
        placeholder="my-agent-name"
        @input="enforceSlug"
      />
      <p v-if="!isEditMode" class="form-hint">Lowercase letters, numbers, and hyphens only. Becomes the folder name.</p>
      <p v-if="errors.id" class="form-error">{{ errors.id }}</p>

      <label class="form-label">Agent Name <span class="required">*</span></label>
      <input
        v-model="form.name"
        class="form-input"
        :class="{ dark: isDark, error: errors.name }"
        placeholder="My Agent"
      />
      <p v-if="errors.name" class="form-error">{{ errors.name }}</p>

      <label class="form-label">Description</label>
      <textarea
        v-model="form.description"
        class="form-textarea"
        :class="{ dark: isDark }"
        placeholder="What does this agent do?"
        rows="3"
      ></textarea>

      <label class="form-label">Type <span class="required">*</span></label>
      <select v-model="form.type" class="form-select" :class="{ dark: isDark }">
        <option value="planner">Planner</option>
        <option value="worker">Worker</option>
        <option value="judge">Judge</option>
      </select>

      <hr class="form-separator" :class="{ dark: isDark }" />

      <h3 class="form-section-title">Agent Assignment</h3>

      <label class="default-agent-toggle" :class="{ dark: isDark }">
        <input
          type="checkbox"
          v-model="form.isDefault"
          @change="onDefaultToggle"
        />
        <span class="toggle-label">Set as Default Agent</span>
      </label>
      <p class="form-hint">The default agent handles all triggers that don't have a specific agent assigned.</p>
      <p v-if="currentDefaultAgentId && currentDefaultAgentId !== form.id && form.isDefault" class="form-hint form-hint-warn">
        This will replace "{{ currentDefaultAgentId }}" as the default agent.
      </p>

      <label class="form-label">Trigger Assignments</label>
      <p class="form-hint" style="margin-bottom: 8px;">Assign this agent to handle specific triggers. Leave empty to only use as default.</p>
      <div class="trigger-list">
        <label
          v-for="trigger in TRIGGER_TYPES"
          :key="trigger.value"
          class="skill-checkbox"
          :class="{ dark: isDark }"
        >
          <input
            type="checkbox"
            :value="trigger.value"
            v-model="form.triggers"
            @change="emit('dirty')"
          />
          <span class="skill-name">{{ trigger.label }}</span>
          <span v-if="triggerCurrentAgents[trigger.value] && triggerCurrentAgents[trigger.value] !== form.id" class="trigger-current-agent">
            (currently: {{ triggerCurrentAgents[trigger.value] }})
          </span>
        </label>
      </div>

      <hr class="form-separator" :class="{ dark: isDark }" />

      <div class="form-section-header">
        <h3 class="form-section-title">Skills</h3>
        <div v-if="!skillsLoading && skillsFolders.length > 0" class="bulk-actions">
          <button class="bulk-btn" :class="{ dark: isDark }" @click="selectAllSkills">Select All</button>
          <button class="bulk-btn" :class="{ dark: isDark }" @click="unselectAllSkills">Unselect All</button>
        </div>
      </div>
      <p v-if="skillsLoading" class="form-hint">Loading skills...</p>
      <p v-else-if="skillsFolders.length === 0" class="form-hint">No skills folders found.</p>
      <div v-else class="skills-list">
        <label
          v-for="skill in skillsFolders"
          :key="skill"
          class="skill-checkbox"
          :class="{ dark: isDark }"
        >
          <input
            type="checkbox"
            :value="skill"
            v-model="form.skills"
            @change="emit('dirty')"
          />
          <span class="skill-name">{{ skill }}</span>
        </label>
      </div>

      <hr class="form-separator" :class="{ dark: isDark }" />

      <div class="form-section-header">
        <h3 class="form-section-title">Tools</h3>
        <div v-if="!toolsLoading && toolCategories.length > 0" class="bulk-actions">
          <button class="bulk-btn" :class="{ dark: isDark }" @click="selectAllTools">Select All</button>
          <button class="bulk-btn" :class="{ dark: isDark }" @click="unselectAllTools">Unselect All</button>
        </div>
      </div>
      <div v-if="!toolsLoading && toolCategories.length > 0" class="tool-filter-bar">
        <select v-model="toolFilter" class="tool-filter-select" :class="{ dark: isDark }">
          <option value="all">All operations</option>
          <option v-for="op in ALL_OPERATION_TYPES" :key="op" :value="op">{{ op.charAt(0).toUpperCase() + op.slice(1) }}</option>
        </select>
        <span class="tool-filter-count" :class="{ dark: isDark }">
          {{ filteredToolCategories.flatMap(c => c.tools).length }} tools
        </span>
      </div>
      <p v-if="toolsLoading" class="form-hint">Loading tools...</p>
      <p v-else-if="toolCategories.length === 0" class="form-hint">No tools found.</p>
      <p v-else-if="filteredToolCategories.length === 0" class="form-hint">No tools match this filter.</p>
      <div v-else class="tools-tree">
        <div v-for="cat in filteredToolCategories" :key="cat.category" class="tool-category">
          <button
            class="tool-category-header"
            :class="{ dark: isDark }"
            @click="toggleCategory(cat.category)"
          >
            <svg
              class="tool-chevron"
              :class="{ expanded: expandedCategories.has(cat.category) }"
              width="10" height="10" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"
            >
              <polyline points="9 18 15 12 9 6"/>
            </svg>
            <input
              type="checkbox"
              :checked="isCategoryFullySelected(cat)"
              :indeterminate="isCategoryPartiallySelected(cat)"
              @click.stop
              @change="toggleCategoryTools(cat, $event)"
            />
            <span class="tool-category-name">{{ cat.category }}</span>
            <span class="tool-category-count">{{ cat.tools.length }}</span>
          </button>
          <div v-if="expandedCategories.has(cat.category)" class="tool-category-tools">
            <label
              v-for="tool in cat.tools"
              :key="tool.name"
              class="tool-checkbox"
              :class="{ dark: isDark }"
              :title="tool.description"
            >
              <input
                type="checkbox"
                :value="tool.name"
                v-model="form.tools"
                @change="emit('dirty')"
              />
              <span class="tool-name">{{ tool.name }}</span>
            </label>
          </div>
        </div>
      </div>

      <div class="form-actions">
        <button class="save-btn" :class="{ dark: isDark }" :disabled="saving" @click="save">
          {{ saving ? (isEditMode ? 'Saving...' : 'Creating...') : (isEditMode ? 'Save Changes' : 'Create Agent') }}
        </button>
      </div>

      <p v-if="saveError" class="form-error save-error">{{ saveError }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue';
import { ipcRenderer } from 'electron';
import yaml from 'yaml';

const props = defineProps<{
  isDark: boolean;
  content?: string;
  filePath?: string;
  fileExt?: string;
  readOnly?: boolean;
}>();

const emit = defineEmits<{
  'dirty': [];
  'saved': [agentPath: string];
}>();

const isEditMode = computed(() => {
  return !!props.filePath && props.filePath.startsWith('agent-form://edit/');
});

interface ToolEntry {
  name: string;
  description: string;
  operationTypes: string[];
}

interface ToolCategoryEntry {
  category: string;
  description: string;
  tools: ToolEntry[];
}

const TRIGGER_TYPES = [
  { value: 'sulla-desktop', label: 'Sulla Desktop (Chat)' },
  { value: 'workbench', label: 'Workbench' },
  { value: 'heartbeat', label: 'Heartbeat' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'chat-app', label: 'Chat App (Slack/Discord)' },
  { value: 'chat-completions', label: 'Chat Completions API' },
] as const;

type TriggerType = typeof TRIGGER_TYPES[number]['value'];

const form = reactive({
  id: '',
  name: '',
  description: '',
  type: 'worker',
  isDefault: false,
  triggers: [] as string[],
  skills: [] as string[],
  tools: [] as string[],
});

const errors = reactive({ id: '', name: '' });
const saving = ref(false);
const saveError = ref('');
const skillsFolders = ref<string[]>([]);
const skillsLoading = ref(false);
const toolCategories = ref<ToolCategoryEntry[]>([]);
const toolsLoading = ref(false);
const expandedCategories = ref(new Set<string>());
const toolFilter = ref('all');

const currentDefaultAgentId = ref('');
const triggerCurrentAgents = ref<Record<string, string>>({});

const ALL_OPERATION_TYPES = ['read', 'create', 'update', 'delete', 'execute'] as const;

const filteredToolCategories = computed(() => {
  if (toolFilter.value === 'all') return toolCategories.value;
  return toolCategories.value
    .map(cat => ({
      ...cat,
      tools: cat.tools.filter(t => t.operationTypes.includes(toolFilter.value)),
    }))
    .filter(cat => cat.tools.length > 0);
});

onMounted(async() => {
  // If content is provided (edit mode), parse YAML to pre-fill form
  if (props.content) {
    try {
      const parsed = yaml.parse(props.content);
      if (parsed) {
        form.name = parsed.name || '';
        form.description = parsed.description || '';
        form.type = parsed.type || 'worker';
        form.skills = Array.isArray(parsed.skills) ? parsed.skills : [];
        form.tools = Array.isArray(parsed.tools) ? parsed.tools : [];
      }
    } catch { /* ignore parse errors */ }
  }
  // Extract agent ID from filePath: agent-form://edit/{agentId}
  if (isEditMode.value && props.filePath) {
    form.id = props.filePath.replace('agent-form://edit/', '');
  }

  // Load skills folders, tools, and agent assignment settings in parallel
  await Promise.all([loadSkillsFolders(), loadToolCategories(), loadAgentAssignments()]);
});

async function loadSkillsFolders() {
  skillsLoading.value = true;
  try {
    const vars: { key: string; preview: string }[] = await ipcRenderer.invoke('agents-get-template-variables');
    const skillsDirVar = vars.find(v => v.key === '{{skills_dir}}');
    if (!skillsDirVar) return;

    const entries: { name: string; isDir: boolean }[] = await ipcRenderer.invoke('filesystem-read-dir', skillsDirVar.preview);
    skillsFolders.value = entries.filter(e => e.isDir && !e.name.startsWith('.')).map(e => e.name);
  } catch (err) {
    console.error('Failed to load skills folders:', err);
  } finally {
    skillsLoading.value = false;
  }
}

async function loadToolCategories() {
  toolsLoading.value = true;
  try {
    toolCategories.value = await ipcRenderer.invoke('tools-list-by-category');
  } catch (err) {
    console.error('Failed to load tools:', err);
  } finally {
    toolsLoading.value = false;
  }
}

async function loadAgentAssignments() {
  try {
    const defaultId: string = await ipcRenderer.invoke('sulla-settings-get', 'defaultAgentId', '');
    currentDefaultAgentId.value = defaultId;
    if (defaultId === form.id) {
      form.isDefault = true;
    }

    const triggerMap: Record<string, string> = await ipcRenderer.invoke('sulla-settings-get', 'triggerAgentMap', {});
    triggerCurrentAgents.value = triggerMap;

    // Pre-check triggers assigned to this agent
    for (const [trigger, agentId] of Object.entries(triggerMap)) {
      if (agentId === form.id) {
        form.triggers.push(trigger);
      }
    }
  } catch (err) {
    console.error('Failed to load agent assignments:', err);
  }
}

function onDefaultToggle() {
  emit('dirty');
}

function toggleCategory(category: string) {
  if (expandedCategories.value.has(category)) {
    expandedCategories.value.delete(category);
  } else {
    expandedCategories.value.add(category);
  }
}

function isCategoryFullySelected(cat: ToolCategoryEntry): boolean {
  return cat.tools.length > 0 && cat.tools.every(t => form.tools.includes(t.name));
}

function isCategoryPartiallySelected(cat: ToolCategoryEntry): boolean {
  const count = cat.tools.filter(t => form.tools.includes(t.name)).length;
  return count > 0 && count < cat.tools.length;
}

function toggleCategoryTools(cat: ToolCategoryEntry, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  const toolNames = cat.tools.map(t => t.name);
  if (checked) {
    const toAdd = toolNames.filter(n => !form.tools.includes(n));
    form.tools.push(...toAdd);
  } else {
    form.tools = form.tools.filter(n => !toolNames.includes(n));
  }
  emit('dirty');
}

function selectAllSkills() {
  form.skills = [...skillsFolders.value];
  emit('dirty');
}

function unselectAllSkills() {
  form.skills = [];
  emit('dirty');
}

function selectAllTools() {
  const visible = new Set(filteredToolCategories.value.flatMap(cat => cat.tools.map(t => t.name)));
  const existing = form.tools.filter(n => !visible.has(n));
  form.tools = [...existing, ...visible];
  emit('dirty');
}

function unselectAllTools() {
  const visible = new Set(filteredToolCategories.value.flatMap(cat => cat.tools.map(t => t.name)));
  form.tools = form.tools.filter(n => !visible.has(n));
  emit('dirty');
}

function enforceSlug() {
  form.id = form.id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-/, '');
  emit('dirty');
}

function validate(): boolean {
  errors.id = '';
  errors.name = '';

  if (!form.id.trim()) {
    errors.id = 'Agent ID is required';
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(form.id)) {
    errors.id = 'Must start with a letter or number';
  }
  if (!form.name.trim()) {
    errors.name = 'Agent name is required';
  }

  return !errors.id && !errors.name;
}

defineExpose({ save });

async function save() {
  if (!validate()) return;

  saving.value = true;
  saveError.value = '';

  try {
    const root = await ipcRenderer.invoke('filesystem-get-root');
    const agentsDir = `${root}/agents`;
    const agentDir = `${agentsDir}/${form.id}`;

    if (!isEditMode.value) {
      // Create the agent directory
      await ipcRenderer.invoke('filesystem-create-dir', agentsDir, form.id);
    }

    // Build and write agent.yaml
    const agentYaml = yaml.stringify({
      name: form.name.trim(),
      description: form.description.trim(),
      type: form.type,
      skills: form.skills,
      tools: form.tools,
    });

    await ipcRenderer.invoke('filesystem-write-file', `${agentDir}/agent.yaml`, agentYaml);

    if (!isEditMode.value) {
      // Create soul.md from prompt template (only on new agent).
      // environment.md is NOT created — the global environment prompt is always
      // injected by enrichPrompt() and should not be overridable per-agent.
      const templates = await ipcRenderer.invoke('agents-get-prompt-templates');
      await ipcRenderer.invoke('filesystem-write-file', `${agentDir}/soul.md`, templates.soul);
    }

    // Persist default agent setting
    if (form.isDefault) {
      await ipcRenderer.invoke('sulla-settings-set', 'defaultAgentId', form.id);
      currentDefaultAgentId.value = form.id;
    } else if (currentDefaultAgentId.value === form.id) {
      // Unset default if this agent was previously default and user unchecked it
      await ipcRenderer.invoke('sulla-settings-set', 'defaultAgentId', '');
      currentDefaultAgentId.value = '';
    }

    // Persist trigger-to-agent map
    const triggerMap: Record<string, string> = await ipcRenderer.invoke('sulla-settings-get', 'triggerAgentMap', {});
    // Remove this agent from any triggers it was previously assigned to
    for (const key of Object.keys(triggerMap)) {
      if (triggerMap[key] === form.id) {
        delete triggerMap[key];
      }
    }
    // Assign this agent to the selected triggers
    for (const trigger of form.triggers) {
      triggerMap[trigger] = form.id;
    }
    await ipcRenderer.invoke('sulla-settings-set', 'triggerAgentMap', triggerMap);
    triggerCurrentAgents.value = triggerMap;

    emit('saved', agentDir);
  } catch (err: any) {
    saveError.value = err?.message || 'Failed to save agent';
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.agent-form {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  background: #ffffff;
  color: #333;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.agent-form.dark {
  background: #0f172a;
  color: #e2e8f0;
}

.form-inner {
  max-width: 520px;
  margin: 0 auto;
  padding: 32px 24px;
}

.form-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 24px 0;
}

.form-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: #64748b;
  margin: 16px 0 6px 0;
}

.agent-form.dark .form-label {
  color: #94a3b8;
}

.required {
  color: #ef4444;
}

.form-input,
.form-textarea,
.form-select {
  display: block;
  width: 100%;
  padding: 8px 12px;
  font-size: 13px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #fff;
  color: #333;
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
}

.form-input:focus,
.form-textarea:focus,
.form-select:focus {
  border-color: var(--accent-primary, #0078d4);
  box-shadow: 0 0 0 2px rgba(0,120,212,0.15);
}

.form-input.dark,
.form-textarea.dark,
.form-select.dark {
  background: var(--bg-surface, #1e293b);
  border-color: var(--border-default, #334155);
  color: #e2e8f0;
}

.form-input.error {
  border-color: #ef4444;
}

.form-input.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.form-textarea {
  resize: vertical;
  min-height: 60px;
}

.form-select {
  cursor: pointer;
}

.form-hint {
  font-size: 11px;
  color: #94a3b8;
  margin: 4px 0 0 0;
}

.form-error {
  font-size: 12px;
  color: #ef4444;
  margin: 4px 0 0 0;
}

.save-error {
  margin-top: 12px;
}

.form-actions {
  margin-top: 24px;
}

.save-btn {
  padding: 8px 20px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  border-radius: 6px;
  background: var(--accent-primary, #0078d4);
  color: #fff;
  cursor: pointer;
}

.save-btn:hover {
  background: #006abc;
}

.save-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.save-btn.dark {
  background: var(--accent-primary, #0078d4);
}

.save-btn.dark:hover {
  background: #1a8ae8;
}

.form-separator {
  border: none;
  border-top: 1px solid #e2e8f0;
  margin: 24px 0 16px 0;
}

.form-separator.dark {
  border-top-color: var(--border-default, #334155);
}

.form-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 12px 0;
}

.form-section-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}

.bulk-actions {
  display: flex;
  gap: 6px;
}

.bulk-btn {
  padding: 3px 8px;
  font-size: 11px;
  border: 1px solid #cbd5e1;
  border-radius: 4px;
  background: transparent;
  color: #64748b;
  cursor: pointer;
}

.bulk-btn:hover {
  background: rgba(0,0,0,0.04);
  color: #333;
}

.bulk-btn.dark {
  border-color: var(--border-default, #334155);
  color: #94a3b8;
}

.bulk-btn.dark:hover {
  background: rgba(255,255,255,0.06);
  color: #e2e8f0;
}

.tool-filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.tool-filter-select {
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid #cbd5e1;
  border-radius: 4px;
  background: #fff;
  color: #333;
  outline: none;
  cursor: pointer;
}

.tool-filter-select.dark {
  background: var(--bg-surface, #1e293b);
  border-color: var(--border-default, #334155);
  color: #e2e8f0;
}

.tool-filter-count {
  font-size: 11px;
  color: #94a3b8;
}

.tool-filter-count.dark {
  color: #64748b;
}

.skills-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.skill-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}

.skill-checkbox:hover {
  background: rgba(0,0,0,0.04);
}

.skill-checkbox.dark:hover {
  background: rgba(255,255,255,0.04);
}

.skill-checkbox input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
}

.skill-name {
  user-select: none;
}

.tools-tree {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tool-category-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  border-radius: 4px;
  text-align: left;
}

.tool-category-header:hover {
  background: rgba(0,0,0,0.04);
}

.tool-category-header.dark:hover {
  background: rgba(255,255,255,0.04);
}

.tool-category-header input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
}

.tool-chevron {
  flex-shrink: 0;
  transition: transform 0.15s ease;
}

.tool-chevron.expanded {
  transform: rotate(90deg);
}

.tool-category-name {
  user-select: none;
}

.tool-category-count {
  font-size: 10px;
  color: #94a3b8;
  margin-left: auto;
}

.tool-category-tools {
  padding-left: 20px;
}

.tool-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.tool-checkbox:hover {
  background: rgba(0,0,0,0.04);
}

.tool-checkbox.dark:hover {
  background: rgba(255,255,255,0.04);
}

.tool-checkbox input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
}

.tool-name {
  user-select: none;
  color: #64748b;
}

.agent-form.dark .tool-name {
  color: #94a3b8;
}

.default-agent-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  margin: 8px 0 4px 0;
}

.default-agent-toggle:hover {
  background: rgba(0,0,0,0.04);
}

.default-agent-toggle.dark:hover {
  background: rgba(255,255,255,0.04);
}

.default-agent-toggle input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
}

.toggle-label {
  font-weight: 500;
  user-select: none;
}

.form-hint-warn {
  color: #f59e0b;
}

.trigger-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.trigger-current-agent {
  font-size: 11px;
  color: #94a3b8;
  margin-left: auto;
}
</style>
