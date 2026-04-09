/**
 * Composable — audio-driver IPC bridge for Capture Studio.
 *
 * All mic and speaker access goes through MicrophoneDriverController /
 * SpeakerDriverController via IPC. The tray panel renderer owns the
 * actual getUserMedia stream and Web Audio pipeline. This composable
 * provides reactive refs for level metering, VAD state, and lifecycle.
 *
 * Reference: main/audio-driver/controller/MicrophoneDriverController.ts
 */

import { ref, onMounted, onUnmounted } from 'vue';

const { ipcRenderer } = require('electron');

export function useAudioDriver() {
  // ── Mic state (from MicrophoneDriverController via audio-driver:mic-vad) ──

  const micLevel = ref(0);
  const micRunning = ref(false);
  const micSpeaking = ref(false);
  const micMuted = ref(false);

  // ── Speaker state ──

  const speakerLevel = ref(0);
  const speakerRunning = ref(false);

  // ── IPC listeners ──

  let micVadCount = 0;
  const onMicVad = (_e: any, data: any) => {
    if (!data) return;
    micLevel.value = data.level ?? 0;
    micSpeaking.value = !!data.speaking;
    micVadCount++;
  };

  let speakerLevelCount = 0;
  const onSpeakerLevel = (_e: any, data: { rms: number }) => {
    speakerLevel.value = typeof data === 'number' ? data : data.rms;
    speakerLevelCount++;
    if (speakerLevelCount <= 5 || (speakerLevelCount % 300 === 0)) {
      console.log('[useAudioDriver] speaker-level', { rms: speakerLevel.value, count: speakerLevelCount });
    }
  };

  onMounted(() => {
    console.log('[useAudioDriver] Registering IPC listeners');
    ipcRenderer.on('audio-driver:mic-vad', onMicVad);
    ipcRenderer.on('audio-driver:speaker-level', onSpeakerLevel);
  });

  onUnmounted(() => {
    ipcRenderer.removeListener('audio-driver:mic-vad', onMicVad);
    ipcRenderer.removeListener('audio-driver:speaker-level', onSpeakerLevel);
  });

  // ── Mic commands ──

  async function startMic(formats?: string[]): Promise<any> {
    const result = await ipcRenderer.invoke('audio-driver:start-mic', 'capture-studio', formats || ['webm-opus', 'pcm-s16le']);
    micRunning.value = !!result?.micRunning;
    return result;
  }

  async function stopMic(): Promise<void> {
    const result = await ipcRenderer.invoke('audio-driver:stop-mic', 'capture-studio');
    micRunning.value = !!result?.micRunning;
  }

  function setMicGain(value: number): void {
    ipcRenderer.send('audio-driver:mic-gain', value);
  }

  function setMicMuted(muted: boolean): void {
    micMuted.value = muted;
    ipcRenderer.send('audio-driver:mic-mute', muted);
  }

  async function getMicSocketPath(): Promise<string | null> {
    return ipcRenderer.invoke('audio-driver:get-mic-socket-path');
  }

  async function getMicPcmSocketPath(): Promise<string | null> {
    return ipcRenderer.invoke('audio-driver:get-mic-pcm-socket-path');
  }

  /**
   * Set the mic PCM quality mode for recording.
   * 'raw' = all audio, no processing (ASMR/music/environment)
   * 'noise-reduction' = VAD-gated + noise-processed (voice)
   */
  async function setMicPcmMode(mode: 'raw' | 'noise-reduction'): Promise<void> {
    await ipcRenderer.invoke('audio-driver:set-mic-pcm-mode', mode);
  }

  async function setMicDevice(deviceName: string): Promise<void> {
    await ipcRenderer.invoke('audio-driver:set-system-input', deviceName);
  }

  // ── Speaker commands ──

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
    micRunning.value = !!state?.micRunning;
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
    // Mic
    micLevel,
    micRunning,
    micSpeaking,
    micMuted,
    startMic,
    stopMic,
    setMicGain,
    setMicMuted,
    setMicDevice,
    setMicPcmMode,
    getMicSocketPath,
    getMicPcmSocketPath,
    // Speaker
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
