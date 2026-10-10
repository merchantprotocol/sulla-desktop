<template>
  <div class="computer-use-settings">
    <!-- Header -->
    <div class="settings-header">
      <h1>Computer Use Settings</h1>
    </div>

    <!-- Body -->
    <div class="settings-body">
      <div class="noir-computer-head">
        <div class="noir-computer-eyebrow">
          Computer Use
        </div>
        <div class="noir-computer-headline">
          Your Mac, with boundaries.
        </div>
        <div class="noir-computer-lead">
          Choose the applications Sulla can control and verify each permission in place.
        </div>
      </div>
      <p class="settings-description">
        Control which applications Sulla can interact with on your Mac.
        macOS will also ask for your permission the first time Sulla accesses each app.
      </p>

      <div class="noir-computer-hero">
        <div>
          <span class="noir-computer-hero-title">Permission overview</span>
          <span class="noir-computer-hero-copy">Changes save automatically</span>
        </div>
        <div class="noir-computer-stats">
          <div><b>{{ installedApps.length }}</b><span>INSTALLED</span></div>
          <div><b>{{ Object.values(enabledApps).filter(Boolean).length }}</b><span>ENABLED</span></div>
          <div>
            <b><span :class="healthCheckRunning ? 'noir-computer-warn' : 'noir-computer-ok'" />{{ healthCheckRunning ? 'Checking' : 'Ready' }}</b>
            <span>PERMISSIONS</span>
          </div>
        </div>
      </div>

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
        <button
          class="action-btn action-btn--health"
          :disabled="healthCheckRunning"
          @click="runHealthCheck"
        >
          {{ healthCheckRunning ? 'Checking...' : 'Test Permissions' }}
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
                  <span
                    v-if="permissionStatus[app.bundleId] === 'granted'"
                    class="permission-badge permission-badge--granted"
                    title="Permission granted"
                  >Granted</span>
                  <span
                    v-else-if="permissionStatus[app.bundleId] === 'denied'"
                    class="permission-badge permission-badge--denied"
                    title="Permission denied — open System Settings > Privacy & Security > Automation to allow"
                  >Denied</span>
                  <span
                    v-else-if="permissionStatus[app.bundleId] === 'error'"
                    class="permission-badge permission-badge--error"
                    :title="permissionError[app.bundleId] || 'Probe failed'"
                  >Error</span>
                  <span
                    v-else-if="permissionStatus[app.bundleId] === 'checking'"
                    class="permission-badge permission-badge--checking"
                  >Checking...</span>
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
                <div
                  v-if="permissionStatus[app.bundleId] === 'denied'"
                  class="denied-hint"
                >
                  Open System Settings &gt; Privacy &amp; Security &gt; Automation to grant access.
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
import { ref, onMounted, onBeforeUnmount } from 'vue';

import { SullaSettingsModel } from '../agent/database/models/SullaSettingsModel';
import { useTheme } from '../composables/useTheme';
import { APP_REGISTRY, APP_CATEGORIES } from '../main/computerUseSettings/appRegistry';

import type { AppCategory, AppEntry } from '../main/computerUseSettings/appRegistry';

const { execFile } = require('child_process');

const { ipcRenderer } = require('electron');

useTheme();

// ─── State ─────────────────────────────────────────────────────

const enabledApps = ref<Record<string, boolean>>({});
const installedApps = ref<string[]>([]);
const permissionStatus = ref<Record<string, 'granted' | 'denied' | 'error' | 'checking'>>({});
const permissionError = ref<Record<string, string>>({});
const loading = ref(true);
const healthCheckRunning = ref(false);
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

async function probePermission(bundleId: string, appName: string) {
  permissionStatus.value = { ...permissionStatus.value, [bundleId]: 'checking' };
  try {
    const result = await ipcRenderer.invoke('computer-use:request-permission', appName);
    permissionStatus.value = { ...permissionStatus.value, [bundleId]: result.status };
    if (result.error) {
      permissionError.value = { ...permissionError.value, [bundleId]: result.error };
    }
  } catch {
    permissionStatus.value = { ...permissionStatus.value, [bundleId]: 'error' };
  }
}

