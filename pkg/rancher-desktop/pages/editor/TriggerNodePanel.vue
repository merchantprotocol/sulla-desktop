<template>
  <div
    class="trigger-panel"
    :class="{ dark: isDark }"
  >
    <div class="trigger-section-label">
      Trigger Type
    </div>
    <div class="trigger-options">
      <button
        v-for="trigger in triggers"
        :key="trigger.id"
        class="trigger-option"
        :class="{ active: selectedTrigger === trigger.id, dark: isDark }"
        @click="selectTrigger(trigger.id)"
      >
        <div
          class="trigger-option-icon"
          v-html="trigger.icon"
        />
        <div class="trigger-option-info">
          <div class="trigger-option-name">
            {{ trigger.name }}
          </div>
          <div class="trigger-option-desc">
            {{ trigger.description }}
          </div>
        </div>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  isDark: boolean;
  nodeId: string;
}>();

const emit = defineEmits<{
  'update-trigger': [nodeId: string, triggerType: string];
}>();

const selectedTrigger = ref<string | null>(null);

// Only `manual` and `schedule` are user-selectable. Older trigger subtypes
// (calendar, chat-app, heartbeat, sulla-desktop, workbench, chat-completions)
// are subsumed by `manual` — any external invocation routes through it.
const triggers = [
  {
    id:          'manual',
    name:        'Manual',
    description: 'Run on demand — from chat, the UI, calendar events, or any external signal',
    icon:        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  },
  {
    id:          'schedule',
    name:        'Schedule',
    description: 'Cron-based recurring schedule trigger',
    icon:        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/><path d="M17.7 17.7l2.8 2.8"/></svg>',
  },
];

function selectTrigger(id: string) {
  selectedTrigger.value = id;
  emit('update-trigger', props.nodeId, id);
}
</script>

<style scoped>
.trigger-panel {
  padding: 12px;
}

.trigger-section-label {
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.trigger-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.trigger-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--bg-surface-hover);
  border-radius: 6px;
  background: var(--bg-surface);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, background 0.15s;
  width: 100%;
}

.trigger-option:hover {
  background: var(--bg-surface-alt);
}

.trigger-option.active {
  border-color: var(--accent-primary);
  background: var(--bg-accent);
}

.trigger-option-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  color: var(--text-secondary);
}

.trigger-option.active .trigger-option-icon {
  color: var(--accent-primary);
}

.trigger-option-info {
  flex: 1;
  min-width: 0;
}

.trigger-option-name {
  font-size: var(--fs-code);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
  line-height: 1.3;
}

.trigger-option-desc {
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  margin-top: 2px;
  line-height: 1.3;
}
</style>
