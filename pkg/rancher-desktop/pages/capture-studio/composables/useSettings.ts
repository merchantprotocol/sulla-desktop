/**
 * Composable — persist Capture Studio settings across sessions.
 *
 * Uses SullaSettingsModel via IPC (key-value store, no migration needed).
 * Settings are loaded on mount and auto-saved on change with debounce.
 */

import { ref, watch, onMounted, onUnmounted } from 'vue';

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

  // Load all settings on mount (parallelized)
  onMounted(async () => {
    const [
      layoutVal, cameraShapeVal, cameraDeviceIdVal, micDeviceIdVal,
      tpFontSizeVal, tpSpeedVal, tpHighlightColorVal, savePathVal,
    ] = await Promise.all([
      loadSetting('layout', 'pip'),
      loadSetting('cameraShape', 'circle'),
      loadSetting('cameraDeviceId', ''),
      loadSetting('micDeviceId', ''),
      loadSetting('tpFontSize', 42),
      loadSetting('tpSpeed', 6),
      loadSetting('tpHighlightColor', '#e6edf3'),
      loadSetting('savePath', ''),
    ]);
    layout.value = layoutVal;
    cameraShape.value = cameraShapeVal;
    cameraDeviceId.value = cameraDeviceIdVal;
    micDeviceId.value = micDeviceIdVal;
    tpFontSize.value = tpFontSizeVal;
    tpSpeed.value = tpSpeedVal;
    tpHighlightColor.value = tpHighlightColorVal;
    savePath.value = savePathVal;
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

  // Clear pending save timeout on unmount
  onUnmounted(() => {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
  });

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