async function toggleApp(bundleId: string, event: Event) {
  const target = event.target as HTMLInputElement;
  enabledApps.value = { ...enabledApps.value, [bundleId]: target.checked };
  await saveSettings();

  if (target.checked) {
    const appEntry = registry.find(a => a.bundleId === bundleId);
    if (appEntry) {
      await probePermission(bundleId, appEntry.name);
    }
  } else {
    // Clear status when disabled
    const updated = { ...permissionStatus.value };
    delete updated[bundleId];
    permissionStatus.value = updated;
  }
}

async function runHealthCheck() {
  const enabledEntries = registry.filter(a => enabledApps.value[a.bundleId]);
  if (enabledEntries.length === 0) {
    return;
  }

  healthCheckRunning.value = true;

  // Mark all as checking
  const checking: Record<string, 'checking'> = {};
  for (const app of enabledEntries) {
    checking[app.bundleId] = 'checking';
  }
  permissionStatus.value = { ...permissionStatus.value, ...checking };

  try {
    const appNames = enabledEntries.map(a => a.name);
    const results = await ipcRenderer.invoke('computer-use:health-check', appNames);

    for (const app of enabledEntries) {
      const r = results[app.name];
      if (r) {
        permissionStatus.value = { ...permissionStatus.value, [app.bundleId]: r.status };
        if (r.error) {
          permissionError.value = { ...permissionError.value, [app.bundleId]: r.error };
        }
      }
    }
  } catch {
    for (const app of enabledEntries) {
      permissionStatus.value = { ...permissionStatus.value, [app.bundleId]: 'error' };
    }
  }

  healthCheckRunning.value = false;
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
  permissionStatus.value = {};
  permissionError.value = {};
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

// Agent tools (applescript_execute auto-enable, computer_use_enable/disable)
// broadcast `computer-use:settings-changed` whenever they flip a toggle on
// behalf of the user. Reload the UI so the checkbox state matches disk.
function onSettingsChanged(): void {
  loadSettings().catch(() => undefined);
}

onMounted(async() => {
  await loadSettings();
  await detectInstalledApps();
  loading.value = false;
  ipcRenderer.on('computer-use:settings-changed' as any, onSettingsChanged);
  ipcRenderer.send('dialog/ready');
});

onBeforeUnmount(() => {
  ipcRenderer.removeListener('computer-use:settings-changed' as any, onSettingsChanged);
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

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  &--health {
    margin-left: auto;
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
  display: flex;
  align-items: center;
  gap: 0.5rem;
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

.denied-hint {
  font-size: var(--fs-body-sm, 0.75rem);
  color: var(--status-warning, #f59e0b);
  margin-top: 0.2rem;
}

// ─── Permission badges ────────────────────────────────────────

.permission-badge {
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  white-space: nowrap;

  &--granted {
    background: rgba(34, 197, 94, 0.15);
    color: #16a34a;
  }

  &--denied {
    background: rgba(239, 68, 68, 0.15);
    color: #dc2626;
  }

  &--error {
    background: rgba(245, 158, 11, 0.15);
    color: #d97706;
  }

  &--checking {
    background: rgba(59, 130, 246, 0.15);
    color: #2563eb;
  }
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

<style lang="scss" scoped>
.noir-computer-head,
.noir-computer-hero {
  display: none;
}

:global(.theme-noir) .computer-use-settings {
  background: radial-gradient(circle at 18% 0%, color-mix(in srgb, var(--nx-accent) 5%, transparent), transparent 32%), var(--nx-paper);
  color: var(--nx-read-2);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}

:global(.theme-noir) .settings-header {
  display: none;
}

:global(.theme-noir) .settings-body {
  padding: 30px 34px;
}

:global(.theme-noir) .noir-computer-head {
  display: block;
  max-width: 920px;
  margin-bottom: 22px;
  animation: noir-computer-in 340ms ease both;
}

:global(.theme-noir) .noir-computer-eyebrow {
  margin-bottom: 7px;
  color: var(--nx-accent-2);
  font-size: 10.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

:global(.theme-noir) .noir-computer-headline {
  color: var(--nx-read-1);
  font-family: "Playfair Display", Georgia, serif;
  font-size: 30px;
  font-weight: 600;
  line-height: 1.15;
}

:global(.theme-noir) .noir-computer-lead {
  margin-top: 7px;
  color: var(--nx-read-3);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
}

:global(.theme-noir) .settings-description {
  display: none;
}

:global(.theme-noir) .noir-computer-hero {
  display: block;
  max-width: 920px;
  margin-bottom: 14px;
  padding: 22px;
  border-radius: 20px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--nx-accent) 16%, transparent), color-mix(in srgb, var(--nx-accent) 3%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 25%, transparent), 0 18px 60px rgba(0, 0, 0, 0.22);
  animation: noir-computer-in 340ms ease both;
}

:global(.theme-noir) .noir-computer-hero > div:first-child {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

:global(.theme-noir) .noir-computer-hero-title {
  color: var(--nx-read-1);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  font-weight: 600;
}

:global(.theme-noir) .noir-computer-hero-copy {
  color: var(--nx-read-4);
  font-size: 11px;
}

:global(.theme-noir) .noir-computer-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-top: 16px;
}

:global(.theme-noir) .noir-computer-stats > div {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 14px 16px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--bg-surface-alt) 46%, transparent);
  box-shadow: inset 0 0 0 1px var(--nx-hair);
}

:global(.theme-noir) .noir-computer-stats b {
  color: var(--nx-read-1);
  font-family: "Playfair Display", Georgia, serif;
  font-size: 24px;
  font-weight: 600;
}

:global(.theme-noir) .noir-computer-stats > div > span {
  color: var(--nx-read-4);
  font-size: 10px;
  letter-spacing: 0.1em;
}

:global(.theme-noir) .noir-computer-ok,
:global(.theme-noir) .noir-computer-warn {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--nx-success);
  box-shadow: 0 0 8px color-mix(in srgb, var(--nx-success) 70%, transparent);
}

:global(.theme-noir) .noir-computer-warn {
  background: var(--nx-warning);
  box-shadow: 0 0 8px color-mix(in srgb, var(--nx-warning) 55%, transparent);
}

:global(.theme-noir) .settings-controls {
  max-width: 920px;
  margin-bottom: 14px;
  padding: 14px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--nx-hair) 43.75%, transparent);
  box-shadow: inset 0 0 0 1px var(--nx-hair);
}

