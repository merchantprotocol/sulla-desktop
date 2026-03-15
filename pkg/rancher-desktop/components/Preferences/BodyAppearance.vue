<script lang="ts">
import { defineComponent } from 'vue';

import { availableThemes, themeGroups } from '@pkg/composables/useTheme';
import type { ThemeScheme } from '@pkg/composables/useTheme';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const THEME_STORAGE_KEY = 'agentTheme';
const THEME_SETTING_KEY = 'theme';

export default defineComponent({
  name: 'preferences-body-appearance',
  data() {
    return {
      selectedTheme: localStorage.getItem(THEME_STORAGE_KEY) || 'default-light',
      themeGroups,
    };
  },
  computed: {
    selectedScheme(): ThemeScheme {
      const theme = availableThemes.find(t => t.id === this.selectedTheme);
      return theme?.scheme ?? 'default';
    },
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
    selectScheme(scheme: ThemeScheme) {
      // Find the current mode from the active theme
      const current = availableThemes.find(t => t.id === this.selectedTheme);
      const preferredMode = current?.mode ?? 'dark';
      // Pick the variant matching the current mode, or fall back to any variant
      const match = availableThemes.find(t => t.scheme === scheme && t.mode === preferredMode) ??
        availableThemes.find(t => t.scheme === scheme);
      if (match) {
        this.selectedTheme = match.id;
        localStorage.setItem(THEME_STORAGE_KEY, match.id);
        // Persist to database so theme survives app reload
        SullaSettingsModel.set(THEME_SETTING_KEY, match.id, 'string').catch(() => {});
        window.dispatchEvent(new StorageEvent('storage', {
          key:      THEME_STORAGE_KEY,
          newValue: match.id,
        }));
        this.$store.dispatch('preferences/setCanApply', true);
        ipcRenderer.send('preferences-set-dirty', true);
      }
    },
    hasBothModes(group: typeof themeGroups[number]): boolean {
      return group.themes.some(t => t.mode === 'light') && group.themes.some(t => t.mode === 'dark');
    },
  },
});
</script>

<template>
  <div class="appearance-content">
    <h3>Theme</h3>
    <p class="description">
      Choose a visual theme for Sulla Desktop. Use the sun/moon button in the header to switch between light and dark mode.
    </p>

    <div class="theme-list">
      <button
        v-for="group in themeGroups"
        :key="group.scheme"
        class="theme-card"
        :class="{ active: selectedScheme === group.scheme }"
        @click="selectScheme(group.scheme)"
      >
        <div
          class="theme-preview"
          :class="hasBothModes(group) ? 'split' : ''"
        >
          <template v-if="hasBothModes(group)">
            <div
              class="preview-half"
              :class="'preview-' + group.scheme + '-light'"
            />
            <div
              class="preview-half"
              :class="'preview-' + group.scheme + '-dark'"
            />
          </template>
          <template v-else>
            <div
              class="preview-full"
              :class="'preview-' + group.themes[0].id"
            />
          </template>
        </div>
        <div class="theme-card-label">
          <span
            class="theme-card-dot"
            :class="{ active: selectedScheme === group.scheme }"
          />
          {{ group.label }}
        </div>
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.appearance-content {
  padding: var(--preferences-content-padding, 1.5rem);

  h3 {
    margin: 0 0 0.25rem;
    font-size: var(--fs-heading);
    font-weight: 600;
  }

  .description {
    color: var(--text-secondary, #64748b);
    font-size: var(--fs-body);
    margin: 0 0 1rem;
  }
}

.theme-list {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.theme-card {
  display: flex;
  flex-direction: column;
  min-width: 140px;
  max-width: 200px;
  flex: 1;
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
  overflow: hidden;

  &.split {
    display: flex;
  }
}

.preview-half {
  flex: 1;
  height: 100%;
}

.preview-full {
  width: 100%;
  height: 100%;
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

.preview-protocol-dark {
  background: linear-gradient(135deg, #0d1117 0%, #161b22 40%, #5096b3 100%);
}

.theme-card-label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font-size: var(--fs-code);
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
