<script lang="ts">
import { defineComponent } from 'vue';

import { availableThemes, themeGroups } from '@pkg/composables/useTheme';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const THEME_STORAGE_KEY = 'agentTheme';

export default defineComponent({
  name: 'preferences-body-appearance',
  data() {
    return {
      selectedTheme:  localStorage.getItem(THEME_STORAGE_KEY) || 'default-light',
      availableThemes,
      themeGroups,
    };
  },
  mounted() {
    window.addEventListener('storage', this.onStorageChange);
  },
  beforeUnmount() {
    window.removeEventListener('storage', this.onStorageChange);
  },
  methods: {
    onStorageChange(e: StorageEvent) {
      if (e.key === THEME_STORAGE_KEY && e.newValue) {
        this.selectedTheme = e.newValue;
      }
    },
    setTheme(themeId: string) {
      this.selectedTheme = themeId;
      localStorage.setItem(THEME_STORAGE_KEY, themeId);
      window.dispatchEvent(new StorageEvent('storage', {
        key:      THEME_STORAGE_KEY,
        newValue: themeId,
      }));
      // Enable the Apply button so the user can close with Apply
      this.$store.dispatch('preferences/setCanApply', true);
      ipcRenderer.send('preferences-set-dirty', true);
    },
  },
});
</script>

<template>
  <div class="appearance-content">
    <h3>Theme</h3>
    <p class="description">
      Choose a visual theme for Sulla Desktop. Your selection applies across all windows.
    </p>

    <div class="theme-groups">
      <div v-for="group in themeGroups" :key="group.scheme" class="theme-group">
        <div class="theme-group-label">{{ group.label }}</div>
        <div class="theme-variants">
          <button
            v-for="theme in group.themes"
            :key="theme.id"
            class="theme-card"
            :class="{ active: selectedTheme === theme.id }"
            @click="setTheme(theme.id)"
          >
            <div class="theme-preview" :class="'preview-' + theme.id" />
            <div class="theme-card-label">
              <span class="theme-card-dot" :class="{ active: selectedTheme === theme.id }" />
              {{ theme.mode === 'light' ? 'Light' : 'Dark' }}
            </div>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.appearance-content {
  padding: var(--preferences-content-padding, 1.5rem);

  h3 {
    margin: 0 0 0.25rem;
    font-size: 1.1rem;
    font-weight: 600;
  }

  .description {
    color: var(--text-secondary, #64748b);
    font-size: 0.875rem;
    margin: 0 0 1rem;
  }
}

.theme-groups {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.theme-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.theme-group-label {
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary, #64748b);
}

.theme-variants {
  display: flex;
  flex-direction: row;
  gap: 12px;
}

.theme-card {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 140px;
  max-width: 200px;
  border: 2px solid var(--border-default, #e2e8f0);
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
  background: transparent;
  padding: 0;
  text-align: left;

  &:hover {
    border-color: var(--border-strong, #94a3b8);
  }

  &.active {
    border-color: var(--accent-primary, #0ea5e9);
    box-shadow: 0 0 0 2px rgba(14, 165, 233, 0.2);
  }
}

.theme-preview {
  height: 80px;
  border-bottom: 1px solid var(--border-default, #e2e8f0);
}

.preview-default-light {
  background: linear-gradient(135deg, #ffffff 0%, #f1f5f9 50%, #e2e8f0 100%);
}

.preview-default-dark {
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #334155 100%);
}

.preview-ocean-light {
  background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 50%, #90caf9 100%);
}

.preview-ocean-dark {
  background: linear-gradient(135deg, #0a1929 0%, #132f4c 50%, #1a3a5c 100%);
}

.preview-nord-light {
  background: linear-gradient(135deg, #eceff4 0%, #e5e9f0 50%, #d8dee9 100%);
}

.preview-nord-dark {
  background: linear-gradient(135deg, #2e3440 0%, #3b4252 50%, #434c5e 100%);
}

.theme-card-label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--text-primary, #334155);
}

.theme-card-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--border-strong, #cbd5e1);
  flex-shrink: 0;

  &.active {
    border-color: var(--accent-primary, #0ea5e9);
    background: var(--accent-primary, #0ea5e9);
  }
}
</style>
