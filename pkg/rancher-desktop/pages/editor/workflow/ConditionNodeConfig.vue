<template>
  <div class="condition-config" :class="{ dark: isDark }">
    <div class="node-field">
      <label class="node-field-label" :class="{ dark: isDark }">Combinator</label>
      <div class="combinator-toggle">
        <button
          class="combinator-btn"
          :class="{ active: config.combinator === 'and', dark: isDark }"
          @click="setCombinator('and')"
        >AND</button>
        <button
          class="combinator-btn"
          :class="{ active: config.combinator === 'or', dark: isDark }"
          @click="setCombinator('or')"
        >OR</button>
      </div>
    </div>

    <div class="node-field">
      <label class="node-field-label" :class="{ dark: isDark }">Rules</label>
      <div class="rules-list">
        <div v-for="(rule, idx) in config.rules" :key="idx" class="rule-row">
          <input
            class="node-field-input rule-input"
            :class="{ dark: isDark }"
            placeholder="e.g. sentiment"
            :value="rule.field"
            @input="onRuleChange(idx, 'field', ($event.target as HTMLInputElement).value)"
          />
          <select
            class="node-field-input rule-operator"
            :class="{ dark: isDark }"
            :value="rule.operator"
            @change="onRuleChange(idx, 'operator', ($event.target as HTMLSelectElement).value)"
          >
            <option value="equals">equals</option>
            <option value="not_equals">not equals</option>
            <option value="contains">contains</option>
            <option value="not_contains">not contains</option>
            <option value="greater_than">greater than</option>
            <option value="less_than">less than</option>
            <option value="exists">exists</option>
            <option value="not_exists">not exists</option>
          </select>
          <input
            class="node-field-input rule-input"
            :class="{ dark: isDark }"
            placeholder="e.g. positive"
            :value="rule.value"
            @input="onRuleChange(idx, 'value', ($event.target as HTMLInputElement).value)"
          />
          <button class="rule-remove-btn" :class="{ dark: isDark }" @click="removeRule(idx)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <button class="rule-add-btn" :class="{ dark: isDark }" @click="addRule">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Add Rule
        </button>
      </div>
    </div>
    <div class="node-field help-section" :class="{ dark: isDark }">
      <p class="help-title" :class="{ dark: isDark }">How conditions work</p>
      <p class="help-text" :class="{ dark: isDark }">
        Conditions evaluate data fields from the previous node's output.
        If the combined rules evaluate to <strong>true</strong>, flow continues
        down the True output. Otherwise it follows the False output.
      </p>
      <p class="help-text" :class="{ dark: isDark }">
        <strong>Field</strong> is the data key to check (e.g. <em>sentiment</em>, <em>message.type</em>, <em>user.role</em>).
        <strong>Value</strong> is what to compare against.
        Use <strong>AND</strong> when all rules must pass, or <strong>OR</strong> when any single rule is enough.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ConditionNodeConfig } from './types';

const props = defineProps<{
  isDark: boolean;
  nodeId: string;
  config: ConditionNodeConfig;
}>();

const emit = defineEmits<{
  'update-config': [nodeId: string, config: ConditionNodeConfig];
}>();

function setCombinator(c: 'and' | 'or') {
  emit('update-config', props.nodeId, { ...props.config, combinator: c });
}

function onRuleChange(idx: number, field: 'field' | 'operator' | 'value', value: string) {
  const rules = [...props.config.rules];
  rules[idx] = { ...rules[idx], [field]: value };
  emit('update-config', props.nodeId, { ...props.config, rules });
}

function addRule() {
  const rules = [...props.config.rules, { field: '', operator: 'equals', value: '' }];
  emit('update-config', props.nodeId, { ...props.config, rules });
}

function removeRule(idx: number) {
  const rules = props.config.rules.filter((_, i) => i !== idx);
  emit('update-config', props.nodeId, { ...props.config, rules });
}
</script>

<style scoped>
.condition-config { padding: 0; }

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

.combinator-toggle {
  display: flex;
  gap: 4px;
}

.combinator-btn {
  flex: 1;
  padding: 6px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-semibold);
  cursor: pointer;
}
.combinator-btn.active { border-color: var(--border-accent); color: var(--text-info); background: rgba(99, 102, 241, 0.06); }

.rules-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rule-row {
  display: flex;
  gap: 4px;
  align-items: center;
}

.rule-input { flex: 1; min-width: 0; }
.rule-operator { width: auto; flex-shrink: 0; }

.rule-remove-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
}
.rule-remove-btn:hover { background: var(--bg-hover); color: var(--text-error); }

.rule-add-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border: 1px dashed var(--border-default);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--fs-code);
  cursor: pointer;
}
.rule-add-btn:hover { border-color: var(--border-accent); color: var(--text-info); }
.rule-add-btn.dark { border-color: var(--border-default); color: var(--text-muted); }
.rule-add-btn.dark:hover { border-color: var(--border-accent); color: var(--text-info); }

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
