<template>
  <div
    class="router-config"
    :class="{ dark: isDark }"
  >
    <div class="node-field">
      <label
        class="node-field-label"
        :class="{ dark: isDark }"
      >Classification Prompt</label>
      <textarea
        class="node-field-input node-field-textarea"
        :class="{ dark: isDark }"
        rows="3"
        placeholder="Map the intent of the previous response to a route"
        :value="config.classificationPrompt || ''"
        @input="onPromptChange"
      />
      <p
        class="field-hint"
        :class="{ dark: isDark }"
      >
        The LLM reads this prompt along with the incoming message to decide which route to take.
        Leave blank to use the default: classify by intent.
      </p>
    </div>

    <div class="node-field">
      <label
        class="node-field-label"
        :class="{ dark: isDark }"
      >Routes</label>
      <div class="routes-list">
        <div
          v-for="(route, idx) in config.routes"
          :key="idx"
          class="route-card"
          :class="{ dark: isDark }"
        >
          <div class="route-card-header">
            <input
              class="node-field-input route-label-input"
              :class="{ dark: isDark }"
              placeholder="e.g. Support, Sales, Escalation"
              :value="route.label"
              @input="onRouteChange(idx, 'label', ($event.target as HTMLInputElement).value)"
            >
            <button
              class="route-remove-btn"
              :class="{ dark: isDark }"
              @click="removeRoute(idx)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <line
                  x1="18"
                  y1="6"
                  x2="6"
                  y2="18"
                />
                <line
                  x1="6"
                  y1="6"
                  x2="18"
                  y2="18"
                />
              </svg>
            </button>
          </div>
          <textarea
            class="node-field-input node-field-textarea route-description"
            :class="{ dark: isDark }"
            rows="2"
            placeholder="e.g. Use when the user asks about billing, refunds, or account issues"
            :value="route.description || ''"
            @input="onRouteChange(idx, 'description', ($event.target as HTMLTextAreaElement).value)"
          />
        </div>
        <button
          class="route-add-btn"
          :class="{ dark: isDark }"
          @click="addRoute"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line
              x1="12"
              y1="5"
              x2="12"
              y2="19"
            />
            <line
              x1="5"
              y1="12"
              x2="19"
              y2="12"
            />
          </svg>
          Add Route
        </button>
      </div>
    </div>

    <div
      class="node-field help-section"
      :class="{ dark: isDark }"
    >
      <p
        class="help-title"
        :class="{ dark: isDark }"
      >
        How routing works
      </p>
      <p
        class="help-text"
        :class="{ dark: isDark }"
      >
        The router uses an LLM to read the incoming message and pick the best matching route.
        Each route needs a <strong>label</strong> (a short name shown on the node) and a
        <strong>description</strong> (tells the LLM when to choose this route).
      </p>
      <p
        class="help-text"
        :class="{ dark: isDark }"
      >
        The classification prompt gives the LLM overall context. Good descriptions are specific
        &mdash; instead of "general questions", write "questions not related to billing, sales, or technical support".
      </p>
      <p
        class="help-text"
        :class="{ dark: isDark }"
      >
        Each route creates a connectable output on the node. Connect each output to the
        downstream node that should handle that route.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { RouterNodeConfig } from './types';

const props = defineProps<{
  isDark: boolean;
  nodeId: string;
  config: RouterNodeConfig;
}>();

const emit = defineEmits<{
  'update-config': [nodeId: string, config: RouterNodeConfig];
}>();

function onPromptChange(event: Event) {
  const el = event.target as HTMLTextAreaElement;

  emit('update-config', props.nodeId, {
    ...props.config,
    classificationPrompt: el.value,
  });
}

function onRouteChange(idx: number, field: 'label' | 'description', value: string) {
  const routes = [...props.config.routes];
  routes[idx] = { ...routes[idx], [field]: value };
  emit('update-config', props.nodeId, { ...props.config, routes });
}

function addRoute() {
  const routes = [...props.config.routes, { label: '', description: '' }];
  emit('update-config', props.nodeId, { ...props.config, routes });
}

function removeRoute(idx: number) {
  const routes = props.config.routes.filter((_, i) => i !== idx);
  emit('update-config', props.nodeId, { ...props.config, routes });
}
</script>

<style scoped>
.router-config { padding: 0; }

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

.routes-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.route-card {
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.route-card.dark { border-color: var(--border-strong); }

.route-card-header {
  display: flex;
  gap: 4px;
  align-items: center;
}

.route-label-input { flex: 1; }

.route-description {
  resize: vertical;
  font-family: inherit;
  min-height: 40px;
  font-size: var(--fs-code);
}

.route-remove-btn {
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
.route-remove-btn:hover { background: var(--bg-hover); color: var(--text-error); }

.route-add-btn {
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
  margin-top: 4px;
}
.route-add-btn:hover { border-color: var(--accent-primary); color: var(--text-info); }
.route-add-btn.dark { border-color: var(--border-strong); color: var(--text-muted); }
.route-add-btn.dark:hover { border-color: var(--accent-primary); color: var(--text-info); }

.field-hint {
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  margin: 6px 0 0;
  line-height: 1.4;
}
.field-hint.dark { color: var(--text-secondary); }

.help-section {
  border-bottom: none;
}

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
