/**
 * @module composables/audio
 *
 * Audio Driver Client API — the canonical interface for all audio operations
 * in Sulla Desktop.
 *
 * ## For Vue components
 * ```ts
 * import { useAudioDriver } from '@pkg/composables/audio';
 * const { micRunning, speaking, startMic, stopMic } = useAudioDriver();
 * ```
 *
 * ## For controllers / services
 * ```ts
 * import { AudioDriverClient } from '@pkg/composables/audio';
 * const client = AudioDriverClient.getInstance();
 * await client.startMic();
 * ```
 */

export { AudioDriverClient } from './AudioDriverClient';
export { useAudioDriver } from './useAudioDriver';
export type {
  AudioDriverEvents,
  AudioDriverState,
  GatewaySession,
  GatewayStartOpts,
  SpeakerLevelEvent,
  TranscribeOpts,
  TranscriptEntry,
  VadDetails,
  VadEvent,
  VolumeState,
  WhisperStatus,
} from './types';
