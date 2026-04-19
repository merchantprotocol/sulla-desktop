/**
 * Composable — track mouse clicks, keystrokes, and window focus changes
 * during recording. Events are logged to the recorder manifest for
 * post-production use (click highlights, keystroke overlays, auto-zoom).
 *
 * Uses IPC to the main process for global event tracking:
 * - Mouse clicks: Electron's globalShortcut can't do this, so we use
 *   a polling approach on the focused window info
 * - Window focus: ipcMain watches NSWorkspace notifications (macOS)
 * - Keystrokes: Captured via beforeinput in the renderer (local only)
 *
 * The main process provides global window focus tracking via
 * 'capture-studio:start-tracking' / 'capture-studio:stop-tracking' IPC.
 */

import { ref, onUnmounted } from 'vue';

import type { CaptureEvent } from './useRecorder';

const { ipcRenderer } = require('electron');

export function useInputEventTracker(
  logEvent: (event: Omit<CaptureEvent, 'time'>) => void,
) {
  const tracking = ref(false);

  let windowFocusHandler: ((_e: any, data: any) => void) | null = null;
  let mouseClickHandler: ((_e: any, data: any) => void) | null = null;

  function startTracking() {
    if (tracking.value) return;
    tracking.value = true;

    // Tell main process to start global event tracking
    ipcRenderer.invoke('capture-studio:start-tracking');

    // Listen for window focus changes from main process
    windowFocusHandler = (_e: any, data: { app: string; title: string; bounds: { x: number; y: number; width: number; height: number } }) => {
      if (!tracking.value) return;
      logEvent({
        type:   'window-focus',
        app:    data.app,
        title:  data.title,
        bounds: data.bounds,
      });
    };
    ipcRenderer.on('capture-studio:window-focus', windowFocusHandler);

    // Listen for mouse click events from main process
    mouseClickHandler = (_e: any, data: { x: number; y: number; button: string }) => {
      if (!tracking.value) return;
      logEvent({
        type:   'click',
        x:      data.x,
        y:      data.y,
        button: data.button,
      });
    };
    ipcRenderer.on('capture-studio:mouse-click', mouseClickHandler);

    // Capture keystrokes in the renderer (global keyboard events)
    document.addEventListener('keydown', onKeyDown, true);

    console.log('[InputEventTracker] Started tracking');
  }

  function stopTracking() {
    if (!tracking.value) return;
    tracking.value = false;

    ipcRenderer.invoke('capture-studio:stop-tracking');

    if (windowFocusHandler) {
      ipcRenderer.removeListener('capture-studio:window-focus', windowFocusHandler);
      windowFocusHandler = null;
    }
    if (mouseClickHandler) {
      ipcRenderer.removeListener('capture-studio:mouse-click', mouseClickHandler);
      mouseClickHandler = null;
    }

    document.removeEventListener('keydown', onKeyDown, true);

    console.log('[InputEventTracker] Stopped tracking');
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!tracking.value) return;
    // Only log modifier combos and special keys, not regular typing
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) return;

    const parts: string[] = [];
    if (e.metaKey) parts.push('Cmd');
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.key.length === 1) {
      parts.push(e.key.toUpperCase());
    } else {
      parts.push(e.key);
    }

    logEvent({
      type:  'keystroke',
      key:   parts.join('+'),
      label: parts.join('+'),
    });
  }

  onUnmounted(stopTracking);

  return {
    tracking,
    startTracking,
    stopTracking,
  };
}
