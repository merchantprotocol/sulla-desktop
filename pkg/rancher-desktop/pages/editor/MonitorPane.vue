<template>
  <div class="monitor-nav" :class="{ dark: isDark }">
    <div class="pane-header">
      <span class="pane-title">MONITOR</span>
      <button class="pane-close" @click="$emit('close')" title="Close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>

    <div class="nav-items">
      <button
        v-for="item in navItems"
        :key="item.id"
        class="nav-item"
        :class="{ active: activeSection === item.id }"
        @click="$emit('section-change', item.id)"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" v-html="item.icon"></svg>
        <span class="nav-label">{{ item.label }}</span>
        <span v-if="item.badge" class="nav-badge" :class="item.badgeClass">{{ item.badge }}</span>
      </button>
    </div>

    <div class="nav-footer">
      <button class="refresh-btn" @click="$emit('refresh')">Refresh All</button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  isDark: boolean;
  activeSection: string;
}>();

defineEmits<{
  close: [];
  'section-change': [section: string];
  refresh: [];
}>();

const navItems = [
  {
    id: 'health',
    label: 'Health',
    icon: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    badge: null,
    badgeClass: '',
  },
  {
    id: 'heartbeat',
    label: 'Heartbeat',
    icon: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
    badge: null,
    badgeClass: '',
  },
  {
    id: 'live',
    label: 'Live',
    icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    badge: null,
    badgeClass: '',
  },
  {
    id: 'conversations',
    label: 'Conversations',
    icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    badge: null,
    badgeClass: '',
  },
  {
    id: 'errors',
    label: 'Errors',
    icon: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    badge: null,
    badgeClass: '',
  },
];
</script>

<style scoped>
.monitor-nav {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-size: 12px;
  color: #334155;
}
.monitor-nav.dark { color: #94a3b8; }

.pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: #64748b;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.dark .pane-header { border-color: #334155; color: #94a3b8; }

.pane-close {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 2px;
  border-radius: 3px;
  display: flex;
}
.pane-close:hover { background: rgba(0,0,0,0.08); }
.dark .pane-close:hover { background: rgba(255,255,255,0.08); }

.nav-items {
  flex: 1;
  padding: 8px 0;
  overflow-y: auto;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  text-align: left;
  transition: background 0.1s;
}
.nav-item:hover { background: rgba(0,0,0,0.05); }
.dark .nav-item:hover { background: rgba(255,255,255,0.05); }

.nav-item.active {
  background: rgba(0, 120, 212, 0.08);
  color: #0078d4;
  font-weight: 500;
}
.dark .nav-item.active {
  background: rgba(0, 120, 212, 0.15);
  color: #60a5fa;
}

.nav-label { flex: 1; }

.nav-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;
}

.nav-footer {
  padding: 8px 10px;
  border-top: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.dark .nav-footer { border-color: #334155; }

.refresh-btn {
  width: 100%;
  padding: 6px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 11px;
}
.refresh-btn:hover { background: rgba(0,0,0,0.05); }
.dark .refresh-btn { border-color: #334155; }
.dark .refresh-btn:hover { background: rgba(255,255,255,0.05); }
</style>
