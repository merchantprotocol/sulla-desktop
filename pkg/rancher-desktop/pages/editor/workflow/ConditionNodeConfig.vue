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
  border-bottom: 1px solid #e2e8f0;
}
.condition-config.dark .node-field { border-bottom-color: #3c3c5c; }

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

.combinator-toggle {
  display: flex;
  gap: 4px;
}

.combinator-btn {
  flex: 1;
  padding: 6px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  background: #fff;
  color: #64748b;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.combinator-btn.active { border-color: #6366f1; color: #6366f1; background: rgba(99, 102, 241, 0.06); }
.combinator-btn.dark { background: #2d2d44; border-color: #3c3c5c; color: #94a3b8; }
.combinator-btn.dark.active { border-color: #6366f1; color: #818cf8; background: rgba(99, 102, 241, 0.15); }

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
  color: #94a3b8;
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
}
.rule-remove-btn:hover { background: rgba(0,0,0,0.06); color: #ef4444; }
.rule-remove-btn.dark:hover { background: rgba(255,255,255,0.08); color: #f87171; }

.rule-add-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border: 1px dashed #e2e8f0;
  border-radius: 4px;
  background: transparent;
  color: #64748b;
  font-size: 12px;
  cursor: pointer;
}
.rule-add-btn:hover { border-color: #6366f1; color: #6366f1; }
.rule-add-btn.dark { border-color: #3c3c5c; color: #94a3b8; }
.rule-add-btn.dark:hover { border-color: #6366f1; color: #818cf8; }

.help-section { border-bottom: none; }

.help-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
  margin: 0 0 8px;
}
.help-title.dark { color: #94a3b8; }

.help-text {
  font-size: 11px;
  color: #94a3b8;
  margin: 0 0 6px;
  line-height: 1.5;
}
.help-text:last-child { margin-bottom: 0; }
.help-text.dark { color: #64748b; }
</style>