:global(.theme-noir) .action-btn {
  min-height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: 16px;
  color: var(--nx-read-2);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--nx-hair-strong);
  transition: transform 180ms ease, background 160ms ease;
}

:global(.theme-noir) .action-btn:hover {
  transform: translateY(-1px);
  background: color-mix(in srgb, var(--nx-accent) 10%, transparent);
}

:global(.theme-noir) .action-btn--health {
  color: #fff;
  background: linear-gradient(180deg, var(--nx-accent-2), var(--nx-accent));
  box-shadow: 0 0 16px color-mix(in srgb, var(--nx-accent) 35%, transparent);
}

:global(.theme-noir) .loading-state {
  max-width: 920px;
  padding: 40px;
  border-radius: 18px;
  color: var(--nx-read-4);
  background: color-mix(in srgb, var(--nx-hair) 43.75%, transparent);
  box-shadow: inset 0 0 0 1px var(--nx-hair);
  text-align: center;
}

:global(.theme-noir) .app-list {
  max-width: 920px;
}

:global(.theme-noir) .app-category {
  margin-bottom: 14px;
  padding: 18px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--nx-hair) 43.75%, transparent);
  box-shadow: inset 0 0 0 1px var(--nx-hair);
}

:global(.theme-noir) .category-header {
  margin-bottom: 8px;
  padding: 0 0 8px;
  border-bottom-color: var(--nx-hair);
  color: var(--nx-accent-2);
  font-size: 10.5px;
  letter-spacing: 0.14em;
}

