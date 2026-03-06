<template>
  <div class="workflow-pane" :class="{ dark: isDark }">
    <div class="workflow-header" :class="{ dark: isDark }">
      <span class="workflow-header-title">Agent Workflows</span>
      <button class="workflow-close-btn" :class="{ dark: isDark }" title="Close Panel" @click="$emit('close')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
    <div class="workflow-content">
      <div class="workflow-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.3">
          <rect x="2" y="3" width="6" height="5" rx="1"/>
          <rect x="16" y="3" width="6" height="5" rx="1"/>
          <rect x="9" y="16" width="6" height="5" rx="1"/>
          <path d="M5 8v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/>
          <line x1="12" y1="12" x2="12" y2="16"/>
        </svg>
        <p class="workflow-empty-text">Agent Workflows</p>
        <p class="workflow-empty-hint">Coming soon</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  isDark: boolean;
}>();

defineEmits<{
  'close': [];
}>();
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

.workflow-close-btn:hover {
  background: rgba(0,0,0,0.06);
  color: #475569;
}

.workflow-close-btn.dark {
  color: #64748b;
}

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
</style>
