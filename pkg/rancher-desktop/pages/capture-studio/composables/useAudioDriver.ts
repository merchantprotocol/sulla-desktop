/**
 * Composable — audio-driver IPC bridge for Capture Studio.
 *
 * Wraps the audio-driver IPC channels as reactive refs.
 * Speaker capture is handled by the main process (CoreAudio daemon).
 * No transcription — pure capture only.
 *
 * Reference: main/trayPanel/renderer/bridge.js
 */

import { ref, onMounted, onUnmounted } from 'vue';

const { ipcRenderer } = require('electron');

export function useAudioDriver() {
  const speakerLevel = ref(0);
  const speakerRunning = ref(false);

  // ── IPC listeners (registered on mount, removed on unmount to prevent stacking) ──

  let levelCount = 0;
  const onLevel = (_e: any, data: { rms: number }) => {
    speakerLevel.value = typeof data === 'number' ? data : data.rms;
    levelCount++;
    if (levelCount <= 5 || (levelCount % 300 === 0)) {
      console.log('[useAudioDriver] speaker-level', { rms: speakerLevel.value, count: levelCount });
    }
  };

  onMounted(() => {
    console.log('[useAudioDriver] Registering IPC listeners');
    ipcRenderer.on('audio-driver:speaker-level', onLevel);
  });

  onUnmounted(() => {
    ipcRenderer.removeListener('audio-driver:speaker-level', onLevel);
  });

  // ── Commands ──

  async function startSpeaker(): Promise<void> {
    const result = await ipcRenderer.invoke('audio-driver:start-speaker', 'capture-studio');
    speakerRunning.value = !!result?.speakerRunning;
  }

  async function stopSpeaker(): Promise<void> {
    const result = await ipcRenderer.invoke('audio-driver:stop-speaker', 'capture-studio');
    speakerRunning.value = !!result?.speakerRunning;
  }

  async function getState(): Promise<any> {
    const state = await ipcRenderer.invoke('audio-driver:get-state');
    speakerRunning.value = !!state?.speakerRunning;
    return state;
  }

  async function speakerVolumeGet(): Promise<{ ok: boolean; volume: number; muted: boolean }> {
    return ipcRenderer.invoke('audio-driver:speaker-volume-get');
  }

  async function speakerVolumeUp(): Promise<void> {
    await ipcRenderer.invoke('audio-driver:speaker-volume-up');
  }

  async function speakerVolumeDown(): Promise<void> {
    await ipcRenderer.invoke('audio-driver:speaker-volume-down');
  }

  async function speakerMuteToggle(): Promise<void> {
    await ipcRenderer.invoke('audio-driver:speaker-mute-toggle');
  }

  async function getSpeakerSocketPath(): Promise<string | null> {
    return ipcRenderer.invoke('audio-driver:get-speaker-socket-path');
  }

  return {
    speakerLevel,
    speakerRunning,
    startSpeaker,
    stopSpeaker,
    getState,
    speakerVolumeGet,
    speakerVolumeUp,
    speakerVolumeDown,
    speakerMuteToggle,
    getSpeakerSocketPath,
  };
}
