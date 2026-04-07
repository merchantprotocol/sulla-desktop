<template>
  <div class="computer-use-settings">
    <!-- Header -->
    <div class="settings-header">
      <h1>Computer Use Settings</h1>
    </div>

    <!-- Body -->
    <div class="settings-body">
      <p class="settings-description">
        Control which applications Sulla can interact with on your Mac.
        macOS will also ask for your permission the first time Sulla accesses each app.
      </p>

      <!-- Bulk controls -->
      <div class="settings-controls">
        <button
          class="action-btn"
          @click="selectAll"
        >
          Select All
        </button>
        <button
          class="action-btn"
          @click="deselectAll"
        >
          Deselect All
        </button>
      </div>

      <!-- Loading state -->
      <div
        v-if="loading"
        class="loading-state"
      >
        Detecting installed applications...
      </div>

      <!-- App list by category -->
      <div
        v-else
        class="app-list"
      >
        <div
          v-for="category in categories"
          :key="category.id"
          class="app-category"
        >
          <!-- Only show category if it has installed apps (or any apps) -->
          <template v-if="getAppsForCategory(category.id).length > 0">
            <h2 class="category-header">
              {{ category.label }}
            </h2>
            <div
              v-for="app in getAppsForCategory(category.id)"
              :key="app.bundleId"
              class="app-entry"
              :class="{ 'is-disabled': !isInstalled(app.bundleId) }"
            >
              <div class="app-info">
                <div class="app-name">
                  {{ app.name }}
                </div>
                <div class="app-description">
                  {{ app.description }}
                </div>
                <div
                  v-if="!isInstalled(app.bundleId)"
                  class="not-installed-label"
                >
                  Not Installed
                </div>
              </div>
              <label class="toggle-switch">
                <input
                  type="checkbox"
                  :checked="enabledApps[app.bundleId] || false"
                  :disabled="!isInstalled(app.bundleId)"
                  @change="toggleApp(app.bundleId, $event)"
                >
                <span class="toggle-slider" />
              </label>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useTheme } from '../composables/useTheme';
import { SullaSettingsModel } from '../agent/database/models/SullaSettingsModel';
import { APP_REGISTRY, APP_CATEGORIES } from '../main/computerUseSettings/appRegistry';
import type { AppCategory, AppEntry } from '../main/computerUseSettings/appRegistry';

const { execFile } = require('child_process');
const { ipcRenderer } = require('electron');

useTheme();

// ─── State ─────────────────────────────────────────────────────

const enabledApps = ref<Record<string, boolean>>({});
const installedApps = ref<string[]>([]);
const loading = ref(true);
const categories = APP_CATEGORIES;
const registry = APP_REGISTRY;

// ─── Methods ───────────────────────────────────────────────────

function getAppsForCategory(categoryId: AppCategory): AppEntry[] {
  return registry.filter(app => app.category === categoryId);
}

function isInstalled(bundleId: string): boolean {
  return installedApps.value.includes(bundleId);
}

async function loadSettings() {
  const stored = await SullaSettingsModel.get('computerUse.enabledApps', '{}');
  try {
    enabledApps.value = typeof stored === 'string' ? JSON.parse(stored) : (stored || {});
  } catch {
    enabledApps.value = {};
  }
}

async function saveSettings() {
  await SullaSettingsModel.set('computerUse.enabledApps', JSON.stringify(enabledApps.value), 'string');
}

async function toggleApp(bundleId: string, event: Event) {
  const target = event.target as HTMLInputElement;
  enabledApps.value = { ...enabledApps.value, [bundleId]: target.checked };
  await saveSettings();

  if (target.checked) {
    const appEntry = registry.find(a => a.bundleId === bundleId);
    if (appEntry) {
      ipcRenderer.invoke('computer-use:request-permission', appEntry.name).catch(() => {});
    }
  }
}

async function selectAll() {
  const updated: Record<string, boolean> = { ...enabledApps.value };
  for (const app of registry) {
    if (isInstalled(app.bundleId)) {
      updated[app.bundleId] = true;
    }
  }
  enabledApps.value = updated;
  await saveSettings();
}

