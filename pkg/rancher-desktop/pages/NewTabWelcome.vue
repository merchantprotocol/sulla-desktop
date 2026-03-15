<template>
  <div class="new-tab-root">
    <div class="new-tab-center">
      <!-- Chat input — Google-style centered bar -->
      <form class="new-tab-chat-form" @submit.prevent="startChat">
        <div class="new-tab-input-wrapper">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="new-tab-input-icon">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <input
            ref="chatInput"
            v-model="chatQuery"
            type="text"
            class="new-tab-input"
            placeholder="Start a new chat..."
            autofocus
          />
          <button
            v-if="chatQuery.trim()"
            type="submit"
            class="new-tab-send-btn"
            aria-label="Send"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </form>

      <!-- Quick links grid -->
      <div class="new-tab-grid">
        <button
          v-for="link in quickLinks"
          :key="link.id"
          class="new-tab-tile"
          @click="link.action"
        >
          <div class="new-tab-tile-icon" :style="{ background: link.color }">
            <component :is="link.icon" />
          </div>
          <span class="new-tab-tile-label">{{ link.label }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, h, onMounted } from 'vue';
import type { BrowserTabMode } from '@pkg/composables/useBrowserTabs';

const chatQuery = ref('');
const chatInput = ref<HTMLInputElement | null>(null);

const emit = defineEmits<{
  'start-chat': [query: string];
  'set-mode':   [mode: BrowserTabMode];
}>();

function startChat() {
  const text = chatQuery.value.trim();
  if (!text) return;
  emit('start-chat', text);
}

// SVG icon render functions
const ChatIcon = () => h('svg', {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  class: 'new-tab-svg',
}, [
  h('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }),
]);

const CalendarIcon = () => h('svg', {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  class: 'new-tab-svg',
}, [
  h('rect', { x: '3', y: '4', width: '18', height: '18', rx: '2', ry: '2' }),
  h('line', { x1: '16', y1: '2', x2: '16', y2: '6' }),
  h('line', { x1: '8', y1: '2', x2: '8', y2: '6' }),
  h('line', { x1: '3', y1: '10', x2: '21', y2: '10' }),
]);

const IntegrationsIcon = () => h('svg', {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  class: 'new-tab-svg',
}, [
  h('circle', { cx: '12', cy: '12', r: '3' }),
  h('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }),
]);

const ExtensionsIcon = () => h('svg', {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  class: 'new-tab-svg',
}, [
  h('rect', { x: '3', y: '3', width: '7', height: '7' }),
  h('rect', { x: '14', y: '3', width: '7', height: '7' }),
  h('rect', { x: '14', y: '14', width: '7', height: '7' }),
  h('rect', { x: '3', y: '14', width: '7', height: '7' }),
]);

const quickLinks = [
  {
    id:     'chat',
    label:  'Chat',
    icon:   ChatIcon,
    color:  'var(--accent-primary)',
    action: () => emit('set-mode', 'chat'),
  },
  {
    id:     'calendar',
    label:  'Calendar',
    icon:   CalendarIcon,
    color:  '#f59e0b',
    action: () => emit('set-mode', 'calendar'),
  },
  {
    id:     'integrations',
    label:  'Integrations',
    icon:   IntegrationsIcon,
    color:  '#8b5cf6',
    action: () => emit('set-mode', 'integrations'),
  },
  {
    id:     'extensions',
    label:  'Extensions',
    icon:   ExtensionsIcon,
    color:  '#10b981',
    action: () => emit('set-mode', 'extensions'),
  },
];

onMounted(() => {
  chatInput.value?.focus();
});
</script>

<style scoped>
.new-tab-root {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: var(--bg-page);
}

.new-tab-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2.5rem;
  width: 100%;
  max-width: 560px;
  padding: 0 1.5rem;
  margin-top: -6rem;
}

.new-tab-chat-form {
  width: 100%;
}

.new-tab-input-wrapper {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.75rem 1rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 1.5rem;
  transition: border-color 200ms, box-shadow 200ms;
}

.new-tab-input-wrapper:focus-within {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary) 15%, transparent);
}

.new-tab-input-icon {
  width: 1.25rem;
  height: 1.25rem;
  color: var(--text-muted);
  flex-shrink: 0;
}

.new-tab-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-size: 0.9375rem;
}

.new-tab-input::placeholder {
  color: var(--text-muted);
}

.new-tab-send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.375rem;
  border-radius: 50%;
  background: var(--accent-primary);
  color: var(--bg-page);
  border: none;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 150ms;
}

.new-tab-send-btn:hover {
  opacity: 0.85;
}

.new-tab-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
  width: 100%;
  max-width: 420px;
}

.new-tab-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 1rem 0.5rem;
  background: transparent;
  border: none;
  border-radius: 0.75rem;
  cursor: pointer;
  transition: background-color 150ms;
}

.new-tab-tile:hover {
  background: var(--bg-surface);
}

.new-tab-tile-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 3rem;
  height: 3rem;
  border-radius: 0.75rem;
  color: white;
}

.new-tab-svg {
  width: 1.25rem;
  height: 1.25rem;
}

.new-tab-tile-label {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-secondary);
}
</style>
