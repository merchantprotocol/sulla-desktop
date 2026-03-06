<template>
  <header class="editor-header-bar" :class="{ dark: isDark }">
    <!-- Left: Logo -->
    <div class="header-left">
      <a aria-label="Home page" href="#/" class="logo-link">
        <img
          :src="logoLightUrl"
          alt="Sulla Desktop"
          class="logo"
          :class="{ hidden: isDark }"
        >
        <img
          :src="logoDarkUrl"
          alt="Sulla Desktop"
          class="logo"
          :class="{ hidden: !isDark }"
        >
      </a>
    </div>

    <!-- Right: Pane toggles + theme -->
    <div class="header-right">
      <!-- Toggle left pane (sidebar) -->
      <button
        class="header-btn"
        :class="{ dark: isDark }"
        type="button"
        aria-label="Toggle sidebar"
        title="Toggle sidebar"
        @click="$emit('toggle-left-pane')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="2" width="14" height="12" rx="1" :stroke="isDark ? '#ccc' : '#333'" stroke-width="1.2"/>
          <rect x="1" y="2" width="4" height="12" rx="1" :fill="leftPaneVisible ? (isDark ? '#ccc' : '#333') : 'none'" :stroke="isDark ? '#ccc' : '#333'" stroke-width="1.2"/>
        </svg>
      </button>

      <!-- Toggle bottom pane (terminal) -->
      <button
        class="header-btn"
        :class="{ dark: isDark }"
        type="button"
        aria-label="Toggle terminal"
        title="Toggle terminal"
        @click="$emit('toggle-bottom-pane')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="2" width="14" height="12" rx="1" :stroke="isDark ? '#ccc' : '#333'" stroke-width="1.2"/>
          <rect x="1" y="10" width="14" height="4" rx="1" :fill="bottomPaneVisible ? (isDark ? '#ccc' : '#333') : 'none'" :stroke="isDark ? '#ccc' : '#333'" stroke-width="1.2"/>
        </svg>
      </button>

      <!-- Toggle right pane -->
      <button
        class="header-btn"
        :class="{ dark: isDark }"
        type="button"
        aria-label="Toggle right panel"
        title="Toggle right panel"
        @click="$emit('toggle-right-pane')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="2" width="14" height="12" rx="1" :stroke="isDark ? '#ccc' : '#333'" stroke-width="1.2"/>
          <rect x="11" y="2" width="4" height="12" rx="1" :fill="rightPaneVisible ? (isDark ? '#ccc' : '#333') : 'none'" :stroke="isDark ? '#ccc' : '#333'" stroke-width="1.2"/>
        </svg>
      </button>

      <div class="header-separator"></div>

      <!-- Theme toggle -->
      <button
        class="header-btn"
        :class="{ dark: isDark }"
        type="button"
        :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
        :title="isDark ? 'Light mode' : 'Dark mode'"
        @click="toggleTheme"
      >
        <svg v-if="isDark" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M7 1a1 1 0 0 1 2 0v1a1 1 0 1 1-2 0V1Zm4 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm2.657-5.657a1 1 0 0 0-1.414 0l-.707.707a1 1 0 0 0 1.414 1.414l.707-.707a1 1 0 0 0 0-1.414Zm-1.415 11.313-.707-.707a1 1 0 0 1 1.415-1.415l.707.708a1 1 0 0 1-1.415 1.414ZM16 7.999a1 1 0 0 0-1-1h-1a1 1 0 1 0 0 2h1a1 1 0 0 0 1-1ZM7 14a1 1 0 1 1 2 0v1a1 1 0 1 1-2 0v-1Zm-2.536-2.464a1 1 0 0 0-1.414 0l-.707.707a1 1 0 0 0 1.414 1.414l.707-.707a1 1 0 0 0 0-1.414Zm0-8.486A1 1 0 0 1 3.05 4.464l-.707-.707a1 1 0 1 1 1.414-1.414l.707.707ZM3 8a1 1 0 0 0-1-1H1a1 1 0 0 0 0 2h1a1 1 0 0 0 1-1Z"/>
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M7.23 3.333C7.757 2.905 7.68 2 7 2a6 6 0 1 0 0 12c.68 0 .758-.905.23-1.332A5.989 5.989 0 0 1 5 8c0-1.885.87-3.568 2.23-4.668ZM12 5a1 1 0 0 1 1 1 1 1 0 0 0 1 1 1 1 0 0 1 0 2 1 1 0 0 0-1 1 1 1 0 1 1-2 0 1 1 0 0 0-1-1 1 1 0 1 1 0-2 1 1 0 0 0 1-1Z"/>
        </svg>
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
defineProps<{
  isDark: boolean;
  toggleTheme: () => void;
  leftPaneVisible: boolean;
  bottomPaneVisible: boolean;
  rightPaneVisible: boolean;
}>();

defineEmits<{
  'toggle-left-pane': [];
  'toggle-bottom-pane': [];
  'toggle-right-pane': [];
}>();

const logoLightUrl = new URL('../../../../resources/icons/logo-sulla-desktop-nobg.png', import.meta.url).toString();
const logoDarkUrl = new URL('../../../../resources/icons/logo-sulla-desktop-dark-nobg.png', import.meta.url).toString();
</script>

<style scoped>
.editor-header-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  padding: 0 8px;
  background: #f0f0f0;
  border-bottom: 1px solid #cbd5e1;
  flex-shrink: 0;
  -webkit-app-region: drag;
}

.editor-header-bar.dark {
  background: #1e1e2e;
  border-bottom-color: #2d2d3d;
}

.header-left {
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
}

.logo-link {
  display: flex;
  align-items: center;
}

.logo {
  height: 18px;
  width: auto;
}

.logo.hidden {
  display: none;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 2px;
  -webkit-app-region: no-drag;
}

.header-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: #333;
  cursor: pointer;
  transition: background 0.1s;
}

.header-btn:hover {
  background: rgba(0, 0, 0, 0.08);
}

.header-btn.dark {
  color: #ccc;
}

.header-btn.dark:hover {
  background: rgba(255, 255, 255, 0.08);
}

.header-separator {
  width: 1px;
  height: 14px;
  background: #ccc;
  margin: 0 4px;
}

.editor-header-bar.dark .header-separator {
  background: #444;
}
</style>
