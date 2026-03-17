<template>
  <div
    class="trigger-config"
    :class="{ dark: isDark }"
  >
    <!-- Schedule-specific fields -->
    <template v-if="config.triggerType === 'schedule'">
      <div class="node-field">
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Cron Expression</label>
        <input
          class="node-field-input"
          :class="{ dark: isDark }"
          placeholder="e.g. 0 9 * * 1-5 (weekdays at 9am)"
          :value="config.cronExpression || ''"
          @input="updateField('cronExpression', ($event.target as HTMLInputElement).value)"
        >
        <p
          class="help-text field-hint"
          :class="{ dark: isDark }"
        >
          Format: minute hour day-of-month month day-of-week
        </p>
      </div>
      <div class="node-field">
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Timezone</label>
        <input
          class="node-field-input"
          :class="{ dark: isDark }"
          placeholder="e.g. America/New_York (empty = system default)"
          :value="config.timezone || ''"
          @input="updateField('timezone', ($event.target as HTMLInputElement).value)"
        >
      </div>
    </template>

    <div class="node-field">
      <label
        class="node-field-label"
        :class="{ dark: isDark }"
      >Trigger Description</label>
      <textarea
        class="node-field-input node-field-textarea"
        :class="{ dark: isDark }"
        rows="3"
        placeholder="e.g. This workflow handles customer support questions about billing and refunds"
        :value="config.triggerDescription || ''"
        @input="updateField('triggerDescription', ($event.target as HTMLTextAreaElement).value)"
      />
    </div>
    <div class="node-field help-section">
      <p
        class="help-text"
        :class="{ dark: isDark }"
      >
        This description is used by the workflow registry to determine if an incoming
        message should trigger this workflow. Be specific about what kinds of messages
        or events this workflow should handle.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  isDark: boolean;
  nodeId: string;
  config: Record<string, any>;
}>();

const emit = defineEmits<{
  'update-config': [nodeId: string, config: Record<string, any>];
}>();

function updateField(field: string, value: any) {
  emit('update-config', props.nodeId, { ...props.config, [field]: value });
}
</script>

<style scoped>
.trigger-config { padding: 0; }

.node-field {
  padding: 12px;
  border-bottom: 1px solid var(--border-default);
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
  min-height: 60px;
}

.field-hint {
  margin-top: 4px;
  margin-bottom: 0;
}

.help-section { border-bottom: none; }

.help-text {
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  margin: 0 0 6px;
  line-height: 1.5;
}
.help-text:last-child { margin-bottom: 0; }
.help-text.dark { color: var(--text-secondary); }
</style>
