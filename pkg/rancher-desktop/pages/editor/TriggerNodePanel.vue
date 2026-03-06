<template>
  <div class="trigger-panel" :class="{ dark: isDark }">
    <div class="trigger-section-label">Trigger Type</div>
    <div class="trigger-options">
      <button
        v-for="trigger in triggers"
        :key="trigger.id"
        class="trigger-option"
        :class="{ active: selectedTrigger === trigger.id, dark: isDark }"
        @click="selectTrigger(trigger.id)"
      >
        <div class="trigger-option-icon" v-html="trigger.icon"></div>
        <div class="trigger-option-info">
          <div class="trigger-option-name">{{ trigger.name }}</div>
          <div class="trigger-option-desc">{{ trigger.description }}</div>
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

const triggers = [
  {
    id:          'calendar',
    name:        'Calendar Event',
    description: 'Triggered by a calendar event or schedule',
    icon:        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  },
  {
    id:          'chat-app',
    name:        'Chat App',
    description: 'Slack, Telegram, or other messaging platforms',
    icon:        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  },
  {
    id:          'heartbeat',
    name:        'Heartbeat',
    description: 'Periodic interval that triggers the agent',
    icon:        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  },
  {
    id:          'sulla-desktop',
    name:        'Sulla Desktop',
    description: 'User chatting directly in the desktop app',
    icon:        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  },
  {
    id:          'chat-completions',
    name:        'Chat Completions API',
    description: 'OpenAI-compatible /v1/chat/completions endpoint',
    icon:        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6-6-6"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
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
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
  margin-bottom: 8px;
}

.trigger-panel.dark .trigger-section-label {
  color: #94a3b8;
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
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, background 0.15s;
  width: 100%;
}

.trigger-option:hover {
  border-color: #cbd5e1;
  background: #f8fafc;
}

.trigger-option.active {
  border-color: #6366f1;
  background: rgba(99, 102, 241, 0.06);
}

.trigger-option.dark {
  background: #2d2d44;
  border-color: #3c3c5c;
  color: #e2e8f0;
}

.trigger-option.dark:hover {
  border-color: #4a4a6a;
  background: #33334e;
}

.trigger-option.dark.active {
  border-color: #6366f1;
  background: rgba(99, 102, 241, 0.15);
}

.trigger-option-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  color: #64748b;
}

.trigger-option.active .trigger-option-icon {
  color: #6366f1;
}

.trigger-option.dark .trigger-option-icon {
  color: #94a3b8;
}

.trigger-option.dark.active .trigger-option-icon {
  color: #818cf8;
}

.trigger-option-info {
  flex: 1;
  min-width: 0;
}

.trigger-option-name {
  font-size: 13px;
  font-weight: 500;
  color: #1e293b;
  line-height: 1.3;
}

.trigger-option.dark .trigger-option-name {
  color: #e2e8f0;
}

.trigger-option-desc {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 2px;
  line-height: 1.3;
}

.trigger-option.dark .trigger-option-desc {
  color: #64748b;
}
</style>
