/**
 * Composable — audio-driver IPC bridge for Capture Studio.
 *
 * Wraps the audio-driver IPC channels as reactive refs.
 * Speaker capture is handled by the main process (CoreAudio daemon).
 * No transcription — pure capture only.
 *
 * Reference: main/trayPanel/renderer/bridge.js
 */

import { ref, onUnmounted } from 'vue';

const { ipcRenderer } = require('electron');

export function useAudioDriver() {
  const speakerLevel = ref(0);
  const speakerRunning = ref(false);

  // ── IPC listeners ──

  const onLevel = (_e: any, data: { rms: number }) => {
    speakerLevel.value = data.rms;
  };

  const onState = (_e: any, state: { running: boolean; message: string }) => {
    speakerRunning.value = state.running;
  };

  ipcRenderer.on('audio-driver:speaker-level', onLevel);
  ipcRenderer.on('audio-driver:state', onState);

  onUnmounted(() => {
    ipcRenderer.removeListener('audio-driver:speaker-level', onLevel);
    ipcRenderer.removeListener('audio-driver:state', onState);
  });

  // ── Commands ──

  async function startCapture(): Promise<{ running: boolean; message: string }> {
    const result = await ipcRenderer.invoke('audio-driver:start-capture');
    speakerRunning.value = result.running;
    return result;
  }

  async function stopCapture(): Promise<{ running: boolean; message: string }> {
    const result = await ipcRenderer.invoke('audio-driver:stop-capture');
    speakerRunning.value = result.running;
    return result;
  }

  async function getState(): Promise<{ running: boolean; message: string }> {
    return ipcRenderer.invoke('audio-driver:get-state');
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

  return {
    speakerLevel,
    speakerRunning,
    startCapture,
    stopCapture,
    getState,
    speakerVolumeGet,
    speakerVolumeUp,
    speakerVolumeDown,
    speakerMuteToggle,
  };
}