async function deselectAll() {
  enabledApps.value = {};
  await saveSettings();
}

async function detectInstalledApps() {
  const checks = registry.map(app => {
    return new Promise<string | null>((resolve) => {
      execFile('mdfind', [
        `kMDItemCFBundleIdentifier == "${ app.bundleId }"`,
      ], { timeout: 5000 }, (error: any, stdout: string) => {
        if (!error && stdout && stdout.trim().length > 0) {
          resolve(app.bundleId);
        } else {
          resolve(null);
        }
      });
    });
  });
  const results = await Promise.all(checks);
  installedApps.value = results.filter((id): id is string => id !== null);
}

// ─── Lifecycle ─────────────────────────────────────────────────

onMounted(async() => {
  await loadSettings();
  await detectInstalledApps();
  loading.value = false;
  ipcRenderer.send('dialog/ready');
});
</script>

<style lang="scss" scoped>
.computer-use-settings {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-page, var(--body-bg));
  color: var(--text-primary, var(--body-text));
}

.settings-header {
  height: 3rem;
  font-size: var(--fs-heading);
  line-height: 2rem;
  display: flex;
  align-items: center;
  padding: 0 0.75rem;
  width: 100%;
  border-bottom: 1px solid var(--border-default, var(--header-border));

  h1 {
    flex: 1;
    margin: 0;
    font-size: inherit;
    font-weight: normal;
  }
}

.settings-body {
  flex: 1;
  padding: 1.5rem;
  overflow: auto;
}

.settings-description {
  font-size: var(--fs-body);
  color: var(--text-muted, var(--muted));
  margin: 0 0 1.25rem;
  line-height: 1.5;
}

.settings-controls {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}

.action-btn {
  padding: 0.5rem 1rem;
  border: 1px solid var(--border-default, var(--input-border));
  border-radius: 6px;
  background: var(--bg-page, var(--input-bg));
  color: var(--text-primary, var(--body-text));
  font-size: var(--fs-body);
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background: var(--bg-surface-hover, var(--nav-active));
  }
}

.loading-state {
  font-size: var(--fs-body);
  color: var(--text-muted, var(--muted));
  padding: 2rem 0;
}

// ─── Category ──────────────────────────────────────────────────

.app-category {
  margin-bottom: 1.5rem;
}

.category-header {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted, var(--muted));
  margin: 0 0 0.5rem;
  padding-bottom: 0.4rem;
  border-bottom: 1px solid var(--border-default, var(--header-border));
}

// ─── App entry ─────────────────────────────────────────────────

.app-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 0.5rem;
  border-bottom: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.1));
  transition: background 0.12s;

  &:hover {
    background: var(--bg-surface-hover, var(--nav-active));
  }

  &:last-child {
    border-bottom: none;
  }

  &.is-disabled {
    opacity: 0.45;
  }
}

.app-info {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  flex: 1;
  min-width: 0;
}

.app-name {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--text-primary, var(--body-text));
}

.app-description {
  font-size: var(--fs-body-sm, 0.8rem);
  color: var(--text-muted, var(--muted));
  line-height: 1.4;
}

.not-installed-label {
  font-size: var(--fs-body-sm, 0.75rem);
  font-style: italic;
  color: var(--status-warning, #f59e0b);
}

// ─── Toggle switch ─────────────────────────────────────────────

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  flex-shrink: 0;
  margin-left: 1rem;

  input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-slider {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--border-default, #ccc);
    border-radius: 24px;
    transition: background 0.2s;

    &::before {
      content: '';
      position: absolute;
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background: white;
      border-radius: 50%;
      transition: transform 0.2s;
    }
  }

  input:checked + .toggle-slider {
    background: var(--accent-primary, var(--primary, #3b82f6));
  }

  input:checked + .toggle-slider::before {
    transform: translateX(20px);
  }

  input:disabled + .toggle-slider {
    cursor: not-allowed;
    opacity: 0.5;
  }
}
</style>
