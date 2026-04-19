/**
 * @module composables/audio/types
 *
 * Shared type definitions for the Audio Driver Client API.
 *
 * These types describe the data flowing through the audio driver's IPC
 * channels. All consumers — Vue components, controllers, services — should
 * import from here rather than defining their own ad-hoc shapes.
 */

// ── VAD (Voice Activity Detection) ──────────────────────────────

/**
 * Full VAD event payload broadcast on every analysis frame (~60 fps).
 * Produced by the tray panel's VAD orchestrator and relayed via
 * `audio-driver:mic-vad` IPC.
 */
export interface VadEvent {
  /** Whether the VAD classifies the current frame as speech. */
  speaking:   boolean;
  /** Mic RMS level (0–1 scale, pre-gain). */
  level:      number;
  /** True if steady-state mechanical noise (fan, AC) is detected. */
  fanNoise:   boolean;
  /** Adaptive noise floor RMS — adjusts to ambient conditions. */
  noiseFloor: number;
  /** Zero-crossing rate (0–1). Speech is typically 0.05–0.15. */
  zcr:        number;
  /** Temporal variance of recent RMS values. Speech varies; noise is flat. */
  variance:   number;
  /** Detected pitch in Hz, or null if no tonal content. Human voice: 80–400 Hz. */
  pitch:      number | null;
  /** Spectral centroid (0–1 normalized). Speech energy is concentrated low. */
  centroid:   number;
}

/**
 * Subset of VAD analysis metrics exposed as a stable property.
 * Updated on every `vad` event; consumers can read without subscribing.
 */
export interface VadDetails {
  zcr:      number;
  variance: number;
  pitch:    number | null;
  centroid: number;
}

// ── Speaker Level ───────────────────────────────────────────────

/**
 * Speaker level data from the CoreAudio capture helper (Swift).
 * Broadcast via `audio-driver:speaker-level` at the capture helper's native rate.
 */
export interface SpeakerLevelEvent {
  rms:      number;
  peak:     number;
  zcr:      number;
  variance: number;
}

// ── Audio Driver State ──────────────────────────────────────────

/**
 * Full state snapshot returned by `getState()` and broadcast on `stateChange`.
 */
export interface AudioDriverState {
  /** Whether the mic capture pipeline is active (getUserMedia + VAD). */
  micRunning:     boolean;
  /** Whether the speaker capture pipeline is active (BlackHole mirror + CoreAudio). */
  speakerRunning: boolean;
  /** Convenience: true if either mic or speaker is running. */
  running:        boolean;
  /** Human-readable status: 'Off', 'Capturing', 'Enabling...', etc. */
  message:        string;
  /** Whether the aggregate mirror device is active (macOS). */
  mirrorActive:   boolean;
  /** Display name of the active mic device. */
  micName:        string;
  /** Display name of the active speaker device. */
  speakerName:    string;
}

// ── Volume ──────────────────────────────────────────────────────

/** System speaker volume state. */
export interface VolumeState {
  ok:     boolean;
  /** Volume level 0–1. */
  volume: number;
  /** Whether the speaker is muted. */
  muted:  boolean;
}

// ── Gateway (Transcription Streaming) ───────────────────────────

/** Identifiers returned when a gateway session is created. */
export interface GatewaySession {
  sessionId: string;
  callId:    string;
}

/** Options for starting a gateway transcription session. */
export interface GatewayStartOpts {
  /** Display name for the caller (default: 'Sulla Desktop'). */
  userName?: string;
  /**
   * Channel definitions. Keys are channel IDs as strings ('0', '1', ...).
   * Default: channel 0 = mic, channel 1 = system_audio.
   */
  channels?: Record<string, {
    label:        string;
    source:       string;
    audioFormat?: { inputFormat: string; inputRate: number; inputChannels: number };
  }>;
}

// ── Transcript ──────────────────────────────────────────────────

/** A single transcript entry (from gateway, whisper, or browser STT). */
export interface TranscriptEntry {
  /** Speaker label (e.g. 'You', 'Caller', channel label). */
  speaker:   string;
  /** Transcribed text. */
  text:      string;
  /** True if this is an interim/partial result that may be updated. */
  partial:   boolean;
  /** Unix timestamp (ms) when this entry was received. */
  timestamp: number;
}

// ── Whisper (Local STT) ─────────────────────────────────────────

/** Status of the local whisper.cpp installation. */
export interface WhisperStatus {
  installed: boolean;
  path?:     string;
  models?:   string[];
}

/** Options for starting local whisper transcription. */
export interface TranscribeOpts {
  mode:      'conversation' | 'secretary';
  language?: string;
  model?:    string;
}

// ── Events ──────────────────────────────────────────────────────

/** Event map for AudioDriverClient.on(). */
export interface AudioDriverEvents {
  vad:          VadEvent;
  speakerLevel: SpeakerLevelEvent;
  stateChange:  AudioDriverState;
  transcript:   TranscriptEntry;
  volumeChange: VolumeState;
  deviceChange: string;
}