:global(.theme-noir) .app-entry {
  min-height: 58px;
  margin-bottom: 6px;
  padding: 10px 12px;
  border: 0;
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-surface-alt) 40%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-hair) 75%, transparent);
  transition: transform 180ms ease, background 160ms ease, box-shadow 160ms ease;
}

:global(.theme-noir) .app-entry:hover {
  transform: translateX(2px);
  background: color-mix(in srgb, var(--nx-accent) 8%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 22%, transparent);
}

:global(.theme-noir) .app-entry.is-disabled {
  opacity: 0.4;
}

:global(.theme-noir) .app-name {
  color: var(--nx-read-1);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  font-weight: 600;
}

:global(.theme-noir) .app-description,
:global(.theme-noir) .not-installed-label,
:global(.theme-noir) .denied-hint {
  color: var(--nx-read-4);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 11.5px;
}

:global(.theme-noir) .permission-badge {
  border-radius: 10px;
  font-size: 9.5px;
  letter-spacing: 0.04em;
}

:global(.theme-noir) .permission-badge--granted {
  color: #9fd8a8;
  background: color-mix(in srgb, var(--nx-success) 10%, transparent);
}

:global(.theme-noir) .permission-badge--denied,
:global(.theme-noir) .permission-badge--error {
  color: #e7a19c;
  background: color-mix(in srgb, var(--nx-danger) 8%, transparent);
}

:global(.theme-noir) .permission-badge--checking {
  color: #a8c0dc;
  background: color-mix(in srgb, var(--nx-accent) 12%, transparent);
}

:global(.theme-noir) .toggle-switch {
  width: 46px;
  height: 26px;
}

:global(.theme-noir) .toggle-switch .toggle-slider {
  border-radius: 13px;
  background: color-mix(in srgb, var(--nx-hair-strong) 75%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-hair-strong) 87.5%, transparent);
}

:global(.theme-noir) .toggle-switch .toggle-slider::before {
  width: 20px;
  height: 20px;
  bottom: 3px;
  border-radius: 50%;
  background: var(--nx-read-2);
  transition: transform linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013, 1) .58s;
}

:global(.theme-noir) .toggle-switch input:checked + .toggle-slider {
  background: linear-gradient(180deg, var(--nx-accent-2), var(--nx-accent));
  box-shadow: 0 0 14px color-mix(in srgb, var(--nx-accent) 45%, transparent);
}

:global(.theme-noir) .toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(20px);
}

:global(.theme-noir-light) .noir-computer-hero {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 25%, transparent),
    0 18px 60px color-mix(in srgb, var(--nx-ink) 10%, transparent);
}

:global(.theme-noir-light) .permission-badge--granted {
  color: var(--nx-success);
}

:global(.theme-noir-light) .permission-badge--denied,
:global(.theme-noir-light) .permission-badge--error {
  color: var(--nx-danger);
}

:global(.theme-noir-light) .permission-badge--checking {
  color: var(--nx-accent);
}

@keyframes noir-computer-in {
  from { opacity: 0; filter: blur(8px); transform: translateY(8px); }
  to { opacity: 1; filter: blur(0); transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  :global(.theme-noir) .noir-computer-head,
  :global(.theme-noir) .noir-computer-hero,
  :global(.theme-noir) .action-btn,
  :global(.theme-noir) .app-entry,
  :global(.theme-noir) .toggle-switch .toggle-slider::before {
    animation: none;
    transition: none;
  }
}
</style>
