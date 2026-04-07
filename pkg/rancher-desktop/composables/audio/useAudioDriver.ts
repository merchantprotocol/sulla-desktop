/**
 * @module composables/audio/useAudioDriver
 *
 * Vue composable that wraps {@link AudioDriverClient} as reactive refs.
 *
 * ## Usage
 *
 * ```vue
 * <script setup>
 * const {
 *   micRunning, speaking, micLevel, micDb, noiseFloor,
 *   startMic, stopMic, startListening, stopListening,
 * } = useAudioDriver();
 * </script>
 *
 * <template>
 *   <div>{{ speaking ? 'Speaking' : 'Silent' }}</div>
 *   <div>Level: {{ micDb }} dB</div>
 *   <button @click="startMic">Start Mic</button>
 * </template>
 * ```
 *
 * All state refs are **readonly** — mutation happens through the methods.
 * Multiple components calling `useAudioDriver()` share the same singleton
 * client. Listeners are auto-cleaned on `onUnmounted`.
 */

import { ref, computed, readonly, onUnmounted } from 'vue';
import { AudioDriverClient } from './AudioDriverClient';
import type { VadDetails, TranscriptEntry } from './types';

export function useAudioDriver() {
  const client = AudioDriverClient.getInstance();

  // ── Reactive state ──────────────────────────────────────────

  const micRunning = ref(client.micRunning);
  const speakerRunning = ref(client.speakerRunning);
  const micLevel = ref(client.micLevel);
  const speakerLevel = ref(client.speakerLevel);
  const speaking = ref(client.speaking);
  const fanNoise = ref(client.fanNoise);
  const noiseFloor = ref(client.noiseFloor);
  const vadDetails = ref<VadDetails>(client.vadDetails);
  const listening = ref(client.listening);

  // ── Computed (derived) ──────────────────────────────────────

  const micDb = computed(() => AudioDriverClient.levelToDb(micLevel.value));
  const micDbFormatted = computed(() => AudioDriverClient.formatDb(micDb.value));
  const speakerDb = computed(() => AudioDriverClient.levelToDb(speakerLevel.value));
  const speakerDbFormatted = computed(() => AudioDriverClient.formatDb(speakerDb.value));
  const noiseFloorDb = computed(() => AudioDriverClient.levelToDb(noiseFloor.value));
  const noiseFloorDbFormatted = computed(() => AudioDriverClient.formatDb(noiseFloorDb.value, 1));
  const running = computed(() => micRunning.value || speakerRunning.value);

  // ── Subscribe to client events, sync refs ───────────────────

  const unsubs: Array<() => void> = [];

  unsubs.push(client.on('vad', (data) => {
    micLevel.value = data.level;
    speaking.value = data.speaking;
    fanNoise.value = data.fanNoise;
    if (data.noiseFloor !== undefined) noiseFloor.value = data.noiseFloor;
    vadDetails.value = {
      zcr:      data.zcr ?? vadDetails.value.zcr,
      variance: data.variance ?? vadDetails.value.variance,
      pitch:    data.pitch !== undefined ? data.pitch : vadDetails.value.pitch,
      centroid: data.centroid ?? vadDetails.value.centroid,
    };
  }));

  unsubs.push(client.on('speakerLevel', (data) => {
    speakerLevel.value = typeof data === 'number' ? data : (data as any).rms;
  }));

  unsubs.push(client.on('stateChange', (state) => {
    micRunning.value = state.micRunning;
    speakerRunning.value = state.speakerRunning;
  }));

  // ── Auto-cleanup on unmount ─────────────────────────────────

  onUnmounted(() => {
    for (const unsub of unsubs) unsub();
    // Sync listening state (don't stop — other components may still be using it)
    listening.value = client.listening;
  });

  // ── Return ──────────────────────────────────────────────────

  return {
    // State (readonly refs)
    micRunning:           readonly(micRunning),
    speakerRunning:       readonly(speakerRunning),
    running,
    micLevel:             readonly(micLevel),
    micDb,
    micDbFormatted,
    speakerLevel:         readonly(speakerLevel),
    speakerDb,
    speakerDbFormatted,
    speaking:             readonly(speaking),
    fanNoise:             readonly(fanNoise),
    noiseFloor:           readonly(noiseFloor),
    noiseFloorDb,
    noiseFloorDbFormatted,
    vadDetails:           readonly(vadDetails),
    listening:            readonly(listening),

    // Mic lifecycle
    startMic:       () => client.startMic(),
    stopMic:        () => client.stopMic(),
    toggleMic:      () => client.toggleMic(),
    setMicGain:     (v: number) => client.setMicGain(v),
    setMicMuted:    (m: boolean) => client.setMicMuted(m),
    setMicDevice:   (d: string) => client.setMicDevice(d),

    // Speaker lifecycle
    startSpeaker:       () => client.startSpeaker(),
    stopSpeaker:        () => client.stopSpeaker(),
    toggleSpeaker:      () => client.toggleSpeaker(),
    speakerVolumeUp:    () => client.speakerVolumeUp(),
    speakerVolumeDown:  () => client.speakerVolumeDown(),
    speakerMuteToggle:  () => client.speakerMuteToggle(),
    speakerVolumeGet:   () => client.speakerVolumeGet(),
    setSpeakerDevice:   (d: string) => client.setSpeakerDevice(d),

    // Combined
    startAll: () => client.startAll(),
    stopAll:  () => client.stopAll(),

    // Speech recognition (VAD-driven browser STT)
    startListening: (opts?: { lang?: string }) => {
      client.startListening(opts);
      listening.value = true;
    },
    stopListening: () => {
      client.stopListening();
      listening.value = false;
    },

    // Test recording
    testRecordStart: () => client.testRecordStart(),
    testRecordStop:  () => client.testRecordStop(),

    // Direct client access for advanced usage (gateway, whisper, sockets)
    client,
  };
}
