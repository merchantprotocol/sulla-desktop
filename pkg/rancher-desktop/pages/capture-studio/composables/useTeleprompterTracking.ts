/**
 * Composable — voice-tracked teleprompter scrolling (IPC wrapper).
 *
 * All fuzzy matching, prediction, and VAD logic now runs in the main
 * process (teleprompterTracking.ts). This composable is a thin IPC
 * bridge that sends the script and receives position updates.
 */

import { ref, onUnmounted } from 'vue';

const { ipcRenderer } = require('electron');

export function useTeleprompterTracking(
  onIndexUpdate: (index: number) => void,
) {
  const isTracking = ref(false);
  const confidence = ref(0);

  // Listen for position updates from the main-process tracker
  let positionHandler: ((_event: any, data: any) => void) | null = null;

  function attachListener() {
    if (positionHandler) return;
    positionHandler = (_event: any, data: any) => {
      if (typeof data?.currentIndex === 'number') {
        confidence.value = data.confidence ?? 0;
        onIndexUpdate(data.currentIndex);
      }
    };
    ipcRenderer.on('teleprompter-tracking:position', positionHandler);
  }

  function detachListener() {
    if (positionHandler) {
      ipcRenderer.removeListener('teleprompter-tracking:position', positionHandler);
      positionHandler = null;
    }
  }

  async function startTracking(words: string[], startIndex: number = 0) {
    if (isTracking.value) {
      await stopTracking();
    }

    // Send script to the main process
    await ipcRenderer.invoke('teleprompter-tracking:set-script', {
      words,
      currentIndex: startIndex,
    });

    // Start the main-process tracker (mic + whisper + prediction)
    const result = await ipcRenderer.invoke('teleprompter-tracking:start');

    if (!result?.ok) {
      console.warn('[TeleprompterTracking] Main-process tracker failed to start');
      return;
    }

    attachListener();
    isTracking.value = true;
    console.log('[TeleprompterTracking] Started — main-process tracking active');
  }

  async function stopTracking() {
    isTracking.value = false;
    confidence.value = 0;
    detachListener();

    await ipcRenderer.invoke('teleprompter-tracking:stop').catch(() => {});
    console.log('[TeleprompterTracking] Stopped');
  }

  /**
   * Update the current index externally (e.g. user clicked a word).
   */
  function setCurrentIndex(index: number) {
    ipcRenderer.invoke('teleprompter-tracking:jump-to', { currentIndex: index }).catch(() => {});
  }

  // Clean up listener if the component using this composable unmounts
  onUnmounted(() => {
    detachListener();
  });

  return {
    isTracking,
    confidence,
    startTracking,
    stopTracking,
    setCurrentIndex,
  };
}
