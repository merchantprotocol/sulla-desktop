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

const form = reactive({
  id: '',
  name: '',
  description: '',
  type: 'worker',
});

const errors = reactive({ id: '', name: '' });
const saving = ref(false);
const saveError = ref('');

onMounted(() => {
  // If content is provided (edit mode), parse YAML to pre-fill form
  if (props.content) {
    try {
      const parsed = yaml.parse(props.content);
      if (parsed) {
        form.name = parsed.name || '';
        form.description = parsed.description || '';
        form.type = parsed.type || 'worker';
      }
    } catch { /* ignore parse errors */ }
  }
  // Extract agent ID from filePath: agent-form://edit/{agentId}
  if (isEditMode.value && props.filePath) {
    form.id = props.filePath.replace('agent-form://edit/', '');
  }
});

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
    });

    await ipcRenderer.invoke('filesystem-write-file', `${agentDir}/agent.yaml`, agentYaml);

    if (!isEditMode.value) {
      // Create soul.md and environment.md from prompt templates (only on new agent)
      const templates = await ipcRenderer.invoke('agents-get-prompt-templates');
      await Promise.all([
        ipcRenderer.invoke('filesystem-write-file', `${agentDir}/soul.md`, templates.soul),
        ipcRenderer.invoke('filesystem-write-file', `${agentDir}/environment.md`, templates.environment),
      ]);
    }

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
  border-color: #0078d4;
  box-shadow: 0 0 0 2px rgba(0,120,212,0.15);
}

.form-input.dark,
.form-textarea.dark,
.form-select.dark {
  background: #1e293b;
  border-color: #334155;
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
  background: #0078d4;
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
  background: #0078d4;
}

.save-btn.dark:hover {
  background: #1a8ae8;
}
</style>
