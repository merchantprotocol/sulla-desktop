/**
 * Composable — persist Capture Studio settings across sessions.
 *
 * Uses SullaSettingsModel via IPC (key-value store, no migration needed).
 * Settings are loaded on mount and auto-saved on change with debounce.
 */

import { ref, watch, onMounted } from 'vue';

const { ipcRenderer } = require('electron');

const SETTINGS_PREFIX = 'captureStudio:';
const DEBOUNCE_MS = 500;

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

async function loadSetting(key: string, defaultValue: any): Promise<any> {
  try {
    const result = await ipcRenderer.invoke('sulla-settings:get', SETTINGS_PREFIX + key);
    return result !== null && result !== undefined ? result : defaultValue;
  } catch {
    return defaultValue;
  }
}

async function saveSetting(key: string, value: any): Promise<void> {
  try {
    const cast = typeof value === 'number' ? 'number'
      : typeof value === 'boolean' ? 'boolean'
      : 'string';
    await ipcRenderer.invoke('sulla-settings:set', SETTINGS_PREFIX + key, value, cast);
  } catch (e: any) {
    console.warn('[useSettings] Failed to save', key, e.message);
  }
}

export function useSettings() {
  const layout = ref('pip');
  const cameraShape = ref('circle');
  const cameraDeviceId = ref('');
  const micDeviceId = ref('');
  const tpFontSize = ref(42);
  const tpSpeed = ref(6);
  const tpHighlightColor = ref('#e6edf3');
  const savePath = ref('');
  const loaded = ref(false);

  // Load all settings on mount
  onMounted(async () => {
    layout.value = await loadSetting('layout', 'pip');
    cameraShape.value = await loadSetting('cameraShape', 'circle');
    cameraDeviceId.value = await loadSetting('cameraDeviceId', '');
    micDeviceId.value = await loadSetting('micDeviceId', '');
    tpFontSize.value = await loadSetting('tpFontSize', 42);
    tpSpeed.value = await loadSetting('tpSpeed', 6);
    tpHighlightColor.value = await loadSetting('tpHighlightColor', '#e6edf3');
    savePath.value = await loadSetting('savePath', '');
    loaded.value = true;
  });

  // Auto-save on change (debounced)
  function debouncedSave(key: string, value: any) {
    if (!loaded.value) return; // Don't save during initial load
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveSetting(key, value), DEBOUNCE_MS);
  }

  watch(layout, v => debouncedSave('layout', v));
  watch(cameraShape, v => debouncedSave('cameraShape', v));
  watch(cameraDeviceId, v => debouncedSave('cameraDeviceId', v));
  watch(micDeviceId, v => debouncedSave('micDeviceId', v));
  watch(tpFontSize, v => debouncedSave('tpFontSize', v));
  watch(tpSpeed, v => debouncedSave('tpSpeed', v));
  watch(tpHighlightColor, v => debouncedSave('tpHighlightColor', v));
  watch(savePath, v => debouncedSave('savePath', v));

  return {
    layout,
    cameraShape,
    cameraDeviceId,
    micDeviceId,
    tpFontSize,
    tpSpeed,
    tpHighlightColor,
    savePath,
    loaded,
  };
}
