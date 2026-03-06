<template>
  <div class="workflow-pane" :class="{ dark: isDark }">
    <div class="workflow-header" :class="{ dark: isDark }">
      <span class="workflow-header-title">Workflows</span>
      <div class="workflow-header-actions">
        <button class="workflow-action-btn" :class="{ dark: isDark }" title="New Workflow" @click="onNewWorkflow">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
        <button class="workflow-close-btn" :class="{ dark: isDark }" title="Close Panel" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>
    <div class="workflow-content">
      <div v-if="workflows.length === 0" class="workflow-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.3">
          <rect x="2" y="3" width="6" height="5" rx="1"/>
          <rect x="16" y="3" width="6" height="5" rx="1"/>
          <rect x="9" y="16" width="6" height="5" rx="1"/>
          <path d="M5 8v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/>
          <line x1="12" y1="12" x2="12" y2="16"/>
        </svg>
        <p class="workflow-empty-text">No workflows yet</p>
        <p class="workflow-empty-hint">Click + to create your first workflow</p>
      </div>
      <div v-else class="workflow-list">
        <div
          v-for="wf in workflows"
          :key="wf.id"
          class="workflow-item"
          :class="{ active: wf.id === activeWorkflowId, dark: isDark }"
          @click="selectWorkflow(wf.id)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="6" height="5" rx="1"/>
            <rect x="16" y="3" width="6" height="5" rx="1"/>
            <rect x="9" y="16" width="6" height="5" rx="1"/>
            <path d="M5 8v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/>
            <line x1="12" y1="12" x2="12" y2="16"/>
          </svg>
          <span class="workflow-item-name">{{ wf.name }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

defineProps<{
  isDark: boolean;
}>();

defineEmits<{
  'close': [];
}>();

interface Workflow {
  id: string;
  name: string;
}

const workflows = ref<Workflow[]>([]);
const activeWorkflowId = ref<string | null>(null);
let nextId = 1;

function onNewWorkflow() {
  const wf: Workflow = { id: String(nextId++), name: `Workflow ${ nextId - 1 }` };

  workflows.value.push(wf);
  activeWorkflowId.value = wf.id;
}

function selectWorkflow(id: string) {
  activeWorkflowId.value = id;
}
</script>

<style scoped>
.workflow-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #f8fafc;
  color: #333;
  font-size: 13px;
  user-select: none;
  overflow: hidden;
}

.workflow-pane.dark {
  background: #1e293b;
  color: #ccc;
}

.workflow-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 12px;
  height: 35px;
  flex-shrink: 0;
  background: #f8fafc;
  border-bottom: 1px solid #cbd5e1;
}

.workflow-header.dark {
  background: #1e293b;
  border-bottom-color: #3c3c3c;
}

.workflow-header-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
}

.workflow-header.dark .workflow-header-title {
  color: #94a3b8;
}

.workflow-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.workflow-action-btn,
.workflow-close-btn {
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
}

.workflow-action-btn:hover,
.workflow-close-btn:hover {
  background: rgba(0,0,0,0.06);
  color: #475569;
}

.workflow-action-btn.dark,
.workflow-close-btn.dark {
  color: #64748b;
}

.workflow-action-btn.dark:hover,
.workflow-close-btn.dark:hover {
  background: rgba(255,255,255,0.08);
  color: #94a3b8;
}

.workflow-content {
  flex: 1;
  overflow-y: auto;
}

.workflow-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 16px;
  gap: 8px;
}

.workflow-empty-text {
  font-size: 13px;
  font-weight: 500;
  color: #64748b;
  margin: 0;
}

.workflow-empty-hint {
  font-size: 11px;
  color: #94a3b8;
  margin: 0;
}

.workflow-pane.dark .workflow-empty-text {
  color: #94a3b8;
}

.workflow-pane.dark .workflow-empty-hint {
  color: #64748b;
}

.workflow-list {
  padding: 4px 0;
}

.workflow-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  color: #475569;
}

.workflow-item:hover {
  background: rgba(0,0,0,0.04);
}

.workflow-item.active {
  background: rgba(99, 102, 241, 0.1);
  color: #6366f1;
}

.workflow-item.dark {
  color: #94a3b8;
}

.workflow-item.dark:hover {
  background: rgba(255,255,255,0.06);
}

.workflow-item.dark.active {
  background: rgba(99, 102, 241, 0.15);
  color: #818cf8;
}

.workflow-item-name {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
